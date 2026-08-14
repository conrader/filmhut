// The reference review gate: what it can settle, and what it must not claim.

import test, { before, after, describe } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import sharp from "sharp";

import { inspectSheet, panelBoxes, subjectCoverage, buildFaceStrip } from "../lib/refsheet.js";
import { checkRefsReviewed } from "../cli/_review_guard.js";

const run = promisify(execFile);
let dir;

before(async () => {
  dir = await fsp.mkdtemp(path.join(os.tmpdir(), "refsheet-"));
});
after(async () => {
  await fsp.rm(dir, { recursive: true, force: true });
});

const GREY = { r: 128, g: 128, b: 128 };

/**
 * A synthetic sheet: `blocks` describes, per panel, a filled rectangle as
 * fractions of the panel — [topFrac, heightFrac] — or null for an empty panel.
 * Crude, but it exercises the geometry, which is what these checks are about.
 */
async function sheet(name, blocks, { width = 1200, height = 900 } = {}) {
  const out = path.join(dir, name);
  const boxes = panelBoxes(width, height, blocks.length);
  const layers = [];
  for (const [i, b] of blocks.entries()) {
    if (!b) continue;
    const [topFrac, hFrac, colour = { r: 20, g: 30, b: 40 }] = b;
    const w = Math.round(boxes[i].width * 0.7);
    const h = Math.max(1, Math.round(height * hFrac));
    layers.push({
      input: await sharp({ create: { width: w, height: h, channels: 3, background: colour } }).png().toBuffer(),
      left: boxes[i].left + Math.round((boxes[i].width - w) / 2),
      top: Math.round(height * topFrac),
    });
  }
  await sharp({ create: { width, height, channels: 3, background: GREY } })
    .composite(layers).png().toFile(out);
  return out;
}

describe("panel geometry", () => {
  test("panels tile the full width with no gap and no overlap", () => {
    const boxes = panelBoxes(1003, 400, 4); // deliberately not divisible by 4
    assert.equal(boxes[0].left, 0);
    for (let i = 1; i < boxes.length; i++) {
      assert.equal(boxes[i].left, boxes[i - 1].left + boxes[i - 1].width, "no gap between panels");
    }
    const last = boxes.at(-1);
    assert.equal(last.left + last.width, 1003, "the remainder column must not be dropped");
  });

  test("subject coverage separates a filled panel from bare backdrop", async () => {
    const f = await sheet("cov.png", [[0.1, 0.6], null]);
    const boxes = panelBoxes(1200, 900, 2);
    const filled = await subjectCoverage(f, boxes[0]);
    const empty = await subjectCoverage(f, boxes[1]);
    assert.ok(filled > 0.3, `filled panel read ${filled}`);
    assert.ok(empty < 0.05, `empty panel read ${empty}`);
  });
});

describe("the face strip", () => {
  test("the bust panel is shown WHOLE, not centre-cropped", async () => {
    // Three cleverer versions failed on real sheets: a `cover` resize cropped
    // a 1:3.75 column to a collar, a fixed band returned bare backdrop for a
    // panel whose subject sat low, and a neck-finder cropped to a forehead.
    // Whatever the close-up contains must survive into the strip — including,
    // especially, when what it contains is wrong.
    const f = await sheet(
      "bust.png",
      [[0.05, 0.8], [0.05, 0.8], [0.05, 0.8], [0.62, 0.3, { r: 250, g: 40, b: 40 }]],
    );
    const out = path.join(dir, "strip");
    await fsp.mkdir(out, { recursive: true });
    const boxes = panelBoxes(1200, 900, 4);
    const file = await buildFaceStrip(f, boxes, path.join(out, "s.png"), { kind: "character" });

    // The marker sits in the lower part of panel 4; if it reaches the strip,
    // the panel was letterboxed rather than cropped to its middle.
    const { data, info } = await sharp(file).extract({ left: 320 * 3, top: 0, width: 320, height: 320 })
      .raw().toBuffer({ resolveWithObject: true });
    let red = 0;
    for (let i = 0; i < data.length; i += info.channels) {
      if (data[i] > 180 && data[i + 1] < 90 && data[i + 2] < 90) red += 1;
    }
    assert.ok(red > 50, `the close-up's content must survive into the strip, found ${red} marker pixels`);
  });

  test("one cell per panel, at a fixed size", async () => {
    const f = await sheet("cells.png", [[0.05, 0.8], [0.05, 0.8], [0.05, 0.8], [0.05, 0.8]]);
    const out = path.join(dir, "strip2");
    await fsp.mkdir(out, { recursive: true });
    const file = await buildFaceStrip(f, panelBoxes(1200, 900, 4), path.join(out, "s.png"), { kind: "character" });
    const meta = await sharp(file).metadata();
    assert.equal(meta.width, 320 * 4);
    assert.equal(meta.height, 320);
  });
});

describe("inspectSheet", () => {
  test("an empty panel is a hard fail — the sheet did not come back as asked", async () => {
    const f = await sheet("missing.png", [[0.05, 0.8], [0.05, 0.8], [0.05, 0.8], null]);
    const r = await inspectSheet({ imagePath: f, kind: "character", panelCount: 4, outDir: path.join(dir, "o1") });
    const c = r.checks.find((x) => x.id === "panel_count");
    assert.equal(c.status, "fail");
    assert.equal(r.machine_verdict, "fail");
  });

  test("a 2x2 GRID is caught, though it has the same aspect ratio as a good sheet", async () => {
    // A prop sheet came back as a 2x2 grid. Sliced as a 1x4 strip every check
    // passed — each column did contain subject matter — and every crop was
    // garbage. Aspect ratio cannot separate the two: the grid and both correct
    // sheets were all 1536x1440. The gutter is the only tell.
    const grid = await sheet("grid.png", [
      [0.05, 0.35], [0.05, 0.35], [0.05, 0.35], [0.05, 0.35],
    ]);
    // Second row of the grid, composited on top.
    const withLower = path.join(dir, "grid2.png");
    const boxes = panelBoxes(1200, 900, 4);
    await sharp(grid).composite(boxes.map((b) => ({
      input: { create: { width: Math.round(b.width * 0.7), height: Math.round(900 * 0.35), channels: 3, background: { r: 20, g: 30, b: 40 } } },
      left: b.left + Math.round(b.width * 0.15),
      top: Math.round(900 * 0.6),
    }))).toFile(withLower);

    const r = await inspectSheet({ imagePath: withLower, kind: "item", panelCount: 4, outDir: path.join(dir, "o8") });
    const c = r.checks.find((x) => x.id === "layout_is_single_row");
    assert.equal(c.status, "fail", c.detail);
    assert.equal(r.machine_verdict, "fail");
  });

  test("a real single row is not mistaken for a grid", async () => {
    const f = await sheet("row.png", [[0.05, 0.8], [0.05, 0.8], [0.05, 0.8], [0.05, 0.8]]);
    const r = await inspectSheet({ imagePath: f, kind: "character", panelCount: 4, outDir: path.join(dir, "o9") });
    assert.equal(r.checks.find((x) => x.id === "layout_is_single_row").status, "ok");
  });

  test("a thin close-up panel fails — the head did not fill its panel", async () => {
    // The real defect from this project: three good full-body panels and a
    // close-up floating in mostly empty space.
    const f = await sheet("thin.png", [[0.05, 0.8], [0.05, 0.8], [0.05, 0.8], [0.05, 0.2]]);
    const r = await inspectSheet({ imagePath: f, kind: "character", panelCount: 4, outDir: path.join(dir, "o2") });
    const c = r.checks.find((x) => x.id === "closeup_fill");
    assert.equal(c.status, "fail", `ratio was ${c.value}`);
    assert.equal(r.machine_verdict, "fail");
  });

  test("a backdrop difference warns but never fails", async () => {
    // A close-up panel on a slightly brighter seamless scored 0.146 here on a
    // sheet that was correct in every way that mattered. Structure can fail;
    // a shade of grey may not.
    const f = await sheet("bg.png", [
      [0.05, 0.8, { r: 20, g: 30, b: 40 }],
      [0.05, 0.8, { r: 20, g: 30, b: 40 }],
      [0.05, 0.8, { r: 20, g: 30, b: 40 }],
      [0.05, 0.8, { r: 245, g: 245, b: 245 }],
    ]);
    const r = await inspectSheet({ imagePath: f, kind: "character", panelCount: 4, outDir: path.join(dir, "o7") });
    const c = r.checks.find((x) => x.id === "backdrop_consistency");
    assert.notEqual(c.status, "fail", "a backdrop check must never block a structurally sound sheet");
  });

  test("a well-formed sheet reaches inconclusive — never 'pass'", async () => {
    const f = await sheet("ok.png", [[0.05, 0.8], [0.05, 0.8], [0.05, 0.8], [0.05, 0.8]]);
    const r = await inspectSheet({ imagePath: f, kind: "character", panelCount: 4, outDir: path.join(dir, "o3") });
    assert.equal(r.machine_verdict, "inconclusive");
    assert.ok(!r.checks.some((c) => c.status === "fail"));
  });

  test("IT NEVER CLAIMS TO HAVE CHECKED IDENTITY", async () => {
    // The load-bearing test. There is no vision-language model available to
    // this tool, so any report implying the faces were compared is a lie that
    // launders an unchecked asset as a checked one.
    const f = await sheet("id.png", [[0.05, 0.8], [0.05, 0.8], [0.05, 0.8], [0.05, 0.8]]);
    const r = await inspectSheet({ imagePath: f, kind: "character", panelCount: 4, outDir: path.join(dir, "o4") });
    assert.equal(r.identity_checked, false);
    for (const id of ["identity_consistency", "feature_consistency", "no_text"]) {
      assert.equal(r.checks.find((c) => c.id === id).status, "unchecked", `${id} must stay unchecked`);
    }
    assert.notEqual(r.machine_verdict, "pass", "there is no pass verdict — only a human-or-model verdict approves");
  });

  test("it writes the panels and the face strip a reviewer needs to look at", async () => {
    const out = path.join(dir, "o5");
    const f = await sheet("files.png", [[0.05, 0.8], [0.05, 0.8], [0.05, 0.8], [0.05, 0.8]]);
    const r = await inspectSheet({ imagePath: f, kind: "character", panelCount: 4, outDir: out });
    assert.equal(r.panels.length, 4);
    for (const p of r.panels) await fsp.access(p.path);
    await fsp.access(r.face_strip);
    const meta = await sharp(r.face_strip).metadata();
    assert.equal(meta.width, 320 * 4, "one cell per panel, matched scale");
    assert.equal(meta.height, 320);
  });

  test("item sheets get item panel roles", async () => {
    const f = await sheet("item.png", [[0.2, 0.5], [0.2, 0.5], [0.2, 0.5], [0.2, 0.5]]);
    const r = await inspectSheet({ imagePath: f, kind: "item", panelCount: 4, outDir: path.join(dir, "o6") });
    assert.deepEqual(r.panels.map((p) => p.role), ["front", "three_quarter", "reverse", "macro"]);
    assert.ok(!r.checks.some((c) => c.id === "closeup_fill"), "an item sheet has no close-up panel");
  });
});

describe("the guard that stands between a reference and a paid clip", () => {
  const node = (id, review) => ({ id, type: "image_result", data: review ? { review } : {} });

  test("a REJECTED reference blocks, and says why", () => {
    const { blocked } = checkRefsReviewed([node("image_7", { verdict: "rejected", reason: "panel 3 costume differs" })]);
    assert.match(blocked, /image_7/);
    assert.match(blocked, /panel 3 costume differs/, "the reason must travel with the block");
  });

  test("an APPROVED reference passes silently", () => {
    const r = checkRefsReviewed([node("image_8", { verdict: "approved" })]);
    assert.equal(r.blocked, null);
    assert.equal(r.warning, null);
  });

  test("unreviewed and pending WARN but never block", () => {
    // Blocking here would turn a nudge into an obstacle and get the guard
    // switched off, which is how safety rails die.
    for (const review of [null, { verdict: "pending" }]) {
      const r = checkRefsReviewed([node("image_1", review)]);
      assert.equal(r.blocked, null, "must not block");
      assert.match(r.warning, /image_1/);
    }
  });

  test("one rejected reference among approved ones still blocks", () => {
    const { blocked } = checkRefsReviewed([
      node("image_8", { verdict: "approved" }),
      node("image_7", { verdict: "rejected", reason: "face drift" }),
    ]);
    assert.match(blocked, /image_7/);
    assert.ok(!blocked.includes("image_8"));
  });

  test("non-image nodes are ignored rather than mis-warned", () => {
    const r = checkRefsReviewed([{ id: "video_1", type: "video_result", data: {} }, null, undefined]);
    assert.equal(r.blocked, null);
    assert.equal(r.warning, null);
  });
});
