// F1 — trimming, verified against real encoded video.
//
// These tests generate actual H.264 files with ffmpeg rather than using stubs.
// The whole point of this module is that assumptions about stream-copy trimming
// do not survive contact with a real inter-frame codec, so testing it against
// fixtures would prove nothing.

import test, { before, describe } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  KEYFRAME_TOLERANCE_S,
  buildConcatList,
  buildTrimFilter,
  keyframeAtOrBefore,
  planTrims,
  probeKeyframes,
  probeMedia,
} from "../lib/trim.js";

const run = promisify(execFile);
let dir;
let ffmpegAvailable = true;

/** A real clip: `seconds` long, keyframe every `gop` seconds, optional audio. */
async function makeClip(name, { seconds = 4, gop = 2, size = "320x240", rate = 48000, silent = false } = {}) {
  const out = path.join(dir, name);
  const args = [
    "-y",
    "-f", "lavfi", "-i", `testsrc=size=${size}:rate=25:duration=${seconds}`,
  ];
  if (!silent) args.push("-f", "lavfi", "-i", `sine=frequency=440:sample_rate=${rate}:duration=${seconds}`);
  args.push(
    "-c:v", "libx264", "-pix_fmt", "yuv420p",
    "-g", String(gop * 25), "-keyint_min", String(gop * 25), "-sc_threshold", "0",
  );
  if (!silent) args.push("-c:a", "aac", "-ar", String(rate));
  args.push("-t", String(seconds), out);
  await run("ffmpeg", args, { maxBuffer: 8 * 1024 * 1024 });
  return out;
}

before(async () => {
  dir = await fsp.mkdtemp(path.join(os.tmpdir(), "pai-trim-"));
  try {
    await run("ffmpeg", ["-version"]);
  } catch {
    ffmpegAvailable = false;
  }
});

describe("keyframe arithmetic", () => {
  test("a copied cut lands on the nearest preceding keyframe", () => {
    const kf = [0, 2, 4, 6];
    assert.equal(keyframeAtOrBefore(kf, 0), 0);
    assert.equal(keyframeAtOrBefore(kf, 2), 2, "exactly on one stays put");
    assert.equal(keyframeAtOrBefore(kf, 3.5), 2, "between two moves BACK, never forward");
    assert.equal(keyframeAtOrBefore(kf, 5.9), 4);
    assert.equal(keyframeAtOrBefore(kf, 99), 6, "past the end clamps to the last");
  });

  test("a concat list carries per-entry trim points", () => {
    const list = buildConcatList([
      { path: "/tmp/a.mp4", in_s: 1.5, out_s: 3 },
      { path: "/tmp/b.mp4" },
      { path: "/tmp/it's here.mp4", in_s: 0.25 },
    ]);
    assert.match(list, /inpoint 1\.500/);
    assert.match(list, /outpoint 3\.000/);
    assert.match(list, /it'\\''s here\.mp4/, "quotes in a filename must be escaped");
    const untrimmed = list.split("\n").filter((l) => l.includes("b.mp4"));
    assert.equal(untrimmed.length, 1, "an untrimmed clip gets no trim lines");
  });

  test("the exact-trim filter pads silent clips so the graph does not fail", () => {
    const filter = buildTrimFilter([
      { in_s: 1, out_s: 3, media: { hasAudio: true, duration: 4 } },
      { in_s: 0, out_s: 2, media: { hasAudio: false, duration: 4 } },
    ]);
    assert.match(filter, /\[0:a\]atrim=start=1:end=3/);
    assert.match(filter, /anullsrc/, "a clip with no audio needs a generated silent track");
    assert.match(filter, /concat=n=2:v=1:a=1/);
  });
});

describe("against real encoded video", { skip: !ffmpegAvailable }, () => {
  test("keyframes are where we asked ffmpeg to put them", async () => {
    const clip = await makeClip("gop2.mp4", { seconds: 6, gop: 2 });
    const kf = await probeKeyframes(clip);
    assert.ok(kf.length >= 3, `expected several keyframes, got ${kf.length}`);
    assert.ok(Math.abs(kf[0]) < 0.01, "the first frame is always a keyframe");
    assert.ok(kf.some((k) => Math.abs(k - 2) < 0.1), "a keyframe near 2s");
    assert.ok(kf.some((k) => Math.abs(k - 4) < 0.1), "a keyframe near 4s");
  });

  test("probeMedia reports what the copy decision depends on", async () => {
    const clip = await makeClip("probe.mp4", { seconds: 3, rate: 44100 });
    const info = await probeMedia(clip);
    assert.equal(info.video.codec, "h264");
    assert.equal(info.video.width, 320);
    assert.equal(info.audio.sampleRate, 44100);
    assert.ok(Math.abs(info.duration - 3) < 0.3);
  });

  test("a keyframe-aligned cut is copyable and reported exact", async () => {
    const a = await makeClip("aligned_a.mp4", { seconds: 6, gop: 2 });
    const b = await makeClip("aligned_b.mp4", { seconds: 6, gop: 2 });
    const plan = await planTrims([
      { path: a, in_s: 2, out_s: 4 }, // exactly on a keyframe
      { path: b },
    ]);
    assert.equal(plan.mode, "copy");
    assert.equal(plan.exact, true);
    assert.ok(plan.maxDriftSeconds <= KEYFRAME_TOLERANCE_S);
  });

  test("A CUT BETWEEN KEYFRAMES FORCES A RE-ENCODE — the finding this module exists for", async () => {
    const a = await makeClip("mid_gop.mp4", { seconds: 6, gop: 2 });
    // 3.0s sits squarely between keyframes at 2s and 4s. Stream copy would
    // silently start the clip a whole second early.
    const plan = await planTrims([{ path: a, in_s: 3.0, out_s: 5.0 }]);

    assert.equal(plan.mode, "encode", "copying here would move the cut by ~1s");
    assert.ok(plan.maxDriftSeconds > KEYFRAME_TOLERANCE_S);
    assert.match(plan.reasons.join(" "), /keyframe/);
    assert.equal(plan.clips[0].copyLandsAt, 2, "copy would have landed on the 2s keyframe");
  });

  test("mismatched audio sample rates still force a re-encode", async () => {
    const a = await makeClip("rate48.mp4", { seconds: 3, rate: 48000 });
    const b = await makeClip("rate44.mp4", { seconds: 3, rate: 44100 });
    const plan = await planTrims([{ path: a }, { path: b }]);
    assert.equal(plan.mode, "encode");
    assert.match(plan.reasons.join(" "), /sample rate/);
  });

  test("a silent clip forces a re-encode rather than failing the graph", async () => {
    const a = await makeClip("with_audio.mp4", { seconds: 3 });
    const b = await makeClip("silent.mp4", { seconds: 3, silent: true });
    const plan = await planTrims([{ path: a }, { path: b }]);
    assert.equal(plan.mode, "encode");
    assert.match(plan.reasons.join(" "), /no audio track/);
  });

  test("an exact trim really does produce the requested duration", async () => {
    const a = await makeClip("exact_src.mp4", { seconds: 6, gop: 2 });
    const out = path.join(dir, "exact_out.mp4");
    const clips = [{ path: a, in_s: 3.0, out_s: 5.0, media: await probeMedia(a) }];

    await run("ffmpeg", [
      "-y", "-i", a,
      "-filter_complex", buildTrimFilter(clips),
      "-map", "[outv]", "-map", "[outa]",
      "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac",
      out,
    ], { maxBuffer: 16 * 1024 * 1024 });

    const info = await probeMedia(out);
    // The whole promise of F1: a 10s generation good for 2s costs nothing to cut.
    assert.ok(
      Math.abs(info.duration - 2.0) < 0.15,
      `expected ~2.0s from a 3.0-5.0 trim, measured ${info.duration.toFixed(3)}s`,
    );
  });
});

// An OUT point had never been measured against keyframes — only in-points were.
// So a clip trimmed at the END reported zero drift, took the stream-copy path,
// and produced an export with non-monotonic DTS: it plays, mostly, and is
// quietly broken. Every trim in one finished film was out-point-only, and every
// export of it was corrupt.
//
// The clips this happens on carry exactly ONE keyframe, at 0.000 — H3 output
// does — so no out point inside them can ever be copy-safe.
test("an out point that misses a keyframe forces a re-encode", async () => {
  const { planTrims } = await import("../lib/trim.js");
  const single = await singleKeyframeClip("okf.mp4");

  const trimmed = await planTrims([{ path: single, in_s: null, out_s: 2.0 }]);
  assert.equal(trimmed.mode, "encode", `reasons: ${JSON.stringify(trimmed.reasons)}`);
  assert.match(trimmed.reasons.join(" "), /out point/);

  const whole = await planTrims([{ path: single, in_s: null, out_s: null }]);
  assert.equal(whole.mode, "copy", "an untrimmed reel must still stream-copy");
});

test("A TRIMMED STREAM COPY IS WHAT CORRUPTED THE TIMESTAMPS", async () => {
  // Guards the diagnosis, not just the fix: if a future ffmpeg makes trimmed
  // concat+copy safe, this test fails and the extra re-encode can be dropped
  // deliberately rather than by accident.
  const single = await singleKeyframeClip("dts.mp4");
  const list = path.join(dir, "dts_list.txt");
  await fsp.writeFile(list, `file '${single}'\noutpoint 2.000\nfile '${single}'\n`, "utf8");

  const copied = path.join(dir, "dts_copy.mp4");
  await run("ffmpeg", ["-y", "-f", "concat", "-safe", "0", "-i", list, "-c", "copy", copied, "-loglevel", "error"]);
  const { stderr } = await run("ffmpeg", ["-v", "error", "-i", copied, "-f", "null", "-"]).catch((e) => e);
  assert.match(String(stderr ?? ""), /non monotonic/i,
    "trimmed concat+copy is expected to corrupt DTS — that is why planTrims refuses it");
});

/** A clip with exactly one keyframe, like the video model's own output. */
async function singleKeyframeClip(name) {
  const out = path.join(dir, name);
  await run("ffmpeg", [
    "-y", "-f", "lavfi", "-i", "testsrc=size=320x240:rate=24:d=5",
    "-f", "lavfi", "-i", "anullsrc=r=48000:cl=mono", "-shortest",
    "-c:v", "libx264", "-g", "1000", "-keyint_min", "1000", "-sc_threshold", "0",
    "-pix_fmt", "yuv420p", "-c:a", "aac", out, "-loglevel", "error",
  ]);
  return out;
}
