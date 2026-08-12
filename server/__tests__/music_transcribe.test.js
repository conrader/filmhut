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
