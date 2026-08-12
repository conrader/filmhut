// deAPI → text-to-speech (capability id: tts).
//
// POST /api/v2/audio/speech (multipart) is async: submit returns a
// request_id, the job is polled, and the MP3 lands at a presigned
// result_url.
//
// Field mapping from generate_voice.js args:
//   text   → form `text`      (the line to be spoken; min length is
//                              model-specific — 10 chars on Qwen3 TTS)
//   prompt → form `instruct`  (the voice design brief — timbre, pace,
//                              accent, etc.)
//
// Mode selection adapts to the configured model's catalog entry:
//   supports_voice_design → mode=voice_design, brief drives the voice
//   otherwise             → mode=custom_voice with the model's first
//                           advertised voice preset; the brief still
//                           rides along as `instruct` (style/emotion
//                           control) where the model honors it.
//
// Every deployed deAPI TTS model currently advertises mp3-only output
// at 24 kHz; format/sample_rate are read from the model's limits rather
// than hardcoded so catalog changes flow through.

import {
  postForm,
  pollJob,
  requestIdOf,
  quotePrice,
  getModelEntry,
  downloadResult,
  err,
} from "./deapi_client.js";
import { getDefault } from "./model_registry.js";

const SUBMIT_TIMEOUT_MS = 60_000;
const POLL_TIMEOUT_MS = 5 * 60_000;

function ttsRequestShape(modelEntry, { text, prompt }) {
  const limits = modelEntry?.info?.limits ?? {};
  const features = modelEntry?.info?.features ?? {};
  const langs = Array.isArray(modelEntry?.languages) ? modelEntry.languages : [];

  const minText = Number(limits.min_text) || 1;
  if (text.length < minText) {
    throw err("bad_args", `generateVoice: text is ${text.length} chars; model ${modelEntry.slug} requires at least ${minText}`);
  }

  const format = Array.isArray(limits.output_formats) && limits.output_formats[0]
    ? limits.output_formats[0]
    : "mp3";
  const sampleRate = Array.isArray(limits.available_ratios) && limits.available_ratios[0]
    ? limits.available_ratios[0]
    : 24000;
  // Speed 1 is legal everywhere (several models pin min == max == 1).
  const speed = 1;

  const lang = langs[0]?.slug || "en-us";
  const fields = {
    text,
    model: modelEntry.slug,
    lang,
    speed,
    format,
    sample_rate: sampleRate,
  };

  if (features.supports_voice_design) {
    fields.mode = "voice_design";
    fields.instruct = prompt;
  } else {
    const voice = langs[0]?.voices?.[0]?.slug;
    if (!voice) {
      throw err(
        "bad_args",
        `generateVoice: model ${modelEntry.slug} advertises neither voice_design nor voice presets — `
        + "set DEAPI_TTS_MODEL to a TTS model from your deAPI catalog.",
      );
    }
    fields.mode = "custom_voice";
    fields.voice = voice;
    fields.instruct = prompt; // style/emotion hint where supported
  }
  return { fields, format };
}

/**
 * Generate one audio clip via deAPI TTS.
 *
 * @param {Object} opts
 * @param {string} opts.text    line to be spoken
 * @param {string} opts.prompt  voice design brief
 *
 * @returns {Promise<{
 *   bytes: Buffer,
 *   mime: string,
 *   model: string,
 *   durationSeconds: number,
 *   costUsd: number|null,
 *   audioDurationSec: null,
 *   wallClockSec: number,
 *   predictionId: string,
 * }>}
 *
 * @throws  classified Error (.klass): bad_args / content_filtered /
 *          rate_limited / infra / transient / transient_exhausted
 */
export async function generateVoice({ text, prompt , onSubmitted} = {}) {
  if (typeof text !== "string" || !text.trim()) {
    throw err("bad_args", "generateVoice: empty text");
  }
  if (typeof prompt !== "string" || !prompt.trim()) {
    throw err("bad_args", "generateVoice: empty prompt (voice design brief required)");
  }

  const registryEntry = getDefault("voice");
  const modelEntry = await getModelEntry(registryEntry.deapi_slug, { logTag: "deapi-tts" });
  const { fields, format } = ttsRequestShape(modelEntry, {
    text: String(text),
    prompt: String(prompt),
  });

  let costUsd = null;
  try {
    costUsd = await quotePrice({
      path: "audio/speech",
      body: {
        model: fields.model,
        // count_text stands in for the full text on the price endpoint.
        count_text: fields.text.length,
        speed: fields.speed,
        lang: fields.lang,
        format: fields.format,
        sample_rate: fields.sample_rate,
        // `mode` is validated here too: a voice-design-only model
        // rejects the default custom_voice mode outright.
        mode: fields.mode,
        ...(fields.voice ? { voice: fields.voice } : {}),
      },
      logTag: "deapi-tts",
    });
  } catch (e) {
    console.error(`[deapi-tts] price quote failed (continuing without): ${e.message.slice(0, 120)}`);
  }

  const started = Date.now();
  const submitted = await postForm({
    path: "audio/speech",
    fields,
    timeoutMs: SUBMIT_TIMEOUT_MS,
    logTag: "deapi-tts",
  });
  const requestId = requestIdOf(submitted, "audio/speech");

  // The supplier has the job and the money is committed. Report the id

  // before polling so a caller can make it durable (see cli/_resume.js).

  if (typeof onSubmitted === "function") { try { onSubmitted(requestId); } catch { /* never let bookkeeping fail a paid job */ } }

  const job = await pollJob(requestId, {
    intervalMs: 2_000,
    timeoutMs: POLL_TIMEOUT_MS,
    logTag: "deapi-tts",
  });
  if (typeof job?.result_url !== "string" || !job.result_url) {
    throw err("infra", `deAPI tts job ${requestId} finished with no result_url`);
  }
  const { bytes, mime } = await downloadResult(job.result_url);

  return {
    bytes,
    mime: mime === "application/octet-stream" ? (format === "mp3" ? "audio/mpeg" : mime) : mime,
    model: registryEntry.id,
    durationSeconds: (Date.now() - started) / 1000,
    costUsd,
    audioDurationSec: null, // deAPI doesn't echo the clip duration; CLI probes if needed
    wallClockSec: (Date.now() - started) / 1000,
    predictionId: requestId,
  };
}
