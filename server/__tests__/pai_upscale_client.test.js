// Unit tests for pai_upscale_client (deAPI-backed). quoteUpscale prices
// via POST /api/v2/videos/upscales/price; submitUpscale uploads the
// source file inline via POST /api/v2/videos/upscales; pollUpscale polls
// the job to terminal. Scale is derived from source resolution against
// a 3840px long-side target, clamped into the model's min/max_scale (or
// omitted entirely for fixed-factor models).

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { quoteUpscale, submitUpscale, pollUpscale, UPSCALE_MODEL_ID } from "../pai_upscale_client.js";
import {
  installDeapiFetch,
  jsonResponse,
  errorJob,
  DEFAULT_CATALOG,
  DEFAULT_RESULT_URL,
} from "./helpers/deapi_fetch_mock.js";

function writeTmpMp4(t) {
  const p = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "deapi-upscale-test-")), "source.mp4");
  fs.writeFileSync(p, Buffer.from([0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70]));
  t.after(() => fs.rmSync(path.dirname(p), { recursive: true, force: true }));
  return p;
}

test("UPSCALE_MODEL_ID is the registry capability id", () => {
  assert.equal(UPSCALE_MODEL_ID, "video-upscale");
});

test("quoteUpscale prices from source dimensions and derives scale toward 4K", async (t) => {
  const calls = installDeapiFetch(t);

  const result = await quoteUpscale({ sourceSpec: { width: 1280, height: 720, duration: 5, size: 1_000_000 } });
  assert.equal(result.costUsd, 0.0042);
  // 3840 / 1280 = 3, inside FlashVSR_Tiny's [2, 4] range.
  assert.equal(result.scale, 3);
  assert.equal(result.modelSlug, "FlashVSR_Tiny");

  const priced = calls.find((c) => c.url.endsWith("/api/v2/videos/upscales/price") && c.method === "POST");
  assert.ok(priced, "expected a POST to videos/upscales/price");
  assert.equal(priced.body.model, "FlashVSR_Tiny");
  assert.equal(priced.body.width, 1280);
  assert.equal(priced.body.height, 720);
  assert.equal(priced.body.duration, 5);
  assert.equal(priced.body.scale, 3);
});

test("quoteUpscale rejects a source over the model's duration cap or the 50MB size cap", async (t) => {
  const calls = installDeapiFetch(t);

  await assert.rejects(
    quoteUpscale({ sourceSpec: { width: 1280, height: 720, duration: 61, size: 1_000_000 } }),
    (e) => e.klass === "bad_args" && /60s/.test(e.message),
  );
  await assert.rejects(
    quoteUpscale({ sourceSpec: { width: 1280, height: 720, duration: 5, size: 51 * 1024 * 1024 } }),
    (e) => e.klass === "bad_args" && /50MB/.test(e.message),
  );
  assert.equal(calls.filter((c) => c.method === "POST").length, 0, "no paid calls on validation failures");
});

test("quoteUpscale rejects a source over the model's max_width before any POST", async (t) => {
  const calls = installDeapiFetch(t);

  // FlashVSR_Tiny's input box caps at 1920x1920.
  await assert.rejects(
    quoteUpscale({ sourceSpec: { width: 3840, height: 2160, duration: 5, size: 1_000_000 } }),
    (e) => e.klass === "bad_args" && /3840x2160/.test(e.message) && /1920x1920/.test(e.message),
  );
  assert.equal(calls.filter((c) => c.method === "POST").length, 0, "no paid calls on validation failures");
});

test("quoteUpscale omits scale for a fixed-factor model (min/max_scale null)", async (t) => {
  const catalog = DEFAULT_CATALOG.map((m) => (m.slug !== "FlashVSR_Tiny" ? m : {
    ...m,
    info: { ...m.info, limits: { ...m.info.limits, min_scale: null, max_scale: null } },
  }));
  const calls = installDeapiFetch(t, { catalog });

  const result = await quoteUpscale({ sourceSpec: { width: 1280, height: 720, duration: 5, size: 1_000_000 } });
  assert.equal(result.scale, null);

  const priced = calls.find((c) => c.url.endsWith("/api/v2/videos/upscales/price"));
  assert.equal(priced.body.scale, undefined);
});

test("submitUpscale uploads the source file as multipart with model and scale", async (t) => {
  const filePath = writeTmpMp4(t);
  const calls = installDeapiFetch(t);

  const result = await submitUpscale({
    filePath,
    sourceSpec: { width: 1280, height: 720, duration: 5, size: fs.statSync(filePath).size },
  });
  assert.equal(result.taskId, "req-1");
  assert.equal(result.scale, 3);

  const submit = calls.find((c) => c.url === "https://deapi.test/api/v2/videos/upscales" && c.method === "POST");
  assert.ok(submit, "expected a POST to videos/upscales");
  assert.ok(submit.form, "upscale submit must be multipart form data");
  assert.equal(submit.form.model, "FlashVSR_Tiny");
  assert.equal(submit.form.scale, "3");
  assert.equal(submit.form.video.filename, "source.mp4");
});

test("pollUpscale resolves videoUrl from the job's result_url", async (t) => {
  installDeapiFetch(t);
  const result = await pollUpscale("req-1");
  assert.equal(result.videoUrl, DEFAULT_RESULT_URL);
  assert.equal(typeof result.durationSeconds, "number");
});

test("pollUpscale maps a job error to its classified klass", async (t) => {
  installDeapiFetch(t, {
    handler(entry) {
      if (entry.url.includes("/api/v2/jobs/")) {
        return jsonResponse(errorJob({ error_code: "WORKER_TIMEOUT", error_message: "gave up" }));
      }
      return undefined;
    },
  });

  await assert.rejects(
    pollUpscale("req-1"),
    (e) => e.klass === "transient" && /WORKER_TIMEOUT/.test(e.message),
  );
});
