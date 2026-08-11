// Shared HTTP plumbing for the deAPI v2 media API (https://deapi.ai).
//
// deAPI is the compute supplier behind every media capability in this
// fork; the per-capability clients (pai_image_client.js, etc.) keep
// their exported signatures but route here instead of the PAI media API.
//
// Surface used (contract: https://deapi.ai/llms.txt):
//
//   POST /api/v2/<resource>            async submit → { data: { request_id } }
//                                      (JSON or multipart/form-data per endpoint)
//   GET  /api/v2/jobs/{request_id}     polled until status done | error
//   POST /api/v2/<resource>/price      cost quote → { data: { price } }
//   GET  /api/v2/models                paginated catalog (25/page — always walk
//                                      meta.last_page; page size is fixed)
//
// Auth: Authorization: Bearer <DEAPI_KEY> + Accept: application/json.
// Base URL override: DEAPI_API_BASE (default https://api.deapi.ai).
//
// The error model carries `.klass` so _cli.js can tag failure banners.
// Mapping onto the repo's existing class vocabulary:
//
//   bad_args            HTTP 404 (bad request_id), 413 (payload too large),
//                       422 (validation — field errors joined into message);
//                       job error_code INVALID_INPUT / CONTEXT_LENGTH_EXCEEDED
//   infra               HTTP 401 (auth); job error_code PROCESSING_ERROR /
//                       UNKNOWN_ERROR (message carries refunded/retryable)
//   content_filtered    job error_code AGE_RESTRICTED
//   rate_limited        HTTP 429 (Retry-After parsed)
//   transient           HTTP 408/5xx, network blips; job WORKER_TIMEOUT
//   transient_exhausted re-tagged after the single retry also failed;
//                       also poll timeout
//
// One transient retry (2 attempts total) with 5s backoff, matching the
// old PAI client's policy. Multipart bodies are rebuilt per attempt.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { config as dotenvConfig } from "dotenv";

// Load .env defensively — library callers may import us before dotenv ran.
const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenvConfig({ path: path.resolve(__dirname, "..", ".env") });

const DEFAULT_BASE_URL = "https://api.deapi.ai";
const TRANSIENT_RETRY_BACKOFF_MS = 5_000;

export function deapiBaseUrl() {
  const fromEnv = String(process.env.DEAPI_API_BASE ?? "").trim().replace(/\/+$/, "");
  return fromEnv || DEFAULT_BASE_URL;
}

export function deapiToken() {
  const t = process.env.DEAPI_KEY;
  if (!t) throw err("infra", "DEAPI_KEY not set in env — get one at https://app.deapi.ai/dashboard/api-keys");
  return t;
}

export function err(klass, message, extra = {}) {
  const e = new Error(message);
  e.klass = klass;
  Object.assign(e, extra);
  return e;
}

// 422 bodies: { message, errors: { field: ["msg", ...], ... } }. Field
// message lists can repeat the same string — de-duplicate before joining.
function validationDetail(body) {
  const errors = body?.errors;
  if (!errors || typeof errors !== "object") return null;
  const parts = [];
  for (const [field, msgs] of Object.entries(errors)) {
    const list = Array.isArray(msgs) ? [...new Set(msgs.map(String))] : [String(msgs)];
    parts.push(`${field}: ${list.join(" ")}`);
  }
  return parts.length ? parts.join("; ") : null;
}

function responseErrorMessage(body) {
  const detail = validationDetail(body);
  const msg = typeof body?.message === "string" && body.message ? body.message : null;
  if (detail && msg && !msg.startsWith("The given data was invalid")) return `${msg} [${detail}]`;
  if (detail) return detail;
  return msg;
}

function classifyHttpFailure(status, errMsg, retryAfterSec) {
  if (status === 401) return err("infra", `deAPI 401 (auth): ${errMsg}`);
  if (status === 404) return err("bad_args", `deAPI 404: ${errMsg}`);
  if (status === 408) return err("transient", `deAPI 408 (timeout): ${errMsg}`);
  if (status === 413) return err("bad_args", `deAPI 413 (payload too large): ${errMsg}`);
  if (status === 422) return err("bad_args", `deAPI 422: ${errMsg}`);
  if (status === 429) {
    return err("rate_limited", `deAPI 429: ${errMsg}`, {
      retryAfterSec: Number.isFinite(retryAfterSec) ? retryAfterSec : null,
    });
  }
  if (status >= 400 && status < 500) return err("bad_args", `deAPI ${status}: ${errMsg}`);
  return err("transient", `deAPI ${status}: ${errMsg}`);
}

// Terminal job failure (status=error on GET /api/v2/jobs/{id}). error_code
// is the stable enum; error_message is free-form and carries the real
// detail. refunded/retryable are the fields to branch on — we surface
// them in the message so the agent can decide whether to resubmit.
export function classifyJobFailure(job) {
  const code = String(job?.error_code || "UNKNOWN_ERROR");
  const detail = job?.error_message || job?.error_reason || "no error details";
  const suffix = ` (refunded=${job?.refunded ?? "?"}, retryable=${job?.retryable ?? "?"})`;
  const msg = `deAPI job failed [${code}]: ${detail}${suffix}`;
  if (code === "AGE_RESTRICTED") return err("content_filtered", msg);
  if (code === "INVALID_INPUT" || code === "CONTEXT_LENGTH_EXCEEDED") return err("bad_args", msg);
  if (code === "WORKER_TIMEOUT") return err("transient", msg);
  return err("infra", msg);
}

function authHeaders(extra = {}) {
  return {
    Authorization: `Bearer ${deapiToken()}`,
    Accept: "application/json",
    ...extra,
  };
}

async function parseResponse(res, pathTag) {
  const rawBody = await res.text().catch(() => "");
  let parsed = null;
  try { parsed = rawBody ? JSON.parse(rawBody) : null; } catch { /* not JSON */ }

  if (!res.ok) {
    const errMsg = responseErrorMessage(parsed)
      || rawBody.slice(0, 300)
      || `HTTP ${res.status}`;
    const ra = parseInt(res.headers.get("retry-after") || "", 10);
    throw classifyHttpFailure(res.status, errMsg, ra);
  }
  if (parsed === null || typeof parsed !== "object") {
    throw err("transient", `deAPI ${pathTag} returned non-JSON 200: ${rawBody.slice(0, 200)}`);
  }
  return parsed;
}

async function fetchOnce({ url, options, timeoutMs, pathTag }) {
  const controller = new AbortController();
  const timer = timeoutMs ? setTimeout(() => controller.abort(), timeoutMs) : null;
  let res;
  try {
    res = await fetch(url, { ...options, signal: controller.signal });
  } catch (e) {
    if (e.name === "AbortError") {
      throw err("transient", `deAPI ${pathTag} aborted after ${timeoutMs}ms`);
    }
    throw err("transient", `Network error calling deAPI ${pathTag}: ${e.message}`);
  } finally {
    if (timer) clearTimeout(timer);
  }
  return parseResponse(res, pathTag);
}

function apiUrl(p) {
  return `${deapiBaseUrl()}/api/v2/${String(p).replace(/^\/+/, "")}`;
}

async function withTransientRetry({ logTag, attempt }) {
  try {
    return await attempt();
  } catch (e) {
    if (e.klass !== "transient") throw e;
    console.error(`[${logTag}] transient retry in ${TRANSIENT_RETRY_BACKOFF_MS / 1000}s: ${e.message.slice(0, 120)}`);
    await new Promise((r) => setTimeout(r, TRANSIENT_RETRY_BACKOFF_MS));
    try {
      return await attempt();
    } catch (e2) {
      if (e2.klass === "transient") {
        throw err("transient_exhausted", `${e2.message} (after 2 attempts)`);
      }
      throw e2;
    }
  }
}

/**
 * POST a JSON body to /api/v2/<path>. Returns the parsed response body.
 */
export async function postJson({ path: p, body, timeoutMs = 60_000, logTag = "deapi" }) {
  if (!body || typeof body !== "object") throw err("bad_args", "postJson: body object required");
  return withTransientRetry({
    logTag,
    attempt: () => fetchOnce({
      url: apiUrl(p),
      options: {
        method: "POST",
        headers: authHeaders({ "Content-Type": "application/json" }),
        body: JSON.stringify(body),
      },
      timeoutMs,
      pathTag: p,
    }),
  });
}

/**
 * POST multipart/form-data to /api/v2/<path>.
 *
 * @param {Object}   opts
 * @param {string}   opts.path
 * @param {object}   opts.fields  scalar form fields ({ name: value }); arrays
 *                                are appended once per element
 * @param {Array}    [opts.files] [{ field, filePath?, bytes?, filename?, contentType? }]
 *                                filePath is read per attempt (retry-safe)
 * @param {number}   [opts.timeoutMs=120_000]
 * @param {string}   [opts.logTag="deapi"]
 */
export async function postForm({ path: p, fields = {}, files = [], timeoutMs = 120_000, logTag = "deapi" }) {
  async function buildForm() {
    const form = new FormData();
    for (const [name, value] of Object.entries(fields)) {
      if (value === undefined || value === null) continue;
      if (Array.isArray(value)) {
        for (const v of value) form.append(name, String(v));
      } else {
        form.append(name, String(value));
      }
    }
    for (const f of files) {
      const bytes = f.bytes ?? await fs.promises.readFile(f.filePath);
      const filename = f.filename || (f.filePath ? path.basename(f.filePath) : "file.bin");
      const blob = new Blob([bytes], { type: f.contentType || "application/octet-stream" });
      form.append(f.field, blob, filename);
    }
    return form;
  }
  return withTransientRetry({
    logTag,
    attempt: async () => fetchOnce({
      url: apiUrl(p),
      // No explicit Content-Type — fetch derives the multipart boundary.
      options: { method: "POST", headers: authHeaders(), body: await buildForm() },
      timeoutMs,
      pathTag: p,
    }),
  });
}

export async function getJson({ path: p, timeoutMs = 30_000, logTag = "deapi" }) {
  return withTransientRetry({
    logTag,
    attempt: () => fetchOnce({
      url: apiUrl(p),
      options: { method: "GET", headers: authHeaders() },
      timeoutMs,
      pathTag: p,
    }),
  });
}

/**
 * Unwrap { data: { request_id } } from a submit response.
 */
export function requestIdOf(submitBody, pathTag = "submit") {
  const id = submitBody?.data?.request_id;
  if (typeof id !== "string" || !id) {
    throw err("infra", `deAPI ${pathTag} returned no request_id: ${JSON.stringify(submitBody).slice(0, 300)}`);
  }
  return id;
}

const TERMINAL_DONE = "done";
const TERMINAL_ERROR = "error";

/**
 * GET /api/v2/jobs/{request_id} — poll until terminal.
 *
 * Resolves with the job `data` object on status=done (result_url,
 * results_alt_formats, preview, ...). Throws via classifyJobFailure on
 * status=error. Any other status (pending/processing/in_progress/new
 * ones) is treated as non-terminal.
 *
 * result_url is a presigned URL that expires — download promptly.
 */
export async function pollJob(requestId, {
  intervalMs = 3_000,
  timeoutMs = 15 * 60_000,
  requestTimeoutMs = 30_000,
  onProgress,
  logTag = "deapi",
} = {}) {
  if (typeof requestId !== "string" || !requestId) throw err("bad_args", "pollJob: requestId required");
  // Test hook: DEAPI_POLL_INTERVAL_MS caps the poll cadence so unit
  // tests don't sleep multi-second intervals against mocked fetch.
  const envInterval = Number(process.env.DEAPI_POLL_INTERVAL_MS);
  if (Number.isFinite(envInterval) && envInterval > 0) {
    intervalMs = Math.min(intervalMs, envInterval);
  }
  const started = Date.now();
  let consecutiveTransient = 0;

  while (Date.now() - started < timeoutMs) {
    await new Promise((r) => setTimeout(r, intervalMs));
    let body;
    try {
      body = await getJson({
        path: `jobs/${encodeURIComponent(requestId)}`,
        timeoutMs: requestTimeoutMs,
        logTag,
      });
      consecutiveTransient = 0;
    } catch (e) {
      if (e.klass === "rate_limited") {
        // Job-status polling is rate-limited separately (50 RPM basic).
        // Back off for the advertised window instead of failing the job.
        const waitSec = Number.isFinite(e.retryAfterSec) ? e.retryAfterSec : 15;
        await new Promise((r) => setTimeout(r, waitSec * 1000));
        continue;
      }
      if (e.klass === "bad_args" || e.klass === "infra") throw e;
      consecutiveTransient++;
      if (consecutiveTransient >= 5) throw e;
      continue;
    }

    const job = body?.data ?? {};
    const status = String(job.status || "").toLowerCase();
    if (onProgress) {
      onProgress({
        status,
        progress: Number(job.progress) || 0,
        elapsedSec: (Date.now() - started) / 1000,
      });
    }
    if (status === TERMINAL_DONE) return job;
    if (status === TERMINAL_ERROR) throw classifyJobFailure(job);
  }
  throw err("transient_exhausted", `deAPI pollJob timed out after ${timeoutMs / 1000}s (request_id=${requestId})`);
}

/**
 * POST /api/v2/<resource>/price — exact cost quote before spending.
 * Returns a number (USD). Handles both { data: { price } } and the
 * unwrapped { price } shape. Quotes are advisory: /price validation is
 * looser than the real endpoint's, so a quote success does not
 * guarantee the submission passes.
 */
export async function quotePrice({ path: p, body, timeoutMs = 30_000, logTag = "deapi-price" }) {
  const resp = await postJson({ path: `${String(p).replace(/\/+$/, "")}/price`, body, timeoutMs, logTag });
  const price = resp?.data?.price ?? resp?.price;
  const n = Number(price);
  if (!Number.isFinite(n)) {
    throw err("infra", `deAPI price quote returned no numeric price: ${JSON.stringify(resp).slice(0, 200)}`);
  }
  return n;
}

// ── Model catalog ────────────────────────────────────────────────────
//
// The catalog is paginated at a fixed 25/page and account-scoped; walk
// every page. Cached in-process for 5 minutes per filter key — CLIs are
// one-shot processes, so this mostly saves the multi-call flows.

const MODELS_CACHE_TTL_MS = 5 * 60_000;
const modelsCache = new Map(); // filterKey → { ts, models }

// Test hook: clear the in-process catalog cache between tests.
export function __clearModelsCache() {
  modelsCache.clear();
}

export async function listModels({ inferenceTypes = null, logTag = "deapi-models" } = {}) {
  const filterKey = Array.isArray(inferenceTypes) ? inferenceTypes.join(",") : (inferenceTypes || "");
  const cached = modelsCache.get(filterKey);
  if (cached && Date.now() - cached.ts < MODELS_CACHE_TTL_MS) return cached.models;

  const models = [];
  let page = 1;
  for (;;) {
    const qs = new URLSearchParams({ page: String(page) });
    if (filterKey) qs.set("filter[inference_types]", filterKey);
    const body = await getJson({ path: `models?${qs}`, logTag });
    models.push(...(Array.isArray(body?.data) ? body.data : []));
    const lastPage = Number(body?.meta?.last_page) || page;
    if (page >= lastPage) break;
    page++;
  }
  modelsCache.set(filterKey, { ts: Date.now(), models });
  return models;
}

/**
 * Fetch one model's catalog entry by slug (info.limits is authoritative
 * for parameter ranges; info.features/defaults are optional keys).
 * Throws bad_args when the slug isn't visible to this account.
 */
export async function getModelEntry(slug, { logTag = "deapi-models" } = {}) {
  if (typeof slug !== "string" || !slug) throw err("bad_args", "getModelEntry: slug required");
  const models = await listModels({ logTag });
  const m = models.find((x) => x?.slug === slug);
  if (!m) {
    const known = models.map((x) => x.slug).join(", ");
    throw err("bad_args", `deAPI model "${slug}" not in this account's catalog. Available: ${known}`);
  }
  return m;
}

/**
 * Download a public URL to a Buffer (result_url payloads, local viewer
 * assets). Kept signature-compatible with the old pai_client export.
 */
export async function downloadUrlToBuffer(url, { timeoutMs = 120_000 } = {}) {
  if (typeof url !== "string" || !url) throw err("bad_args", "downloadUrlToBuffer: url required");
  const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw err("transient", `download ${res.status}: ${body.slice(0, 200)}`);
  }
  const buf = await res.arrayBuffer();
  return Buffer.from(buf);
}

/**
 * Download a job's result_url returning { bytes, mime }. mime comes from
 * the response Content-Type (presigned S3 URLs set it correctly); the
 * fallback is derived from the URL path extension.
 */
export async function downloadResult(url, { timeoutMs = 120_000 } = {}) {
  if (typeof url !== "string" || !url) throw err("bad_args", "downloadResult: url required");
  const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw err("transient", `result download ${res.status}: ${body.slice(0, 200)}`);
  }
  const buf = Buffer.from(await res.arrayBuffer());
  if (!buf.length) throw err("transient", "result download returned 0 bytes");
  let mime = String(res.headers.get("content-type") || "").split(";")[0].trim();
  if (!mime || mime === "application/octet-stream" || mime === "binary/octet-stream") {
    const ext = path.extname(new URL(url).pathname).toLowerCase();
    mime = {
      ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
      ".webp": "image/webp", ".mp4": "video/mp4", ".mp3": "audio/mpeg",
      ".wav": "audio/wav",
    }[ext] || "application/octet-stream";
  }
  return { bytes: buf, mime };
}

// ── Parameter derivation from model limits ──────────────────────────
//
// deAPI parameter ranges are model-specific and authoritative in
// info.limits (features flags are advisory). These helpers derive legal
// request values from a catalog entry rather than hardcoding them.

function clampNum(v, min, max) {
  let n = Number(v);
  if (!Number.isFinite(n)) n = min ?? 0;
  if (Number.isFinite(min) && n < min) n = min;
  if (Number.isFinite(max) && n > max) n = max;
  return n;
}

/**
 * Compute legal { width, height } for a model from an aspect ratio
 * string ("16:9") and a target long side in pixels, snapped to the
 * model's resolution_step and clamped into its min/max box.
 */
export function deriveDimensions(modelEntry, { aspectRatio = "16:9", longSide = 1024 } = {}) {
  const limits = modelEntry?.info?.limits ?? {};
  const step = Number(limits.resolution_step) || 64;
  const minW = Number(limits.min_width) || step;
  const maxW = Number(limits.max_width) || 4096;
  const minH = Number(limits.min_height) || step;
  const maxH = Number(limits.max_height) || 4096;

  const m = /^(\d+(?:\.\d+)?)\s*:\s*(\d+(?:\.\d+)?)$/.exec(String(aspectRatio).trim());
  const arW = m ? Number(m[1]) : 16;
  const arH = m ? Number(m[2]) : 9;
  const ratio = arW / arH; // width / height

  const snap = (v) => Math.round(v / step) * step;
  let width, height;
  if (ratio >= 1) {
    width = clampNum(snap(longSide), minW, maxW);
    height = clampNum(snap(width / ratio), minH, maxH);
  } else {
    height = clampNum(snap(longSide), minH, maxH);
    width = clampNum(snap(height * ratio), minW, maxW);
  }
  return { width, height };
}

/**
 * Pick legal steps for a model: explicit value clamped into
 * limits.min_steps/max_steps, else defaults.steps, else the range floor
 * (many deAPI models pin steps to a single value via min == max).
 */
export function deriveSteps(modelEntry, requested = null) {
  const limits = modelEntry?.info?.limits ?? {};
  const min = Number.isFinite(Number(limits.min_steps)) ? Number(limits.min_steps) : null;
  const max = Number.isFinite(Number(limits.max_steps)) ? Number(limits.max_steps) : null;
  const fallback = Number(modelEntry?.info?.defaults?.steps);
  // Number(null) is 0 — treat null/undefined as "not requested".
  let v = requested == null ? NaN : Number(requested);
  if (!Number.isFinite(v)) v = Number.isFinite(fallback) ? fallback : (min ?? 4);
  return clampNum(v, min ?? 1, max ?? v);
}
