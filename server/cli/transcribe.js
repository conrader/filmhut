#!/usr/bin/env node
// Transcribe an audio or video asset already on the canvas.
//
//   node transcribe.js --path assets/videos/video_3.mp4 --diarize
//   node transcribe.js --source-node-id video_3 --srt subtitles.srt
//
// Lands the transcript as a note node so it is readable and searchable on the
// canvas, with the timed segments in metadata for anything that needs to
// sequence against them. Prints one JSON line.

import path from "node:path";
import fsp from "node:fs/promises";
import { parseArgs, emitSuccess, emitFailure, classify, isoNow } from "./_cli.js";
import { transcribe, toSrt } from "../pai_transcribe_client.js";
import { readActiveProject } from "../local_mirror.js";
import { postNodeAddBatch } from "./_mutate_helper.js";
import { newJobId, writePending, removePending } from "./_pending.js";
import { protectOnExit, recordProviderRef } from "./_resume.js";

const args = parseArgs({
  path:              { type: "string" },
  "source-node-id":  { type: "string" },
  diarize:           { type: "boolean" },
  language:          { type: "string" },
  srt:               { type: "string" },
  label:             { type: "string" },
  "project-id":      { type: "string" },
  "request-id":      { type: "string" },
  "no-canvas-write": { type: "boolean" },
});

if (!args.path) {
  emitFailure("bad_args", "--path is required: the audio or video file to transcribe");
  process.exit(2);
}

const filePath = path.isAbsolute(args.path) ? args.path : path.resolve(process.cwd(), args.path);
const jobId = newJobId();

await writePending({
  jobId,
  kind: "audio",
  prompt: `transcribe ${path.basename(filePath)}`,
  sourceNodeId: args["source-node-id"] || null,
});

protectOnExit(jobId);

try {
  const projectId = args["project-id"] || (await readActiveProject());

  const result = await transcribe({
    filePath,
    diarize: Boolean(args.diarize),
    onSubmitted: (ref) => recordProviderRef(jobId, ref),
  });

  // Optional sidecar file — what a video editor or a burn-in filter wants.
  let srtPath = null;
  if (args.srt && result.segments.length > 0) {
    srtPath = path.isAbsolute(args.srt) ? args.srt : path.resolve(process.cwd(), args.srt);
    await fsp.writeFile(srtPath, toSrt(result.segments), "utf8");
  }

  const speakers = [...new Set(result.segments.map((s) => s.speaker).filter(Boolean))];

  const data = {
    label: args.label || `Transcript — ${path.basename(filePath)}`,
    body: result.text,
    metadata: {
      source: "deapi",
      task_type: "transcription",
      model: result.model,
      transcribed_at: isoNow(),
      source_file: filePath,
      segments: result.segments,
      speakers,
      duration: result.segments.at(-1)?.end ?? null,
      cost_usd: result.costUsd ?? null,
      pending_job_id: jobId,
      ...(srtPath ? { srt_path: srtPath } : {}),
    },
  };

  const mutation = await postNodeAddBatch({
    args,
    type: "note",
    data,
    actor: "transcribe",
    pendingJobId: jobId,
  });

  await removePending(jobId);

  emitSuccess({
    ok: true,
    kind: "transcription",
    job_id: jobId,
    model: result.model,
    characters: result.text.length,
    segments: result.segments.length,
    speakers: speakers.length,
    cost_usd: result.costUsd ?? null,
    ...(srtPath ? { srt_path: srtPath } : {}),
    ...(mutation ?? {}),
  });
} catch (e) {
  await removePending(jobId);
  emitFailure(classify(e), e?.message ?? String(e));
  process.exit(1);
}
