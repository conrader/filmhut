// F1 — trimming, and the honesty required to do it on a stream copy.
//
// The concat demuxer accepts `inpoint`/`outpoint` per entry, which makes it
// tempting to believe trimming and `-c copy` compose freely. They do not.
// ffmpeg's own documentation is explicit that this "works best with intra frame
// codecs", and that under stream copy you "will most likely get additional
// packets with presentation timestamp after Out point". H.264 is inter-frame:
// a decoder cannot start anywhere but a keyframe, so a copied cut lands on the
// nearest preceding one.
//
// So the choice is real and it belongs to the caller:
//
//   exact   — re-encode. The cut is where it was asked for. Costs CPU and a
//             generation of quality.
//   fast    — stream copy. Free and lossless, but the cut moves to a keyframe.
//
// This module decides which is possible, and — the part that matters — always
// reports which one happened and how far the cut actually moved. A trim that
// silently lands somewhere else is worse than one that refuses.

import { execFile } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);

/** How close a requested cut must be to a keyframe to call stream copy exact. */
export const KEYFRAME_TOLERANCE_S = 0.04; // ~1 frame at 25fps

export async function probeKeyframes(filePath) {
  const { stdout } = await run("ffprobe", [
    "-v", "error",
    "-select_streams", "v:0",
    "-skip_frame", "nokey",
    "-show_entries", "frame=pts_time",
    "-of", "csv=p=0",
    filePath,
  ], { maxBuffer: 8 * 1024 * 1024 });

  return stdout
    .split("\n")
    .map((l) => Number(l.trim().replace(/,$/, "")))
    .filter((n) => Number.isFinite(n))
    .sort((a, b) => a - b);
}

export async function probeMedia(filePath) {
  const { stdout } = await run("ffprobe", [
    "-v", "error",
    "-show_entries", "stream=codec_type,codec_name,width,height,sample_rate,r_frame_rate",
    "-show_entries", "format=duration",
    "-of", "json",
    filePath,
  ], { maxBuffer: 4 * 1024 * 1024 });

  const parsed = JSON.parse(stdout);
  const video = (parsed.streams ?? []).find((s) => s.codec_type === "video") ?? null;
  const audio = (parsed.streams ?? []).find((s) => s.codec_type === "audio") ?? null;
  return {
    duration: Number(parsed.format?.duration ?? 0),
    video: video && {
      codec: video.codec_name,
      width: Number(video.width),
      height: Number(video.height),
      frameRate: video.r_frame_rate,
    },
    audio: audio && { codec: audio.codec_name, sampleRate: Number(audio.sample_rate) },
    hasAudio: Boolean(audio),
  };
}

/** Nearest keyframe at or before `t` — where a copied cut actually lands. */
export function keyframeAtOrBefore(keyframes, t) {
  let best = keyframes.length ? keyframes[0] : 0;
  for (const k of keyframes) {
    if (k <= t + 1e-6) best = k;
    else break;
  }
  return best;
}

/**
 * Work out whether a set of trims can be stream-copied without moving.
 *
 * Returns the decision AND the per-clip drift, so a caller can show the user
 * where their cut would actually land instead of discovering it in the export.
 */
export async function planTrims(clips, { tolerance = KEYFRAME_TOLERANCE_S } = {}) {
  const analysed = [];

  for (const clip of clips) {
    const media = await probeMedia(clip.path);
    const trimmed = Number(clip.in_s ?? 0) > 0 || (clip.out_s != null && clip.out_s < media.duration);

    let drift = 0;
    let landsAt = Number(clip.in_s ?? 0);
    let outAligned = true;

    if (trimmed) {
      const keyframes = await probeKeyframes(clip.path);

      if (Number(clip.in_s ?? 0) > 0) {
        landsAt = keyframeAtOrBefore(keyframes, Number(clip.in_s));
        drift = Number(clip.in_s) - landsAt;
      }

      // THE OUT POINT MATTERS TOO, AND USED NOT TO BE CHECKED AT ALL.
      //
      // Only in-points were measured against keyframes, so a clip trimmed at
      // the END — which is the common case, and every trim in one finished
      // film — reported zero drift and was stream-copied. Copying to an out
      // point inside a GOP leaves the muxer emitting packets whose DTS run
      // past the cut, and the export lands with non-monotonic timestamps: it
      // plays, mostly, and is quietly broken.
      //
      // A copy can only end a segment where a keyframe begins, so the out
      // point has to coincide with one.
      if (clip.out_s != null && clip.out_s < media.duration) {
        outAligned = keyframes.some((k) => Math.abs(k - Number(clip.out_s)) <= tolerance);
      }
    }

    analysed.push({
      ...clip, media, trimmed, copyLandsAt: landsAt, copyDriftSeconds: drift, outAligned,
    });
  }

  const anyTrimmed = analysed.some((c) => c.trimmed);
  const maxDrift = analysed.reduce((m, c) => Math.max(m, c.copyDriftSeconds), 0);

  // Uniformity still governs whether concat can copy at all — the sample-rate
  // mismatch that corrupts audio silently is the reason this check exists.
  const rates = new Set(analysed.filter((c) => c.media.hasAudio).map((c) => c.media.audio.sampleRate));
  const dims = new Set(analysed.filter((c) => c.media.video).map((c) => `${c.media.video.width}x${c.media.video.height}`));
  const someSilent = analysed.some((c) => !c.media.hasAudio);
  const uniform = rates.size <= 1 && dims.size <= 1 && !someSilent;

  const reasons = [];
  if (rates.size > 1) reasons.push(`audio sample rates differ (${[...rates].join(", ")}Hz)`);
  if (dims.size > 1) reasons.push(`resolutions differ (${[...dims].join(", ")})`);
  if (someSilent) reasons.push("at least one clip has no audio track");
  const misalignedOut = analysed.filter((c) => c.trimmed && !c.outAligned);
  if (misalignedOut.length) {
    reasons.push(
      `${misalignedOut.length} out point${misalignedOut.length === 1 ? " does" : "s do"} not land on a keyframe`,
    );
  }
  if (anyTrimmed && maxDrift > tolerance) {
    reasons.push(`a cut is ${maxDrift.toFixed(3)}s from the nearest keyframe`);
  }

  const canCopy = uniform
    && (!anyTrimmed || maxDrift <= tolerance)
    && misalignedOut.length === 0;

  return {
    clips: analysed,
    mode: canCopy ? "copy" : "encode",
    exact: canCopy ? maxDrift <= tolerance : true, // re-encoding is always exact
    maxDriftSeconds: maxDrift,
    reasons,
  };
}

/** A concat list carrying per-entry trim points. */
export function buildConcatList(clips) {
  return clips
    .map((c) => {
      const lines = [`file '${c.path.replace(/'/g, "'\\''")}'`];
      if (Number(c.in_s ?? 0) > 0) lines.push(`inpoint ${Number(c.in_s).toFixed(3)}`);
      if (c.out_s != null) lines.push(`outpoint ${Number(c.out_s).toFixed(3)}`);
      return lines.join("\n");
    })
    .join("\n");
}

/**
 * A filter graph that trims exactly, for when copy would move the cut.
 * Silent clips get a generated silent track so the audio pads line up —
 * without it the graph fails on any reel containing one.
 */
export function buildTrimFilter(clips) {
  const parts = [];
  const pads = [];
  clips.forEach((c, i) => {
    const from = Number(c.in_s ?? 0);
    const to = c.out_s == null ? null : Number(c.out_s);
    const vTrim = to == null ? `trim=start=${from}` : `trim=start=${from}:end=${to}`;
    parts.push(`[${i}:v]${vTrim},setpts=PTS-STARTPTS[v${i}]`);
    if (c.media?.hasAudio) {
      const aTrim = to == null ? `atrim=start=${from}` : `atrim=start=${from}:end=${to}`;
      parts.push(`[${i}:a]${aTrim},asetpts=PTS-STARTPTS[a${i}]`);
    } else {
      const dur = (to ?? c.media?.duration ?? 0) - from;
      parts.push(`anullsrc=channel_layout=stereo:sample_rate=48000,atrim=duration=${dur.toFixed(3)}[a${i}]`);
    }
    pads.push(`[v${i}][a${i}]`);
  });
  parts.push(`${pads.join("")}concat=n=${clips.length}:v=1:a=1[outv][outa]`);
  return parts.join(";");
}
