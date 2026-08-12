import { describe, expect, test } from 'vitest'
import { clampWindow, parseTime } from './TrimControls'

describe('parsing what a person actually types', () => {
  test('plain seconds', () => {
    expect(parseTime('2')).toBe(2)
    expect(parseTime('2.5')).toBe(2.5)
    expect(parseTime(' 3.25 ')).toBe(3.25)
  })

  test('timecode, because people type it without being asked', () => {
    expect(parseTime('1:03')).toBe(63)
    expect(parseTime('0:07.5')).toBe(7.5)
    expect(parseTime('2:00')).toBe(120)
  })

  test('empty means "the natural boundary", not zero', () => {
    // The distinction matters: null leaves the clip whole, 0 would pin the in
    // point and mark the clip trimmed.
    expect(parseTime('')).toBeNull()
    expect(parseTime('   ')).toBeNull()
  })

  test('junk is rejected rather than coerced', () => {
    expect(parseTime('abc')).toBeNull()
    expect(parseTime('1:xy')).toBeNull()
  })
})

describe('the window can never describe an impossible cut', () => {
  test('values are clamped into the clip', () => {
    expect(clampWindow(-5, 20, 10)).toMatchObject({ in: 0, out: 10 })
    expect(clampWindow(2, 8, 10)).toMatchObject({ in: 2, out: 8, error: null })
  })

  test('an out point at or before the in point is refused', () => {
    expect(clampWindow(5, 5, 10).error).toBeTruthy()
    expect(clampWindow(6, 3, 10).error).toBeTruthy()
  })

  test('a half-open window is legal', () => {
    // "from 2s to the end" and "the start up to 8s" are both real edits.
    expect(clampWindow(2, null, 10)).toMatchObject({ in: 2, out: null, error: null })
    expect(clampWindow(null, 8, 10)).toMatchObject({ in: null, out: 8, error: null })
  })

  test('no window at all is the untrimmed clip', () => {
    expect(clampWindow(null, null, 10)).toMatchObject({ in: null, out: null, error: null })
  })

  test('an out point beyond the clip clamps to its real end', () => {
    // Guards against sending the exporter a window the file cannot satisfy.
    expect(clampWindow(1, 999, 10).out).toBe(10)
  })
})
