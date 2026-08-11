// deAPI → standard image tier (capability id: image-generation).
//
// Text-to-image routes to POST /api/v2/images/generations (JSON);
// ref-based generation routes to POST /api/v2/images/edits (multipart,
// local ref files uploaded directly — no tunnel, no preupload). Both are
// async: submit returns request_id, the job is polled to terminal, and
// the presigned result_url is downloaded to bytes.
//
// Returns { bytes, mime, model, durationSeconds, costUsd } for the CLI.
// costUsd is the exact /price quote taken before submitting; when the
// quote itself fails the generation still proceeds with costUsd null.
//
// Refs are LOCAL FILE PATHS — every entry in `refImagePaths` must be an
// absolute path to a mirrored project asset (from buildProviderRefs).
// URLs are rejected at the boundary: deAPI takes the bytes as multipart
// uploads, so there is nothing for a URL to do here.
//
// Contract reference: scratchpad copy of https://deapi.ai/llms.txt.

import fs from "node:fs";
import {
  postJson,
  postForm,
  pollJob,
  requestIdOf,
  quotePrice,
  getModelEntry,
  downloadResult,
  deriveDimensions,
  deriveSteps,
  err,
} from "./deapi_client.js";
import { getDefault } from "./model_registry.js";

const SUBMIT_TIMEOUT_MS = 60_000;
const POLL_TIMEOUT_MS = 10 * 60_000;

// Target long side per pai-pro size tier. Models with a smaller
// max_width/height clamp down transparently (e.g. 4K on a 2048-max
// model produces 2048).
const LONG_SIDE_BY_TIER = { "1k": 1024, "2k": 2048, "4k": 4096 };

function longSideForTier(imageSize) {
  return LONG_SIDE_BY_TIER[String(imageSize || "2K").toLowerCase()] ?? 2048;
}

function validateRefPaths(refImagePaths) {
  const refs = Array.isArray(refImagePaths)
    ? refImagePaths.filter((p) => typeof p === "string" && p.trim() !== "")
    : [];
  for (const p of refs) {
    if (/^(https?:|data:)/i.test(p)) {
      throw err(
        "bad_args",
        `pai_image_client expects local file paths for refs, got "${p.slice(0, 60)}" — `
        + "resolve refs through buildProviderRefs() and pass absPath.",
      );
    }
    if (!fs.existsSync(p)) {
      throw err("bad_args", `image ref file not found: ${p}`);
    }
  }
  return refs;
}

async function quoteOrNull(quote) {
  try {
    return await quote();
  } catch (e) {
    console.error(`[deapi-image] price quote failed (continuing without): ${e.message.slice(0, 120)}`);
    return null;
  }
}

/**
 * Generate one image via deAPI.
 *
 * @param {Object}    opts
 * @param {string}    opts.prompt        text-to-image / edit prompt
 * @param {string}    [opts.aspectRatio="16:9"]
 * @param {string}    [opts.imageSize="2K"]   "1K" | "2K" | "4K"
 * @param {string[]}  [opts.refImagePaths]  absolute local paths of ref
 *                                          images (routes to images/edits)
 *
 * @returns {Promise<{
 *   bytes: Buffer,
 *   mime: string,
 *   model: string,
 *   durationSeconds: number,
 *   costUsd: number|null
 * }>}
 *
 * @throws  classified Error (.klass): bad_args / content_filtered /
 *          rate_limited / infra / transient / transient_exhausted
 */
export async function generateImage({ prompt, aspectRatio, imageSize, refImagePaths } = {}) {
  if (typeof prompt !== "string" || !prompt.trim()) {
    throw err("bad_args", "generateImage: prompt required");
  }
  const refs = validateRefPaths(refImagePaths);
  const registryEntry = getDefault("image");
  const slug = refs.length > 0 ? registryEntry.deapi_edit_slug : registryEntry.deapi_slug;

  const modelEntry = await getModelEntry(slug, { logTag: "deapi-image" });
  const { width, height } = deriveDimensions(modelEntry, {
    aspectRatio,
    longSide: longSideForTier(imageSize),
  });
  const steps = deriveSteps(modelEntry);
  const maxRefs = Number(modelEntry?.info?.limits?.max_input_images) || 1;
  if (refs.length > maxRefs) {
    throw err("bad_args", `generateImage: model ${slug} accepts at most ${maxRefs} ref image(s), got ${refs.length}`);
  }

  const started = Date.now();
  let requestId;
  let costUsd;
  if (refs.length === 0) {
    const body = { prompt, model: slug, width, height, steps, seed: -1 };
    costUsd = await quoteOrNull(() => quotePrice({
      path: "images/generations",
      body: { model: slug, width, height, steps },
      logTag: "deapi-image",
    }));
    const submitted = await postJson({
      path: "images/generations",
      body,
      timeoutMs: SUBMIT_TIMEOUT_MS,
      logTag: "deapi-image",
    });
    requestId = requestIdOf(submitted, "images/generations");
  } else {
    costUsd = await quoteOrNull(() => quotePrice({
      path: "images/edits",
      body: { model: slug, steps, width, height },
      logTag: "deapi-image",
    }));
    const files = refs.length === 1
      ? [{ field: "image", filePath: refs[0] }]
      : refs.map((p) => ({ field: "images[]", filePath: p }));
    const submitted = await postForm({
      path: "images/edits",
      fields: { prompt, model: slug, seed: -1, steps, width, height },
      files,
      timeoutMs: SUBMIT_TIMEOUT_MS,
      logTag: "deapi-image",
    });
    requestId = requestIdOf(submitted, "images/edits");
  }

  const job = await pollJob(requestId, {
    timeoutMs: POLL_TIMEOUT_MS,
    logTag: "deapi-image",
  });
  if (typeof job?.result_url !== "string" || !job.result_url) {
    throw err("infra", `deAPI image job ${requestId} finished with no result_url`);
  }
  const { bytes, mime } = await downloadResult(job.result_url);

  return {
    bytes,
    mime,
    model: registryEntry.id,
    durationSeconds: (Date.now() - started) / 1000,
    costUsd,
  };
}
