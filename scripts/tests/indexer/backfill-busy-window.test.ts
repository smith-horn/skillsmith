/**
 * SMI-7121: the TypeScript busy-window predicate must equal the driver's bash predicate.
 * The bash lines are extracted from backfill-rollout-driver.sh at test time, never copied.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  DEFAULT_BUSY_HOURS,
  parseBusyHours,
  windowState,
} from '../../indexer/backfill-busy-window.ts'

const here = dirname(fileURLToPath(import.meta.url))
const driver = readFileSync(join(here, '../../indexer/backfill-rollout-driver.sh'), 'utf8')

/** The driver's predicate: from `mtb=9999; ready=0` through the closing `esac`. */
function extractPredicate(): string {
  const lines = driver.split('\n')
  const start = lines.findIndex((l) => l.trim().startsWith('mtb=9999; ready=0'))
  expect(start).toBeGreaterThan(-1)
  const end = lines.findIndex((l, i) => i > start && l.trim() === 'esac')
  expect(end).toBeGreaterThan(start)
  return lines.slice(start, end + 1).join('\n')
}

/** Runs the driver's predicate for every minute of a day in one bash process. */
function bashOpenByMinute(busy: string): boolean[] {
  const script = `
busy="${busy}"
for H in $(seq 0 23); do for M in $(seq 0 59); do
${extractPredicate()}
echo "$H $M $ready"
done; done
`
  const r = spawnSync('bash', ['-c', script], { encoding: 'utf8' })
  expect(r.status).toBe(0)
  const rows = r.stdout.trim().split('\n')
  expect(rows).toHaveLength(1440)
  return rows.map((row) => row.split(' ')[2] === '1')
}

const HOUR_SETS: Array<[string, string]> = [
  ['default', DEFAULT_BUSY_HOURS],
  ['sparse', ' 5 23 '],
  ['wraps midnight', ' 0 1 22 23 10 '],
]

describe('windowState parity with the driver predicate', () => {
  it.each(HOUR_SETS)('%s: all 1440 minutes agree', (_label, busy) => {
    const bash = bashOpenByMinute(busy)
    const hours = parseBusyHours(busy)
    const mismatches: string[] = []
    let openCount = 0
    for (let h = 0; h < 24; h++) {
      for (let m = 0; m < 60; m++) {
        const ts = windowState(new Date(Date.UTC(2026, 9, 16, h, m)), hours).open
        if (ts) openCount++
        if (ts !== bash[h * 60 + m]) mismatches.push(`${h}:${m} ts=${ts}`)
      }
    }
    expect(mismatches).toEqual([])
    // Not vacuous: each set has both open and closed minutes.
    expect(openCount).toBeGreaterThan(0)
    expect(openCount).toBeLessThan(1440)
  })
})

describe('parseBusyHours', () => {
  it.each([
    [undefined, [0, 3, 6, 7, 8, 12, 13, 14, 18, 19, 20]],
    ['', [0, 3, 6, 7, 8, 12, 13, 14, 18, 19, 20]],
    [' 1 2 ', [1, 2]],
    ['5', [5]],
    ['23   0\t7', [23, 0, 7]],
  ])('%j -> %j', (raw, expected) => {
    expect(parseBusyHours(raw as string | undefined)).toEqual(expected)
  })
  it.each(['1 1', '24', '-1', '7a', '   ', '1.5', '1,2', '+3'])('%j throws', (raw) => {
    expect(() => parseBusyHours(raw)).toThrow(/BACKFILL_BUSY_HOURS/)
  })
})

describe('windowState.nextOpenUtc', () => {
  const hours = parseBusyHours(undefined)
  const at = (iso: string) => windowState(new Date(iso), hours)
  it('open now: next open is now', () => {
    const s = at('2026-10-16T10:00:00Z')
    expect(s.open).toBe(true)
    expect(s.nextOpenUtc.toISOString()).toBe('2026-10-16T10:00:00.000Z')
  })
  it('inside a busy hour: next open is the first open minute after it', () => {
    // 12,13,14 busy; 15:00 is open (next busy 18 is 180m away).
    const s = at('2026-10-16T12:30:00Z')
    expect(s.open).toBe(false)
    expect(s.nextOpenUtc.toISOString()).toBe('2026-10-16T15:00:00.000Z')
  })
  it('within 80 minutes of a busy hour: closed; reopens after the busy block', () => {
    // 10:50 -> busy 12 is 70m away (closed). 11:00 -> 60m (closed). Reopen at 15:00.
    const s = at('2026-10-16T10:50:00Z')
    expect(s.open).toBe(false)
    expect(s.nextOpenUtc.toISOString()).toBe('2026-10-16T15:00:00.000Z')
  })
  it('exactly 80 minutes away is open', () => {
    // 10:40 -> busy 12 is 80m away.
    expect(at('2026-10-16T10:40:00Z').open).toBe(true)
    expect(at('2026-10-16T10:41:00Z').open).toBe(false)
  })
  it('throws when no minute in 48h is open', () => {
    const all = Array.from({ length: 24 }, (_, i) => i)
    expect(() => windowState(new Date('2026-10-16T00:00:00Z'), all)).toThrow(/No open window/)
  })
})

/** Minutes of the day (UTC) on which the cron `3,23,43 <hours> * * *` fires. */
function resumeTicks(): number[] {
  const hours = [1, 4, 9, 10, 15, 16, 21, 22]
  return hours.flatMap((h) => [3, 23, 43].map((m) => h * 60 + m))
}

describe('planned resume cron places ticks inside every open window', () => {
  it('3,23,43 1,4,9,10,15,16,21,22 * * * lands >=2 ticks in each maximal open window (default hours)', () => {
    const hours = parseBusyHours(undefined)
    const open = Array.from(
      { length: 1440 },
      (_, i) => windowState(new Date(Date.UTC(2026, 9, 16, 0, i)), hours).open
    )
    // Maximal runs of open minutes (cyclic over the day).
    const start = open.findIndex((o) => !o)
    expect(start).toBeGreaterThan(-1)
    const windows: Array<[number, number]> = []
    let runStart = -1
    for (let k = 1; k <= 1440; k++) {
      const i = (start + k) % 1440
      if (open[i] && runStart < 0) runStart = k
      if (!open[i] && runStart >= 0) {
        windows.push([runStart, k - 1])
        runStart = -1
      }
    }
    expect(windows.length).toBeGreaterThan(0)
    const ticks = resumeTicks()
    for (const [a, b] of windows) {
      const inside = ticks.filter((t) => {
        const k = (t - start + 1440) % 1440
        return k >= a && k <= b
      })
      expect(inside.length, `window k=${a}..${b} (from minute ${start})`).toBeGreaterThanOrEqual(2)
    }
  })
})
