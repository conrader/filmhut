// Unit tests for pai_image_pro_client (deAPI-backed). Mirrors
// pai_image_client.test.js's shared-mock style — no refs routes JSON to
// images/generations at the pro model slug; refs route multipart to
// images/edits at the edit slug, running at the edit model's own
// default steps (higher-quality tier, not the standard tier's override).

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { generateImagePro } from "../pai_image_pro_client.js";
import {
  installDeapiFetch,
  jsonResponse,
  bytesResponse,
  doneJob,
  errorJob,
  PNG_BYTES,
  RESULTS_HOST,
} from "./helpers/deapi_fetch_mock.js";

function writeTmpPng(t) {
  const p = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "deapi-imgpro-test-")), "ref.png");
  fs.writeFileSync(p, PNG_BYTES);
  t.after(() => fs.rmSync(path.dirname(p), { recursive: true, force: true }));
  return p;
}

test("generateImagePro with no refs submits to images/generations at the pro slug", async (t) => {
  const calls = installDeapiFetch(t);

  const result = await generateImagePro({
    prompt: "a clean product render",
    size: "1024x1024",
  });

  assert.equal(result.model, "image-generation-pro");
  assert.equal(result.size, "1024x1024");
  assert.equal(result.imageSize, "1K");
  assert.equal(result.aspectRatio, "1:1");
  assert.equal(result.mime, "image/png");
  assert.deepEqual(result.bytes, PNG_BYTES);
  assert.equal(result.costUsd, 0.0042);

  const submit = calls.find((c) => c.url === "https://deapi.test/api/v2/images/generations" && c.method === "POST");
  assert.ok(submit, "expected a POST to images/generations");
  assert.equal(submit.body.model, "Flux_2_Klein_4B_BF16");
  assert.equal(submit.body.prompt, "a clean product render");
  assert.equal(submit.body.seed, -1);
  // 1024x1024 already sits on FLUX.2's 16px grid within its 2048 max.
  assert.equal(submit.body.width, 1024);
  assert.equal(submit.body.height, 1024);
  // txt2img steps come from the catalog defaults (no supports_steps override here).
  assert.equal(submit.body.steps, 4);
});

test("generateImagePro with one ref routes to images/edits at the edit slug", async (t) => {
  const refPath = writeTmpPng(t);
  const calls = installDeapiFetch(t);

  const result = await generateImagePro({
    prompt: "match the reference",
    refImagePaths: [refPath],
  });
  assert.deepEqual(result.bytes, PNG_BYTES);

  const submit = calls.find((c) => c.url === "https://deapi.test/api/v2/images/edits" && c.method === "POST");
  assert.ok(submit, "expected a POST to images/edits");
  assert.ok(submit.form, "edit submit must be multipart form data");
  assert.equal(submit.form.model, "Flux_2_Klein_4B_BF16");
  assert.equal(submit.form.image.filename, "ref.png");
  // Pro tier runs edits at the edit model's own default steps (4 for
  // Flux_2_Klein_4B_BF16, whose min/max steps are both pinned at 4).
  assert.equal(submit.form.steps, "4");
  // Flux_2_Klein_4B_BF16 declares supports_custom_output_size: true, so
  // dims ARE sent (default 1024x1024 size already fits the model's box).
  assert.equal(submit.form.width, "1024");
  assert.equal(submit.form.height, "1024");
});

test("generateImagePro with two refs sends images[] array", async (t) => {
  const refA = writeTmpPng(t);
  const refB = writeTmpPng(t);
  const calls = installDeapiFetch(t);

  await generateImagePro({ prompt: "combine references", refImagePaths: [refA, refB] });

  const submit = calls.find((c) => c.url.endsWith("/api/v2/images/edits"));
  assert.ok(Array.isArray(submit.form["images[]"]));
  assert.equal(submit.form["images[]"].length, 2);
});

test("generateImagePro validates size, output_format, and ref cap before any provider call", async (t) => {
  const calls = installDeapiFetch(t);

  await assert.rejects(
    generateImagePro({ prompt: "x", size: "1920x1080" }),
    (e) => e.klass === "bad_args" && /unsupported size/.test(e.message),
  );
  await assert.rejects(
    generateImagePro({ prompt: "x", outputFormat: "webp" }),
    (e) => e.klass === "bad_args" && /output_format/.test(e.message),
  );
  await assert.rejects(
    generateImagePro({
      prompt: "x",
      refImagePaths: Array.from({ length: 33 }, () => "/does/not/matter.png"),
    }),
    (e) => e.klass === "bad_args" && /reference cap/.test(e.message),
  );
  assert.equal(calls.filter((c) => c.method === "POST").length, 0, "no paid calls on validation failures");
});

test("generateImagePro jpeg output downloads the job's results_alt_formats.jpg URL", async (t) => {
  const jpgUrl = `${RESULTS_HOST}/out.jpg?sig=1`;
  installDeapiFetch(t, {
    handler(entry) {
      if (entry.url.includes("/api/v2/jobs/")) {
        return jsonResponse(doneJob({
          results_alt_formats: { jpg: jpgUrl, webp: `${RESULTS_HOST}/out.webp?sig=1` },
        }));
      }
      if (entry.url === jpgUrl) return bytesResponse(PNG_BYTES, "image/jpeg");
      return undefined;
    },
  });

  const result = await generateImagePro({ prompt: "x", outputFormat: "jpeg" });
  assert.equal(result.mime, "image/jpeg");
  assert.deepEqual(result.bytes, PNG_BYTES);
});

test("generateImagePro rejects URL/data: refs and missing files pre-call", async (t) => {
  const calls = installDeapiFetch(t);

  await assert.rejects(
    generateImagePro({ prompt: "x", refImagePaths: ["https://example.com/a.png"] }),
    (e) => e.klass === "bad_args" && /local file paths/.test(e.message),
  );
  await assert.rejects(
    generateImagePro({ prompt: "x", refImagePaths: ["data:image/png;base64,abcd"] }),
    (e) => e.klass === "bad_args",
  );
  await assert.rejects(
    generateImagePro({ prompt: "x", refImagePaths: ["/definitely/missing/ref.png"] }),
    (e) => e.klass === "bad_args" && /not found/.test(e.message),
  );
  assert.equal(calls.filter((c) => c.method === "POST").length, 0);
});

test("generateImagePro maps a job error with AGE_RESTRICTED to content_filtered", async (t) => {
  installDeapiFetch(t, {
    handler(entry) {
      if (entry.url.includes("/api/v2/jobs/")) {
        return jsonResponse(errorJob({ error_code: "AGE_RESTRICTED", error_message: "flagged" }));
      }
      return undefined;
    },
  });

  await assert.rejects(
    generateImagePro({ prompt: "x" }),
    (e) => e.klass === "content_filtered" && /AGE_RESTRICTED/.test(e.message),
  );
});
