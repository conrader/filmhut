// Full-path spawn tests for cli/generate_voice.js (deAPI tts).
//
// Cloned from generate_image_pro_cli.test.js: fake deAPI server
// (DEAPI_API_BASE), fake viewer HTTP server for /mutate + /preupload-asset,
// runCli spawn helper, throwaway project under PAI_REPO_ROOT/projects
// (local_mirror.js hardcodes that root, so PAI_PROJECTS_DIR can't redirect
// the CLIs).
// One deliberate upgrade over the pro harness: the fake viewer routes
// /mutate through the real canvas_mutator, so tests can assert the node
// actually landed in workflow.json and the staged tmp file was renamed
// into assets/audios/<node-id>.mp3.

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
const MP3_BYTES = Buffer.from([0x49, 0x44, 0x33, 0x03, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]);

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

// Seeds an image_1 anchor node so --source-node-id can draw a derived edge.
async function setupProject(t) {
  const projectId = `voc_cli_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const dir = join(PAI_REPO_ROOT, "projects", projectId);
  await mkdir(join(dir, "assets", ".tmp"), { recursive: true });
  await mkdir(join(dir, "assets", "images"), { recursive: true });
  await mkdir(join(dir, "assets", "audios"), { recursive: true });
  await writeFile(join(dir, "assets", "images", "image_1.png"), PNG_BYTES);
  const anchor = {
    id: "image_1",
    type: "image_result",
    data: {
      label: "hero portrait",
      local_path: "assets/images/image_1.png",
      metadata: { source: "test" },
    },
  };
  await writeFile(
    join(dir, "workflow.json"),
    JSON.stringify({ version: 2, workflow_id: projectId, title: "T", nodes: [anchor], edges: [] }) + "\n",
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

test("generate_voice.js direct fire lands anchored audio node + mp3 asset", async (t) => {
  const { projectId, dir } = await setupProject(t);
  const deapi = await makeDeapiServer({ resultExt: "mp3", resultBytes: MP3_BYTES, resultContentType: "audio/mpeg" });
  t.after(() => new Promise((resolve) => deapi.server.close(resolve)));
  const viewer = await makeViewerServer({ dir, projectId });
  t.after(() => new Promise((resolve) => viewer.server.close(resolve)));

  const text = "Hello there, traveler.";
  const brief = "warm baritone, slow, slight rasp";
  const { code, stdout, stderr } = await runCli({
    script: "generate_voice.js",
    args: [
      "--text", text,
      "--prompt", brief,
      "--source-node-id", "image_1",
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
  assert.equal(reply.model, "tts");
  assert.equal(reply.text, text);
  assert.equal(reply.prompt, brief);
  assert.equal(reply.audio_duration_seconds, null);
  assert.equal(typeof reply.wall_clock_seconds, "number");
  assert.equal(reply.local_path, "assets/audios/audio_1.mp3");
  assert.equal(reply.output_url, `/projects/${projectId}/assets/audios/audio_1.mp3`);
  assert.equal(reply.cost_usd, 0.0042);
  assert.equal(reply.canvas_mutation.node_id, "audio_1");
  assert.equal(reply.canvas_mutation.version, 1);

  // Upstream wire contract: multipart submit to audio/speech. Default
  // catalog model (Qwen3_TTS_12Hz_1_7B_VoiceDesign) advertises
  // supports_voice_design → voice_design mode, brief drives the voice
  // directly (no preset voice field).
  assert.equal(deapi.captures.submits.length, 1);
  const submit = deapi.captures.submits[0];
  assert.equal(submit.url, "/api/v2/audio/speech");
  const sentFields = submit.form.fields;
  assert.equal(sentFields.model, "Qwen3_TTS_12Hz_1_7B_VoiceDesign");
  assert.equal(sentFields.text, text);
  assert.equal(sentFields.instruct, brief);
  assert.equal(sentFields.mode, "voice_design");
  assert.equal(sentFields.voice, undefined);
  assert.equal(sentFields.format, "mp3");

  // Node + authorship edge landed in workflow.json via the real mutator.
  const wf = JSON.parse(await readFile(join(dir, "workflow.json"), "utf8"));
  assert.equal(wf.nodes.length, 2);
  const node = wf.nodes.find((n) => n.id === "audio_1");
  assert.equal(node.type, "audio_result");
  assert.equal(node.data.subtype, "voice");
  assert.equal(node.data.label, text);
  assert.equal(node.data.text, text);
  assert.equal(node.data.prompt, brief);
  assert.equal(node.data.source_id, "image_1");
  assert.equal(node.data.local_path, "assets/audios/audio_1.mp3");
  assert.equal(node.data.metadata.source, "deapi");
  assert.equal(node.data.metadata.task_type, "tts");
  assert.equal(node.data.metadata.model, "tts");
  assert.ok(!("duration_sec" in node.data.metadata), "deAPI tts envelope has no duration");
  assert.ok(node.data.metadata.pending_job_id.startsWith("pending_"));
  assert.deepEqual(wf.edges, [{ from: "image_1", to: "audio_1", kind: "derived" }]);

  // The staged tmp file was renamed into assets/audios/ (not copied).
  const assetBytes = await readFile(join(dir, "assets", "audios", "audio_1.mp3"));
  assert.deepEqual(assetBytes, MP3_BYTES);
  assert.deepEqual(await readdir(join(dir, "assets", ".tmp")), []);

  // Voice preupload kick carries no mime type (kind inferred from .mp3).
  const jobId = node.data.metadata.pending_job_id;
  assert.equal(viewer.captures.mutateBodies.length, 1);
  assert.equal(viewer.captures.mutateBodies[0].pending_job_id, jobId);
  assert.deepEqual(viewer.captures.preuploadBodies, [{ local_path: "assets/audios/audio_1.mp3" }]);

  // Sidecars: durable result written, pending removed.
  const sidecar = JSON.parse(await readFile(join(dir, ".results", `${jobId}.json`), "utf8"));
  assert.equal(sidecar.ok, true);
  assert.equal(sidecar.job_id, jobId);
  assert.deepEqual(await readdir(join(dir, ".pending")), []);
});

test("generate_voice.js deAPI 422 exits 1 with bad_args and no retry", async (t) => {
  const { projectId, dir } = await setupProject(t);
  const deapi = await makeDeapiServer({
    submitStatus: 422,
    submitErrorBody: { message: "synthetic tts rejection" },
  });
  t.after(() => new Promise((resolve) => deapi.server.close(resolve)));
  const viewer = await makeViewerServer({ dir, projectId });
  t.after(() => new Promise((resolve) => viewer.server.close(resolve)));

  const { code, stdout } = await runCli({
    script: "generate_voice.js",
    args: [
      "--text", "doomed line",
      "--prompt", "doomed brief",
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
  assert.match(reply.message, /deAPI 422: synthetic tts rejection/);
  assert.deepEqual(reply.limits, { min_text_chars: 10, max_text_chars: 5000 });
  assert.deepEqual(reply.sent, {
    text_chars: "doomed line".length,
    prompt_chars: "doomed brief".length,
    source_node_id: null,
  });
  // bad_args fails fast — exactly one upstream submit attempt.
  assert.equal(deapi.captures.submits.length, 1);

  // No new node, no asset, no leftover tmp; failure sidecar persisted.
  const wf = JSON.parse(await readFile(join(dir, "workflow.json"), "utf8"));
  assert.equal(wf.nodes.length, 1);
  assert.equal(viewer.captures.mutateBodies.length, 0);
  assert.deepEqual(await readdir(join(dir, "assets", ".tmp")), []);
  assert.deepEqual(await readdir(join(dir, "assets", "audios")), []);
  const results = await readdir(join(dir, ".results"));
  assert.equal(results.length, 1);
  const sidecar = JSON.parse(await readFile(join(dir, ".results", results[0]), "utf8"));
  assert.equal(sidecar.ok, false);
  assert.equal(sidecar.klass, "bad_args");
  assert.deepEqual(await readdir(join(dir, ".pending")), []);
});
