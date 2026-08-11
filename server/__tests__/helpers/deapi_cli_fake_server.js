// Real (non-mocked) HTTP fake server speaking the deAPI v2 wire contract,
// for the full-path CLI spawn integration tests (generate_*_cli.test.js).
// Unlike helpers/deapi_fetch_mock.js (which stubs globalThis.fetch for
// same-process unit tests), these tests spawn a real child process that
// needs a real socket to hit via DEAPI_API_BASE.
//
// Routes served:
//   GET  /api/v2/models                 → { data: catalog, meta: {...} }
//   POST /api/v2/**/price               → { data: { price } }
//   POST /api/v2/<resource>             → { data: { request_id } } (JSON or
//                                          multipart; submitStatus overrides
//                                          the response for retry/error tests)
//   GET  /api/v2/jobs/:id                → done job, result_url → /results/out.<ext>
//   GET  /results/out.<ext>              → resultBytes

import http from "node:http";
import { DEFAULT_CATALOG } from "./deapi_fetch_mock.js";

export { DEFAULT_CATALOG };

function readBody(req) {
  return new Promise((resolve) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks)));
  });
}

// Minimal multipart/form-data parser — enough to assert field values and
// which file fields/filenames were uploaded. Not RFC-complete.
export function parseMultipart(buffer, contentType) {
  const fields = {};
  const files = [];
  const m = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(contentType || "");
  const boundary = m ? (m[1] || m[2]).trim() : null;
  if (!boundary) return { fields, files };
  const boundaryBuf = Buffer.from(`--${boundary}`);
  let start = buffer.indexOf(boundaryBuf);
  if (start === -1) return { fields, files };
  start += boundaryBuf.length;
  for (;;) {
    if (buffer.slice(start, start + 2).toString("latin1") === "--") break;
    const nextIdx = buffer.indexOf(boundaryBuf, start);
    if (nextIdx === -1) break;
    let part = buffer.slice(start, nextIdx);
    if (part.slice(0, 2).toString("latin1") === "\r\n") part = part.slice(2);
    if (part.slice(-2).toString("latin1") === "\r\n") part = part.slice(0, -2);
    const headerEnd = part.indexOf("\r\n\r\n");
    if (headerEnd !== -1) {
      const headerStr = part.slice(0, headerEnd).toString("utf8");
      const body = part.slice(headerEnd + 4);
      const nameMatch = /name="([^"]+)"/.exec(headerStr);
      const filenameMatch = /filename="([^"]*)"/.exec(headerStr);
      const name = nameMatch ? nameMatch[1] : null;
      if (name) {
        if (filenameMatch) {
          const ctMatch = /content-type:\s*([^\r\n]+)/i.exec(headerStr);
          files.push({
            field: name,
            filename: filenameMatch[1],
            contentType: ctMatch ? ctMatch[1].trim() : null,
            bytes: body,
          });
        } else {
          const value = body.toString("utf8");
          if (name in fields) {
            fields[name] = Array.isArray(fields[name]) ? [...fields[name], value] : [fields[name], value];
          } else {
            fields[name] = value;
          }
        }
      }
    }
    start = nextIdx + boundaryBuf.length;
  }
  return { fields, files };
}

/**
 * @param {Object}   opts
 * @param {Array}    [opts.catalog=DEFAULT_CATALOG]
 * @param {string}   [opts.resultExt="png"]      extension served at /results/out.<ext>
 * @param {Buffer}   [opts.resultBytes]
 * @param {string}   [opts.resultContentType]
 * @param {number}   [opts.priceValue=0.0042]
 * @param {number}   [opts.submitStatus=200]     non-200 makes every submit POST fail this way
 * @param {object}   [opts.submitErrorBody]
 * @param {number}   [opts.retryAfterSec]        Retry-After header (429 tests)
 */
export function makeDeapiServer({
  catalog = DEFAULT_CATALOG,
  resultExt = "png",
  resultBytes,
  resultContentType,
  priceValue = 0.0042,
  submitStatus = 200,
  submitErrorBody = { message: "synthetic upstream failure" },
  retryAfterSec,
} = {}) {
  const captures = { submits: [], priceCalls: [], jobPolls: 0, modelCalls: 0 };
  const CT_BY_EXT = { png: "image/png", mp3: "audio/mpeg", mp4: "video/mp4" };
  const resultCT = resultContentType || CT_BY_EXT[resultExt] || "application/octet-stream";

  const server = http.createServer(async (req, res) => {
    const url = req.url;

    if (req.method === "GET" && url.startsWith("/api/v2/models")) {
      captures.modelCalls += 1;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({
        data: catalog,
        links: {},
        meta: { current_page: 1, last_page: 1, per_page: 25, total: catalog.length },
      }));
      return;
    }

    if (req.method === "GET" && url.startsWith("/api/v2/jobs/")) {
      captures.jobPolls += 1;
      const { port } = server.address();
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({
        data: {
          status: "done",
          result_url: `http://127.0.0.1:${port}/results/out.${resultExt}`,
          results_alt_formats: null,
          progress: 100,
          error_code: null,
          error_message: null,
          refunded: null,
          retryable: null,
        },
      }));
      return;
    }

    if (req.method === "GET" && url.startsWith("/results/")) {
      res.setHeader("content-type", resultCT);
      res.end(resultBytes);
      return;
    }

    if (req.method === "POST" && /\/price$/.test(url)) {
      const raw = await readBody(req);
      captures.priceCalls.push({ url, body: raw.length ? JSON.parse(raw.toString()) : {} });
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ data: { price: priceValue } }));
      return;
    }

    if (req.method === "POST" && url.startsWith("/api/v2/")) {
      const raw = await readBody(req);
      const contentType = req.headers["content-type"] || "";
      const entry = { url, body: null, form: null };
      if (contentType.includes("multipart/form-data")) {
        entry.form = parseMultipart(raw, contentType);
      } else if (raw.length) {
        try { entry.body = JSON.parse(raw.toString()); } catch { entry.body = null; }
      }
      captures.submits.push(entry);
      if (submitStatus !== 200) {
        res.statusCode = submitStatus;
        if (retryAfterSec != null) res.setHeader("Retry-After", String(retryAfterSec));
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify(submitErrorBody));
        return;
      }
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ data: { request_id: `req-${captures.submits.length}` } }));
      return;
    }

    res.statusCode = 404;
    res.end("not found");
  });

  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      resolve({ server, url: `http://127.0.0.1:${port}`, captures });
    });
  });
}
