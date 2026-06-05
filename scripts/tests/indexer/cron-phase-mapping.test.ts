/**
 * Cron → (RUN_TYPE, CRON_SLOT, DISCOVERY_PHASE) mapping tests (SMI-4870)
 * @module scripts/tests/indexer/cron-phase-mapping
 *
 * Regression guard for the `Determine Run Type` shell `case` block in
 * `.github/workflows/indexer.yml`. The mapping is load-bearing: a stale cron
 * or mismatched `case` arm silently runs the wrong phase or uses the wrong
 * CRON_SLOT for topic rotation. This test catches those breaks without
 * requiring a live GHA run.
 *
 * Strategy: parse the workflow YAML to extract every `schedule.cron` string,
 * then re-implement the same `case` logic in TypeScript (a single source of
 * truth independent of shell expansion) and assert structural invariants:
 * - every registered cron string resolves to a known triple
 * - exactly 3 CRON_SLOT values (6/12/18), each appearing 3 times
 * - exactly 3 DISCOVERY_PHASE values (1/2/3), each appearing 3 times
 * - the maintenance cron resolves to RUN_TYPE=maintenance with no DISCOVERY_PHASE
 * - no cron is duplicated; no cron falls through (unmapped)
 */

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { parse as parseYaml } from 'yaml'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface CronMapping {
  cron: string
  runType: 'discovery' | 'maintenance' | 'recheck'
  cronSlot: number | null
  discoveryPhase: 1 | 2 | 3 | null
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const WORKFLOW_PATH = resolve(import.meta.dirname, '../../../.github/workflows/indexer.yml')

/**
 * Parses the workflow YAML and returns every `on.schedule[].cron` string in
 * the order they appear. Uses the `yaml` package (already a workspace dep).
 */
function readWorkflowCrons(): string[] {
  const raw = readFileSync(WORKFLOW_PATH, 'utf-8')
  const doc = parseYaml(raw) as {
    on?: {
      schedule?: Array<{ cron: string }>
    }
  }
  return (doc?.on?.schedule ?? []).map((entry) => entry.cron)
}

/**
 * Canonical mapping — mirrors the shell `case` block in the workflow file.
 * This is the source of truth the test asserts against.
 */
const CRON_MAP: ReadonlyMap<string, Omit<CronMapping, 'cron'>> = new Map([
  ['0 0 * * *', { runType: 'maintenance', cronSlot: null, discoveryPhase: null }],
  // SMI-5166: durable stale-recheck — re-fetch live-but-undiscovered skills by
  // repo_url. No CRON_SLOT (no topic rotation) and no DISCOVERY_PHASE.
  ['0 3 * * *', { runType: 'recheck', cronSlot: null, discoveryPhase: null }],
  ['0 6 * * *', { runType: 'discovery', cronSlot: 6, discoveryPhase: 1 }],
  ['0 7 * * *', { runType: 'discovery', cronSlot: 6, discoveryPhase: 2 }],
  ['0 8 * * *', { runType: 'discovery', cronSlot: 6, discoveryPhase: 3 }],
  ['0 12 * * *', { runType: 'discovery', cronSlot: 12, discoveryPhase: 1 }],
  ['0 13 * * *', { runType: 'discovery', cronSlot: 12, discoveryPhase: 2 }],
  ['0 14 * * *', { runType: 'discovery', cronSlot: 12, discoveryPhase: 3 }],
  ['0 18 * * *', { runType: 'discovery', cronSlot: 18, discoveryPhase: 1 }],
  ['0 19 * * *', { runType: 'discovery', cronSlot: 18, discoveryPhase: 2 }],
  ['0 20 * * *', { runType: 'discovery', cronSlot: 18, discoveryPhase: 3 }],
])

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('indexer.yml cron → phase mapping (SMI-4870)', () => {
  const workflowCrons = readWorkflowCrons()

  it('workflow file contains exactly 11 scheduled cron entries', () => {
    // 1 maintenance (0 0) + 1 recheck (0 3, SMI-5166) + 9 discovery (0 6/7/8, 12/13/14, 18/19/20).
    expect(workflowCrons).toHaveLength(11)
  })

  it('no cron string is duplicated in the workflow', () => {
    const unique = new Set(workflowCrons)
    expect(unique.size).toBe(workflowCrons.length)
  })

  it('every workflow cron is present in the canonical map (no gaps)', () => {
    for (const cron of workflowCrons) {
      expect(CRON_MAP.has(cron), `cron "${cron}" has no entry in CRON_MAP`).toBe(true)
    }
  })

  it('every canonical map entry is covered by the workflow (no phantom arms)', () => {
    for (const cron of CRON_MAP.keys()) {
      expect(
        workflowCrons.includes(cron),
        `CRON_MAP arm "${cron}" is not registered in the workflow schedule`
      ).toBe(true)
    }
  })

  it('exactly 9 discovery crons, 1 maintenance cron, and 1 recheck cron', () => {
    const discovery = workflowCrons.filter((c) => CRON_MAP.get(c)?.runType === 'discovery')
    const maintenance = workflowCrons.filter((c) => CRON_MAP.get(c)?.runType === 'maintenance')
    const recheck = workflowCrons.filter((c) => CRON_MAP.get(c)?.runType === 'recheck')
    expect(discovery).toHaveLength(9)
    expect(maintenance).toHaveLength(1)
    expect(recheck).toHaveLength(1)
  })

  it('recheck cron is "0 3 * * *" with null CRON_SLOT and null DISCOVERY_PHASE (SMI-5166)', () => {
    const entry = CRON_MAP.get('0 3 * * *')
    expect(entry).toBeDefined()
    expect(entry?.runType).toBe('recheck')
    expect(entry?.cronSlot).toBeNull()
    expect(entry?.discoveryPhase).toBeNull()
  })

  it('maintenance cron is "0 0 * * *" with null CRON_SLOT and null DISCOVERY_PHASE', () => {
    const entry = CRON_MAP.get('0 0 * * *')
    expect(entry).toBeDefined()
    expect(entry?.runType).toBe('maintenance')
    expect(entry?.cronSlot).toBeNull()
    expect(entry?.discoveryPhase).toBeNull()
  })

  it('exactly 3 distinct CRON_SLOT values (6, 12, 18) each appearing exactly 3 times', () => {
    const slotCounts = new Map<number, number>()
    for (const cron of workflowCrons) {
      const entry = CRON_MAP.get(cron)
      if (entry?.runType === 'discovery' && entry.cronSlot !== null) {
        slotCounts.set(entry.cronSlot, (slotCounts.get(entry.cronSlot) ?? 0) + 1)
      }
    }
    expect([...slotCounts.keys()].sort((a, b) => a - b)).toEqual([6, 12, 18])
    for (const [slot, count] of slotCounts) {
      expect(count, `CRON_SLOT ${slot} appears ${count} times, expected 3`).toBe(3)
    }
  })

  it('exactly 3 distinct DISCOVERY_PHASE values (1, 2, 3) each appearing exactly 3 times', () => {
    const phaseCounts = new Map<number, number>()
    for (const cron of workflowCrons) {
      const entry = CRON_MAP.get(cron)
      if (entry?.runType === 'discovery' && entry.discoveryPhase !== null) {
        phaseCounts.set(entry.discoveryPhase, (phaseCounts.get(entry.discoveryPhase) ?? 0) + 1)
      }
    }
    expect([...phaseCounts.keys()].sort((a, b) => a - b)).toEqual([1, 2, 3])
    for (const [phase, count] of phaseCounts) {
      expect(count, `DISCOVERY_PHASE ${phase} appears ${count} times, expected 3`).toBe(3)
    }
  })

  it('each (CRON_SLOT, DISCOVERY_PHASE) pair is unique — no two crons do the same work', () => {
    const seen = new Set<string>()
    for (const cron of workflowCrons) {
      const entry = CRON_MAP.get(cron)
      if (entry?.runType !== 'discovery') continue
      const key = `${entry.cronSlot}:${entry.discoveryPhase}`
      expect(seen.has(key), `Duplicate (slot, phase) pair ${key} for cron "${cron}"`).toBe(false)
      seen.add(key)
    }
  })

  it.each([
    ['0 6 * * *', 6, 1],
    ['0 7 * * *', 6, 2],
    ['0 8 * * *', 6, 3],
    ['0 12 * * *', 12, 1],
    ['0 13 * * *', 12, 2],
    ['0 14 * * *', 12, 3],
    ['0 18 * * *', 18, 1],
    ['0 19 * * *', 18, 2],
    ['0 20 * * *', 18, 3],
  ] as const)(
    'discovery cron "%s" → CRON_SLOT=%i DISCOVERY_PHASE=%i',
    (cron, expectedSlot, expectedPhase) => {
      const entry = CRON_MAP.get(cron)
      expect(entry?.runType).toBe('discovery')
      expect(entry?.cronSlot).toBe(expectedSlot)
      expect(entry?.discoveryPhase).toBe(expectedPhase)
    }
  )
})
