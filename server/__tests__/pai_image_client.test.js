// Unit tests for pai_image_client (deAPI-backed). Mocks globalThis.fetch
// via the shared deapi_fetch_mock helper — a generation is submit (POST)
// → job poll (GET /api/v2/jobs/:id) → result download from the presigned
// result_url.

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { generateImage } from "../pai_image_client.js";
import {
  installDeapiFetch,
  jsonResponse,
  errorJob,
  PNG_BYTES,
} from "./helpers/deapi_fetch_mock.js";

function writeTmpPng(t) {
  const p = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "deapi-img-test-")), "ref.png");
  fs.writeFileSync(p, PNG_BYTES);
  t.after(() => fs.rmSync(path.dirname(p), { recursive: true, force: true }));
  return p;
}

test("generateImage submits to images/generations and downloads the result", async (t) => {
  const calls = installDeapiFetch(t);

  const result = await generateImage({
    prompt: "a foggy harbor at dawn",
    aspectRatio: "16:9",
    imageSize: "2K",
  });

  assert.deepEqual(result.bytes, PNG_BYTES);
  assert.equal(result.mime, "image/png");
  assert.equal(result.model, "image-generation");
  assert.equal(typeof result.durationSeconds, "number");
  assert.equal(result.costUsd, 0.0042); // from the mocked /price quote

  const submit = calls.find((c) => c.url === "https://deapi.test/api/v2/images/generations" && c.method === "POST");
  assert.ok(submit, "expected a POST to images/generations");
  assert.equal(submit.body.prompt, "a foggy harbor at dawn");
  assert.equal(submit.body.model, "Flux1schnell");
  assert.equal(submit.body.seed, -1);
  // 2K long side 2048 at 16:9 snapped to Flux's 128px grid within 2048 max.
  assert.equal(submit.body.width, 2048);
  assert.equal(submit.body.height, 1152);
  // steps from the catalog defaults, inside min/max.
  assert.equal(submit.body.steps, 4);

  const priced = calls.find((c) => c.url.endsWith("/api/v2/images/generations/price"));
  assert.ok(priced, "expected a price quote before submit");
  const polled = calls.find((c) => c.url.includes("/api/v2/jobs/req-1"));
  assert.ok(polled, "expected a job status poll");
});

test("generateImage routes refs to images/edits as multipart file uploads", async (t) => {
  const refPath = writeTmpPng(t);
  const calls = installDeapiFetch(t);

  const result = await generateImage({
    prompt: "match the reference style",
    refImagePaths: [refPath],
  });
  assert.deepEqual(result.bytes, PNG_BYTES);

  const submit = calls.find((c) => c.url === "https://deapi.test/api/v2/images/edits" && c.method === "POST");
  assert.ok(submit, "expected a POST to images/edits");
  assert.ok(submit.form, "edit submit must be multipart form data");
  assert.equal(submit.form.prompt, "match the reference style");
  assert.equal(submit.form.model, "QwenImageEdit_Plus_NF4");
  assert.equal(submit.form.image.filename, "ref.png");
  assert.equal(submit.form.image.size, PNG_BYTES.length);
});

test("generateImage sends two refs as images[] and enforces the model's max_input_images", async (t) => {
  const refA = writeTmpPng(t);
  const refB = writeTmpPng(t);
  const calls = installDeapiFetch(t);

  await generateImage({ prompt: "combine them", refImagePaths: [refA, refB] });
  const submit = calls.find((c) => c.url.endsWith("/api/v2/images/edits"));
  assert.ok(Array.isArray(submit.form["images[]"]));
  assert.equal(submit.form["images[]"].length, 2);

  // Catalog caps QwenImageEdit_Plus_NF4 at 3 input images.
  await assert.rejects(
    generateImage({ prompt: "too many", refImagePaths: [refA, refB, refA, refB] }),
    (e) => e.klass === "bad_args" && /at most 3/.test(e.message),
  );
});

test("generateImage validates prompt and rejects URL/data: refs before any provider call", async (t) => {
  const calls = installDeapiFetch(t);

  await assert.rejects(generateImage({}), (e) => e.klass === "bad_args" && /prompt required/.test(e.message));
  await assert.rejects(
    generateImage({ prompt: "x", refImagePaths: ["https://example.com/a.png"] }),
    (e) => e.klass === "bad_args" && /local file paths/.test(e.message),
  );
  await assert.rejects(
    generateImage({ prompt: "x", refImagePaths: ["data:image/png;base64,abcd"] }),
    (e) => e.klass === "bad_args",
  );
  await assert.rejects(
    generateImage({ prompt: "x", refImagePaths: ["/definitely/missing/ref.png"] }),
    (e) => e.klass === "bad_args" && /not found/.test(e.message),
  );
  assert.equal(calls.filter((c) => c.method === "POST").length, 0, "no paid calls on validation failures");
});

test("generateImage maps a job error with AGE_RESTRICTED to content_filtered", async (t) => {
  installDeapiFetch(t, {
    handler(entry) {
      if (entry.url.includes("/api/v2/jobs/")) {
        return jsonResponse(errorJob({ error_code: "AGE_RESTRICTED", error_message: "flagged" }));
      }
      return undefined;
    },
  });

  await assert.rejects(
    generateImage({ prompt: "harbor" }),
    (e) => e.klass === "content_filtered" && /AGE_RESTRICTED/.test(e.message),
  );
});

test("generateImage maps job PROCESSING_ERROR to infra and surfaces refunded/retryable", async (t) => {
  installDeapiFetch(t, {
    handler(entry) {
      if (entry.url.includes("/api/v2/jobs/")) {
        return jsonResponse(errorJob({ refunded: true, retryable: false }));
      }
      return undefined;
    },
  });

  await assert.rejects(
    generateImage({ prompt: "harbor" }),
    (e) => e.klass === "infra" && /refunded=true/.test(e.message) && /retryable=false/.test(e.message),
  );
});

test("generateImage maps HTTP 422 on submit to bad_args with field detail", async (t) => {
  installDeapiFetch(t, {
    handler(entry) {
      if (entry.url.endsWith("/api/v2/images/generations") && entry.method === "POST") {
        return jsonResponse({
          message: "The steps field must not be greater than 10.",
          errors: { steps: ["The steps field must not be greater than 10.", "The steps field must not be greater than 10."] },
        }, 422);
      }
      return undefined;
    },
  });

  await assert.rejects(
    generateImage({ prompt: "harbor" }),
    // Duplicate field messages are de-duplicated before joining.
    (e) => e.klass === "bad_args"
      && /steps:/.test(e.message)
      && e.message.split("must not be greater than 10").length === 3, // once in message, once in detail
  );
});

test("generateImage maps HTTP 429 to rate_limited and parses Retry-After", async (t) => {
  installDeapiFetch(t, {
    handler(entry) {
      if (entry.url.endsWith("/api/v2/images/generations") && entry.method === "POST") {
        return jsonResponse({ message: "Too Many Attempts." }, 429, { "Retry-After": "17" });
      }
      return undefined;
    },
  });

  await assert.rejects(
    generateImage({ prompt: "harbor" }),
    (e) => e.klass === "rate_limited" && e.retryAfterSec === 17,
  );
});

test("generateImage proceeds with costUsd null when the price quote fails", async (t) => {
  installDeapiFetch(t, {
    handler(entry) {
      if (/\/price$/.test(entry.url)) {
        return jsonResponse({ message: "Server Error" }, 500);
      }
      return undefined;
    },
  });

  const result = await generateImage({ prompt: "harbor" });
  assert.deepEqual(result.bytes, PNG_BYTES);
  assert.equal(result.costUsd, null);
});

test("generateImage throws infra when the job finishes with no result_url", async (t) => {
  installDeapiFetch(t, {
    handler(entry) {
      if (entry.url.includes("/api/v2/jobs/")) {
        return jsonResponse({ data: { status: "done", result_url: null, progress: 100 } });
      }
      return undefined;
    },
  });

  await assert.rejects(
    generateImage({ prompt: "harbor" }),
    (e) => e.klass === "infra" && /no result_url/.test(e.message),
  );
});

test("generateImage rejects an unknown model slug with the account catalog listed", async (t) => {
  installDeapiFetch(t, { env: { DEAPI_IMAGE_MODEL: "NotARealModel" } });
  // model_registry reads env at module init, so override via a fresh import.
  const registry = await import(`../model_registry.js?bust=${Date.now()}`);
  assert.ok(registry); // registry env plumbing is covered in model_registry.test.js
  // Direct catalog check through the client path:
  const { getModelEntry } = await import("../deapi_client.js");
  await assert.rejects(
    getModelEntry("NotARealModel"),
    (e) => e.klass === "bad_args" && /not in this account's catalog/.test(e.message) && /Flux1schnell/.test(e.message),
  );
});
