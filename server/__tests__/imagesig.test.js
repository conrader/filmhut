// F3 — continuity signals, and the limit of what they can claim.

import test, { before, describe } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { compare, dHash, hashDistance, histogramSimilarity, colourHistogram, signature } from "../lib/imagesig.js";

const run = promisify(execFile);
let dir;

async function solid(name, colour, size = "320x240") {
  const out = path.join(dir, name);
  await run("ffmpeg", ["-y", "-f", "lavfi", "-i", `color=c=${colour}:size=${size}:d=1`, "-frames:v", "1", out, "-loglevel", "error"]);
  return out;
}

async function pattern(name, extra = []) {
  const out = path.join(dir, name);
  await run("ffmpeg", ["-y", "-f", "lavfi", "-i", "testsrc=size=320x240:d=1", ...extra, "-frames:v", "1", out, "-loglevel", "error"]);
  return out;
}

before(async () => {
  dir = await fsp.mkdtemp(path.join(os.tmpdir(), "pai-sig-"));
});

describe("perceptual signature", () => {
  test("an image is identical to itself", async () => {
    const a = await pattern("self.png");
    const h = await dHash(a);
    assert.equal(hashDistance(h, h), 0);
    const hist = await colourHistogram(a);
    assert.ok(histogramSimilarity(hist, hist) > 0.999);
  });

  test("the hash survives rescaling, which is what makes it useful", async () => {
    const big = await pattern("big.png");
    const small = path.join(dir, "small.png");
    await run("ffmpeg", ["-y", "-i", big, "-vf", "scale=160:120", small, "-loglevel", "error"]);
    const d = hashDistance(await dHash(big), await dHash(small));
    assert.ok(d < 0.2, `a rescaled frame should still match, distance was ${d}`);
  });

  test("different palettes score far apart", async () => {
    const blue = await solid("blue.png", "0x2a4d69");
    const orange = await solid("orange.png", "0xd94f2b");
    const sim = histogramSimilarity(await colourHistogram(blue), await colourHistogram(orange));
    assert.ok(sim < 0.2, `unrelated palettes should not agree, got ${sim}`);
  });

  test("near-identical palettes score close", async () => {
    const a = await solid("t1.png", "0x2a4d69");
    const b = await solid("t2.png", "0x2d5070");
    const sim = histogramSimilarity(await colourHistogram(a), await colourHistogram(b));
    assert.ok(sim > 0.5, `a slight grade shift should still agree, got ${sim}`);
  });
});

describe("comparison and its stated limits", () => {
  test("a palette break is reported under location_style", async () => {
    const a = await signature(await solid("c1.png", "0x2a4d69"));
    const b = await signature(await solid("c2.png", "0xd94f2b"));
    const result = compare(a, b);
    assert.ok(result.signals.length > 0);
    assert.ok(result.signals.some((s) => s.bucket === "location_style"));
  });

  test("a matching frame raises nothing", async () => {
    const p = await pattern("same.png");
    const sig = await signature(p);
    assert.deepEqual(compare(sig, sig).signals, []);
  });

  test("EVERY comparison declares that identity was not checked", async () => {
    // The honest limit. Without an embedding model this cannot tell whether two
    // shots show the same person, and a caller must never read a passing
    // palette score as a passing identity check.
    const p = await pattern("id.png");
    const sig = await signature(p);
    assert.equal(compare(sig, sig).identity_checked, false);

    const other = await signature(await solid("id2.png", "0x111111"));
    assert.equal(compare(sig, other).identity_checked, false);
  });

  test("scores are bounded and rounded for reporting", async () => {
    const a = await signature(await pattern("b1.png"));
    const b = await signature(await solid("b2.png", "0x808080"));
    for (const k of ["palette", "composition", "exposure"]) {
      const v = compare(a, b)[k];
      assert.ok(v >= 0 && v <= 1, `${k} out of range: ${v}`);
      assert.equal(v, Math.round(v * 1000) / 1000);
    }
  });

  test("an exposure jump is caught even when the palette holds", async () => {
    const normal = await signature(await solid("e1.png", "0x404040"));
    const blown = await signature(await solid("e2.png", "0xf0f0f0"));
    const result = compare(normal, blown);
    assert.ok(result.exposure < 0.6, `expected an exposure signal, got ${result.exposure}`);
  });
});

// The sampling bug: a fixed fps filter plus -frames:v N only reached N/fps
// seconds into a clip, so a 30s reel was judged on its first 8 seconds. Two
// films sharing an opening scored identically and a collapse at the end was
// invisible.

describe("frame sampling spans the whole clip", () => {
  test("drift in the SECOND half changes the score", { skip: !process.env.PATH }, async () => {
    const { execFile } = await import("node:child_process");
    const { promisify } = await import("node:util");
    const run2 = promisify(execFile);

    const ref = await solid("ref-blue.png", "0x2a4d69");

    // Ten seconds: blue throughout.
    const steady = path.join(dir, "steady.mp4");
    await run2("ffmpeg", ["-y", "-f", "lavfi", "-i", "color=c=0x2a4d69:size=320x240:d=10:r=10",
      "-c:v", "libx264", "-pix_fmt", "yuv420p", "-t", "10", steady, "-loglevel", "error"]);

    // Ten seconds: blue for five, then orange. Identical opening to `steady`.
    const drifts = path.join(dir, "drifts.mp4");
    await run2("ffmpeg", ["-y",
      "-f", "lavfi", "-i", "color=c=0x2a4d69:size=320x240:d=5:r=10",
      "-f", "lavfi", "-i", "color=c=0xd94f2b:size=320x240:d=5:r=10",
      "-filter_complex", "[0][1]concat=n=2:v=1:a=0[v]", "-map", "[v]",
      "-c:v", "libx264", "-pix_fmt", "yuv420p", "-t", "10", drifts, "-loglevel", "error"]);

    const cli = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "cli", "check_continuity.js");
    const score = async (v) => {
      const { stdout } = await run2("node", [cli, "--path", v, "--ref", ref, "--frames", "8"],
        { cwd: dir, maxBuffer: 8e6 });
      return JSON.parse(String(stdout).trim().split("\n").pop()).palette;
    };

    const a = await score(steady);
    const b = await score(drifts);
    assert.ok(a > 0.9, `a steady clip should match its reference, got ${a}`);
    assert.ok(
      b < a - 0.1,
      `drift after the opening must lower the score — steady ${a}, drifting ${b}. ` +
      "Equal scores mean only the opening was sampled.",
    );
  });
});
