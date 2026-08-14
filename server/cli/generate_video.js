#!/usr/bin/env node
// CLI wrapper for video generation via deAPI
// (capability id: video-generation). Synchronous from the caller's POV —
// typical wall-clock is 2-8 min, so plan accordingly.
//
// Refs: every ref is a canvas node id (--ref-source-id for image
// sources, --ref-audio-source-id for audio sources). buildProviderRefs
// resolves each source's local_path to the absolute on-disk file, and
// the client uploads the bytes to deAPI directly as multipart form data
// — no preupload, no tunnel. Image refs map to first/last frame
// (max 2); one audio ref routes to the audio-sync endpoint; video refs
// are not supported by deAPI's video endpoints. External URLs are
// mirrored onto the canvas first via mirror_url.js; no separate
// URL-passthrough flag.

import path from "node:path";
import fs from "node:fs/promises";
import { parseArgs, emitSuccess, emitFailure, classify, isoNow, truncateLabel } from "./_cli.js";
import { submitVideo, pollVideo } from "../pai_video_client.js";
import { getDefault, getCost } from "../model_registry.js";
import { kickPreupload } from "./_preupload_hook.js";
import {
  streamUrlToTmp,
  viewerUrlForLocalPath,
  buildProviderRefs,
  readActiveProject,
  readNodeType,
} from "../local_mirror.js";
import { postNodeAddBatch } from "./_mutate_helper.js";
import {
  fireDraft,
  fireAndWait,
  isBypassEnabled,
  newJobId,
  reserveAutoBudget,
  waitForReviewResult,
  writePending,
  writeResultSidecar,
  removePending,
  removePendingSync,
} from "./_pending.js";
import { protectOnExit, recordProviderRef } from "./_resume.js";
import { VIDEO_LIMITS } from "./_limits.js";
import { checkPromptRefsWired } from "./_ref_guard.js";
import { checkRefsReviewed } from "./_review_guard.js";
import { checkSubjectCoverage } from "./_subject_guard.js";

const rawArgv = process.argv.slice(2);
const defaultVideoModel = getDefault("video");
const defaultVideoParams = defaultVideoModel.default_params ?? {};

const args = parseArgs({
  prompt:                  { type: "string", short: "p" },
  // 10s is the real ceiling on the default model (241 frames @ 24fps);
  // asking for more just clamps. See VIDEO_LIMITS.max_duration_sec.
  duration:                { type: "string", default: "10" },
  "aspect-ratio":          { type: "string", default: "16:9" },
  resolution:              { type: "string", default: defaultVideoParams.resolution ?? "720p" },
  // Audio defaults ON (generate_audio: true). Pass --no-audio ONLY when
  // the user has explicitly asked for a silent clip. Trailer framing,
  // "I'll add SFX in post", or detail-SFX skepticism are NOT triggers —
  // audio is the baseline. See video-compose/SKILL.md § "Hard defaults".
  "no-audio":              { type: "boolean", default: false },
  // canvas-mutate integration
  label:                   { type: "string" },
  "ref-source-id":         { type: "string", multiple: true, default: [] },
  "source-node-id":        { type: "string" }, // authorship edge — see PROJECT_AGENT.md
  // Canvas audio_result refs — resolved to local_path, uploaded via the tunnel.
  "ref-audio-source-id":   { type: "string", multiple: true, default: [] },
  "shot-id":               { type: "string" },
  "project-id":            { type: "string" },
  "request-id":            { type: "string" },
  "no-canvas-write":       { type: "boolean" },
  // Draft gate — see PROJECT_AGENT.md § "Draft gate".
  stage:                   { type: "boolean" },
  "draft-only":            { type: "boolean" },
  "existing-job-id":       { type: "string" },
  "allow-unreferenced":    { type: "boolean" },
  "auto-run-id":           { type: "string" },
});

const audSrcIds = Array.isArray(args["ref-audio-source-id"]) ? args["ref-audio-source-id"] : [];
const refSourcesArg = Array.isArray(args["ref-source-id"]) ? args["ref-source-id"] : [];

// Sent values surfaced in {limits, sent} failure JSON.
function buildSent() {
  return {
    ref_source_ids: refSourcesArg,
    audio_source_ids: audSrcIds,
    source_node_id: args["source-node-id"] || null,
    duration: Number(args.duration) || 15,
    aspect_ratio: args["aspect-ratio"],
    resolution: args.resolution,
    generate_audio: !args["no-audio"],
  };
}

// Last terminal object emitted to stdout, captured so the finally block can
// persist it as the durable result sidecar (failures fire from several inner
// sites and throw, so we funnel capture through fail() rather than each site).
let emitted = null;

function fail(klass, message, extra = {}) {
  emitted = emitFailure(klass, message, { limits: VIDEO_LIMITS, sent: buildSent(), ...extra });
  return emitted;
}

if (!args.prompt) {
  fail("bad_args", "missing --prompt");
  process.exit(2);
}

if (audSrcIds.length > VIDEO_LIMITS.max_audio_refs) {
  fail("bad_args", `reference cap exceeded: audio_refs ${audSrcIds.length} > ${VIDEO_LIMITS.max_audio_refs}`);
  process.exit(2);
}

// Reject prompts that name @ImageN/@VideoN/@AudioN without wiring the matching
// flag — runs before staging + any paid call. See _ref_guard.js.
const refGuardMsg = checkPromptRefsWired({
  prompt: args.prompt,
  refSourceCount: refSourcesArg.length,
  audioRefCount: audSrcIds.length,
  tier: "video",
});
if (refGuardMsg) {
  fail("bad_args", refGuardMsg);
  process.exit(2);
}

// Refuse to render a shot that NAMES a declared subject without anchoring it.
// Runs before staging and before any paid call. See _subject_guard.js — the
// subject list is declared in subjects.json, never guessed from prose.
if (!args["allow-unreferenced"]) {
  try {
    const [wfRaw, subjRaw] = await Promise.all([
      fs.readFile("workflow.json", "utf8"),
      fs.readFile("subjects.json", "utf8").catch(() => '{"subjects":[]}'),
    ]);
    const byId = new Map((JSON.parse(wfRaw).nodes ?? []).map((n) => [n.id, n]));
    const subjects = JSON.parse(subjRaw).subjects ?? [];
    const { blocked } = checkSubjectCoverage({
      prompt: args.prompt,
      subjects,
      refNodes: refSourcesArg.map((id) => byId.get(id)),
    });
    if (blocked) {
      fail("bad_args", blocked);
      process.exit(2);
    }
  } catch (e) {
    if (e?.code !== "ENOENT" && !(e instanceof SyntaxError)) throw e;
  }
}

// Refuse a rejected reference at STAGE time as well as at spend time.
// The spend-time guard further down is the one that protects the money; this
// one exists so the answer arrives now, rather than after the user fires a
// draft that was never going to run. See _review_guard.js.
if (refSourcesArg.length > 0) {
  try {
    const wf = JSON.parse(await fs.readFile("workflow.json", "utf8"));
    const byId = new Map((wf.nodes ?? []).map((n) => [n.id, n]));
    const { blocked } = checkRefsReviewed(refSourcesArg.map((id) => byId.get(id)));
    if (blocked) {
      fail("bad_args", blocked);
      process.exit(2);
    }
  } catch (e) {
    if (e?.code !== "ENOENT" && !(e instanceof SyntaxError)) throw e;
    // No canvas to consult — the spend-time guard still runs.
  }
}

const jobId = args["existing-job-id"] || newJobId();
const routeOwnedPending = !!args["existing-job-id"];
const durationPlanned = Number(args.duration) || 15;
const plannedModel = defaultVideoModel.id;

if (args["auto-run-id"] !== undefined) {
  if (args["auto-run-id"] === "") {
    fail("bad_args", "--auto-run-id must not be empty");
    process.exit(2);
  }
  if (!args.stage && !routeOwnedPending) {
    fail("bad_args", "--auto-run-id requires --stage so the run's budget is reserved before spending");
    process.exit(2);
  }
}

if (args.stage && !routeOwnedPending) {
  // deAPI uploads refs inline with the generation call — no per-ref
  // preupload cost. The staged figure is the registry's display
  // approximation; the client fetches the exact /price quote at run time.
  const videoCost = getCost(plannedModel, {
    resolution: args.resolution,
    duration: durationPlanned,
  });
  const costUsd = +Number(videoCost ?? 0).toFixed(3);
  const autoRunId = args["auto-run-id"] || null;
  const autoProjectId = autoRunId
    ? args["project-id"] || (await readActiveProject().catch(() => null))
    : null;
  if (autoRunId) {
    const reserved = await reserveAutoBudget({
      projectId: autoProjectId,
      runId: autoRunId,
      jobId,
      kind: "video",
      model: plannedModel,
      prompt: args.prompt,
      costUsd,
    });
    if (!reserved.ok) {
      const { ok, klass, message, error, ...extra } = reserved;
      fail(klass || "budget_exceeded", message || error || "auto budget reservation failed", extra);
      process.exit(klass === "bad_args" ? 2 : 1);
    }
  }
  const replayArgv = rawArgv.filter((a) => a !== "--stage" && a !== "--draft-only");
  const staged = await writePending({
    jobId,
    kind: "video",
    stage: "draft",
    prompt: args.prompt,
    aspectRatio: args["aspect-ratio"],
    // --ref-source-id (image + video) and --ref-audio-source-id (audio)
    // both feed the same source-id channel for the projection's dashed
    // edges — match the edges postNodeAddBatch will emit on the final.
    sourceNodeId: args["source-node-id"] || null,
    referenceSourceIds: [...refSourcesArg, ...audSrcIds],
    model: plannedModel,
    resolution: args.resolution,
    duration: durationPlanned,
    costUsd,
    script: "generate_video.js",
    argv: replayArgv,
    autoRunId,
  });
  if (!staged) {
    fail("infra", "failed to write draft sidecar");
    process.exit(1);
  }
  emitSuccess({ stage: "draft", job_id: jobId, model: plannedModel, cost_usd: costUsd });
  try {
    const bypassEnabled = await isBypassEnabled();
    const shouldFire = bypassEnabled || !!autoRunId;
    if (args["draft-only"] && !shouldFire) process.exit(0);
    const projectId = shouldFire
      ? args["project-id"] || (await readActiveProject())
      : null;
    if (args["draft-only"]) {
      const fired = await fireDraft({ projectId, jobId });
      process.stdout.write(JSON.stringify({
        ...fired,
        ...(fired.ok ? { stage: "running", fired: true } : {}),
      }) + "\n");
      process.exit(fired.ok ? 0 : 1);
    }
    const result = shouldFire
      ? await fireAndWait({
          projectId,
          jobId,
          kind: "video",
        })
      : await waitForReviewResult(jobId, { kind: "video" });
    process.stdout.write(JSON.stringify(result) + "\n");
    process.exit(result.ok ? 0 : 1);
  } catch (e) {
    fail(classify(e), e.message);
    process.exit(1);
  }
}

if (!routeOwnedPending) {
  // Preserve paid work on the way out: mark the sidecar resumable rather than
  // deleting it. See cli/_resume.js.
  protectOnExit(jobId);
}

await writePending({
  jobId,
  kind: "video",
  prompt: args.prompt,
  aspectRatio: args["aspect-ratio"],
  sourceNodeId: args["source-node-id"] || null,
  referenceSourceIds: [...refSourcesArg, ...audSrcIds],
  model: plannedModel,
  resolution: args.resolution,
  duration: durationPlanned,
  autoRunId: args["auto-run-id"] || null,
});

let exitCode = 0;
try {
  const durationInt = durationPlanned;
  const projectId = args["project-id"] || (await readActiveProject());

  // Partition --ref-source-id list into image / video buckets by node
  // type. Wrong-typed ids (audio, note, missing) reject with bad_args
  // — silent drops would leave the user with a solid edge to a node
  // the provider never actually received. Audio refs use the
  // dedicated --ref-audio-source-id flag.
  const imgSrcIds = [];
  const vidSrcIds = [];
  const badSrcIds = [];
  for (const sid of refSourcesArg) {
    const t = await readNodeType({ nodeId: sid, projectId });
    if (t === "image_result") imgSrcIds.push(sid);
    else if (t === "video_result") vidSrcIds.push(sid);
    else badSrcIds.push({ id: sid, type: t ?? "missing" });
  }
  if (badSrcIds.length) {
    const desc = badSrcIds.map((b) => `${b.id} (type=${b.type})`).join(", ");
    fail("bad_args", `--ref-source-id rejected: ${desc}. Image / video sources only; for audio use --ref-audio-source-id.`);
    // Set exitCode + throw so the finally block can clean up the sidecar
    // (process.exit() would skip async cleanup).
    exitCode = 2;
    throw new Error("bad_args: wrong-typed ref-source-id");
  }

  // Fast-fail per-kind cap violations now that types are known.
  const overCaps = [];
  if (imgSrcIds.length > VIDEO_LIMITS.max_image_refs) overCaps.push(`image_refs ${imgSrcIds.length} > ${VIDEO_LIMITS.max_image_refs}`);
  if (vidSrcIds.length > VIDEO_LIMITS.max_video_refs) overCaps.push(`video_refs ${vidSrcIds.length} > ${VIDEO_LIMITS.max_video_refs}`);
  if (overCaps.length) {
    fail("bad_args", `reference cap exceeded: ${overCaps.join("; ")}`);
    exitCode = 2;
    throw new Error("bad_args: ref cap exceeded");
  }

  // A reference someone looked at and rejected must not be paid for again.
  // Checked HERE — after the ids are known, before a single provider call —
  // because the whole value of a rejection is that it stops the next spend.
  try {
    const wf0 = JSON.parse(await fs.readFile("workflow.json", "utf8"));
    const byId0 = new Map((wf0.nodes ?? []).map((n) => [n.id, n]));
    const { blocked } = checkRefsReviewed(imgSrcIds.map((id) => byId0.get(id)));
    if (blocked) {
      fail("bad_args", blocked);
      exitCode = 2;
      throw new Error("bad_args: rejected reference");
    }
  } catch (e) {
    if (String(e?.message ?? "").startsWith("bad_args:")) throw e;
    // Unreadable workflow.json is the guard's problem, not the caller's.
  }

  const resolvedImages = await buildProviderRefs({ sourceIds: imgSrcIds, projectId });
  const resolvedAudios = await buildProviderRefs({ sourceIds: audSrcIds, projectId });
  const resolvedVideos = await buildProviderRefs({ sourceIds: vidSrcIds, projectId });

  const { taskId, costUsd, effective } = await submitVideo({
    prompt: args.prompt,
    duration: durationInt,
    aspectRatio: args["aspect-ratio"],
    resolution: args.resolution,
    generateAudio: !args["no-audio"],
    imageRefPaths: resolvedImages.map((r) => r.absPath),
    audioRefPaths: resolvedAudios.map((r) => r.absPath),
    videoRefPaths: resolvedVideos.map((r) => r.absPath),
  });

  // Durable BEFORE the first poll: after this line a dead process is recoverable.
  recordProviderRef(jobId, taskId);
  const { videoUrl, durationSeconds } = await pollVideo(taskId);
  // Stream the MP4 straight to the tmp file — a 1080p clip is tens of MB,
  // and buffering it whole made the long-lived viewer OOM-prone under
  // draft-gate fan-out (audit N22).
  const staged = await streamUrlToTmp({
    url: videoUrl,
    mimeType: "video/mp4",
    projectId,
  });
  const tmpAbsPath = staged.absolute_path;
  const ext = path.extname(tmpAbsPath);

  const generatedAt = isoNow();
  const shotIdRaw = args["shot-id"];
  const shotId = shotIdRaw === undefined ? null : Number(shotIdRaw);
  // The clip is frames/fps long, not however many seconds were asked
  // for: the model clamps to its own frame budget (241 frames at 24 fps
  // ≈ 10s on the default model). The canvas node must carry the REAL
  // length or the timeline sequences shots against a duration the file
  // doesn't have.
  const effectiveDurationExact = Number(effective?.effectiveDurationSec) || durationInt;
  // The node schema requires an integer duration, and a clamped clip lands
  // on a fraction (241 frames / 24fps = 10.04). Round for the node; the
  // exact value stays in effective_plan.
  const effectiveDuration = Math.max(1, Math.round(effectiveDurationExact));
  const durationClamped = Math.abs(effectiveDurationExact - durationInt) > 0.25;
  const data = {
    label: args.label || truncateLabel(args.prompt),
    prompt: args.prompt,
    duration: effectiveDuration,
    aspect: args["aspect-ratio"],
    shot_id: Number.isFinite(shotId) ? shotId : null,
    metadata: {
      source: "deapi",
      task_type: "video_generation",
      model: plannedModel,
      duration: effectiveDuration,
      requested_duration: durationInt,
      aspect_ratio: args["aspect-ratio"],
      resolution: args.resolution,
      generate_audio: !args["no-audio"],
      generated_at: generatedAt,
      // deAPI's presigned result URL (expires quickly). Surfaced for
      // debugging; the canvas URL itself is always derived from local_path.
      provider_output_url: videoUrl,
      // Effective plan after clamping into the model's limits (frames,
      // fps, snapped dimensions) — can differ from the requested params.
      effective_plan: effective,
      pending_job_id: jobId,
      // What this node actually cost. Recorded here so project spend is a
      // canvas read rather than a walk over ephemeral .results sidecars.
      cost_usd: costUsd ?? null,
    },
  };
  // Merge audio source-ids into the --ref-source-id list so
  // postNodeAddBatch emits one derived edge per ref (image + video +
  // audio sources all feed the same edge channel).
  const argsForMutate = {
    ...args,
    "ref-source-id": [...refSourcesArg, ...audSrcIds],
  };
  // A video anchored on a one-off portrait has ONE viewpoint to work from, so
  // any angle the portrait does not show gets invented — which is where
  // identity drifts. A four-panel sheet (reference_sheet.js) triangulates
  // front, profile, back and a face close-up. Say so rather than assume the
  // caller has read the skill.
  let anchorAdvice = null;
  let reviewWarning = null;
  try {
    const wf = JSON.parse(await fs.readFile("workflow.json", "utf8"));
    const byId = new Map((wf.nodes ?? []).map((n) => [n.id, n]));
    const weak = refSourcesArg
      .map((id) => byId.get(id))
      .filter((n) => n?.type === "image_result" && n.data?.subtype !== "character");
    if (weak.length > 0) {
      anchorAdvice =
        `anchored on ${weak.map((n) => n.id).join(", ")}, which ${weak.length === 1 ? "is not a" : "are not"} character sheet${weak.length === 1 ? "" : "s"}. `
        + "A single image gives the model one viewpoint and it invents the rest; "
        + 'build a multi-angle sheet with reference_sheet.js --kind character to hold identity across shots.';
    }
    reviewWarning = checkRefsReviewed(refSourcesArg.map((id) => byId.get(id))).warning;
  } catch {
    // No workflow.json, or unreadable — advice is a nicety, never a blocker.
  }

  const mutResult = await postNodeAddBatch({
    args: argsForMutate,
    type: "video_result",
    data,
    actor: "cli:generate_video",
    tmpPath: tmpAbsPath,
    pendingJobId: jobId,
  });
  const assignedNodeId = mutResult?.canvas_mutation?.node_id ?? null;
  if (!assignedNodeId) {
    await fs.unlink(tmpAbsPath).catch(() => {});
  }
  if (mutResult?.canvas_mutation_error) {
    const err = new Error(mutResult.canvas_mutation_error.message || "canvas mutation failed");
    err.klass = mutResult.canvas_mutation_error.klass || "infra";
    throw err;
  }
  const localPath = assignedNodeId
    ? `assets/videos/${assignedNodeId}${ext}`
    : null;
  const url = localPath
    ? viewerUrlForLocalPath({ localPath, projectId })
    : null;

  if (localPath) {
    await kickPreupload({ projectId, localPath, mimeType: "video/mp4" });
  }

  const payload = {
    output_url: url,
    local_path: localPath,
    provider_output_url: videoUrl,
    model: plannedModel,
    duration: effectiveDuration,
    ...(durationClamped ? {
      requested_duration: durationInt,
      note: `duration clamped to ${effectiveDurationExact}s — ${effective.model} allows at most `
        + `${effective.frames} frames at ${effective.fps}fps. Chain clips for longer sequences.`,
    } : {}),
    aspect_ratio: args["aspect-ratio"],
    resolution: args.resolution,
    generate_audio: !args["no-audio"],
    cost_usd: costUsd ?? null,
    effective_plan: effective,
    poll_seconds: durationSeconds,
    generated_at: generatedAt,
  };
  if (mutResult) Object.assign(payload, mutResult);
  if (anchorAdvice) payload.anchor_advice = anchorAdvice;
  if (reviewWarning) payload.review_warning = reviewWarning;

  emitted = emitSuccess(payload);
} catch (e) {
  if (exitCode === 0) {
    fail(classify(e), e.message, e.retryAfterSec ? { retryAfterSec: e.retryAfterSec } : {});
    exitCode = 1;
  }
} finally {
  // Route-owned fires get their durable result written by the fire route
  // from captured stdout; a direct/bypass CLI run persists its own.
  if (!routeOwnedPending) {
    if (emitted) await writeResultSidecar(jobId, { ...emitted, kind: "video" });
    await removePending(jobId);
  }
}
process.exit(exitCode);
