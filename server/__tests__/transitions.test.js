// Transitions — verified against real encoded video, because the failure that
// matters (a reel that is shorter than the sum of its clips) only shows up
// when ffmpeg actually runs.

import test, { before, describe } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  DEFAULT_DURATION_S,
  buildTransitionFilter,
  isValidTransition,
  planTransitions,
} from "../lib/transitions.js";
import { probeMedia } from "../lib/trim.js";

const run = promisify(execFile);
let dir;
let ffmpegAvailable = true;

async function clip(name, seconds, colour = "0x2a4d69") {
  const out = path.join(dir, name);
  await run("ffmpeg", [
    "-y",
    "-f", "lavfi", "-i", `color=c=${colour}:size=320x240:d=${seconds}:r=30`,
    "-f", "lavfi", "-i", `sine=frequency=440:sample_rate=48000:duration=${seconds}`,
    "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac",
    "-t", String(seconds), out, "-loglevel", "error",
  ], { maxBuffer: 8e6 });
  return { path: out, duration: seconds, hasAudio: true };
}

before(async () => {
  dir = await fsp.mkdtemp(path.join(os.tmpdir(), "pai-xfade-"));
  try { await run("ffmpeg", ["-version"]); } catch { ffmpegAvailable = false; }
});

describe("planning", () => {
  test("a transition shortens the reel, and the plan says by how much", () => {
    const plan = planTransitions(
      [{ duration: 10 }, { duration: 10 }, { duration: 10 }],
      { durationS: 0.5 },
    );
    assert.equal(plan.joins.length, 2);
    assert.equal(plan.rawDurationS, 30);
    assert.equal(plan.finalDurationS, 29);
    assert.equal(plan.shortenedByS, 1);
  });

  test("offsets account for earlier overlaps pulling the timeline in", () => {
    const plan = planTransitions([{ duration: 10 }, { duration: 10 }, { duration: 10 }], { durationS: 0.5 });
    // First join at 10 - 0.5. Second at 20 - 0.5 - 0.5, because the first
    // overlap already moved everything after it half a second earlier.
    assert.equal(plan.joins[0].offsetS, 9.5);
    assert.equal(plan.joins[1].offsetS, 19);
  });

  test("a clip too short for the overlap keeps a hard cut and says so", () => {
    const plan = planTransitions([{ duration: 10 }, { duration: 0.3 }, { duration: 10 }], { durationS: 0.5 });
    assert.equal(plan.joins.length, 0, "neither join can hold a 0.5s dissolve");
    assert.equal(plan.skipped.length, 2);
    assert.match(plan.skipped[0].reason, /too short/);
    assert.equal(plan.finalDurationS, plan.rawDurationS, "no overlap means no shortening");
  });

  test("an unknown transition is refused rather than passed to ffmpeg", () => {
    assert.equal(isValidTransition("fade"), true);
    assert.equal(isValidTransition("teleport"), false);
    assert.throws(() => planTransitions([{ duration: 5 }, { duration: 5 }], { transition: "teleport" }), /unknown transition/);
  });

  test("a silent clip gets generated silence rather than breaking the chain", () => {
    const filter = buildTransitionFilter(
      [{ duration: 5, hasAudio: true }, { duration: 5, hasAudio: false }],
      planTransitions([{ duration: 5 }, { duration: 5 }]),
    );
    assert.match(filter, /anullsrc/);
    assert.match(filter, /acrossfade/, "audio must cross too, or sound cuts hard under a dissolve");
  });
});

describe("against real video", { skip: !ffmpegAvailable }, () => {
  test("A DISSOLVED REEL IS SHORTER THAN THE SUM OF ITS CLIPS", async () => {
    const clips = [
      await clip("t1.mp4", 4, "0x2a4d69"),
      await clip("t2.mp4", 4, "0x8a4d20"),
      await clip("t3.mp4", 4, "0xd94f2b"),
    ];
    const plan = planTransitions(clips, { durationS: 0.5 });
    const out = path.join(dir, "dissolved.mp4");

    await run("ffmpeg", [
      "-y", ...clips.flatMap((c) => ["-i", c.path]),
      "-filter_complex", buildTransitionFilter(clips, plan),
      "-map", "[outv]", "-map", "[outa]",
      "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac",
      out, "-loglevel", "error",
    ], { maxBuffer: 32e6 });

    const info = await probeMedia(out);
    // 12s of clips minus two 0.5s overlaps = 11s.
    assert.ok(
      Math.abs(info.duration - 11) < 0.4,
      `expected ~11s (12s minus two 0.5s dissolves), got ${info.duration.toFixed(2)}s`,
    );
    assert.ok(info.duration < 12, "if this equals 12 the transitions did not apply");
  });

  test("the join actually blends rather than cutting", async () => {
    const clips = [await clip("b1.mp4", 3, "0x000000"), await clip("b2.mp4", 3, "0xffffff")];
    const plan = planTransitions(clips, { durationS: 1 });
    const out = path.join(dir, "blend.mp4");
    await run("ffmpeg", [
      "-y", ...clips.flatMap((c) => ["-i", c.path]),
      "-filter_complex", buildTransitionFilter(clips, plan),
      "-map", "[outv]", "-map", "[outa]",
      "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac",
      out, "-loglevel", "error",
    ], { maxBuffer: 32e6 });

    // Mid-transition between pure black and pure white must be grey. A hard
    // cut would give one or the other and nothing between.
    const frame = path.join(dir, "mid.png");
    await run("ffmpeg", ["-y", "-ss", "2.5", "-i", out, "-frames:v", "1", frame, "-loglevel", "error"]);
    const { default: sharp } = await import("sharp");
    const { channels } = await sharp(frame).stats();
    const mean = channels.slice(0, 3).reduce((n, c) => n + c.mean, 0) / 3;
    assert.ok(mean > 40 && mean < 215, `mid-dissolve should be grey, measured mean ${mean.toFixed(1)}`);
  });
});
