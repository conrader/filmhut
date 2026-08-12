// Perceptual signatures for continuity checking.
//
// WHAT THIS IS NOT: identity verification. Telling whether two shots show the
// same *person* needs a face or subject embedding model — and the honest state
// of that for a self-hosted tool is that it means shipping an ONNX runtime plus
// weights whose licences vary from Apache-2.0 to research-only. That is a real
// dependency decision, not a detail, so it is deliberately not made here.
//
// WHAT THIS IS: cheap, local, dependency-free detection of the continuity
// breaks that do not need a model — palette drift, exposure and lighting jumps,
// and gross composition changes. In the taxonomy the continuity skill uses,
// this covers `location_style` well, `seam` partially, and `identity` not at
// all. Every report says which, because a check that overstates itself is worse
// than no check.
//
// Built on sharp, already a dependency.

import sharp from "sharp";

const HASH_SIZE = 8;   // 8x8 comparisons from a 9x8 grid = 64 bits
const HIST_BINS = 8;   // per channel; 512 buckets total is plenty at this scale

/**
 * Difference hash. Encodes relative brightness between neighbouring pixels, so
 * it survives re-encoding and scaling but moves when the composition does.
 */
export async function dHash(imagePath) {
  const { data } = await sharp(imagePath)
    .greyscale()
    .resize(HASH_SIZE + 1, HASH_SIZE, { fit: "fill" })
    .raw()
    .toBuffer({ resolveWithObject: true });

  let bits = 0n;
  for (let y = 0; y < HASH_SIZE; y++) {
    for (let x = 0; x < HASH_SIZE; x++) {
      const left = data[y * (HASH_SIZE + 1) + x];
      const right = data[y * (HASH_SIZE + 1) + x + 1];
      bits = (bits << 1n) | (left > right ? 1n : 0n);
    }
  }
  return bits;
}

/** Fraction of differing bits — 0 identical, 1 opposite. */
export function hashDistance(a, b) {
  let x = a ^ b;
  let bits = 0;
  while (x > 0n) {
    bits += Number(x & 1n);
    x >>= 1n;
  }
  return bits / (HASH_SIZE * HASH_SIZE);
}

/** Normalised RGB histogram — the palette and exposure fingerprint. */
export async function colourHistogram(imagePath) {
  const { data, info } = await sharp(imagePath)
    .resize(64, 64, { fit: "fill" })
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });

  const hist = new Float64Array(HIST_BINS ** 3);
  const step = 256 / HIST_BINS;
  const pixels = info.width * info.height;
  for (let i = 0; i < data.length; i += info.channels) {
    const r = Math.min(HIST_BINS - 1, Math.floor(data[i] / step));
    const g = Math.min(HIST_BINS - 1, Math.floor(data[i + 1] / step));
    const b = Math.min(HIST_BINS - 1, Math.floor(data[i + 2] / step));
    hist[r * HIST_BINS * HIST_BINS + g * HIST_BINS + b] += 1;
  }
  for (let i = 0; i < hist.length; i++) hist[i] /= pixels;
  return hist;
}

/** Cosine similarity, 0..1. */
export function histogramSimilarity(a, b) {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

export async function signature(imagePath) {
  const [hash, histogram, stats] = await Promise.all([
    dHash(imagePath),
    colourHistogram(imagePath),
    sharp(imagePath).stats(),
  ]);
  const means = stats.channels.slice(0, 3).map((c) => c.mean);
  return {
    hash,
    histogram,
    brightness: means.reduce((a, b) => a + b, 0) / means.length / 255,
  };
}

/**
 * Compare a frame against a reference.
 *
 * Thresholds are conservative on purpose: this exists to catch the obvious
 * drift a human would also catch on a second look, not to arbitrate close
 * calls. A false "repair" wastes a paid generation.
 */
export function compare(a, b) {
  const palette = histogramSimilarity(a.histogram, b.histogram);
  const composition = 1 - hashDistance(a.hash, b.hash);
  const exposure = 1 - Math.min(1, Math.abs(a.brightness - b.brightness) * 2);

  const signals = [];
  if (palette < 0.55) signals.push({ bucket: "location_style", detail: `palette diverged (${palette.toFixed(2)})` });
  if (exposure < 0.6) signals.push({ bucket: "location_style", detail: `exposure shifted (${exposure.toFixed(2)})` });
  if (composition < 0.35) signals.push({ bucket: "seam", detail: `composition changed sharply (${composition.toFixed(2)})` });

  return {
    palette: round(palette),
    composition: round(composition),
    exposure: round(exposure),
    signals,
    // Named so no caller can mistake this for an identity verdict.
    identity_checked: false,
  };
}

const round = (n) => Math.round(n * 1000) / 1000;
