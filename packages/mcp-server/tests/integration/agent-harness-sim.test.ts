/**
 * SMI-5456 Wave 1 Step 6 — Validation Ladder Level 2a: harness-simulation MCP
 * client.
 *
 * Spawns the REAL built mcp-server binary over stdio (no mocks), once per
 * simulated harness, and performs a genuine MCP `initialize` handshake with
 * that harness's `clientInfo` — covering all seven Wave-1 targets without
 * needing any harness binary installed (`docs/internal/implementation/
 * smi-5456-skillsmith-agent-wave1.md` Validation Ladder, L2a). Per harness
 * this asserts the four L2a categories:
 *   1. ListTools returns exactly the curated agent profile (SKILLSMITH_TOOL_PROFILE=agent).
 *   2. A CallTool round-trips through the `_meta` marker channel without erroring.
 *   3. Consent gating: with telemetry unconfigured (default/off), the call
 *      completes fast with no network side effect.
 *   4. A CallTool round-trips through the session marker-FILE channel
 *      (PRIMARY channel per Step-0 spike (e): no Tier-1 harness is documented
 *      as able to inject `_meta` on a genuine tool call today) — and the
 *      suggest -> apply -> undo trio is present in the listing.
 *
 * PROCESS-BOUNDARY LIMITATION (read before extending): `withTelemetry`'s
 * emission gate (`packages/core/src/telemetry/wrap.ts`) is in-process module
 * state (a closure variable + a module-scoped `Set`). A spawned child
 * process cannot be introspected for "did trackSkillInvoke actually get
 * called" the way an in-process mock can — a suppressed event has no
 * wire-visible signal (that IS the gate's job: nothing crosses the stdio
 * JSON-RPC channel). The consent-gating assertions below are therefore
 * necessarily indirect: fast, error-free completion with zero telemetry
 * config in the spawned env (see `baseSpawnEnv` — no `POSTHOG_API_KEY` /
 * `SUPABASE_URL`) proves no network attempt was made, since
 * `initializePostHog` / `resolveConsent` both fail fast and silently without
 * those vars. The DEFINITIVE emission-suppression proof is the existing
 * in-process unit test at `packages/core/src/telemetry/wrap.marker.test.ts`
 * ("consent parity — marker fields never emit when the gate suppresses"),
 * which mocks `trackSkillInvoke` directly and is unaffected by this
 * limitation. The `marker channel precedence — unit-level fallback` describe
 * block below closes the equivalent process-boundary gap for the marker-FILE
 * reader by importing `@skillsmith/core/telemetry` directly in-process, per
 * the worker brief's explicit fallback instruction.
 *
 * FIXED (was a KNOWN GAP at this suite's original writing): every tool's
 * `withTelemetry` call site still hardcodes `extractFramework: () =>
 * 'unknown'` (verified via `grep -rn "extractFramework: () => 'unknown'"
 * packages/mcp-server/src/tools/`), but `agent-marker.ts` now threads the
 * marker file's (or `_meta`'s) `harness` hint into the resolved `AgentMarker`
 * as a vocabulary-gated `harness` field, and `wrap.ts`'s emit path prefers
 * `marker.harness` over the per-call extractor result
 * (`framework: marker?.harness ?? framework`) — see SMI-5456
 * `packages/core/src/telemetry/agent-marker.ts` (`KNOWN_HARNESS_FRAMEWORKS`)
 * and `wrap.ts`. So the per-harness `framework` value the plan's telemetry
 * wire format targets (`opencode`, `hermes`, etc.) now reaches the wire for
 * every MCP-tool event whose marker channel supplied a valid harness hint.
 * This suite still cannot observe `framework` over the wire (it isn't part
 * of any tool response) — process-boundary limitation above — so it does not
 * assert per-framework emission values itself; that is proven at the unit
 * level by `packages/core/src/telemetry/wrap.marker.test.ts` ("marker
 * harness feeds framework"). This suite only proves the `harness` field
 * round-trips through a marker file without crashing, i.e. the round-trip
 * half of the SMI-5456 fix, not the emission half.
 */

import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { AGENT_TOOL_PROFILE_NAMES } from '@skillsmith/core'
import { resolveAgentMarker } from '@skillsmith/core/telemetry'

import {
  baseSpawnEnv,
  connectHarness,
  createIsolatedHome,
  DIST_ENTRY,
  ensureDistBuilt,
  HARNESS_CASES,
  writeAgentMarkerFile,
  type HarnessConnection,
} from './agent-harness-sim.helpers.js'

const AGENT_PROFILE_SET = new Set(AGENT_TOOL_PROFILE_NAMES)

// SMI-5548: a local pre-push run has no built dist/ (worktrees never build
// one, and the build itself fails there — EINVAL on the worktree's
// node_modules symlink under Docker). Skip this whole spawn-based suite ONLY
// in that combination; CI never sets SKILLSMITH_PREPUSH, so it always builds
// dist and runs the suite for real, failing loudly on a build-order regression.
const skipInPrePush = process.env['SKILLSMITH_PREPUSH'] === '1' && !existsSync(DIST_ENTRY)
if (skipInPrePush) {
  console.warn('[SMI-5548] skipping spawn integration in pre-push (dist absent; covered by CI)')
}

describe.skipIf(skipInPrePush)('SMI-5456 L2a — agent harness-simulation MCP client', () => {
  beforeAll(() => {
    ensureDistBuilt()
  }, 120_000)

  describe.each(HARNESS_CASES)('harness: $id', ({ id, clientInfo }) => {
    let homeDir: string
    let cleanupHome: () => void
    let connection: HarnessConnection

    beforeAll(async () => {
      const home = createIsolatedHome(`sklx-l2a-${id}-`)
      homeDir = home.homeDir
      cleanupHome = home.cleanup
      connection = await connectHarness(clientInfo, baseSpawnEnv(homeDir))
    }, 30_000)

    afterAll(async () => {
      await connection.close()
      cleanupHome()
    })

    it('ListTools returns exactly the curated agent-profile ∩ registered set', async () => {
      const result = await connection.listTools()
      const names = new Set(result.tools.map((tool) => tool.name))
      expect(names).toEqual(AGENT_PROFILE_SET)
    })

    it('includes the suggest -> apply -> undo trio', async () => {
      const result = await connection.listTools()
      const names = result.tools.map((tool) => tool.name)
      expect(names).toEqual(
        expect.arrayContaining(['skill_inventory_audit', 'apply_namespace_rename', 'undo_apply'])
      )
    })

    it('rounds-trips a CallTool through the `_meta` marker channel and completes fast with no telemetry configured (consent-off/no-network evidence)', async () => {
      const start = Date.now()
      const result = await connection.callTool({
        name: 'skill_outdated',
        arguments: { include_deps: false },
        _meta: { agent_session: true, nudge_origin: false, trigger_id: `eval-l2a-${id}` },
      })
      const elapsedMs = Date.now() - start

      expect(result.isError).toBeFalsy()
      expect((result.content as unknown[] | undefined)?.length ?? 0).toBeGreaterThan(0)
      // No SUPABASE_URL/POSTHOG_API_KEY in the spawn env (baseSpawnEnv) means
      // resolveConsent()/initializePostHog() both fail fast without a network
      // round trip — a slow response here would indicate an unexpected
      // network attempt. Generous bound (this is a correctness smoke, not a
      // perf benchmark): local calls complete in well under 1s.
      expect(elapsedMs).toBeLessThan(10_000)
    })

    it('rounds-trips a CallTool through the session marker-FILE channel (PRIMARY channel per Step-0 spike (e))', async () => {
      writeAgentMarkerFile(homeDir, {
        sessionId: `sess-${id}`,
        harness: id,
        agentSession: true,
        nudgeOrigin: true,
        triggerId: `nudge-${id}`,
      })

      const result = await connection.callTool({
        name: 'skill_outdated',
        arguments: { include_deps: false },
      })

      expect(result.isError).toBeFalsy()
      expect((result.content as unknown[] | undefined)?.length ?? 0).toBeGreaterThan(0)
    })
  })
})

// ---------------------------------------------------------------------------
// Marker channel precedence — unit-level fallback (process-boundary gap, see
// file header). Proves the marker-FILE reader's precedence rules
// deterministically by importing `@skillsmith/core/telemetry` directly
// in-process (no spawn) — the fallback the worker brief calls for when a
// channel is unobservable across a spawned process boundary.
// ---------------------------------------------------------------------------
describe('marker channel precedence — unit-level fallback', () => {
  const markerDir = join(
    tmpdir(),
    `sklx-l2a-marker-unit-${Date.now()}-${Math.random().toString(36).slice(2)}`
  )
  const originalOverride = process.env.SKILLSMITH_AGENT_MARKER_DIR

  beforeAll(() => {
    process.env.SKILLSMITH_AGENT_MARKER_DIR = markerDir
  })

  afterAll(() => {
    if (originalOverride === undefined) {
      delete process.env.SKILLSMITH_AGENT_MARKER_DIR
    } else {
      process.env.SKILLSMITH_AGENT_MARKER_DIR = originalOverride
    }
    rmSync(markerDir, { recursive: true, force: true })
  })

  it('resolves the session marker file when no `_meta` is present', () => {
    // SKILLSMITH_AGENT_MARKER_DIR overrides `getAgentMarkerDir()`'s
    // resolution entirely (see agent-marker.ts), so write straight into
    // markerDir rather than through the homeDir-relative install-shape helper.
    mkdirSync(markerDir, { recursive: true })
    writeFileSync(
      join(markerDir, 'unit-sess.json'),
      JSON.stringify({
        schema: 1,
        session_id: 'unit-sess',
        started_at: Date.now(),
        harness: 'opencode',
        agent_session: true,
        nudge_origin: true,
        trigger_id: 'unit-trigger',
      })
    )
    const marker = resolveAgentMarker(undefined)
    // harness: 'opencode' round-trips too (SMI-5456 marker->framework fix,
    // 37def2f9) — the vocabulary-gated `harness` field threads from the
    // marker file into the resolved AgentMarker alongside the three
    // pre-existing fields.
    expect(marker).toEqual({
      agentSession: true,
      nudgeOrigin: true,
      triggerId: 'unit-trigger',
      harness: 'opencode',
    })
  })

  it('`_meta` wins per-field over a live marker file', () => {
    const marker = resolveAgentMarker({ agent_session: false })
    expect(marker.agentSession).toBe(false)
    expect(marker.nudgeOrigin).toBe(true)
    expect(marker.triggerId).toBe('unit-trigger')
  })
})
