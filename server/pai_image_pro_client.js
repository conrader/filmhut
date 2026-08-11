// deAPI → pro image tier (capability id: image-generation-pro).
//
// The user-facing capability and returned metadata.model stay
// `image-generation-pro`; internally the request routes to deAPI's
// POST /api/v2/images/generations (no refs, JSON) or
// POST /api/v2/images/edits (refs, multipart with local files).
//
// The pro tier differs from the standard tier by model slug (see
// model_registry.js: deapi_slug / deapi_edit_slug on the image_pro
// entry) and by running edits at the edit model's own default steps
// (higher-quality, ~2× the standard tier's step count) instead of the
// standard tier's cost-reduced step override.
//
// The `size` vocabulary ("1024x1024", "2560x1440", ...) is preserved
// from the PAI contract for CLI/skill compatibility; sizes are snapped
// and clamped into the selected deAPI model's limits, so the exact
// output size can differ from the requested one on models with a
// smaller max resolution.
//
// jpeg output uses the job's results_alt_formats.jpg URL when deAPI
// provides one; otherwise the primary result is returned as-is.

import fs from "node:fs";
import {
  postJson,
  postForm,
  pollJob,
  requestIdOf,
  quotePrice,
  getModelEntry,
  downloadResult,
  deriveSteps,
  err,
} from "./deapi_client.js";
import { getDefault } from "./model_registry.js";
import {
  IMAGE_PRO_DEFAULT_SIZE,
  IMAGE_PRO_MAX_IMAGE_REFS,
  aspectRatioForImageProSize,
  imageProSizeTier,
  normalizeImageProOutputFormat,
} from "./image_pro_sizes.js";

const SUBMIT_TIMEOUT_MS = 60_000;
const POLL_TIMEOUT_MS = 15 * 60_000;

function validatePrompt(prompt) {
  if (typeof prompt !== "string" || !prompt.trim()) {
    throw err("bad_args", "generateImagePro: prompt required");
  }
  return prompt;
}

function validateSize(size) {
  const value = String(size || IMAGE_PRO_DEFAULT_SIZE);
  const tier = imageProSizeTier(value);
  if (!tier) {
    throw err("bad_args", `generateImagePro: unsupported size "${value}"`);
  }
  return { size: value, imageSize: tier, aspectRatio: aspectRatioForImageProSize(value) };
}

function validateOutputFormat(outputFormat) {
  const normalized = normalizeImageProOutputFormat(outputFormat || "png");
  if (!normalized) {
    throw err("bad_args", `generateImagePro: unsupported output_format "${outputFormat}"`);
  }
  return normalized;
}

function validateRefPaths(refImagePaths) {
  const refs = Array.isArray(refImagePaths)
    ? refImagePaths.filter((p) => typeof p === "string" && p.trim() !== "").map((p) => p.trim())
    : [];
  if (refs.length > IMAGE_PRO_MAX_IMAGE_REFS) {
    throw err("bad_args", `generateImagePro: reference cap exceeded ${refs.length} > ${IMAGE_PRO_MAX_IMAGE_REFS}`);
  }
  for (const p of refs) {
    if (/^(https?:|data:)/i.test(p)) {
      throw err(
        "bad_args",
        `generateImagePro expects local file paths for refs, got "${p.slice(0, 60)}" — `
        + "resolve refs through buildProviderRefs() and pass absPath.",
      );
    }
    if (!fs.existsSync(p)) {
      throw err("bad_args", `image ref file not found: ${p}`);
    }
  }
  return refs;
}

// Snap the exact requested size into the model's legal box. Pro sizes
// are already multiples of common steps; clamping only bites on models
// whose max resolution is below the requested tier.
function fitSizeToModel(modelEntry, size) {
  const [w, h] = String(size).split("x").map(Number);
  const limits = modelEntry?.info?.limits ?? {};
  const step = Number(limits.resolution_step) || 16;
  const clamp = (v, min, max) => Math.min(Math.max(v, min || step), max || v);
  const snap = (v) => Math.max(step, Math.round(v / step) * step);
  return {
    width: snap(clamp(w, Number(limits.min_width), Number(limits.max_width))),
    height: snap(clamp(h, Number(limits.min_height), Number(limits.max_height))),
  };
}

async function quoteOrNull(quote) {
  try {
    return await quote();
  } catch (e) {
    console.error(`[deapi-image-pro] price quote failed (continuing without): ${e.message.slice(0, 120)}`);
    return null;
  }
}

/**
 * Generate one image via deAPI's pro-tier routing.
 *
 * @param {Object}   opts
 * @param {string}   opts.prompt
 * @param {string}   [opts.size="1024x1024"] exact size from the pro vocabulary
 * @param {string}   [opts.outputFormat="png"] "png" or "jpeg"
 * @param {string[]} [opts.refImagePaths] absolute local paths of ref images
 * @returns {Promise<{
 *   bytes: Buffer,
 *   mime: string,
 *   model: string,
 *   size: string,
 *   imageSize: string,
 *   aspectRatio: string,
 *   durationSeconds: number,
 *   costUsd: number|null
 * }>}
 */
export async function generateImagePro({
  prompt,
  size = IMAGE_PRO_DEFAULT_SIZE,
  outputFormat = "png",
  refImagePaths = [],
} = {}) {
  const promptText = validatePrompt(prompt);
  const sizeInfo = validateSize(size);
  const normalizedFormat = validateOutputFormat(outputFormat);
  const refs = validateRefPaths(refImagePaths);

  const registryEntry = getDefault("image_pro");
  const slug = refs.length > 0 ? registryEntry.deapi_edit_slug : registryEntry.deapi_slug;
  const modelEntry = await getModelEntry(slug, { logTag: "deapi-image-pro" });
  const { width, height } = fitSizeToModel(modelEntry, sizeInfo.size);
  // Pro tier runs at the model's own default step count (quality over
  // cost) — deriveSteps falls back to info.defaults.steps.
  const steps = deriveSteps(modelEntry);
  const maxRefs = Number(modelEntry?.info?.limits?.max_input_images) || 1;
  if (refs.length > maxRefs) {
    throw err("bad_args", `generateImagePro: model ${slug} accepts at most ${maxRefs} ref image(s), got ${refs.length}`);
  }

  const started = Date.now();
  let requestId;
  let costUsd;
  if (refs.length === 0) {
    costUsd = await quoteOrNull(() => quotePrice({
      path: "images/generations",
      body: { model: slug, width, height, steps },
      logTag: "deapi-image-pro",
    }));
    const submitted = await postJson({
      path: "images/generations",
      body: { prompt: promptText, model: slug, width, height, steps, seed: -1 },
      timeoutMs: SUBMIT_TIMEOUT_MS,
      logTag: "deapi-image-pro",
    });
    requestId = requestIdOf(submitted, "images/generations");
  } else {
    costUsd = await quoteOrNull(() => quotePrice({
      path: "images/edits",
      body: { model: slug, steps, width, height },
      logTag: "deapi-image-pro",
    }));
    const files = refs.length === 1
      ? [{ field: "image", filePath: refs[0] }]
      : refs.map((p) => ({ field: "images[]", filePath: p }));
    const submitted = await postForm({
      path: "images/edits",
      fields: { prompt: promptText, model: slug, seed: -1, steps, width, height },
      files,
      timeoutMs: SUBMIT_TIMEOUT_MS,
      logTag: "deapi-image-pro",
    });
    requestId = requestIdOf(submitted, "images/edits");
  }

  const job = await pollJob(requestId, {
    timeoutMs: POLL_TIMEOUT_MS,
    logTag: "deapi-image-pro",
  });
  if (typeof job?.result_url !== "string" || !job.result_url) {
    throw err("infra", `deAPI image-pro job ${requestId} finished with no result_url`);
  }
  const resultUrl = normalizedFormat === "jpeg" && typeof job?.results_alt_formats?.jpg === "string"
    ? job.results_alt_formats.jpg
    : job.result_url;
  const { bytes, mime } = await downloadResult(resultUrl);

  return {
    bytes,
    mime,
    model: registryEntry.id,
    size: sizeInfo.size,
    imageSize: sizeInfo.imageSize,
    aspectRatio: sizeInfo.aspectRatio,
    durationSeconds: (Date.now() - started) / 1000,
    costUsd,
  };
}

export const __imageProClientInternals = {
  fitSizeToModel,
  validateRefPaths,
};
