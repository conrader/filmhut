// Transitions between shots.
//
// Concatenation is not stitching. Butting clips end to end gives a hard cut at
// every join, which is right for some edits and wrong for most — and when the
// shots came from a generator that drifts, hard cuts advertise the drift. A
// dissolve carries the eye across the seam.
//
// The cost is real and worth stating: a transition CANNOT be stream-copied.
// Blending two clips means decoding both, so any reel with transitions
// re-encodes. That is why this is opt-in per render rather than a default.
//
// Every transition also SHORTENS the reel: two clips overlapping by d seconds
// produce a reel d shorter than their sum. Callers who promised a duration
// need to know that, so the plan reports it rather than leaving it to be
// discovered in the output.

/** ffmpeg xfade transitions worth exposing. Others exist; these are the ones an editor reaches for. */
export const TRANSITIONS = new Set([
  "fade",        // dissolve — the default
  "fadeblack",   // through black; a beat, not a blend
  "fadewhite",   // through white; a shock or a memory
  "dissolve",    // grainier than fade, good over texture
  "smoothleft", "smoothright", "smoothup", "smoothdown",
  "wipeleft", "wiperight",
  "circleopen", "circleclose",
]);

export const DEFAULT_TRANSITION = "fade";
export const DEFAULT_DURATION_S = 0.5;

export function isValidTransition(name) {
  return TRANSITIONS.has(String(name));
}

/**
 * Work out where each transition sits and what the reel will actually run to.
 *
 * `clips` are `{ path, duration }` in reel order. A transition is only possible
 * where both neighbours are longer than the overlap — a 0.5s dissolve between
 * two 0.4s clips would consume them entirely, so those joins stay hard cuts and
 * are reported as skipped rather than silently dropped.
 */
export function planTransitions(clips, { transition = DEFAULT_TRANSITION, durationS = DEFAULT_DURATION_S } = {}) {
  if (!isValidTransition(transition)) {
    throw new Error(`unknown transition "${transition}" — try one of: ${[...TRANSITIONS].join(", ")}`);
  }
  const d = Math.max(0.05, Number(durationS) || DEFAULT_DURATION_S);
  const joins = [];
  const skipped = [];

  // Offset of each xfade, in the timeline of everything merged so far.
  let offset = 0;
  for (let i = 0; i < clips.length - 1; i++) {
    const a = Number(clips[i].duration) || 0;
    const b = Number(clips[i + 1].duration) || 0;
    offset += a;

    // Both sides must survive the overlap with something left to show.
    if (a <= d || b <= d) {
      skipped.push({ join: i, reason: `clip too short for a ${d}s transition (${a.toFixed(2)}s → ${b.toFixed(2)}s)` });
      continue;
    }
    joins.push({ join: i, offsetS: +(offset - d).toFixed(3) });
    offset -= d; // the overlap pulls everything after it earlier
  }

  const rawTotal = clips.reduce((n, c) => n + (Number(c.duration) || 0), 0);
  return {
    transition,
    durationS: d,
    joins,
    skipped,
    // What the caller asked for versus what they will get.
    rawDurationS: +rawTotal.toFixed(3),
    finalDurationS: +(rawTotal - joins.length * d).toFixed(3),
    shortenedByS: +(joins.length * d).toFixed(3),
  };
}

/**
 * The filter graph. Video crosses with xfade, audio with acrossfade, so a
 * dissolve does not leave the sound cutting hard underneath the picture.
 *
 * Clips with no audio get a generated silent track — without it the audio
 * chain breaks on the first silent clip and takes the whole render with it.
 */
export function buildTransitionFilter(clips, plan) {
  const parts = [];
  const withTransition = new Set(plan.joins.map((j) => j.join));

  clips.forEach((c, i) => {
    // Apply the clip's trim window BEFORE the crossfade. Without this the
    // transition path silently renders whole clips while the non-transition
    // path honours in_s/out_s — two exporters disagreeing about the same edit.
    const from = Number(c.in_s ?? 0);
    const to = c.out_s == null ? null : Number(c.out_s);
    const vTrim = from > 0 || to != null
      ? (to == null ? `trim=start=${from},` : `trim=start=${from}:end=${to},`)
      : "";
    parts.push(`[${i}:v]${vTrim}setpts=PTS-STARTPTS,settb=AVTB,fps=30,format=yuv420p[v${i}]`);

    if (c.hasAudio === false) {
      const dur = (to ?? Number(c.duration) ?? 0) - from;
      parts.push(`anullsrc=channel_layout=stereo:sample_rate=48000,atrim=duration=${dur.toFixed(3)},asetpts=PTS-STARTPTS[a${i}]`);
    } else {
      const aTrim = from > 0 || to != null
        ? (to == null ? `atrim=start=${from},` : `atrim=start=${from}:end=${to},`)
        : "";
      parts.push(`[${i}:a]${aTrim}aresample=48000,asetpts=PTS-STARTPTS[a${i}]`);
    }
  });

  let v = "v0";
  let a = "a0";
  for (let i = 0; i < clips.length - 1; i++) {
    const nv = `vx${i}`;
    const na = `ax${i}`;
    if (withTransition.has(i)) {
      const { offsetS } = plan.joins.find((j) => j.join === i);
      parts.push(`[${v}][v${i + 1}]xfade=transition=${plan.transition}:duration=${plan.durationS}:offset=${offsetS}[${nv}]`);
      parts.push(`[${a}][a${i + 1}]acrossfade=d=${plan.durationS}[${na}]`);
    } else {
      // Hard cut where a transition would not fit.
      parts.push(`[${v}][v${i + 1}]concat=n=2:v=1:a=0[${nv}]`);
      parts.push(`[${a}][a${i + 1}]concat=n=2:v=0:a=1[${na}]`);
    }
    v = nv;
    a = na;
  }

  parts.push(`[${v}]null[outv]`);
  parts.push(`[${a}]anull[outa]`);
  return parts.join(";");
}
