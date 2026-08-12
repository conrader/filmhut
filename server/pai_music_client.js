// Music via deAPI (AceStep).
//
// A whole score in one call — 10 to 300 seconds — which makes it a different
// shape from the other capabilities: there is no per-shot music, only a bed the
// timeline sits on.
//
// One documented quirk that will otherwise waste a paid call: guidance_scale
// must be <= 1 on the AceStep models. Larger values are rejected outright.

import { err, pollJob, postForm, quotePrice, requestIdOf } from "./deapi_client.js";
import { getDefault } from "./model_registry.js";

const RESOURCE = "audio/music";
const SUBMIT_TIMEOUT_MS = 60_000;
const POLL_TIMEOUT_MS = 10 * 60_000;

export const MUSIC_LIMITS = {
  minSeconds: 10,
  maxSeconds: 300,
  maxGuidance: 1,
  // AceStep_1_5_Turbo pins steps to 8. The gating limits live under
  // info.limits.min_steps/max_steps — note the name mismatch with the
  // inference_steps request field.
  defaultSteps: 8,
};

/** deAPI requires lyrics and rejects an empty value; this is its own sentinel for an instrumental. */
export const INSTRUMENTAL = "[Instrumental]";

export function clampDuration(seconds) {
  const n = Number(seconds);
  if (!Number.isFinite(n)) return 60;
  return Math.min(MUSIC_LIMITS.maxSeconds, Math.max(MUSIC_LIMITS.minSeconds, Math.round(n)));
}

/**
 * Generate a music bed.
 *
 * @param {object}   opts
 * @param {string}   opts.prompt        style brief — genre, instrumentation, tempo, mood
 * @param {number}   [opts.duration]    seconds, clamped into the model's range
 * @param {number}   [opts.guidanceScale]
 * @param {Function} [opts.onSubmitted] called with the provider id before polling
 * @returns {Promise<{ url: string, model: string, durationSeconds: number, costUsd: number|null }>}
 */
export async function generateMusic({
  prompt, duration, guidanceScale, lyrics, format = "mp3", steps, onSubmitted,
} = {}) {
  const text = String(prompt ?? "").trim();
  if (text.length < 3) {
    throw err("bad_args", "generateMusic needs a style brief — genre, instrumentation, mood");
  }

  const registryEntry = getDefault("music");
  const model = registryEntry?.deapi_slug;
  if (!model) throw err("bad_args", "no music model configured — set DEAPI_MUSIC_MODEL");
  const seconds = clampDuration(duration);

  // Clamped rather than rejected: a caller asking for more guidance wants a
  // stronger read of the brief, and failing a paid call over a ceiling they
  // cannot see from here would be unhelpful.
  const guidance = Math.min(
    MUSIC_LIMITS.maxGuidance,
    Number.isFinite(Number(guidanceScale)) ? Number(guidanceScale) : MUSIC_LIMITS.maxGuidance,
  );

  // Field names are deAPI's, not ours: it wants `caption` rather than `prompt`,
  // and it REQUIRES lyrics, inference_steps and format — omitting any of them
  // is a 422 rather than a default.
  const fields = {
    caption: text,
    model,
    lyrics: String(lyrics ?? "").trim() || INSTRUMENTAL,
    duration: seconds,
    inference_steps: Number.isFinite(Number(steps)) ? Number(steps) : MUSIC_LIMITS.defaultSteps,
    guidance_scale: guidance,
    seed: -1,
    format,
  };

  let costUsd = null;
  try {
    costUsd = await quotePrice({ path: RESOURCE, body: fields, logTag: "deapi-music" });
  } catch {
    // A missing quote is not worth failing the call over; the result reports
    // whatever the provider actually charged.
  }

  const submitted = await postForm({
    path: RESOURCE,
    fields,
    files: [],
    timeoutMs: SUBMIT_TIMEOUT_MS,
    logTag: "deapi-music",
  });
  const requestId = requestIdOf(submitted, RESOURCE);

  if (typeof onSubmitted === "function") {
    try { onSubmitted(requestId); } catch { /* never let bookkeeping fail a paid job */ }
  }

  const job = await pollJob(requestId, { timeoutMs: POLL_TIMEOUT_MS, logTag: "deapi-music" });
  const url = job?.result_url ?? job?.output?.url;
  if (typeof url !== "string" || !url) {
    throw err("infra", `deAPI music job ${requestId} finished with no result_url`);
  }

  return { url, model, durationSeconds: seconds, costUsd, requestId };
}
