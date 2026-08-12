#!/usr/bin/env node
// Music generation via deAPI (AceStep).
//
// Unlike every other capability here, this makes ONE long asset rather than a
// per-shot one — 10 to 300 seconds in a single call. So it lands as a single
// `audio_result` node with `subtype: "music"`, which the timeline treats as a
// bed rather than as a clip.
//
//   node generate_music.js --prompt "sparse low strings, storm, unresolved" --duration 90
//   node generate_music.js --prompt "folk ballad, acoustic" --lyrics "She waited by the shore"
//
// Prints one JSON line. Non-zero exit on failure.

import path from "node:path";
import { parseArgs, emitSuccess, emitFailure, classify, isoNow, truncateLabel } from "./_cli.js";
import { generateMusic, MUSIC_LIMITS, clampDuration } from "../pai_music_client.js";
import { getDefault } from "../model_registry.js";
import { streamUrlToTmp, readActiveProject } from "../local_mirror.js";
import { postNodeAddBatch } from "./_mutate_helper.js";
import { newJobId, writePending, removePending } from "./_pending.js";
import { protectOnExit, recordProviderRef } from "./_resume.js";

const args = parseArgs({
  prompt:            { type: "string", short: "p" },
  duration:          { type: "string", short: "d" },
  "guidance-scale":  { type: "string" },
  lyrics:            { type: "string" },
  steps:             { type: "string" },
  format:            { type: "string" },
  label:             { type: "string" },
  "source-node-id":  { type: "string" },
  "project-id":      { type: "string" },
  "request-id":      { type: "string" },
  "no-canvas-write": { type: "boolean" },
});

if (!args.prompt || String(args.prompt).trim().length < 3) {
  emitFailure("bad_args", "--prompt is required: describe genre, instrumentation, tempo and mood");
  process.exit(2);
}

const requested = args.duration === undefined ? 60 : Number(args.duration);
const duration = clampDuration(requested);
const clamped = Number.isFinite(requested) && Math.round(requested) !== duration;

const jobId = newJobId();
const plannedModel = getDefault("music")?.deapi_slug ?? null;

await writePending({
  jobId,
  kind: "audio",
  prompt: args.prompt,
  model: plannedModel,
  duration,
  sourceNodeId: args["source-node-id"] || null,
});

protectOnExit(jobId);

try {
  const projectId = args["project-id"] || (await readActiveProject());

  const result = await generateMusic({
    prompt: args.prompt,
    duration,
    guidanceScale: args["guidance-scale"] === undefined ? undefined : Number(args["guidance-scale"]),
    // deAPI requires lyrics and refuses an empty value; the client defaults to
    // its instrumental sentinel when none is given.
    lyrics: args.lyrics,
    steps: args.steps === undefined ? undefined : Number(args.steps),
    format: args.format || "mp3",
    // Durable before the first poll — see cli/_resume.js.
    onSubmitted: (ref) => recordProviderRef(jobId, ref),
  });

  const staged = await streamUrlToTmp({
    url: result.url,
    mimeType: "audio/mpeg",
    projectId,
  });

  const data = {
    label: args.label || truncateLabel(args.prompt),
    subtype: "music",
    prompt: args.prompt,
    local_path: staged.absolute_path,
    metadata: {
      source: "deapi",
      task_type: "music_generation",
      model: result.model,
      duration: result.durationSeconds,
      requested_duration: Number.isFinite(requested) ? Math.round(requested) : null,
      generated_at: isoNow(),
      provider_output_url: result.url,
      pending_job_id: jobId,
      cost_usd: result.costUsd ?? null,
    },
  };

  const mutation = await postNodeAddBatch({
    args,
    type: "audio_result",
    data,
    actor: "generate_music",
    tmpPath: staged.absolute_path,
    pendingJobId: jobId,
  });

  await removePending(jobId);

  emitSuccess({
    ok: true,
    kind: "music",
    job_id: jobId,
    model: result.model,
    duration: result.durationSeconds,
    cost_usd: result.costUsd ?? null,
    local_path: staged.absolute_path,
    ...(clamped
      ? { note: `duration clamped to ${duration}s (model accepts ${MUSIC_LIMITS.minSeconds}-${MUSIC_LIMITS.maxSeconds}s)` }
      : {}),
    ...(mutation ?? {}),
  });
} catch (e) {
  await removePending(jobId);
  emitFailure(classify(e), e?.message ?? String(e));
  process.exit(1);
}
