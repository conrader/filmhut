// Unit tests for pai_voice_client (deAPI-backed). generateVoice submits
// multipart to POST /api/v2/audio/speech, polls to terminal, and
// downloads the presigned MP3. Mode (custom_voice vs voice_design)
// adapts to the configured model's catalog entry.

import test from "node:test";
import assert from "node:assert/strict";

import { generateVoice } from "../pai_voice_client.js";
import {
  installDeapiFetch,
  jsonResponse,
  bytesResponse,
  DEFAULT_CATALOG,
} from "./helpers/deapi_fetch_mock.js";

function cloneCatalogWith(slug, patch) {
  return DEFAULT_CATALOG.map((m) => {
    if (m.slug !== slug) return m;
    return { ...m, info: { ...m.info, ...patch.info, limits: { ...m.info.limits, ...patch.info?.limits }, features: { ...m.info.features, ...patch.info?.features } }, ...(patch.languages ? { languages: patch.languages } : {}) };
  });
}

test("generateVoice with the default Kokoro model uses custom_voice mode", async (t) => {
  const calls = installDeapiFetch(t, {
    handler(entry) {
      if (entry.url.startsWith("https://results.deapi.test")) return bytesResponse(Buffer.from("id3"), "audio/mpeg");
      return undefined;
    },
  });

  const result = await generateVoice({ text: "hello there", prompt: "warm, calm narrator" });

  assert.equal(result.mime, "audio/mpeg");
  assert.equal(result.model, "tts");
  assert.equal(result.predictionId, "req-1");
  assert.equal(result.costUsd, 0.0042);

  const submit = calls.find((c) => c.url === "https://deapi.test/api/v2/audio/speech" && c.method === "POST");
  assert.ok(submit, "expected a POST to audio/speech");
  assert.ok(submit.form, "tts submit must be multipart form data");
  assert.equal(submit.form.text, "hello there");
  assert.equal(submit.form.model, "Kokoro");
  assert.equal(submit.form.lang, "en-us");
  assert.equal(submit.form.speed, "1");
  assert.equal(submit.form.format, "mp3");
  assert.equal(submit.form.sample_rate, "24000");
  assert.equal(submit.form.mode, "custom_voice");
  assert.equal(submit.form.voice, "af_sky");
  assert.equal(submit.form.instruct, "warm, calm narrator");
});

test("generateVoice uses voice_design mode when the model advertises supports_voice_design", async (t) => {
  // Override the Kokoro catalog entry to advertise voice_design instead
  // of preset voices — env can't steer this (model_registry reads
  // DEAPI_TTS_MODEL at import time, already resolved to Kokoro).
  const catalog = cloneCatalogWith("Kokoro", { info: { features: { supports_voice_design: true } } });
  const calls = installDeapiFetch(t, { catalog });

  await generateVoice({ text: "hello there", prompt: "gravelly villain voice" });

  const submit = calls.find((c) => c.url === "https://deapi.test/api/v2/audio/speech");
  assert.equal(submit.form.mode, "voice_design");
  assert.equal(submit.form.instruct, "gravelly villain voice");
  assert.equal(submit.form.voice, undefined);
});

test("generateVoice rejects text shorter than the model's min_text before any provider call", async (t) => {
  const catalog = cloneCatalogWith("Kokoro", { info: { limits: { min_text: 10 } } });
  const calls = installDeapiFetch(t, { catalog });

  await assert.rejects(
    generateVoice({ text: "short", prompt: "a voice" }),
    (e) => e.klass === "bad_args" && /at least 10/.test(e.message),
  );
  assert.equal(calls.filter((c) => c.method === "POST").length, 0, "no paid calls on validation failures");
});

test("generateVoice rejects empty text and empty prompt before any provider call", async (t) => {
  const calls = installDeapiFetch(t);

  await assert.rejects(generateVoice({ prompt: "a voice" }), (e) => e.klass === "bad_args" && /empty text/.test(e.message));
  await assert.rejects(generateVoice({ text: "hello" }), (e) => e.klass === "bad_args" && /empty prompt/.test(e.message));
  assert.equal(calls.filter((c) => c.method === "POST").length, 0);
});

test("generateVoice maps HTTP 401 on submit to infra", async (t) => {
  installDeapiFetch(t, {
    handler(entry) {
      if (entry.url.endsWith("/api/v2/audio/speech") && entry.method === "POST") {
        return jsonResponse({ message: "Unauthenticated." }, 401);
      }
      return undefined;
    },
  });

  await assert.rejects(
    generateVoice({ text: "hello there", prompt: "a voice" }),
    (e) => e.klass === "infra" && /401/.test(e.message),
  );
});
