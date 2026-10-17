/**
 * SMI-7121: the backfill driver's busy-hour yield, as a pure function
 * @module scripts/indexer/backfill-busy-window
 *
 * Port of the predicate in `backfill-rollout-driver.sh`: a dispatch is allowed only when
 * the current UTC hour is not busy AND the next busy hour (searched 1..8 hours ahead)
 * starts at least {@link MIN_MINUTES_TO_BUSY} minutes away. Parity with the bash is
 * asserted by `scripts/tests/indexer/backfill-busy-window.test.ts`.
 *
 * Parsing is deliberately stricter than the driver: the driver's bash matches only
 * space-padded hours (` 0 3 `), whereas this accepts any whitespace-separated list
 * (`0 3` is normalised to [0, 3]) and rejects leading zeros (`03`) so the accepted
 * language is unambiguous. The predicate itself is identical to the driver's.
 *
 * CLI: reads BACKFILL_BUSY_HOURS and optional NOW_UTC (ISO, for tests); writes
 * `window_open` and `next_window_utc` to GITHUB_OUTPUT when set, else stdout.
 */

import { appendFileSync } from 'node:fs'

export const DEFAULT_BUSY_HOURS = ' 0 3 6 7 8 12 13 14 18 19 20 '
export const MIN_MINUTES_TO_BUSY = 80
const LOOKAHEAD_HOURS = 8
const NEXT_OPEN_SEARCH_MINUTES = 48 * 60

/** Strict parse: whitespace-separated integers 0-23, no duplicates, at least one. */
export function parseBusyHours(raw: string | undefined): number[] {
  const text = raw === undefined || raw === '' ? DEFAULT_BUSY_HOURS : raw
  const tokens = text.split(/\s+/).filter((t) => t !== '')
  if (tokens.length === 0) {
    throw new Error(`BACKFILL_BUSY_HOURS has no hours: ${JSON.stringify(raw)}`)
  }
  const hours: number[] = []
  for (const t of tokens) {
    if (!/^(0|[1-9][0-9]*)$/.test(t) || Number(t) > 23) {
      throw new Error(
        `BACKFILL_BUSY_HOURS entry ${JSON.stringify(t)} is not an unpadded integer 0-23`
      )
    }
    const h = Number(t)
    if (hours.includes(h)) {
      throw new Error(`BACKFILL_BUSY_HOURS lists hour ${h} twice`)
    }
    hours.push(h)
  }
  return hours
}

function isOpenAt(nowUtc: Date, busyHours: number[]): boolean {
  const h = nowUtc.getUTCHours()
  const m = nowUtc.getUTCMinutes()
  if (busyHours.includes(h)) return false
  for (let k = 1; k <= LOOKAHEAD_HOURS; k++) {
    if (busyHours.includes((h + k) % 24)) return k * 60 - m >= MIN_MINUTES_TO_BUSY
  }
  return true
}

export function windowState(
  nowUtc: Date,
  busyHours: number[]
): { open: boolean; nextOpenUtc: Date } {
  const open = isOpenAt(nowUtc, busyHours)
  if (open) return { open, nextOpenUtc: new Date(nowUtc.getTime()) }
  // Closed: first whole minute after now that is open (predicate depends on hour and minute only).
  const base = Math.floor(nowUtc.getTime() / 60000) * 60000
  for (let i = 1; i <= NEXT_OPEN_SEARCH_MINUTES; i++) {
    const candidate = new Date(base + i * 60000)
    if (isOpenAt(candidate, busyHours)) return { open, nextOpenUtc: candidate }
  }
  throw new Error('No open window within 48h: every minute is busy')
}

function main(): void {
  const busyHours = parseBusyHours(process.env.BACKFILL_BUSY_HOURS)
  const nowRaw = process.env.NOW_UTC
  const now = nowRaw ? new Date(nowRaw) : new Date()
  if (Number.isNaN(now.getTime())) throw new Error(`NOW_UTC is not a valid ISO date: ${nowRaw}`)
  const state = windowState(now, busyHours)
  const lines = `window_open=${state.open}\nnext_window_utc=${state.nextOpenUtc.toISOString()}\n`
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, lines)
  else process.stdout.write(lines)
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    main()
  } catch (err) {
    console.error(JSON.stringify({ event: 'busy_window_error', error: String(err) }))
    process.exit(1)
  }
}
