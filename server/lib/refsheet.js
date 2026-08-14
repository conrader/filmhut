// Preparing a reference for review, and the mechanical half of reviewing it.
//
// A reference sheet is the one asset whose defects propagate. Every clip
// anchored on it inherits whatever it got wrong, and the cost of finding out
// late is every generation made in between. So it gets a gate.
//
// THE DIVISION OF LABOUR IS THE WHOLE DESIGN.
//
// There is no vision-language model in the deAPI catalogue — image in, text
// out does not exist there; the closest thing is an OCR model. So filmhut
// cannot form an opinion about whether panel 4 shows the same face as panel 1.
// Pretending otherwise would be worse than useless, because a green tick that
// means nothing is how a defect reaches a human with an air of having been
// checked.
//
// What a machine CAN settle, it settles here:
//   - did the model actually produce N panels, or one image with empty margins?
//   - is the costume the same across the full-body panels?
//   - is the backdrop the same, or did one panel drift to another set?
//
// What only a model that can SEE can settle — is this the same person, is
// there a second face, did facial hair appear in one view and not another —
// is left explicitly unresolved and marked `unchecked`. The CLI's job is to
// hand that model the crops it needs and refuse to call the reference approved
// until a verdict comes back. Silence is never approval.

import sharp from "sharp";
import path from "node:path";
import fs from "node:fs/promises";

import { colourHistogram, histogramSimilarity } from "./imagesig.js";

/** What each panel is for, in the order reference_sheet.js asks for them. */
export const PANEL_ROLES = {
  character: ["front", "profile", "back", "closeup"],
  item: ["front", "three_quarter", "reverse", "macro"],
};

// A head occupies roughly the top quarter of a full-body panel. Generous on
// purpose: a band that clips the chin is worse than one carrying some backdrop.
const HEAD_BAND = { top: 0.04, height: 0.26 };
// Costume lives below the head and above the feet.
const BODY_BAND = { top: 0.35, height: 0.45 };
// Backdrop sample: a thin strip down each panel's outer edge.
const EDGE_FRACTION = 0.06;

/** Equal-width vertical panels, which is the layout the sheet prompt asks for. */
export function panelBoxes(width, height, count) {
  const w = Math.floor(width / count);
  return Array.from({ length: count }, (_, i) => ({
    left: i * w,
    top: 0,
    width: i === count - 1 ? width - i * w : w,
    height,
  }));
}

function band(box, spec) {
  return {
    left: box.left,
    top: box.top + Math.round(box.height * spec.top),
    width: box.width,
    height: Math.round(box.height * spec.height),
  };
}

/**
 * How much of a region is subject rather than backdrop.
 *
 * The sheets are shot on a seamless mid-grey, so "backdrop" is the modal
 * intensity and subject is everything far from it. This is what catches a
 * sheet that came back as one portrait with dead space beside it — the failure
 * that looks fine in a thumbnail and ruins every downstream anchor.
 */
export async function subjectCoverage(imagePath, box) {
  const { data, info } = await sharp(imagePath)
    .extract(box)
    .greyscale()
    .resize(64, 64, { fit: "fill" })
    .raw()
    .toBuffer({ resolveWithObject: true });

  const hist = new Uint32Array(256);
  for (let i = 0; i < data.length; i++) hist[data[i]] += 1;
  let modal = 0;
  for (let v = 1; v < 256; v++) if (hist[v] > hist[modal]) modal = v;

  let off = 0;
  for (let i = 0; i < data.length; i++) if (Math.abs(data[i] - modal) > 18) off += 1;
  return round(off / (info.width * info.height));
}

/** Write each panel out as its own file so a model can be shown them. */
export async function slicePanels(imagePath, outDir, count) {
  const meta = await sharp(imagePath).metadata();
  const boxes = panelBoxes(meta.width, meta.height, count);
  await fs.mkdir(outDir, { recursive: true });

  const out = [];
  for (const [i, box] of boxes.entries()) {
    const file = path.join(outDir, `panel_${i + 1}.png`);
    await sharp(imagePath).extract(box).toFile(file);
    out.push({ index: i + 1, path: file, box });
  }
  return { boxes, panels: out, width: meta.width, height: meta.height };
}

/**
 * The head of every panel, side by side.
 *
 * This is the crop that matters. Asked to compare four full-body panels a
 * reviewer skims; asked to compare four heads it cannot help but notice that
 * one of them has a moustache the others do not. The strip exists to make a
 * defect unmissable rather than merely present.
 *
 * WHICH REGION, AND WHY IT IS NOT CLEVER
 *
 * The sheet prompt fixes the layout, so the panel's role is known by contract:
 * panels 1-3 of a character sheet are full-body, panel 4 is the bust. Full-body
 * panels give up their head to a fixed top band; the bust IS the crop and is
 * letterboxed whole.
 *
 * Three cleverer versions came before this one, and each failed on a real
 * sheet: a `cover` resize of the whole panel centre-cropped a 1:3.75 column to
 * a collar; a fixed band returned bare backdrop for a panel whose subject sat
 * low; a neck-finding detector cropped two panels to a forehead. Contract beats
 * inference here, and a review aid that is wrong is worse than a plain one.
 */
export async function buildFaceStrip(imagePath, boxes, outFile, { kind = "character" } = {}) {
  const CELL = 320;
  const BG = { r: 16, g: 16, b: 16 };
  const tiles = [];
  for (const [i, box] of boxes.entries()) {
    const isBust = kind === "character" && boxes.length === 4 && i === 3;
    tiles.push(
      await sharp(imagePath)
        .extract(isBust ? box : band(box, HEAD_BAND))
        // `contain` on the bust: it is already framed on the face, and its
        // aspect does not match the cell. Letterboxing shows all of it, which
        // is the whole point of putting it here.
        .resize(CELL, CELL, { fit: isBust ? "contain" : "fill", background: BG })
        .png()
        .toBuffer(),
    );
  }

  await sharp({
    create: { width: CELL * tiles.length, height: CELL, channels: 3, background: BG },
  })
    .composite(tiles.map((input, i) => ({ input, left: i * CELL, top: 0 })))
    .png()
    .toFile(outFile);

  return outFile;
}

async function bandHistogram(imagePath, box, spec) {
  const region = band(box, spec);
  const buf = await sharp(imagePath).extract(region).png().toBuffer();
  return colourHistogram(buf);
}

async function edgeHistogram(imagePath, box) {
  const w = Math.max(2, Math.round(box.width * EDGE_FRACTION));
  const buf = await sharp(imagePath)
    .extract({ left: box.left, top: box.top, width: w, height: box.height })
    .png()
    .toBuffer();
  return colourHistogram(buf);
}

/** Lowest pairwise similarity in a set, and which pair it was. */
function weakestPair(vectors) {
  let worst = { similarity: 1, pair: null };
  for (let i = 0; i < vectors.length; i++) {
    for (let j = i + 1; j < vectors.length; j++) {
      const s = histogramSimilarity(vectors[i], vectors[j]);
      if (s < worst.similarity) worst = { similarity: round(s), pair: [i + 1, j + 1] };
    }
  }
  return worst;
}

/**
 * Run every check a machine can run, and name the ones it cannot.
 *
 * Returns checks with status ok | warn | fail | unchecked. `unchecked` is not
 * a soft pass — it is the reason this function alone can never approve
 * anything.
 */
export async function inspectSheet({ imagePath, kind = "character", panelCount = 4, outDir }) {
  const { boxes, panels, width, height } = await slicePanels(imagePath, outDir, panelCount);
  const roles = PANEL_ROLES[kind] ?? [];

  for (const p of panels) {
    p.role = roles[p.index - 1] ?? `panel_${p.index}`;
    p.subject_coverage = await subjectCoverage(imagePath, p.box);
  }

  const stripPath = path.join(outDir, "face_strip.png");
  await buildFaceStrip(imagePath, boxes, stripPath, { kind });

  const checks = [];

  // 1. Are there really N panels?
  const empty = panels.filter((p) => p.subject_coverage < 0.08);
  checks.push(empty.length === 0
    ? { id: "panel_count", status: "ok", detail: `${panelCount} panels, all with subject content` }
    : {
        id: "panel_count",
        status: "fail",
        detail: `panel${empty.length > 1 ? "s" : ""} ${empty.map((p) => p.index).join(", ")} `
          + `${empty.length > 1 ? "are" : "is"} mostly empty backdrop `
          + `(coverage ${empty.map((p) => p.subject_coverage).join(", ")}) — the sheet did not come back as `
          + `${panelCount} panels`,
      });

  // 1b. Did the close-up actually fill its panel?
  //
  // A bust fills MORE of its frame than a standing figure does, so the face
  // panel should read at least as dense as the full-body ones. When it comes
  // back much thinner, the model put a small head in a large empty panel — or,
  // worse, spilled it across the neighbouring column. Both wreck the panel the
  // downstream anchor depends on most.
  //
  // Ratio, not an absolute: absolute coverage moves with costume and crop, the
  // ratio does not. Measured on this project's sheets it separated cleanly —
  // 0.44 and 0.56 on the two defective sheets, 0.91 on the good one — but three
  // sheets is an observation, not a calibration, so it warns before it fails.
  if (kind === "character" && panels.length === 4) {
    const body = panels.slice(0, 3).map((p) => p.subject_coverage).sort((a, b) => a - b)[1];
    const ratio = body > 0 ? round(panels[3].subject_coverage / body) : 1;
    checks.push({
      id: "closeup_fill",
      status: ratio < 0.6 ? "fail" : ratio < 0.8 ? "warn" : "ok",
      detail: `close-up panel carries ${ratio}× the subject density of the full-body panels`
        + (ratio < 0.8 ? " — the head does not fill its panel, or has spilled outside it" : ""),
      value: ratio,
    });
  }

  // 2. Costume, across the panels that show a body. The close-up is a bust, so
  //    its body band is collar and shoulders and would drag the number down
  //    for a sheet that is actually correct.
  const bodyPanels = kind === "character" ? boxes.slice(0, 3) : boxes;
  if (bodyPanels.length > 1) {
    const hists = [];
    for (const b of bodyPanels) hists.push(await bandHistogram(imagePath, b, BODY_BAND));
    const worst = weakestPair(hists);
    checks.push({
      id: "costume_consistency",
      status: worst.similarity < 0.55 ? "fail" : worst.similarity < 0.75 ? "warn" : "ok",
      detail: `weakest pair panels ${worst.pair?.join("/")} at ${worst.similarity}`,
      value: worst.similarity,
    });
  }

  // 3. Backdrop. A panel shot on a different set reads as a different
  //    photograph.
  //
  //    WARN AT WORST, NEVER FAIL. This one is noisy: a close-up panel whose
  //    seamless is a shade brighter than the full-body panels scored 0.146 —
  //    lower than a sheet with an outright broken panel — on a sheet that was
  //    correct in every way that matters. The metric cannot separate "slightly
  //    brighter grey" from "different location", and a check that blocks a good
  //    asset on a distinction it cannot draw costs a re-roll for nothing.
  //
  //    Contrast panel_count and closeup_fill, which do fail: those measure
  //    whether the sheet has the STRUCTURE it was asked for. A backdrop shade
  //    is cosmetic — it does not stop the panel doing its job as an anchor.
  const edges = [];
  for (const b of boxes) edges.push(await edgeHistogram(imagePath, b));
  const worstEdge = weakestPair(edges);
  checks.push({
    id: "backdrop_consistency",
    status: worstEdge.similarity < 0.8 ? "warn" : "ok",
    detail: `weakest pair panels ${worstEdge.pair?.join("/")} at ${worstEdge.similarity}`
      + (worstEdge.similarity < 0.5 ? " — check whether that panel was shot on a different set" : ""),
    value: worstEdge.similarity,
  });

  // 4-6. The ones that need eyes. Stated, never guessed.
  checks.push({
    id: "identity_consistency",
    status: "unchecked",
    detail: "whether every panel shows the SAME subject — and only that subject — "
      + "cannot be settled without a model that can see. Look at face_strip.png.",
  });
  checks.push({
    id: "feature_consistency",
    status: "unchecked",
    detail: "facial hair, spectacles, headwear and jewellery appearing in one view and not "
      + "another. Small in pixels, fatal in a reference. Look at face_strip.png.",
  });
  checks.push({
    id: "no_text",
    status: "unchecked",
    detail: "captions or gibberish lettering anywhere in frame — these get baked into every "
      + "downstream shot. Look at the full sheet.",
  });

  return {
    kind,
    panel_count: panelCount,
    dimensions: { width, height },
    panels: panels.map((p) => ({ index: p.index, role: p.role, path: p.path, subject_coverage: p.subject_coverage })),
    face_strip: stripPath,
    checks,
    machine_verdict: checks.some((c) => c.status === "fail") ? "fail" : "inconclusive",
    // The load-bearing field. No caller may treat this report as an approval.
    identity_checked: false,
  };
}

const round = (n) => Math.round(n * 1000) / 1000;
