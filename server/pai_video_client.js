// deAPI → video generation (capability id: video-generation).
//
// Three deAPI routes hide behind one submit call, picked from the refs:
//
//   no refs          → POST /api/v2/videos/generations   (JSON, txt2video)
//   1-2 image refs   → POST /api/v2/videos/animations    (multipart;
//                       first_frame_image + optional last_frame_image on
//                       models advertising supports_last_frame)
//   1 audio ref      → POST /api/v2/videos/audio-syncs   (multipart; the
//                       audio conditions the clip; image refs may ride
//                       along as first/last frame)
//
// Video refs are NOT supported by deAPI's video endpoints — callers get
// a clear bad_args instead of a silent drop.
//
// Refs are LOCAL FILE PATHS (from buildProviderRefs().absPath); deAPI
// takes the bytes as multipart uploads, so there is no preupload step
// and no tunnel dependency.
//
// width/height/frames/fps/steps are derived from the configured model's
// catalog entry (info.limits is authoritative; several models pin fps
// or steps to a single legal value). duration is converted to frames at
// the model's fps and clamped into min/max_frames — the effective clip
// length can therefore differ from the requested duration; the submit
// result reports the effective plan.
//
// Two exported functions split the submit / poll flow:
//
//   submitVideo({ ... })    → returns { taskId, raw, costUsd, effective }
//   pollVideo(taskId, opts) → polls /api/v2/jobs/{id} to terminal,
//                             returns { videoUrl, raw, durationSeconds }
//
// The resolved MP4 is fetched by the caller (generate_video.js) via
// local_mirror.js's streamUrlToTmp. NOTE: the presigned result_url
// expires — stream it promptly after pollVideo resolves.

import fs from "node:fs";
import {
  postJson,
  postForm,
  pollJob,
  requestIdOf,
  quotePrice,
  getModelEntry,
  deriveDimensions,
  deriveSteps,
  err,
} from "./deapi_client.js";
import { getDefault } from "./model_registry.js";

const SUBMIT_TIMEOUT_MS = 120_000;
const POLL_INTERVAL_MS = 5_000;
const POLL_TIMEOUT_MS = 30 * 60_000;

const RES_TO_HEIGHT = { "480p": 480, "720p": 720, "1080p": 1080 };

function validatePaths(paths, kind) {
  const list = Array.isArray(paths)
    ? paths.filter((p) => typeof p === "string" && p.trim() !== "")
    : [];
  for (const p of list) {
    if (/^(https?:|data:)/i.test(p)) {
      throw err("bad_args", `submitVideo: ${kind} refs must be local file paths, got "${p.slice(0, 60)}"`);
    }
    if (!fs.existsSync(p)) throw err("bad_args", `submitVideo: ${kind} ref file not found: ${p}`);
  }
  return list;
}

// Derive the full legal parameter set for this generation from the
// model's catalog entry.
function deriveVideoPlan(modelEntry, { aspectRatio, resolution, duration }) {
  const limits = modelEntry?.info?.limits ?? {};
  const defaults = modelEntry?.info?.defaults ?? {};

  const targetH = RES_TO_HEIGHT[String(resolution || "720p").toLowerCase()] ?? 720;
  const m = /^(\d+(?:\.\d+)?)\s*:\s*(\d+(?:\.\d+)?)$/.exec(String(aspectRatio || "16:9").trim());
  const ratio = m ? Number(m[1]) / Number(m[2]) : 16 / 9;
  const longSide = ratio >= 1 ? Math.round(targetH * ratio) : targetH;
  const { width, height } = deriveDimensions(modelEntry, { aspectRatio, longSide });

  // fps is usually pinned (min == max); prefer defaults, then the floor.
  const fps = Number(defaults.fps)
    || Number(limits.min_fps)
    || Number(limits.max_fps)
    || 24;
  const wantFrames = Math.round((Number(duration) || 5) * fps);
  const minFrames = Number(limits.min_frames) || 1;
  const maxFrames = Number(limits.max_frames) || wantFrames;
  const frames = Math.min(Math.max(wantFrames, minFrames), maxFrames);

  // Some models (Ltx2_3_22B_Dist_INT8) require steps >= 8 while
  // advertising supports_steps: false — limits stay authoritative, with
  // 8 as the fallback floor when the catalog is silent.
  const steps = deriveSteps(modelEntry, Number(defaults.steps) || 8);
  const guidance = Number(defaults.guidance) || 3;

  return {
    width,
    height,
    fps,
    frames,
    steps,
    guidance,
    effectiveDurationSec: +(frames / fps).toFixed(2),
  };
}

// /price validates prompt + seed alongside the cost-driving numbers,
// so callers quote with the exact body they are about to submit.
async function quoteOrNull(pricePath, body, logTag) {
  try {
    return await quotePrice({ path: pricePath, body, logTag });
  } catch (e) {
    console.error(`[${logTag}] price quote failed (continuing without): ${e.message.slice(0, 120)}`);
    return null;
  }
}

/**
 * Submit a video generation task. Returns immediately with a job id.
 *
 * @param {Object}    opts
 * @param {string}    opts.prompt
 * @param {number}    [opts.duration=5]      requested seconds; clamped to
 *                                           the model's frame budget
 * @param {string}    [opts.aspectRatio="16:9"]
 * @param {string}    [opts.resolution="720p"]
 * @param {boolean}   [opts.generateAudio=true]  accepted for CLI
 *                                           compatibility; audio comes
 *                                           from the model/route, not a
 *                                           toggle, on deAPI
 * @param {string[]}  [opts.imageRefPaths=[]]  0-2 local image files
 *                                           (first frame, optional last)
 * @param {string[]}  [opts.audioRefPaths=[]]  0-1 local audio file
 *                                           (routes to audio-syncs)
 * @param {string[]}  [opts.videoRefPaths=[]]  must be empty — rejected
 *
 * @returns {Promise<{ taskId: string, raw: object, costUsd: number|null,
 *                     effective: object }>}
 *
 * @throws  classified Error (.klass): bad_args / rate_limited / infra /
 *          transient / transient_exhausted
 */
export async function submitVideo({
  prompt,
  duration = 5,
  aspectRatio = "16:9",
  resolution = "720p",
  generateAudio = true, // eslint-disable-line no-unused-vars
  imageRefPaths = [],
  audioRefPaths = [],
  videoRefPaths = [],
} = {}) {
  if (typeof prompt !== "string" || !prompt.trim()) {
    throw err("bad_args", "submitVideo: empty prompt");
  }
  const images = validatePaths(imageRefPaths, "image");
  const audios = validatePaths(audioRefPaths, "audio");
  const videos = validatePaths(videoRefPaths, "video");

  if (videos.length > 0) {
    throw err("bad_args",
      "submitVideo: deAPI video generation does not accept video refs — "
      + "use image refs (first/last frame) or an audio ref, or extract a frame via extract_frames.js.");
  }
  if (audios.length > 1) {
    throw err("bad_args", `submitVideo: at most 1 audio ref (got ${audios.length})`);
  }
  if (images.length > 2) {
    throw err("bad_args",
      `submitVideo: at most 2 image refs — first frame + optional last frame (got ${images.length})`);
  }

  const registryEntry = getDefault("video");
  const modelEntry = await getModelEntry(registryEntry.deapi_slug, { logTag: "deapi-video" });
  const inferenceTypes = Array.isArray(modelEntry?.inference_types) ? modelEntry.inference_types : [];
  const supportsLastFrame = modelEntry?.info?.features?.supports_last_frame === true;
  if (images.length === 2 && !supportsLastFrame) {
    throw err("bad_args",
      `submitVideo: model ${modelEntry.slug} does not advertise last-frame support — pass a single image ref`);
  }

  const plan = deriveVideoPlan(modelEntry, { aspectRatio, resolution, duration });
  const numericParams = {
    model: modelEntry.slug,
    width: plan.width,
    height: plan.height,
    guidance: plan.guidance,
    steps: plan.steps,
    frames: plan.frames,
    fps: plan.fps,
  };

  let route;
  let submitted;
  let costUsd;
  if (audios.length === 1) {
    route = "videos/audio-syncs";
    if (!inferenceTypes.includes("audio2video")) {
      throw err("bad_args",
        `submitVideo: model ${modelEntry.slug} does not support audio-conditioned video (audio2video). `
        + "Set DEAPI_VIDEO_MODEL to a model that does, or drop the audio ref.");
    }
    costUsd = await quoteOrNull(route, { prompt, seed: -1, ...numericParams }, "deapi-video");
    const files = [{ field: "audio", filePath: audios[0] }];
    if (images[0]) files.push({ field: "first_frame_image", filePath: images[0] });
    if (images[1]) files.push({ field: "last_frame_image", filePath: images[1] });
    submitted = await postForm({
      path: route,
      fields: { prompt, seed: -1, ...numericParams },
      files,
      timeoutMs: SUBMIT_TIMEOUT_MS,
      logTag: "deapi-video",
    });
  } else if (images.length >= 1) {
    route = "videos/animations";
    if (!inferenceTypes.includes("img2video")) {
      throw err("bad_args",
        `submitVideo: model ${modelEntry.slug} does not support image-to-video (img2video). `
        + "Set DEAPI_VIDEO_MODEL to a model that does, or drop the image refs.");
    }
    costUsd = await quoteOrNull(route, { prompt, seed: -1, ...numericParams }, "deapi-video");
    const files = [{ field: "first_frame_image", filePath: images[0] }];
    if (images[1]) files.push({ field: "last_frame_image", filePath: images[1] });
    submitted = await postForm({
      path: route,
      fields: { prompt, seed: -1, ...numericParams },
      files,
      timeoutMs: SUBMIT_TIMEOUT_MS,
      logTag: "deapi-video",
    });
  } else {
    route = "videos/generations";
    if (!inferenceTypes.includes("txt2video")) {
      throw err("bad_args",
        `submitVideo: model ${modelEntry.slug} does not support text-to-video (txt2video). `
        + "Set DEAPI_VIDEO_MODEL to a model that does, or add an image ref.");
    }
    costUsd = await quoteOrNull(route, { prompt, seed: -1, ...numericParams }, "deapi-video");
    submitted = await postJson({
      path: route,
      body: { prompt, seed: -1, ...numericParams },
      timeoutMs: SUBMIT_TIMEOUT_MS,
      logTag: "deapi-video",
    });
  }

  const taskId = requestIdOf(submitted, route);
  return {
    taskId,
    raw: submitted,
    costUsd,
    effective: { route, model: modelEntry.slug, ...plan },
  };
}

/**
 * Poll a submitted video task to terminal state.
 *
 * @param {string}   taskId    request_id from submitVideo
 * @param {Object}   [opts]
 * @param {function} [opts.onProgress]  ({ status, progress, elapsedSec })
 *
 * @returns {Promise<{ videoUrl: string, raw: object, durationSeconds: number }>}
 *          videoUrl is a presigned URL that EXPIRES — download promptly.
 *
 * @throws  classified Error: content_filtered / bad_args / infra /
 *          rate_limited / transient_exhausted (see deapi_client.js)
 */
export async function pollVideo(taskId, { onProgress } = {}) {
  const started = Date.now();
  const job = await pollJob(taskId, {
    intervalMs: POLL_INTERVAL_MS,
    timeoutMs: POLL_TIMEOUT_MS,
    onProgress,
    logTag: "deapi-video",
  });
  if (typeof job?.result_url !== "string" || !job.result_url) {
    throw err("infra", `deAPI video job ${taskId} finished with no result_url`);
  }
  return {
    videoUrl: job.result_url,
    raw: job,
    durationSeconds: (Date.now() - started) / 1000,
  };
}
