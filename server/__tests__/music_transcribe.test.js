// F2 — the two capabilities the README documented but never shipped.

import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { getDefault } from "../model_registry.js";
import { MUSIC_LIMITS, clampDuration } from "../pai_music_client.js";
import { toSrt } from "../pai_transcribe_client.js";

const run = promisify(execFile);
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const cli = (name) => path.join(REPO, "server", "cli", name);

test("both models are registered and resolvable", () => {
  const music = getDefault("music");
  assert.ok(music, "music must be in the registry, not just the README");
  assert.equal(music.deapi_slug, "AceStep_1_5_Turbo");

  const stt = getDefault("transcription");
  assert.ok(stt, "transcription must be in the registry, not just the README");
  assert.equal(stt.deapi_slug, "WhisperLargeV3Ct2");
});

test("music duration is clamped into the model's real range", () => {
  assert.equal(clampDuration(90), 90);
  assert.equal(clampDuration(5), MUSIC_LIMITS.minSeconds, "below the floor clamps up");
  assert.equal(clampDuration(9999), MUSIC_LIMITS.maxSeconds, "above the ceiling clamps down");
  assert.equal(clampDuration("not a number"), 60, "junk falls back to a sane default");
  assert.equal(clampDuration(undefined), 60);
});

test("guidance_scale can never exceed 1, which AceStep rejects outright", () => {
  // The ceiling is the documented quirk; encoding it here stops a paid call
  // failing on a value the caller could not have known about.
  assert.equal(MUSIC_LIMITS.maxGuidance, 1);
});

test("SRT output is correctly formatted and ordered", () => {
  const srt = toSrt([
    { start: 0, end: 2.5, text: "Mara climbs the stair." },
    { start: 2.5, end: 6.25, text: "The beacon is dark." },
  ]);
  const lines = srt.split("\n");
  assert.equal(lines[0], "1");
  assert.equal(lines[1], "00:00:00,000 --> 00:00:02,500");
  assert.equal(lines[2], "Mara climbs the stair.");
  assert.equal(lines[4], "2");
  assert.equal(lines[5], "00:00:02,500 --> 00:00:06,250");
});

test("SRT handles hours and rounds milliseconds", () => {
  const srt = toSrt([{ start: 3661.5, end: 3662.001, text: "late" }]);
  assert.match(srt, /01:01:01,500 --> 01:01:02,001/);
});

test("generate_music refuses to spend without a brief", async () => {
  const { stdout } = await run("node", [cli("generate_music.js")], { reject: false }).catch((e) => e);
  const out = JSON.parse(String(stdout).trim().split("\n").pop());
  assert.equal(out.ok, false);
  assert.equal(out.klass, "bad_args");
});

test("transcribe refuses a path that is not there", async () => {
  const { stdout } = await run("node", [cli("transcribe.js"), "--path", "/nope/missing.mp4"], {
    reject: false,
    env: { ...process.env, DEAPI_KEY: "1|x" },
  }).catch((e) => e);
  const out = JSON.parse(String(stdout).trim().split("\n").pop());
  assert.equal(out.ok, false);
  assert.equal(out.klass, "bad_args");
  assert.match(out.message, /no file at/);
});

test("audio nodes accept a music subtype", async () => {
  const schema = await readFile(path.join(REPO, "server", "canvas_schema.js"), "utf8");
  const audioBlock = schema.slice(schema.indexOf("#audioResultData"), schema.indexOf("#audioResultData") + 900);
  assert.match(audioBlock, /"music"/, "a music bed must be storable on the canvas");
});

test("the README's promises now have code behind them", async () => {
  const readme = await readFile(path.join(REPO, "README.md"), "utf8");
  const claimsMusic = /AceStep/i.test(readme);
  const claimsStt = /Whisper/i.test(readme);

  if (claimsMusic) {
    assert.ok(getDefault("music"), "README advertises music; the registry must back it");
  }
  if (claimsStt) {
    assert.ok(getDefault("transcription"), "README advertises transcription; the registry must back it");
  }
});

// The wire contract, verified against deAPI's published spec (llms.txt). These
// exist because the first version of both clients sent field names deAPI does
// not accept, which typechecked, tested green, and would have 422'd on the
// first real call.

async function captureForm(fn) {
  const original = globalThis.fetch;
  const seen = [];
  globalThis.fetch = async (url, init) => {
    seen.push({ url: String(url), body: init?.body });
    throw new Error('captured');
  };
  try { await fn().catch(() => {}); } finally { globalThis.fetch = original; }
  return seen;
}

test("music sends every field deAPI marks required", async () => {
  process.env.DEAPI_KEY = process.env.DEAPI_KEY || '1|x';
  const { generateMusic } = await import("../pai_music_client.js");
  const seen = await captureForm(() => generateMusic({ prompt: "sparse low strings", duration: 90 }));
  const form = seen.find((s) => s.body instanceof FormData);
  assert.ok(form, "a multipart submit should have been attempted");
  const keys = [...form.body.keys()].sort();
  for (const required of ["caption", "model", "lyrics", "duration", "inference_steps", "guidance_scale", "seed", "format"]) {
    assert.ok(keys.includes(required), `deAPI requires "${required}"; sent: ${keys.join(", ")}`);
  }
  assert.ok(!keys.includes("prompt"), 'deAPI wants "caption", not "prompt"');
  assert.equal(form.body.get("lyrics"), "[Instrumental]", "lyrics may not be empty");
});

test("the price endpoint is not double-suffixed", async () => {
  process.env.DEAPI_KEY = process.env.DEAPI_KEY || '1|x';
  const { generateMusic } = await import("../pai_music_client.js");
  const seen = await captureForm(() => generateMusic({ prompt: "abc", duration: 30 }));
  const priced = seen.find((s) => s.url.includes("/price"));
  assert.ok(priced, "a quote should be attempted");
  assert.ok(!priced.url.includes("/price/price"), `quotePrice appends /price itself: ${priced.url}`);
  assert.match(priced.url, /audio\/music\/price$/);
});

test("transcription uses source_file and include_ts, and has no diarization field", async () => {
  process.env.DEAPI_KEY = process.env.DEAPI_KEY || '1|x';
  const { transcribe } = await import("../pai_transcribe_client.js");
  const { writeFileSync, mkdtempSync } = await import("node:fs");
  const os = await import("node:os");
  const tmp = path.join(mkdtempSync(path.join(os.tmpdir(), "stt-")), "a.mp3");
  writeFileSync(tmp, Buffer.from([0x49, 0x44, 0x33]));

  const seen = await captureForm(() => transcribe({ filePath: tmp }));
  const form = seen.find((s) => s.body instanceof FormData);
  assert.ok(form, "a multipart submit should have been attempted");
  const keys = [...form.body.keys()].sort();
  assert.ok(keys.includes("source_file"), `deAPI wants "source_file", not "file"; sent: ${keys.join(", ")}`);
  assert.ok(keys.includes("include_ts"), 'deAPI wants "include_ts", not "timestamps"');
  assert.ok(!keys.includes("diarization"), "diarization is a model capability, not a request field");
});

// A finished transcription job carries `text: null` and `result: null`; the
// document lives at `result_url`, exactly as an image or video result does.
// Reading only the job body made EVERY successful transcription report
// "finished with no text" — including a clean speech recording — so the
// failure read as a bad input rather than a client that never fetched its own
// result. It also made transcription useless as a verification tool at the one
// moment it was needed: checking that a narration was audible in a finished mix.
test("the transcript is fetched from result_url, not read out of the job", async () => {
  process.env.DEAPI_KEY = process.env.DEAPI_KEY || "1|x";
  const { writeFileSync, mkdtempSync } = await import("node:fs");
  const os = await import("node:os");
  const tmp = path.join(mkdtempSync(path.join(os.tmpdir(), "stt2-")), "a.mp3");
  writeFileSync(tmp, Buffer.from([0x49, 0x44, 0x33]));

  const RESULT_URL = "https://results.example.test/abc.json";
  const DOC = {
    text: "Eleven years I have sent other people's words up this hill.",
    segments: [{ start: 0, end: 3.5, text: "Eleven years I have sent other people's words up this hill." }],
  };

  const original = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const u = String(url);
    if (u.endsWith("/price")) return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
    if (u === RESULT_URL) {
      return new Response(JSON.stringify(DOC), { status: 200, headers: { "content-type": "application/json" } });
    }
    if (u.includes("/jobs/")) {
      // status done, transcript ABSENT from the job body — the real shape.
      return new Response(JSON.stringify({
        data: { status: "done", text: null, result: null, result_url: RESULT_URL, progress: 100 },
      }), { status: 200, headers: { "content-type": "application/json" } });
    }
    // submit
    return new Response(JSON.stringify({ data: { request_id: "req_stt_1" } }), {
      status: 200, headers: { "content-type": "application/json" },
    });
  };

  try {
    const { transcribe } = await import("../pai_transcribe_client.js");
    const out = await transcribe({ filePath: tmp });
    assert.match(out.text, /Eleven years/, "the transcript must come from the result document");
    assert.equal(out.segments.length, 1);
    assert.equal(out.segments[0].text, DOC.segments[0].text);
  } finally {
    globalThis.fetch = original;
  }
});
