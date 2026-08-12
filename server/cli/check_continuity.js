#!/usr/bin/env node
// Compare a landed asset against its references, cheaply and locally.
//
//   node check_continuity.js --path assets/videos/video_5.mp4 \
//     --ref assets/images/image_2.png --ref assets/images/image_3.png
//
// Free: no provider call, no network. Complements the agent-side discipline in
// the continuity-compose skill by putting numbers under the eyeball check.
//
// It reports palette, exposure and composition agreement. It does NOT verify
// identity — that needs an embedding model this tool does not ship — and the
// output says so on every run rather than letting a passing score be read as
// "the character is the same person".

import path from "node:path";
import fs from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { parseArgs, emitSuccess, emitFailure, isoNow } from "./_cli.js";
import { signature, compare } from "../lib/imagesig.js";

const run = promisify(execFile);

const args = parseArgs({
  path:  { type: "string" },
  ref:   { type: "string", multiple: true },
  frames:{ type: "string" },
  json:  { type: "boolean" },
});

if (!args.path) {
  emitFailure("bad_args", "--path is required: the asset to check");
  process.exit(2);
}
const refs = Array.isArray(args.ref) ? args.ref : args.ref ? [args.ref] : [];
if (refs.length === 0) {
  emitFailure("bad_args", "at least one --ref is required: what the asset should agree with");
  process.exit(2);
}

const target = path.resolve(process.cwd(), args.path);
if (!fs.existsSync(target)) {
  emitFailure("bad_args", `no file at ${target}`);
  process.exit(2);
}

const isVideo = /\.(mp4|mov|webm|mkv)$/i.test(target);
const frameCount = Math.max(2, Math.min(12, Number(args.frames) || 5));
const tmpDir = path.join(path.dirname(target), ".continuity-tmp");

try {
  let framePaths = [target];

  if (isVideo) {
    // Sample across the clip: drift usually appears at one end, so a single
    // frame is the one thing that reliably misses it.
    fs.mkdirSync(tmpDir, { recursive: true });
    const pattern = path.join(tmpDir, "f_%03d.jpg");
    await run("ffmpeg", [
      "-y", "-i", target,
      "-vf", `fps=1/${Math.max(1, Math.floor(8 / frameCount))},scale=320:-1`,
      "-frames:v", String(frameCount),
      pattern,
    ], { maxBuffer: 16 * 1024 * 1024 });
    framePaths = fs.readdirSync(tmpDir).filter((f) => f.endsWith(".jpg")).sort()
      .map((f) => path.join(tmpDir, f));
    if (framePaths.length === 0) throw new Error("no frames could be extracted");
  }

  const refSigs = [];
  for (const r of refs) {
    const abs = path.resolve(process.cwd(), r);
    if (!fs.existsSync(abs)) throw new Error(`reference not found: ${abs}`);
    refSigs.push({ path: abs, sig: await signature(abs) });
  }

  const perFrame = [];
  for (const f of framePaths) {
    const sig = await signature(f);
    // Best-matching reference: a shot legitimately resembles one anchor more
    // than another, and penalising it for that would produce noise.
    let best = null;
    for (const r of refSigs) {
      const result = compare(sig, r.sig);
      const score = (result.palette + result.exposure + result.composition) / 3;
      if (!best || score > best.score) best = { score, result, ref: path.basename(r.path) };
    }
    perFrame.push({ frame: path.basename(f), ...best.result, matched_ref: best.ref });
  }

  const avg = (k) => perFrame.reduce((n, f) => n + f[k], 0) / perFrame.length;
  const signals = perFrame.flatMap((f) => f.signals);
  const buckets = [...new Set(signals.map((s) => s.bucket))];

  const verdict = buckets.length === 0 ? "pass" : buckets.includes("location_style") ? "review" : "minor";

  emitSuccess({
    ok: true,
    kind: "continuity_check",
    checked_at: isoNow(),
    asset: target,
    references: refSigs.map((r) => path.basename(r.path)),
    frames_sampled: perFrame.length,
    palette: Math.round(avg("palette") * 1000) / 1000,
    exposure: Math.round(avg("exposure") * 1000) / 1000,
    composition: Math.round(avg("composition") * 1000) / 1000,
    verdict,
    buckets,
    issues: [...new Set(signals.map((s) => s.detail))],
    identity_checked: false,
    note: "palette, exposure and composition only — identity is NOT verified here; compare faces yourself or via the continuity-compose skill",
    ...(args.json ? { per_frame: perFrame } : {}),
  });
} catch (e) {
  emitFailure(e?.message?.includes("ffmpeg") ? "infra" : "bad_args", e?.message ?? String(e));
  process.exit(1);
} finally {
  fs.rmSync(tmpDir, { recursive: true, force: true });
}
