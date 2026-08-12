// F4 — a paid job must survive the process that started it.
//
// The bug being fixed: the provider's job id lived only in CLI process memory
// between submit and poll, and the exit handlers deleted the pending sidecar.
// Ctrl-C during a 40-minute video render therefore left the user charged with
// no way to identify, resume, or collect the work.

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  clearResumable,
  listResumable,
  markResumableSync,
  recordProviderRef,
} from "../cli/_resume.js";

async function project() {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "pai-resume-"));
  await fsp.mkdir(path.join(dir, ".pending"), { recursive: true });
  return dir;
}

function stageJob(cwd, jobId, extra = {}) {
  const sidecar = {
    id: jobId,
    kind: "video",
    stage: "running",
    prompt: "a lighthouse in a storm",
    created_at: new Date().toISOString(),
    ...extra,
  };
  fs.writeFileSync(path.join(cwd, ".pending", `${jobId}.json`), JSON.stringify(sidecar, null, 2));
  return sidecar;
}

const read = (cwd, jobId) =>
  JSON.parse(fs.readFileSync(path.join(cwd, ".pending", `${jobId}.json`), "utf8"));

const exists = (cwd, jobId) => fs.existsSync(path.join(cwd, ".pending", `${jobId}.json`));

test("the provider id lands on disk, which is what makes recovery possible", async () => {
  const cwd = await project();
  stageJob(cwd, "pending_1");

  assert.equal(recordProviderRef("pending_1", "req_abc123", cwd), true);
  const after = read(cwd, "pending_1");
  assert.equal(after.provider_ref, "req_abc123");
  assert.ok(after.submitted_at, "the moment of commitment is recorded too");
});

test("an interrupted job is preserved, not deleted", async () => {
  const cwd = await project();
  stageJob(cwd, "pending_2");
  recordProviderRef("pending_2", "req_paid", cwd);

  assert.equal(markResumableSync("pending_2", cwd), "resumable");
  assert.ok(exists(cwd, "pending_2"), "the record of a paid job must survive shutdown");

  const after = read(cwd, "pending_2");
  assert.equal(after.resumable, true);
  assert.equal(after.provider_ref, "req_paid", "the id must still be there to collect with");
  assert.ok(after.interrupted_at);
});

test("a job that never reached the supplier is discarded, not resurrected", async () => {
  const cwd = await project();
  stageJob(cwd, "pending_3"); // no provider_ref: nothing was ever submitted

  assert.equal(markResumableSync("pending_3", cwd), "discarded");
  assert.equal(exists(cwd, "pending_3"), false, "nothing is owed, so nothing to keep");
});

test("a fresh process finds exactly the jobs worth resuming", async () => {
  const cwd = await project();

  stageJob(cwd, "paid_and_interrupted");
  recordProviderRef("paid_and_interrupted", "req_1", cwd);
  markResumableSync("paid_and_interrupted", cwd);

  stageJob(cwd, "still_running");                 // live, not interrupted
  recordProviderRef("still_running", "req_2", cwd);

  stageJob(cwd, "never_submitted");               // no ref at all

  const found = listResumable(cwd);
  assert.equal(found.length, 1, "only the interrupted, paid job is resumable");
  assert.equal(found[0].id, "paid_and_interrupted");
  assert.equal(found[0].provider_ref, "req_1");
});

test("resuming clears the flag so the job is not picked up twice", async () => {
  const cwd = await project();
  stageJob(cwd, "pending_4");
  recordProviderRef("pending_4", "req_x", cwd);
  markResumableSync("pending_4", cwd);

  assert.equal(listResumable(cwd).length, 1);
  assert.equal(clearResumable("pending_4", cwd), true);
  assert.equal(listResumable(cwd).length, 0);

  const after = read(cwd, "pending_4");
  assert.equal(after.resumable, undefined);
  assert.ok(after.resumed_at);
  assert.equal(after.provider_ref, "req_x", "the id survives a resume");
});

test("the ordering that matters: the id is durable BEFORE any poll begins", async () => {
  const cwd = await project();
  stageJob(cwd, "pending_5");

  // Simulate the real sequence. `poll` reads the sidecar the way a separate
  // recovering process would — through the filesystem, not through memory.
  let refVisibleToAnotherProcess = null;
  const submit = () => "req_from_provider";
  const poll = () => {
    refVisibleToAnotherProcess = read(cwd, "pending_5").provider_ref ?? null;
  };

  const ref = submit();
  recordProviderRef("pending_5", ref, cwd);
  poll();

  assert.equal(
    refVisibleToAnotherProcess,
    "req_from_provider",
    "if this is null, a crash here loses a paid job",
  );
});

test("bookkeeping never invents work", async () => {
  const cwd = await project();
  // No sidecar: a CLI run outside a project directory tracks nothing.
  assert.equal(recordProviderRef("ghost", "req", cwd), false);
  assert.equal(markResumableSync("ghost", cwd), "missing");
  assert.equal(clearResumable("ghost", cwd), false);
  assert.equal(listResumable(cwd).length, 0);

  // Junk refs are refused rather than written.
  stageJob(cwd, "pending_6");
  assert.equal(recordProviderRef("pending_6", "", cwd), false);
  assert.equal(recordProviderRef("pending_6", "   ", cwd), false);
  assert.equal(recordProviderRef("pending_6", undefined, cwd), false);
  assert.equal(read(cwd, "pending_6").provider_ref, undefined);
});

test("listResumable tolerates a missing or junk-filled pending directory", async () => {
  const cwd = await fsp.mkdtemp(path.join(os.tmpdir(), "pai-resume-bare-"));
  assert.deepEqual(listResumable(cwd), [], "no .pending dir at all");

  await fsp.mkdir(path.join(cwd, ".pending"));
  await fsp.writeFile(path.join(cwd, ".pending", "notes.txt"), "not json");
  await fsp.writeFile(path.join(cwd, ".pending", "broken.json"), "{{{");
  assert.deepEqual(listResumable(cwd), [], "a corrupt sidecar must not crash recovery");
});

test("no CLI deletes a pending sidecar on the way out any more", async () => {
  const cliDir = new URL("../cli/", import.meta.url);
  for (const file of [
    "generate_image.js", "generate_image_pro.js",
    "generate_video.js", "generate_voice.js", "upscaler.js",
  ]) {
    const src = await fsp.readFile(new URL(file, cliDir), "utf8");
    assert.equal(
      /process\.on\("SIG(INT|TERM)"[\s\S]{0,120}removePendingSync/.test(src),
      false,
      `${file} still deletes its sidecar on signal — that is the money-losing bug`,
    );
    assert.match(src, /protectOnExit\(jobId\)/, `${file} must preserve paid work on exit`);
    assert.match(src, /recordProviderRef/, `${file} must make the provider id durable`);
  }
});
