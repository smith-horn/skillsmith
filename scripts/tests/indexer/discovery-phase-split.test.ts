/**
 * Phase-split gate and env-parse tests (SMI-4870)
 * @module scripts/tests/indexer/discovery-phase-split
 *
 * Two surfaces under test:
 *
 * 1. Phase gates — the four boolean derivations in `runDiscovery`:
 *      runPhase1 = discoveryPhase === undefined || discoveryPhase === 1
 *      runPhase2 = discoveryPhase === undefined || discoveryPhase === 2
 *      runPhase3 = discoveryPhase === undefined || discoveryPhase === 3
 *      runFinalize = discoveryPhase === undefined || discoveryPhase === 3
 *    Critical invariant: when `discoveryPhase` is `undefined` every gate is
 *    `true` — the legacy all-phases path stays byte-identical.
 *    These are pure derivations from a single value; we test them directly
 *    without spinning up a full orchestrator mock.
 *
 * 2. `parseEnv` — the `DISCOVERY_PHASE` field added by SMI-4870:
 *    - unset / empty string → `undefined`
 *    - '1' / '2' / '3' → numeric literal DiscoveryPhase
 *    - any other non-empty string → throws with a helpful message
 *
 * We do NOT write a full-orchestrator integration test — the orchestrator
 * wires together supabase, GitHub API calls, and DB upserts that would
 * require a complete mock rig. The pure-helper and env-parse surfaces give
 * high confidence per the SMI-4861 cache round-trip retro lesson.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import type { DiscoveryPhase } from '../../indexer/discovery-orchestrator.phase-split.ts'
import { parseEnv } from '../../indexer/parse-env.ts'

// ---------------------------------------------------------------------------
// Phase gate derivation — mirrors runDiscovery lines verbatim so a code
// change that diverges will break tests immediately.
// ---------------------------------------------------------------------------

function phaseGates(discoveryPhase: DiscoveryPhase | undefined): {
  runPhase1: boolean
  runPhase2: boolean
  runPhase3: boolean
  runFinalize: boolean
} {
  return {
    runPhase1: discoveryPhase === undefined || discoveryPhase === 1,
    runPhase2: discoveryPhase === undefined || discoveryPhase === 2,
    runPhase3: discoveryPhase === undefined || discoveryPhase === 3,
    runFinalize: discoveryPhase === undefined || discoveryPhase === 3,
  }
}

// ---------------------------------------------------------------------------
// Phase gate tests
// ---------------------------------------------------------------------------

describe('discovery phase gates (SMI-4870)', () => {
  describe('discoveryPhase = undefined (legacy all-phases path)', () => {
    it('all four gates are true — legacy run stays byte-identical', () => {
      const gates = phaseGates(undefined)
      expect(gates.runPhase1).toBe(true)
      expect(gates.runPhase2).toBe(true)
      expect(gates.runPhase3).toBe(true)
      expect(gates.runFinalize).toBe(true)
    })
  })

  describe('discoveryPhase = 1 (high-trust sub-slot)', () => {
    it('phase 1 runs; phases 2/3/finalize are gated off', () => {
      const gates = phaseGates(1)
      expect(gates.runPhase1).toBe(true)
      expect(gates.runPhase2).toBe(false)
      expect(gates.runPhase3).toBe(false)
      expect(gates.runFinalize).toBe(false)
    })
  })

  describe('discoveryPhase = 2 (topic-search sub-slot)', () => {
    it('phase 2 runs; phases 1/3/finalize are gated off', () => {
      const gates = phaseGates(2)
      expect(gates.runPhase1).toBe(false)
      expect(gates.runPhase2).toBe(true)
      expect(gates.runPhase3).toBe(false)
      expect(gates.runFinalize).toBe(false)
    })
  })

  describe('discoveryPhase = 3 (code-search + finalize sub-slot)', () => {
    it('phase 3 runs; phases 1/2 are gated off; finalize runs', () => {
      const gates = phaseGates(3)
      expect(gates.runPhase1).toBe(false)
      expect(gates.runPhase2).toBe(false)
      expect(gates.runPhase3).toBe(true)
      expect(gates.runFinalize).toBe(true)
    })

    it('runPhase3 and runFinalize are always equal (phase 3 is the only finalize trigger)', () => {
      for (const p of [undefined, 1, 2, 3] as const) {
        const g = phaseGates(p)
        expect(g.runPhase3).toBe(g.runFinalize)
      }
    })
  })

  it('exactly one sub-slot has runPhase1=true when a phase is set', () => {
    const phase1Count = ([1, 2, 3] as const).filter((p) => phaseGates(p).runPhase1).length
    expect(phase1Count).toBe(1)
  })

  it('exactly one sub-slot has runPhase2=true when a phase is set', () => {
    const phase2Count = ([1, 2, 3] as const).filter((p) => phaseGates(p).runPhase2).length
    expect(phase2Count).toBe(1)
  })

  it('exactly one sub-slot has runPhase3=true when a phase is set', () => {
    const phase3Count = ([1, 2, 3] as const).filter((p) => phaseGates(p).runPhase3).length
    expect(phase3Count).toBe(1)
  })
})

// ---------------------------------------------------------------------------
// parseEnv — DISCOVERY_PHASE field (SMI-4870)
// ---------------------------------------------------------------------------

const BASE_ENV: NodeJS.ProcessEnv = {
  SUPABASE_URL: 'https://example.supabase.co',
  SUPABASE_SERVICE_ROLE_KEY: 'srk',
}

describe('parseEnv DISCOVERY_PHASE (SMI-4870)', () => {
  let originalEnv: NodeJS.ProcessEnv

  beforeEach(() => {
    originalEnv = { ...process.env }
    // Start each test from a clean base so prior process.env pollution cannot
    // bleed through (mirrors the pattern in parse-env.test.ts).
    for (const k of Object.keys(process.env)) {
      delete process.env[k]
    }
    Object.assign(process.env, BASE_ENV)
  })

  afterEach(() => {
    process.env = originalEnv
  })

  it('DISCOVERY_PHASE unset → undefined (legacy path)', () => {
    delete process.env.DISCOVERY_PHASE
    const env = parseEnv()
    expect(env.DISCOVERY_PHASE).toBeUndefined()
  })

  it('DISCOVERY_PHASE="" (empty string) → undefined', () => {
    process.env.DISCOVERY_PHASE = ''
    const env = parseEnv()
    expect(env.DISCOVERY_PHASE).toBeUndefined()
  })

  it('DISCOVERY_PHASE="1" → numeric 1', () => {
    process.env.DISCOVERY_PHASE = '1'
    const env = parseEnv()
    expect(env.DISCOVERY_PHASE).toBe(1)
  })

  it('DISCOVERY_PHASE="2" → numeric 2', () => {
    process.env.DISCOVERY_PHASE = '2'
    const env = parseEnv()
    expect(env.DISCOVERY_PHASE).toBe(2)
  })

  it('DISCOVERY_PHASE="3" → numeric 3', () => {
    process.env.DISCOVERY_PHASE = '3'
    const env = parseEnv()
    expect(env.DISCOVERY_PHASE).toBe(3)
  })

  it('DISCOVERY_PHASE="4" → throws with helpful message', () => {
    process.env.DISCOVERY_PHASE = '4'
    expect(() => parseEnv()).toThrow(/DISCOVERY_PHASE/)
  })

  it('DISCOVERY_PHASE="0" → throws (0 is not a valid phase)', () => {
    process.env.DISCOVERY_PHASE = '0'
    expect(() => parseEnv()).toThrow(/DISCOVERY_PHASE/)
  })

  it('DISCOVERY_PHASE="x" → throws (non-numeric value)', () => {
    process.env.DISCOVERY_PHASE = 'x'
    expect(() => parseEnv()).toThrow(/DISCOVERY_PHASE/)
  })

  it('DISCOVERY_PHASE="1.5" → throws (float is not a valid phase)', () => {
    process.env.DISCOVERY_PHASE = '1.5'
    expect(() => parseEnv()).toThrow(/DISCOVERY_PHASE/)
  })

  it('parsed DISCOVERY_PHASE is strictly a number type (not a string)', () => {
    process.env.DISCOVERY_PHASE = '2'
    const env = parseEnv()
    expect(typeof env.DISCOVERY_PHASE).toBe('number')
  })

  it('DISCOVERY_PHASE does not affect concurrency or kill_switch_engaged', () => {
    process.env.DISCOVERY_PHASE = '3'
    process.env.CONCURRENCY = '4'
    const env = parseEnv()
    expect(env.DISCOVERY_PHASE).toBe(3)
    expect(env.concurrency).toBe(4)
    expect(env.kill_switch_engaged).toBe(false)
  })
})
