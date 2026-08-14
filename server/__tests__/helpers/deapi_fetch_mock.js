// Shared fetch mock for deAPI client unit tests.
//
// Installs a globalThis.fetch replacement plus DEAPI_* env, records every
// request, and answers with sensible defaults so a test only overrides
// the route it cares about:
//
//   GET  /api/v2/models          → one-page catalog (DEFAULT_CATALOG)
//   POST /api/v2/**/price        → { data: { price: 0.0042 } }
//   POST /api/v2/<generation>    → { data: { request_id: "req-1" } }
//   GET  /api/v2/jobs/:id        → done + result_url on results host
//   GET  https://results.deapi.test/** → PNG_BYTES with image/png
//
// Usage:
//   const calls = installDeapiFetch(t, {
//     handler(entry) {
//       if (entry.url.endsWith("/api/v2/images/generations")) return jsonResponse({...});
//       return undefined; // fall through to defaults
//     },
//   });
//
// Recorded entry shape: { url, method, body (parsed JSON | null),
// form (plain object for FormData posts; file fields become
// { filename, type, size }) }.

import { __clearModelsCache } from "../../deapi_client.js";

export const PNG_BYTES = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
export const RESULTS_HOST = "https://results.deapi.test";
export const DEFAULT_RESULT_URL = `${RESULTS_HOST}/out.png?X-Amz-Signature=test`;

export const DEFAULT_CATALOG = [
  {
    name: "FLUX.1 Schnell", slug: "Flux1schnell",
    inference_types: ["txt2img"], tags: [], status: "standard_model",
    info: {
      limits: { min_width: 256, max_width: 2048, min_height: 256, max_height: 2048, min_steps: 1, max_steps: 10, resolution_step: 128 },
      features: { supports_steps: true, supports_negative_prompt: true },
      defaults: { width: 768, height: 768, steps: 4 },
    },
  },
  {
    name: "FLUX.2 Klein 4B", slug: "Flux_2_Klein_4B_BF16",
    inference_types: ["txt2img", "img2img"], tags: [], status: "standard_model",
    info: {
      limits: { min_width: 256, max_width: 1536, min_height: 256, max_height: 1536, min_steps: 4, max_steps: 4, resolution_step: 16, max_input_images: 3 },
      features: { supports_steps: true, supports_custom_output_size: true },
      defaults: { steps: 4 },
    },
  },
  {
    name: "Qwen Image Edit Plus", slug: "QwenImageEdit_Plus_NF4",
    inference_types: ["img2img"], tags: [], status: "standard_model",
    info: {
      limits: { min_width: 256, max_width: 2048, min_height: 256, max_height: 2048, min_steps: 1, max_steps: 50, resolution_step: 16, max_input_images: 3 },
      features: { supports_steps: true },
      defaults: { steps: 40 },
    },
  },
  {
    name: "LTX-2 3.22B Distilled", slug: "Ltx2_3_22B_Dist_INT8",
    inference_types: ["txt2video", "img2video", "audio2video"], tags: [], status: "standard_model",
    info: {
      limits: { min_width: 256, max_width: 1536, min_height: 256, max_height: 1536, min_steps: 8, max_steps: 40, resolution_step: 32, min_frames: 9, max_frames: 241, min_fps: 24, max_fps: 24 },
      features: { supports_last_frame: true },
      defaults: { steps: 8, fps: 24 },
    },
  },
  {
    // Real limits read off the live catalogue on 2026-08-14. Width and height
    // are PINNED, which is the shape the plan has to cope with.
    name: "MiniMax H3 33B Turbo", slug: "MiniMaxH3_33B_Turbo_INT8",
    inference_types: ["txt2video", "img2video"], tags: [], status: "standard_model",
    info: {
      limits: { min_width: 1344, max_width: 1344, min_height: 768, max_height: 768, min_steps: 8, max_steps: 8, min_frames: 56, max_frames: 243, min_fps: 24, max_fps: 24 },
      features: { supports_last_frame: true },
      defaults: { steps: 8, fps: 24 },
    },
  },
  {
    name: "Kokoro", slug: "Kokoro",
    inference_types: ["txt2audio"], tags: [], status: "standard_model",
    info: {
      limits: { min_text: 3, max_text: 10001, min_speed: 0.5, max_speed: 2, available_ratios: [24000], output_formats: ["mp3"] },
    },
    languages: [
      {
        name: "English (US)", slug: "en-us",
        voices: [{ name: "Sky", slug: "af_sky", gender: "female" }],
      },
    ],
  },
  {
    name: "Qwen3 TTS 12Hz 1.7B VoiceDesign", slug: "Qwen3_TTS_12Hz_1_7B_VoiceDesign",
    inference_types: ["txt2audio"], tags: [], status: "standard_model",
    info: {
      limits: { min_text: 10, max_text: 5000, min_speed: 1, max_speed: 1, available_ratios: [24000], output_formats: ["mp3"] },
      features: { supports_voice_design: true, supports_voice_clone: false, supports_custom_voice: false },
    },
    languages: [
      { name: "English", slug: "English", voices: [] },
    ],
  },
  {
    name: "FlashVSR Tiny", slug: "FlashVSR_Tiny",
    inference_types: ["vid-upscale"], tags: [], status: "standard_model",
    info: {
      limits: { min_scale: 2, max_scale: 4, min_width: 64, max_width: 1920, min_height: 64, max_height: 1920, max_video_duration_seconds: 60 },
    },
  },
];

export function jsonResponse(body, status = 200, headers = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  });
}

export function bytesResponse(bytes = PNG_BYTES, contentType = "image/png") {
  return new Response(bytes, { status: 200, headers: { "Content-Type": contentType } });
}

export function doneJob(overrides = {}) {
  return {
    data: {
      status: "done",
      preview: null,
      result_url: DEFAULT_RESULT_URL,
      results_alt_formats: null,
      result: null,
      progress: 100,
      error_code: null,
      error_message: null,
      refunded: null,
      retryable: null,
      ...overrides,
    },
  };
}

export function errorJob(overrides = {}) {
  return {
    data: {
      status: "error",
      result_url: null,
      progress: 0,
      error_code: "PROCESSING_ERROR",
      error_message: "Error during inference processing",
      refunded: true,
      retryable: false,
      ...overrides,
    },
  };
}

async function formToPlain(form) {
  const out = {};
  for (const [key, value] of form.entries()) {
    let v;
    if (typeof value === "string") {
      v = value;
    } else {
      v = { filename: value.name, type: value.type, size: (await value.arrayBuffer()).byteLength };
    }
    if (key in out) {
      out[key] = Array.isArray(out[key]) ? [...out[key], v] : [out[key], v];
    } else {
      out[key] = v;
    }
  }
  return out;
}

/**
 * Install the mock. Returns the recorded calls array.
 *
 * @param {object} t        node:test context (uses t.after for cleanup)
 * @param {object} [opts]
 * @param {function} [opts.handler]  (entry) => Response | undefined —
 *                                   undefined falls through to defaults
 * @param {Array}   [opts.catalog=DEFAULT_CATALOG]
 * @param {object}  [opts.env]       extra env vars to set for the test
 */
export function installDeapiFetch(t, { handler, catalog = DEFAULT_CATALOG, env = {} } = {}) {
  const priorFetch = globalThis.fetch;
  const priorEnv = {};
  const setEnv = {
    DEAPI_KEY: "dpn-sk-test",
    DEAPI_API_BASE: "https://deapi.test",
    DEAPI_POLL_INTERVAL_MS: "5",
    ...env,
  };
  for (const [k, v] of Object.entries(setEnv)) {
    priorEnv[k] = process.env[k];
    process.env[k] = v;
  }
  __clearModelsCache();
  const calls = [];

  globalThis.fetch = async (url, opts = {}) => {
    const u = String(url);
    const entry = { url: u, method: opts.method || "GET", body: null, form: null };
    if (typeof opts.body === "string") {
      try { entry.body = JSON.parse(opts.body); } catch { /* not JSON */ }
    } else if (opts.body instanceof FormData) {
      entry.form = await formToPlain(opts.body);
    }
    calls.push(entry);

    if (handler) {
      const resp = await handler(entry);
      if (resp !== undefined) return resp;
    }

    // Defaults
    if (u.includes("/api/v2/models")) {
      return jsonResponse({
        data: catalog,
        links: {},
        meta: { current_page: 1, last_page: 1, per_page: 25, total: catalog.length },
      });
    }
    if (/\/api\/v2\/.+\/price$/.test(u)) {
      return jsonResponse({ data: { price: 0.0042 } });
    }
    if (u.includes("/api/v2/jobs/")) {
      return jsonResponse(doneJob());
    }
    if (u.startsWith(RESULTS_HOST)) {
      return bytesResponse();
    }
    if (u.startsWith("https://deapi.test/api/v2/")) {
      return jsonResponse({ data: { request_id: "req-1" } });
    }
    throw new Error(`deapi_fetch_mock: unhandled URL ${u}`);
  };

  t.after(() => {
    globalThis.fetch = priorFetch;
    for (const [k, v] of Object.entries(priorEnv)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    __clearModelsCache();
  });

  return calls;
}
