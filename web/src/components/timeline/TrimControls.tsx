import { useEffect, useMemo, useState } from 'react'
import type { VideoResultNode } from '../../types/canvas'

/**
 * In and out points for one reel clip.
 *
 * The reason this exists: a generation runs to a frame budget, not to the
 * length of the shot you wanted. Before trimming, a ten-second clip that is
 * good for six had to be regenerated at full price. Now it gets cut.
 *
 * Two things the UI has to be honest about, because the export path is:
 *   - the kept range and the discarded remainder, so the cost of a bad
 *     generation is visible rather than implied;
 *   - that trimming forces a re-encode unless the cut happens to land on a
 *     keyframe, which is slower than a straight copy.
 */

export interface TrimControlsProps {
  clip: VideoResultNode
  onApply: (nodeId: string, inS: number | null, outS: number | null) => Promise<void> | void
  disabled?: boolean
}

const fmt = (n: number) => `${n.toFixed(2)}s`

/** Accept "2", "2.5", "1:03.5" — people type timecode without being asked to. */
export function parseTime(raw: string): number | null {
  const text = raw.trim()
  if (text === '') return null
  const parts = text.split(':')
  if (parts.length === 2) {
    const m = Number(parts[0])
    const s = Number(parts[1])
    if (!Number.isFinite(m) || !Number.isFinite(s)) return null
    return m * 60 + s
  }
  const n = Number(text)
  return Number.isFinite(n) ? n : null
}

export function clampWindow(
  inS: number | null,
  outS: number | null,
  duration: number,
): { in: number | null; out: number | null; error: string | null } {
  const start = inS == null ? null : Math.max(0, Math.min(inS, duration))
  const end = outS == null ? null : Math.max(0, Math.min(outS, duration))
  if (start != null && end != null && end <= start) {
    return { in: start, out: end, error: 'The out point has to come after the in point.' }
  }
  return { in: start, out: end, error: null }
}

export default function TrimControls({ clip, onApply, disabled = false }: TrimControlsProps) {
  const duration = Number(clip.data.duration) || 0
  const storedIn = clip.data.in_s ?? null
  const storedOut = clip.data.out_s ?? null

  const [inText, setInText] = useState(storedIn == null ? '' : String(storedIn))
  const [outText, setOutText] = useState(storedOut == null ? '' : String(storedOut))
  const [busy, setBusy] = useState(false)

  // A clip can change under us — a drag reorders the reel, a regeneration
  // replaces the node. Re-seed rather than leave stale text in the boxes.
  useEffect(() => {
    setInText(storedIn == null ? '' : String(storedIn))
    setOutText(storedOut == null ? '' : String(storedOut))
  }, [clip.id, storedIn, storedOut])

  const parsed = useMemo(() => {
    const { in: i, out: o, error } = clampWindow(parseTime(inText), parseTime(outText), duration)
    const kept = (o ?? duration) - (i ?? 0)
    return { i, o, error, kept }
  }, [inText, outText, duration])

  const isTrimmed = storedIn != null || storedOut != null
  const dirty =
    (parsed.i ?? null) !== storedIn || (parsed.o ?? null) !== storedOut
  const discarded = Math.max(0, duration - parsed.kept)

  const apply = async () => {
    if (parsed.error || busy) return
    setBusy(true)
    try {
      await onApply(clip.id, parsed.i, parsed.o)
    } finally {
      setBusy(false)
    }
  }

  const reset = async () => {
    setInText('')
    setOutText('')
    if (isTrimmed) {
      setBusy(true)
      try {
        await onApply(clip.id, null, null)
      } finally {
        setBusy(false)
      }
    }
  }

  return (
    <div className="trim-controls" data-trimmed={isTrimmed ? 'true' : 'false'}>
      <div className="trim-row">
        <label className="trim-field">
          <span>In</span>
          <input
            type="text"
            inputMode="decimal"
            value={inText}
            placeholder="0"
            disabled={disabled || busy}
            onChange={(e) => setInText(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') void apply() }}
            aria-label={`In point for ${clip.data.label}`}
          />
        </label>
        <label className="trim-field">
          <span>Out</span>
          <input
            type="text"
            inputMode="decimal"
            value={outText}
            placeholder={fmt(duration)}
            disabled={disabled || busy}
            onChange={(e) => setOutText(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') void apply() }}
            aria-label={`Out point for ${clip.data.label}`}
          />
        </label>
      </div>

      {parsed.error ? (
        <p className="trim-note trim-error">{parsed.error}</p>
      ) : (
        <p className="trim-note">
          Keeping {fmt(Math.max(0, parsed.kept))} of {fmt(duration)}
          {discarded > 0.01 ? ` · dropping ${fmt(discarded)}` : ''}
        </p>
      )}

      {dirty && !parsed.error ? (
        <p className="trim-note trim-hint">
          Export re-encodes a trimmed clip unless the cut lands on a keyframe.
        </p>
      ) : null}

      <div className="trim-row trim-actions">
        <button type="button" onClick={() => void apply()} disabled={disabled || busy || !dirty || !!parsed.error}>
          {busy ? 'Saving…' : 'Apply trim'}
        </button>
        <button type="button" className="ghost" onClick={() => void reset()} disabled={disabled || busy || (!isTrimmed && !dirty)}>
          Use whole clip
        </button>
      </div>
    </div>
  )
}
