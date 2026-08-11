// deAPI → video upscaling (capability id: video-upscale).
//
// Flow (much simpler than the old PAI upscale-create/accept/complete
// staging — deAPI takes the source bytes inline):
//
//   quoteUpscale({ sourceSpec })  POST /api/v2/videos/upscales/price
//                                 (JSON: width/height/duration/scale)
//                                 → { costUsd, scale, modelSlug }
//   submitUpscale({ filePath })   POST /api/v2/videos/upscales
//                                 (multipart: video file + model + scale)
//                                 → { taskId }
//   pollUpscale(taskId)           GET /api/v2/jobs/{id} to terminal
//                                 → { videoUrl, raw, durationSeconds }
//
// The upscale factor is derived from the source resolution against a 4K
// (3840 long side) target, clamped into the model's min/max_scale;
// fixed-factor models (min/max_scale null) reject the scale parameter,
// so it is omitted for them. deAPI's price scales linearly with
// duration — the quote always passes the real source duration.
//
// Input caps (deAPI): video file ≤ 50 MB; duration ≤ the model's
// max_video_duration_seconds when advertised.

import fs from "node:fs";
import {
  postForm,
  pollJob,
  requestIdOf,
  quotePrice,
  getModelEntry,
  err,
} from "./deapi_client.js";
import { getDefault } from "./model_registry.js";

const SUBMIT_TIMEOUT_MS = 10 * 60_000; // multipart upload of up to 50MB
const POLL_INTERVAL_MS = 5_000;
const POLL_TIMEOUT_MS = 45 * 60_000;
const MAX_SOURCE_BYTES = 50 * 1024 * 1024;
const TARGET_LONG_SIDE = 3840;

function upscaleModelSlug() {
  return getDefault("upscale").deapi_slug;
}

// Model id stamped on canvas nodes / pending sidecars (registry id, not
// the deAPI slug — slugs are env-configurable).
export const UPSCALE_MODEL_ID = getDefault("upscale").id;

function deriveScale(modelEntry, sourceSpec) {
  const limits = modelEntry?.info?.limits ?? {};
  const minScale = limits.min_scale;
  const maxScale = limits.max_scale;
  // null min/max ⇒ fixed-factor model; sending scale is a 422.
  if (minScale == null || maxScale == null) return null;
  const longSide = Math.max(Number(sourceSpec.width) || 0, Number(sourceSpec.height) || 0);
  if (!longSide) return Number(minScale);
  const want = Math.round(TARGET_LONG_SIDE / longSide);
  return Math.min(Math.max(want, Number(minScale)), Number(maxScale));
}

function validateSourceSpec(modelEntry, sourceSpec) {
  const limits = modelEntry?.info?.limits ?? {};
  const maxDur = Number(limits.max_video_duration_seconds);
  if (Number.isFinite(maxDur) && maxDur > 0 && Number(sourceSpec.duration) > maxDur) {
    throw err("bad_args",
      `upscale source is ${sourceSpec.duration}s; model ${modelEntry.slug} caps at ${maxDur}s. `
      + "Split the clip (extract/segment) and upscale the parts.");
  }
  if (Number(sourceSpec.size) > MAX_SOURCE_BYTES) {
    throw err("bad_args",
      `upscale source is ${(sourceSpec.size / 1024 / 1024).toFixed(1)}MB; deAPI caps uploads at 50MB.`);
  }
}

/**
 * Quote the exact upscale cost before spending.
 *
 * @param {Object} opts
 * @param {object} opts.sourceSpec  { width, height, duration, size } from ffprobe
 * @returns {Promise<{ costUsd: number|null, scale: number|null, modelSlug: string }>}
 */
export async function quoteUpscale({ sourceSpec } = {}) {
  if (!sourceSpec || typeof sourceSpec !== "object") {
    throw err("bad_args", "quoteUpscale: sourceSpec required");
  }
  const slug = upscaleModelSlug();
  const modelEntry = await getModelEntry(slug, { logTag: "deapi-upscale" });
  validateSourceSpec(modelEntry, sourceSpec);
  const scale = deriveScale(modelEntry, sourceSpec);
  let costUsd = null;
  try {
    costUsd = await quotePrice({
      path: "videos/upscales",
      body: {
        model: slug,
        width: Math.round(sourceSpec.width),
        height: Math.round(sourceSpec.height),
        duration: Math.max(1, Math.round(sourceSpec.duration)),
        ...(scale != null ? { scale } : {}),
      },
      logTag: "deapi-upscale",
    });
  } catch (e) {
    // bad_args from the price endpoint predicts a submit rejection —
    // surface it; transient/infra quote failures shouldn't block staging.
    if (e.klass === "bad_args") throw e;
    console.error(`[deapi-upscale] price quote failed (continuing without): ${e.message.slice(0, 120)}`);
  }
  return { costUsd, scale, modelSlug: slug };
}

/**
 * Submit the upscale job (uploads the source file inline).
 *
 * @param {Object} opts
 * @param {string} opts.filePath   absolute path of the source video
 * @param {object} opts.sourceSpec { width, height, duration, size }
 * @returns {Promise<{ taskId: string, scale: number|null, raw: object }>}
 */
export async function submitUpscale({ filePath, sourceSpec } = {}) {
  if (typeof filePath !== "string" || !filePath) throw err("bad_args", "submitUpscale: filePath required");
  if (!fs.existsSync(filePath)) throw err("bad_args", `submitUpscale: source file not found: ${filePath}`);
  const slug = upscaleModelSlug();
  const modelEntry = await getModelEntry(slug, { logTag: "deapi-upscale" });
  validateSourceSpec(modelEntry, sourceSpec ?? { size: fs.statSync(filePath).size });
  const scale = sourceSpec ? deriveScale(modelEntry, sourceSpec) : null;

  const submitted = await postForm({
    path: "videos/upscales",
    fields: {
      model: slug,
      ...(scale != null ? { scale } : {}),
    },
    files: [{ field: "video", filePath, contentType: "video/mp4" }],
    timeoutMs: SUBMIT_TIMEOUT_MS,
    logTag: "deapi-upscale",
  });
  return { taskId: requestIdOf(submitted, "videos/upscales"), scale, raw: submitted };
}

/**
 * Poll an upscale job to terminal state.
 *
 * @returns {Promise<{ videoUrl: string, raw: object, durationSeconds: number }>}
 *          videoUrl is a presigned URL that EXPIRES — download promptly.
 */
export async function pollUpscale(taskId, { onProgress } = {}) {
  const started = Date.now();
  const job = await pollJob(taskId, {
    intervalMs: POLL_INTERVAL_MS,
    timeoutMs: POLL_TIMEOUT_MS,
    onProgress,
    logTag: "deapi-upscale",
  });
  if (typeof job?.result_url !== "string" || !job.result_url) {
    throw err("infra", `deAPI upscale job ${taskId} finished with no result_url`);
  }
  return {
    videoUrl: job.result_url,
    raw: job,
    durationSeconds: (Date.now() - started) / 1000,
  };
}
