// Transcription via deAPI (Whisper).
//
// The only capability here that CONSUMES an asset rather than producing one:
// it takes audio or video already on disk and returns text with timings. That
// makes it the input side of the pipeline — subtitles, dialogue-driven shot
// timing, and searchable takes all start here.

import fs from "node:fs";
import { err, pollJob, postForm, quotePrice, requestIdOf } from "./deapi_client.js";
import { getDefault } from "./model_registry.js";

const RESOURCE = "audio/transcriptions";
const SUBMIT_TIMEOUT_MS = 120_000;
const POLL_TIMEOUT_MS = 15 * 60_000;

/**
 * Transcribe a local audio or video file.
 *
 * @param {object}   opts
 * @param {string}   opts.filePath      absolute path to the media
 * @param {boolean}  [opts.diarize]     label distinct speakers
 * @param {string}   [opts.language]    ISO code; omit to let the model detect
 * @param {Function} [opts.onSubmitted] called with the provider id before polling
 * @returns {Promise<{ text: string, segments: Array, model: string, costUsd: number|null }>}
 */
export async function transcribe({ filePath, diarize = false, language, onSubmitted } = {}) {
  if (!filePath || !fs.existsSync(filePath)) {
    throw err("bad_args", `transcribe: no file at ${filePath ?? "(no path given)"}`);
  }

  const model = getDefault("transcription")?.deapi_slug;
  if (!model) throw err("bad_args", "no transcription model configured — set DEAPI_TRANSCRIBE_MODEL");

  const fields = { model, timestamps: true, diarization: Boolean(diarize) };
  if (typeof language === "string" && language) fields.language = language;

  let costUsd = null;
  try {
    costUsd = await quotePrice({ path: `${RESOURCE}/price`, body: fields, logTag: "deapi-stt" });
  } catch {
    // Priced by duration, which the quote endpoint cannot know without the
    // file; a missing quote is expected here rather than exceptional.
  }

  const submitted = await postForm({
    path: RESOURCE,
    fields,
    files: [{ field: "file", filePath }],
    timeoutMs: SUBMIT_TIMEOUT_MS,
    logTag: "deapi-stt",
  });
  const requestId = requestIdOf(submitted, RESOURCE);

  if (typeof onSubmitted === "function") {
    try { onSubmitted(requestId); } catch { /* never let bookkeeping fail a paid job */ }
  }

  const job = await pollJob(requestId, { timeoutMs: POLL_TIMEOUT_MS, logTag: "deapi-stt" });

  const text = job?.text ?? job?.result?.text ?? "";
  const rawSegments = job?.segments ?? job?.result?.segments ?? [];
  if (typeof text !== "string" || text.trim() === "") {
    throw err("infra", `deAPI transcription ${requestId} finished with no text`);
  }

  return {
    text: text.trim(),
    segments: normalizeSegments(rawSegments),
    model,
    costUsd,
    requestId,
  };
}

/**
 * Flatten the provider's segment shape into one the canvas can rely on.
 * Field names vary between models; timings are what callers actually need.
 */
function normalizeSegments(segments) {
  if (!Array.isArray(segments)) return [];
  return segments
    .map((s) => ({
      start: Number(s.start ?? s.start_time ?? 0),
      end: Number(s.end ?? s.end_time ?? 0),
      text: String(s.text ?? "").trim(),
      speaker: s.speaker ?? s.speaker_id ?? null,
    }))
    .filter((s) => s.text !== "" && Number.isFinite(s.start) && Number.isFinite(s.end));
}

/** Segments as SRT — what an editor or a burn-in filter expects. */
export function toSrt(segments) {
  return segments
    .map((s, i) => `${i + 1}\n${srtTime(s.start)} --> ${srtTime(s.end)}\n${s.text}\n`)
    .join("\n");
}

function srtTime(seconds) {
  const ms = Math.max(0, Math.round(seconds * 1000));
  const h = String(Math.floor(ms / 3_600_000)).padStart(2, "0");
  const m = String(Math.floor((ms % 3_600_000) / 60_000)).padStart(2, "0");
  const s = String(Math.floor((ms % 60_000) / 1000)).padStart(2, "0");
  return `${h}:${m}:${s},${String(ms % 1000).padStart(3, "0")}`;
}
