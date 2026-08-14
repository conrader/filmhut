// Unit tests for pai_video_client (deAPI-backed). submitVideo picks one
// of three deAPI routes from the refs (text/image/audio); pollVideo
// polls the job to terminal. Mirrors pai_image_client.test.js's style.

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { submitVideo, pollVideo } from "../pai_video_client.js";
import {
  installDeapiFetch,
  jsonResponse,
  errorJob,
  PNG_BYTES,
  DEFAULT_RESULT_URL,
} from "./helpers/deapi_fetch_mock.js";

function writeTmpFile(t, name, bytes = PNG_BYTES) {
  const p = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "deapi-video-test-")), name);
  fs.writeFileSync(p, bytes);
  t.after(() => fs.rmSync(path.dirname(p), { recursive: true, force: true }));
  return p;
}

test("submitVideo with no refs submits JSON to videos/generations", async (t) => {
  // Pinned to Ltx2: this asserts the 32px grid search, which a model with
  // fixed dimensions does not exercise.
  process.env.DEAPI_VIDEO_MODEL = "Ltx2_3_22B_Dist_INT8";
  t.after(() => { delete process.env.DEAPI_VIDEO_MODEL; });
  const calls = installDeapiFetch(t);

  const result = await submitVideo({
    prompt: "a drone shot over a canyon",
    duration: 5,
    aspectRatio: "16:9",
    resolution: "720p",
  });

  assert.equal(result.taskId, "req-1");
  assert.equal(result.costUsd, 0.0042);
  assert.equal(result.effective.route, "videos/generations");

  const submit = calls.find((c) => c.url === "https://deapi.test/api/v2/videos/generations" && c.method === "POST");
  assert.ok(submit, "expected a POST to videos/generations");
  assert.equal(submit.body.model, "Ltx2_3_22B_Dist_INT8");
  assert.equal(submit.body.fps, 24);
  // duration 5s * 24fps = 120 frames, inside [9, 241].
  assert.equal(submit.body.frames, 120);
  assert.equal(submit.body.steps, 8);
  assert.equal(submit.body.guidance, 3);
  assert.equal(submit.body.seed, -1);
  // 720p 16:9 on a 32px grid: no grid point hits 1.7778 exactly, so
  // deriveDimensions searches ±2 steps and keeps the closest ratio —
  // 1312x736 = 1.7826, within 0.3% of 16:9.
  assert.equal(submit.body.width, 1312);
  assert.equal(submit.body.height, 736);
  assert.ok(Math.abs((1312 / 736) - (16 / 9)) / (16 / 9) < 0.005);
});

test("submitVideo with image refs routes to videos/animations", async (t) => {
  const calls = installDeapiFetch(t);
  const ref1 = writeTmpFile(t, "first.png");

  const result1 = await submitVideo({ prompt: "animate", imageRefPaths: [ref1] });
  assert.equal(result1.effective.route, "videos/animations");
  const submit1 = calls.find((c) => c.url.endsWith("/api/v2/videos/animations"));
  assert.ok(submit1.form, "animations submit must be multipart");
  assert.equal(submit1.form.first_frame_image.filename, "first.png");
  assert.equal(submit1.form.last_frame_image, undefined);

  const ref2 = writeTmpFile(t, "last.png");
  await submitVideo({ prompt: "animate with last frame", imageRefPaths: [ref1, ref2] });
  const submit2 = calls.filter((c) => c.url.endsWith("/api/v2/videos/animations")).at(-1);
  assert.equal(submit2.form.first_frame_image.filename, "first.png");
  assert.equal(submit2.form.last_frame_image.filename, "last.png");

  const ref3 = writeTmpFile(t, "extra.png");
  await assert.rejects(
    submitVideo({ prompt: "too many", imageRefPaths: [ref1, ref2, ref3] }),
    (e) => e.klass === "bad_args",
  );
});

test("submitVideo with an audio ref routes to videos/audio-syncs", async (t) => {
  // audio2video exists only on Ltx2; the default model cannot do it.
  process.env.DEAPI_VIDEO_MODEL = "Ltx2_3_22B_Dist_INT8";
  t.after(() => { delete process.env.DEAPI_VIDEO_MODEL; });
  const calls = installDeapiFetch(t);
  const audio1 = writeTmpFile(t, "voice.mp3");

  const result = await submitVideo({ prompt: "sync to voice", audioRefPaths: [audio1] });
  assert.equal(result.effective.route, "videos/audio-syncs");
  const submit = calls.find((c) => c.url.endsWith("/api/v2/videos/audio-syncs"));
  assert.ok(submit.form, "audio-syncs submit must be multipart");
  assert.equal(submit.form.audio.filename, "voice.mp3");

  // an image ref may ride along as first_frame_image on the same route.
  const image = writeTmpFile(t, "frame.png");
  await submitVideo({ prompt: "sync with frame", audioRefPaths: [audio1], imageRefPaths: [image] });
  const submit2 = calls.filter((c) => c.url.endsWith("/api/v2/videos/audio-syncs")).at(-1);
  assert.equal(submit2.form.first_frame_image.filename, "frame.png");

  const audio2 = writeTmpFile(t, "voice2.mp3");
  await assert.rejects(
    submitVideo({ prompt: "too many audios", audioRefPaths: [audio1, audio2] }),
    (e) => e.klass === "bad_args",
  );
});

test("submitVideo rejects video refs before any provider call", async (t) => {
  const calls = installDeapiFetch(t);
  const clip = writeTmpFile(t, "clip.mp4");

  await assert.rejects(
    submitVideo({ prompt: "use a video ref", videoRefPaths: [clip] }),
    (e) => e.klass === "bad_args" && /video refs/.test(e.message),
  );
  assert.equal(calls.filter((c) => c.method === "POST").length, 0, "no paid calls on validation failures");
});

test("submitVideo rejects an empty prompt before any provider call", async (t) => {
  const calls = installDeapiFetch(t);
  await assert.rejects(submitVideo({}), (e) => e.klass === "bad_args");
  assert.equal(calls.filter((c) => c.method === "POST").length, 0);
});

test("pollVideo resolves videoUrl from the job's result_url", async (t) => {
  installDeapiFetch(t);
  const result = await pollVideo("req-1");
  assert.equal(result.videoUrl, DEFAULT_RESULT_URL);
  assert.equal(typeof result.durationSeconds, "number");
});

test("pollVideo maps AGE_RESTRICTED job errors to content_filtered", async (t) => {
  installDeapiFetch(t, {
    handler(entry) {
      if (entry.url.includes("/api/v2/jobs/")) {
        return jsonResponse(errorJob({ error_code: "AGE_RESTRICTED", error_message: "flagged" }));
      }
      return undefined;
    },
  });

  await assert.rejects(
    pollVideo("req-1"),
    (e) => e.klass === "content_filtered" && /AGE_RESTRICTED/.test(e.message),
  );
});

test("pollVideo throws infra when the job finishes with no result_url", async (t) => {
  installDeapiFetch(t, {
    handler(entry) {
      if (entry.url.includes("/api/v2/jobs/")) {
        return jsonResponse({ data: { status: "done", result_url: null, progress: 100 } });
      }
      return undefined;
    },
  });

  await assert.rejects(
    pollVideo("req-1"),
    (e) => e.klass === "infra" && /no result_url/.test(e.message),
  );
});
