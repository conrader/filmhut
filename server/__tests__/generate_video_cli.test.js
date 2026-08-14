// Full-path spawn tests for cli/generate_video.js (deAPI async video tier).
//
// Cloned from generate_image_pro_cli.test.js: fake deAPI server
// (DEAPI_API_BASE), fake viewer HTTP server for /mutate + /preupload-asset,
// runCli spawn helper, throwaway project under PAI_REPO_ROOT/projects
// (local_mirror.js hardcodes that root, so PAI_PROJECTS_DIR can't redirect
// the CLIs).
// One deliberate upgrade over the pro harness: the fake viewer routes
// /mutate through the real canvas_mutator, so tests can assert the node
// actually landed in workflow.json and the staged tmp file was renamed
// into assets/videos/<node-id>.mp4.
//
// The happy path passes one --ref-source-id image ref, so it exercises the
// whole flow: ref-guard, readNodeType partition, buildProviderRefs (local
// file path resolution — no tunnel, no preupload), multipart submit to
// videos/animations (first_frame_image), job poll, and streamUrlToTmp
// download. deAPI takes ref bytes as direct multipart uploads, so there is
// no asset-preupload leg at all (unlike the old PAI video-generation-assets
// flow).

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import http from "node:http";

import { PAI_REPO_ROOT } from "../lib/paths.js";
import { mutate, initProjectMutatorState } from "../canvas_mutator.js";
import { makeDeapiServer } from "./helpers/deapi_cli_fake_server.js";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const CLI_DIR = join(__dirname, "..", "cli");
const PNG_BYTES = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const MP4_BYTES = Buffer.from([0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70, 0x6d, 0x70, 0x34, 0x32]);

function runCli({ script, args, cwd, env }) {
  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    const child = spawn(
      process.execPath,
      [join(CLI_DIR, script), ...args],
      { cwd, env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "pipe"] },
    );
    child.stdout.on("data", (d) => { stdout += d; });
    child.stderr.on("data", (d) => { stderr += d; });
    child.on("exit", (code) => resolve({ code, stdout, stderr }));
  });
}

function parseReply(stdout) {
  const lines = stdout.trim().split("\n").filter((l) => l.trim().startsWith("{"));
  return JSON.parse(lines[lines.length - 1]);
}

function deapiEnv(deapi) {
  return {
    DEAPI_KEY: "dpn-sk-test",
    DEAPI_API_BASE: deapi.url,
    DEAPI_POLL_INTERVAL_MS: "10",
  };
}

// Seeds an image_1 node so --ref-source-id has a canvas source to resolve.
async function setupProject(t) {
  const projectId = `vid_cli_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const dir = join(PAI_REPO_ROOT, "projects", projectId);
  await mkdir(join(dir, "assets", ".tmp"), { recursive: true });
  await mkdir(join(dir, "assets", "images"), { recursive: true });
  await mkdir(join(dir, "assets", "videos"), { recursive: true });
  await writeFile(join(dir, "assets", "images", "image_1.png"), PNG_BYTES);
  const refNode = {
    id: "image_1",
    type: "image_result",
    data: {
      label: "starting frame",
      local_path: "assets/images/image_1.png",
      metadata: { source: "test" },
    },
  };
  await writeFile(
    join(dir, "workflow.json"),
    JSON.stringify({ version: 2, workflow_id: projectId, title: "T", nodes: [refNode], edges: [] }) + "\n",
  );
  await writeFile(
    join(dir, "meta.json"),
    JSON.stringify({ id: projectId, title: "T", created_at: new Date().toISOString() }) + "\n",
  );
  t.after(() => rm(dir, { recursive: true, force: true }));
  return { projectId, dir };
}

// Fake viewer that applies /mutate envelopes through the real mutator, so
// workflow.json + the assets/ rename behave exactly like production.
async function makeViewerServer({ dir, projectId }) {
  const p = {
    id: projectId,
    canvasState: JSON.parse(await readFile(join(dir, "workflow.json"), "utf8")),
  };
  initProjectMutatorState(p, {
    workflowPath: join(dir, "workflow.json"),
    mutationLogPath: join(dir, "mutations.jsonl"),
  });
  const captures = { mutateBodies: [], preuploadBodies: [] };
  const server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (chunk) => { raw += chunk; });
    req.on("end", () => {
      const parsed = raw ? JSON.parse(raw) : {};
      if (req.url.includes("/mutate")) {
        captures.mutateBodies.push(parsed);
        mutate(p, { ...parsed, project_id: projectId }).then((reply) => {
          res.statusCode = reply.ok ? 200 : 400;
          res.setHeader("content-type", "application/json");
          res.end(JSON.stringify(reply));
        }).catch((e) => {
          res.statusCode = 500;
          res.end(JSON.stringify({ ok: false, klass: "infra", message: e.message }));
        });
        return;
      }
      if (req.url.includes("/preupload-asset")) {
        captures.preuploadBodies.push(parsed);
        res.statusCode = 204;
        res.end();
        return;
      }
      res.statusCode = 404;
      res.end("not found");
    });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      resolve({ server, port, captures });
    });
  });
}

test("generate_video.js direct fire with image ref uploads multipart and lands node + mp4", async (t) => {
  const { projectId, dir } = await setupProject(t);
  const deapi = await makeDeapiServer({ resultExt: "mp4", resultBytes: MP4_BYTES, resultContentType: "video/mp4" });
  t.after(() => new Promise((resolve) => deapi.server.close(resolve)));
  const viewer = await makeViewerServer({ dir, projectId });
  t.after(() => new Promise((resolve) => viewer.server.close(resolve)));

  const prompt = "Slow dolly-in on @Image1 at dusk";
  const { code, stdout, stderr } = await runCli({
    script: "generate_video.js",
    args: [
      "--prompt", prompt,
      "--duration", "8",
      "--label", "dusk clip",
      "--shot-id", "3",
      "--ref-source-id", "image_1",
      "--project-id", projectId,
    ],
    cwd: dir,
    env: {
      ...deapiEnv(deapi),
      VIEWER_HOST: "127.0.0.1",
      VIEWER_PORT: String(viewer.port),
    },
  });

  assert.equal(code, 0, `stderr:\n${stderr}`);
  assert.equal(stdout.trim().split("\n").length, 1, "exactly one stdout JSON line");
  const reply = parseReply(stdout);
  assert.equal(reply.ok, true);
  assert.equal(reply.model, "video-generation");
  assert.equal(reply.duration, 8);
  assert.equal(reply.aspect_ratio, "16:9");
  assert.equal(reply.resolution, "720p");
  assert.equal(reply.generate_audio, true);
  assert.equal(typeof reply.cost_usd, "number");
  assert.equal(reply.effective_plan.route, "videos/animations");
  assert.equal(typeof reply.poll_seconds, "number");
  assert.match(reply.provider_output_url, /^http:\/\/127\.0\.0\.1:\d+\/results\/out\.mp4$/);
  assert.equal(reply.local_path, "assets/videos/video_1.mp4");
  assert.equal(reply.output_url, `/projects/${projectId}/assets/videos/video_1.mp4`);
  assert.equal(reply.canvas_mutation.node_id, "video_1");
  assert.equal(reply.canvas_mutation.version, 1);

  // Ref upload: no preupload leg — deAPI takes the image bytes as direct
  // multipart form-data on the submit call itself.
  assert.equal(deapi.captures.submits.length, 1);
  const submit = deapi.captures.submits[0];
  assert.equal(submit.url, "/api/v2/videos/animations");
  const fields = submit.form.fields;
  assert.equal(fields.prompt, prompt);
  // The default model. Changing DEAPI_VIDEO_MODEL changes this — the point of
  // the getter on the registry entry.
  assert.equal(fields.model, "MiniMaxH3_33B_Turbo_INT8");
  assert.equal(fields.seed, "-1");
  // The default model PINS its dimensions (min_width === max_width), so a
  // 16:9 request snaps to 1344x768 rather than searching a resolution grid.
  assert.equal(fields.width, "1344");
  assert.equal(fields.height, "768");
  assert.equal(fields.fps, "24");
  assert.equal(fields.frames, "192");
  assert.equal(fields.steps, "8");
  const firstFrame = submit.form.files.find((f) => f.field === "first_frame_image");
  assert.ok(firstFrame, "first_frame_image file field present");
  assert.equal(firstFrame.filename, "image_1.png");

  // Node + ref edge landed in workflow.json via the real mutator.
  const wf = JSON.parse(await readFile(join(dir, "workflow.json"), "utf8"));
  assert.equal(wf.nodes.length, 2);
  const node = wf.nodes.find((n) => n.id === "video_1");
  assert.equal(node.type, "video_result");
  assert.equal(node.data.label, "dusk clip");
  assert.equal(node.data.prompt, prompt);
  assert.equal(node.data.duration, 8);
  assert.equal(node.data.aspect, "16:9");
  assert.equal(node.data.shot_id, 3);
  assert.equal(node.data.local_path, "assets/videos/video_1.mp4");
  assert.equal(node.data.metadata.source, "deapi");
  assert.equal(node.data.metadata.task_type, "video_generation");
  assert.equal(node.data.metadata.model, "video-generation");
  assert.equal(node.data.metadata.resolution, "720p");
  assert.equal(node.data.metadata.generate_audio, true);
  assert.equal(node.data.metadata.provider_output_url, reply.provider_output_url);
  assert.equal(node.data.metadata.effective_plan.route, "videos/animations");
  assert.ok(node.data.metadata.pending_job_id.startsWith("pending_"));
  assert.deepEqual(wf.edges, [{ from: "image_1", to: "video_1", kind: "derived" }]);

  // streamUrlToTmp downloaded the MP4; the mutator renamed it into place.
  const assetBytes = await readFile(join(dir, "assets", "videos", "video_1.mp4"));
  assert.deepEqual(assetBytes, MP4_BYTES);
  assert.deepEqual(await readdir(join(dir, "assets", ".tmp")), []);

  const jobId = node.data.metadata.pending_job_id;
  assert.equal(viewer.captures.mutateBodies.length, 1);
  assert.equal(viewer.captures.mutateBodies[0].pending_job_id, jobId);
  assert.equal(viewer.captures.preuploadBodies.length, 1);
  assert.equal(viewer.captures.preuploadBodies[0].local_path, "assets/videos/video_1.mp4");
  assert.equal(viewer.captures.preuploadBodies[0].mime_type, "video/mp4");

  // Sidecars: durable result written, pending removed.
  const sidecar = JSON.parse(await readFile(join(dir, ".results", `${jobId}.json`), "utf8"));
  assert.equal(sidecar.ok, true);
  assert.equal(sidecar.job_id, jobId);
  assert.deepEqual(await readdir(join(dir, ".pending")), []);
});

test("generate_video.js deAPI 422 on submit exits 1 with bad_args and no retry", async (t) => {
  const { projectId, dir } = await setupProject(t);
  const deapi = await makeDeapiServer({
    submitStatus: 422,
    submitErrorBody: { message: "synthetic submit rejection" },
  });
  t.after(() => new Promise((resolve) => deapi.server.close(resolve)));
  const viewer = await makeViewerServer({ dir, projectId });
  t.after(() => new Promise((resolve) => viewer.server.close(resolve)));

  const { code, stdout } = await runCli({
    script: "generate_video.js",
    args: [
      "--prompt", "a doomed clip",
      "--project-id", projectId,
    ],
    cwd: dir,
    env: {
      ...deapiEnv(deapi),
      VIEWER_HOST: "127.0.0.1",
      VIEWER_PORT: String(viewer.port),
    },
  });

  assert.equal(code, 1);
  const reply = parseReply(stdout);
  assert.equal(reply.ok, false);
  assert.equal(reply.klass, "bad_args");
  assert.match(reply.message, /deAPI 422: synthetic submit rejection/);
  assert.equal(reply.limits.max_image_refs, 2);
  assert.equal(reply.limits.max_audio_refs, 1);
  assert.deepEqual(reply.sent, {
    ref_source_ids: [],
    audio_source_ids: [],
    source_node_id: null,
    // --duration defaults to "10" (cli/generate_video.js) — the real
    // ceiling on the default LTX-2 model (241 frames @ 24fps ≈ 10.04s).
    duration: 10,
    aspect_ratio: "16:9",
    resolution: "720p",
    generate_audio: true,
  });
  // bad_args fails fast — exactly one submit attempt (no refs → videos/generations).
  assert.equal(deapi.captures.submits.length, 1);
  assert.equal(deapi.captures.submits[0].url, "/api/v2/videos/generations");
  assert.equal(deapi.captures.jobPolls, 0);

  // No new node, no asset, no leftover tmp; failure sidecar persisted.
  const wf = JSON.parse(await readFile(join(dir, "workflow.json"), "utf8"));
  assert.equal(wf.nodes.length, 1);
  assert.equal(viewer.captures.mutateBodies.length, 0);
  assert.deepEqual(await readdir(join(dir, "assets", ".tmp")), []);
  assert.deepEqual(await readdir(join(dir, "assets", "videos")), []);
  const results = await readdir(join(dir, ".results"));
  assert.equal(results.length, 1);
  const sidecar = JSON.parse(await readFile(join(dir, ".results", results[0]), "utf8"));
  assert.equal(sidecar.ok, false);
  assert.equal(sidecar.klass, "bad_args");
  assert.deepEqual(await readdir(join(dir, ".pending")), []);
});
