// F1 — the exporter must honour a trim window, end to end, on real video.
//
// The unit tests in trim.test.js prove the planner decides correctly. This
// proves the decision reaches ffmpeg and changes the file that comes out.

import test, { before, describe } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { buildReelMaster } from "../reel_stitch.js";
import { probeMedia } from "../lib/trim.js";

const run = promisify(execFile);
let projectDir;
let ffmpegAvailable = true;

async function makeClip(rel, seconds, { gop = 2 } = {}) {
  const abs = path.join(projectDir, rel);
  await fsp.mkdir(path.dirname(abs), { recursive: true });
  await run("ffmpeg", [
    "-y",
    "-f", "lavfi", "-i", `testsrc=size=320x240:rate=25:duration=${seconds}`,
    "-f", "lavfi", "-i", `sine=frequency=440:sample_rate=48000:duration=${seconds}`,
    "-c:v", "libx264", "-pix_fmt", "yuv420p",
    "-g", String(gop * 25), "-keyint_min", String(gop * 25), "-sc_threshold", "0",
    "-c:a", "aac", "-ar", "48000",
    "-t", String(seconds), abs,
  ], { maxBuffer: 8 * 1024 * 1024 });
  return abs;
}

const videoNode = (id, localPath, shotId, extra = {}) => ({
  id,
  type: "video_result",
  data: {
    label: id,
    local_path: localPath,
    duration: 4,
    aspect: "4:3",
    shot_id: shotId,
    metadata: {},
    ...extra,
  },
});

before(async () => {
  projectDir = await fsp.mkdtemp(path.join(os.tmpdir(), "pai-reel-"));
  try {
    await run("ffmpeg", ["-version"]);
  } catch {
    ffmpegAvailable = false;
  }
});

describe("reel export honours trim windows", { skip: !ffmpegAvailable }, () => {
  test("an untrimmed reel is the sum of its clips", async () => {
    await makeClip("assets/videos/a.mp4", 4);
    await makeClip("assets/videos/b.mp4", 4);
    const state = { nodes: [
      videoNode("video_1", "assets/videos/a.mp4", 1),
      videoNode("video_2", "assets/videos/b.mp4", 2),
    ] };

    const out = path.join(projectDir, "untrimmed.mp4");
    await buildReelMaster(state, projectDir, out, "test");
    const info = await probeMedia(out);
    assert.ok(Math.abs(info.duration - 8) < 0.4, `expected ~8s, got ${info.duration.toFixed(2)}s`);
  });

  test("A TRIMMED REEL IS SHORTER — the point of the whole feature", async () => {
    await makeClip("assets/videos/c.mp4", 6);
    await makeClip("assets/videos/d.mp4", 6);
    // Keep 2s of the first clip and 2s of the second, from a mid-GOP start
    // that stream copy could not honour.
    const state = { nodes: [
      videoNode("video_1", "assets/videos/c.mp4", 1, { in_s: 3, out_s: 5 }),
      videoNode("video_2", "assets/videos/d.mp4", 2, { in_s: 1, out_s: 3 }),
    ] };

    const out = path.join(projectDir, "trimmed.mp4");
    await buildReelMaster(state, projectDir, out, "test");
    const info = await probeMedia(out);

    assert.ok(
      Math.abs(info.duration - 4) < 0.5,
      `expected ~4s from two 2s windows out of 12s of source, got ${info.duration.toFixed(2)}s`,
    );
    assert.ok(info.duration < 8, "if this is 12s the trim was ignored entirely");
  });

  test("a trim on one clip leaves the others whole", async () => {
    await makeClip("assets/videos/e.mp4", 4);
    await makeClip("assets/videos/f.mp4", 4);
    const state = { nodes: [
      videoNode("video_1", "assets/videos/e.mp4", 1, { in_s: 2, out_s: 4 }), // 2s
      videoNode("video_2", "assets/videos/f.mp4", 2),                        // 4s
    ] };

    const out = path.join(projectDir, "mixed.mp4");
    await buildReelMaster(state, projectDir, out, "test");
    const info = await probeMedia(out);
    assert.ok(Math.abs(info.duration - 6) < 0.5, `expected ~6s, got ${info.duration.toFixed(2)}s`);
  });

  test("null trim fields mean the natural boundary, not a zero-length clip", async () => {
    await makeClip("assets/videos/g.mp4", 3);
    const state = { nodes: [videoNode("video_1", "assets/videos/g.mp4", 1, { in_s: null, out_s: null })] };
    const out = path.join(projectDir, "nulls.mp4");
    await buildReelMaster(state, projectDir, out, "test");
    const info = await probeMedia(out);
    assert.ok(info.duration > 2.5, "an explicit null must not truncate the clip");
  });
});
