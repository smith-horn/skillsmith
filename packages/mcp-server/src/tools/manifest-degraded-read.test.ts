/**
 * @fileoverview SMI-6733 Phase 2 Wave 2 — the degraded manifest read has to
 * reach the response, and the dereference must not throw.
 * @module @skillsmith/mcp-server/tools/manifest-degraded-read.test
 * @see docs/internal/implementation/smi-6733-manifest-read-state-phase-2.md
 * @see docs/internal/adr/171-manifest-read-state-contract.md § 4, § 5, § 10
 *
 * Why this file exists rather than cases inside `outdated.test.ts` /
 * `skill-updates.test.ts`: both of those `vi.mock('./install.helpers.js')`
 * at module scope, so `loadManifest` — the reader under test here — never
 * executes there. Every assertion below depends on a REAL read of a REAL
 * file, because the defect the dereference half of this wave fixes arrives
 * through the reader's SUCCESS path (`installedSkills: null` classifies
 * `ok`, ADR-171 § 5's nullish carve-out) and a mocked reader cannot
 * demonstrate that.
 *
 * `$HOME` is redirected to a per-run temp dir by `vitest.setup.ts` BEFORE any
 * test module loads, so `MANIFEST_PATH` — derived from `os.homedir()` at
 * module load in `install.types.ts` — already points into the sandbox.
 * `assertNotRealUserHome` is the backstop if it ever does not.
 *
 * TWO DISJOINT FIXTURE FAMILIES, and conflating them is how a test in this
 * wave ends up asserting nothing:
 *
 *   - A manifest the classifier REFUSES (`corrupt` / `unreadable` /
 *     `version_unsupported`) makes `loadManifestLenient` substitute the EMPTY
 *     document and return a non-null `warning`. `installedSkills` is `{}`, so
 *     there is no dereference hazard at all here. This family tests the
 *     warning thread (Steps 1-5).
 *   - A manifest the classifier ACCEPTS whose `installedSkills` is `null`
 *     classifies `ok`: the wrapper returns it UNCHANGED, with NO warning and
 *     NO substitution, and the raw `null` reaches the consumer. This family
 *     tests the dereference (Step 6 / SMI-6886). A corrupt fixture can never
 *     reach it.
 */

import { mkdir, rm, writeFile } from 'fs/promises'
import { dirname } from 'path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { SkillDependencyRepository } from '@skillsmith/core'
import { closeDatabase, createTestDatabase } from '@skillsmith/core/testkit'
import { executeOutdated } from './outdated.js'
import { executeSkillUpdates } from './skill-updates.js'
import { MANIFEST_PATH } from './install.types.js'
import type { ToolContext } from '../context.js'
import type { Database } from '@skillsmith/core'
import type { OutdatedResponse, OutdatedSummary } from './outdated.js'
import type { CheckUpdatesResponse } from './skill-updates.js'

/**
 * The `warning?: string` accessor, written so this file compiles against the
 * response shapes BEFORE Wave 2 Step 1 adds the field and after. Widening
 * only — it changes no assertion, and once Step 1 lands the cast is a no-op.
 * Without it the red state would be a typecheck failure rather than a test
 * failure, and a typecheck failure is not evidence about behaviour.
 */
type Warned = { warning?: string }

// ---------------------------------------------------------------------------
// Fixtures. Each is the exact bytes written to MANIFEST_PATH.
// ---------------------------------------------------------------------------

/** Truncated mid-object: `JSON.parse` itself rejects it -> `corrupt`/unparseable. */
const BYTES_UNPARSEABLE = '{"version":"1.0.0","installedSkills":{"a":{'

/**
 * VALID JSON, wrong document: an array `installedSkills` -> `corrupt`/shape.
 * One token away from `BYTES_OK_NULL` below and classified the OPPOSITE way,
 * which is what makes the pair a discriminator rather than two samples.
 */
const BYTES_CORRUPT_SHAPE = '{"version":"1.0.0","installedSkills":[]}'

/**
 * VALID JSON, and the classifier ACCEPTS it (`ok`) — ADR-171 § 5's nullish
 * carve-out. No warning, no substitution, `null` reaches the consumer.
 */
const BYTES_OK_NULL = '{"version":"1.0.0","installedSkills":null}'

/** The negative control: readable, valid, and genuinely empty. */
const BYTES_OK_EMPTY = '{"version":"1.0.0","installedSkills":{}}'

async function writeManifest(bytes: string): Promise<void> {
  await mkdir(dirname(MANIFEST_PATH), { recursive: true })
  await writeFile(MANIFEST_PATH, bytes, 'utf-8')
}

async function removeManifest(): Promise<void> {
  await rm(MANIFEST_PATH, { force: true })
}

const ZERO_SUMMARY: OutdatedSummary = {
  total_installed: 0,
  outdated: 0,
  up_to_date: 0,
  unknown: 0,
  missing_deps: 0,
  local_drift: 0,
  identity_mismatch: 0,
}

describe('SMI-6733 Wave 2: a degraded manifest read reaches the response', () => {
  let db: Database

  beforeEach(async () => {
    db = await createTestDatabase()
    await removeManifest()
  })

  afterEach(async () => {
    closeDatabase(db)
    await removeManifest()
  })

  function outdatedContext(): ToolContext {
    return {
      db,
      skillDependencyRepository: new SkillDependencyRepository(db),
      // Offline, so no live registry arm runs: with zero entries nothing
      // reaches it anyway, and this keeps the fixtures' only variable the
      // manifest bytes.
      apiClient: { isOffline: () => true },
    } as unknown as ToolContext
  }

  function updatesContext(): ToolContext {
    return { db } as unknown as ToolContext
  }

  async function runOutdated(): Promise<OutdatedResponse & Warned> {
    return (await executeOutdated({ include_deps: false }, outdatedContext())) as OutdatedResponse &
      Warned
  }

  async function runUpdates(): Promise<CheckUpdatesResponse & Warned> {
    return (await executeSkillUpdates({}, updatesContext())) as CheckUpdatesResponse & Warned
  }

  // -------------------------------------------------------------------------
  // Step 5 for skill_outdated. The assertion is DISTINGUISHABILITY, not the
  // presence of a string: a corrupt manifest and an empty-but-readable one
  // must agree on every count and disagree on whether a warning is present.
  // -------------------------------------------------------------------------
  describe('skill_outdated', () => {
    it('distinguishes an unreadable manifest from an empty one, with identical counts', async () => {
      await writeManifest(BYTES_UNPARSEABLE)
      const degraded = await runOutdated()

      await writeManifest(BYTES_OK_EMPTY)
      const empty = await runOutdated()

      // The counts cannot distinguish the two — that is the defect, and it
      // stays true after the fix. So this is asserted, not assumed: if the
      // fix ever made a degraded read report a non-zero count it would be
      // inventing data, which is worse than the silence it replaced.
      expect({ degraded: degraded.summary, empty: empty.summary }).toEqual({
        degraded: ZERO_SUMMARY,
        empty: ZERO_SUMMARY,
      })

      // And the warning is the ONLY thing that distinguishes them. Asserted
      // as one object so neither half can pass alone: a tool that warns
      // unconditionally fails the second key, and today's silent tool fails
      // the first.
      expect({
        degradedWarns: typeof degraded.warning === 'string' && degraded.warning.length > 0,
        emptyWarns: empty.warning !== undefined,
      }).toEqual({ degradedWarns: true, emptyWarns: false })
    })

    it('names the file in the warning, so the user knows which manifest to fix', async () => {
      // ADR-171 § 8's first acceptance property for the refusal string: it
      // names the file. Not a format assertion — the property is that a user
      // reading the response can identify the file to act on, and a warning
      // that omits the path cannot be acted on at all.
      await writeManifest(BYTES_UNPARSEABLE)
      const res = await runOutdated()
      expect(res.warning ?? '').toContain(MANIFEST_PATH)
    })

    it('does not warn when the manifest is simply absent', async () => {
      // ADR-171 § 4b: `missing` is the normal state of a machine that has
      // installed nothing. Warning here would train users to ignore the
      // field, which is the failure mode that makes the whole thread useless.
      await removeManifest()
      const res = await runOutdated()
      expect({ warning: res.warning, summary: res.summary }).toEqual({
        warning: undefined,
        summary: ZERO_SUMMARY,
      })
    })

    it('warns on a shape-corrupt manifest but NOT on a nullish installedSkills', async () => {
      // The author-chosen mutation this arm exists to kill: an implementation
      // that keys the warning on `JSON.parse` throwing, rather than on the
      // classifier's state. Both fixtures below are VALID JSON and differ by
      // one token; the classifier calls one `corrupt` (array) and the other
      // `ok` (null), per ADR-171 § 5. A parse-keyed implementation warns on
      // neither and passes every other test in this file.
      await writeManifest(BYTES_CORRUPT_SHAPE)
      const arrayShaped = await runOutdated()

      await writeManifest(BYTES_OK_NULL)
      const nullish = await runOutdated()

      expect({
        arrayWarns: typeof arrayShaped.warning === 'string' && arrayShaped.warning.length > 0,
        nullishWarns: nullish.warning !== undefined,
      }).toEqual({ arrayWarns: true, nullishWarns: false })
    })
  })

  // -------------------------------------------------------------------------
  // Step 5 for skill_updates. Same key, same meaning, per ADR-171 § 10 — the
  // cross-tool consistency is itself the contract, so it is asserted against
  // the OTHER tool's response rather than restated.
  // -------------------------------------------------------------------------
  describe('skill_updates', () => {
    it('distinguishes an unreadable manifest from an empty one, with identical counts', async () => {
      await writeManifest(BYTES_UNPARSEABLE)
      const degraded = await runUpdates()

      await writeManifest(BYTES_OK_EMPTY)
      const empty = await runUpdates()

      expect({ degraded: degraded.updatesAvailable, empty: empty.updatesAvailable }).toEqual({
        degraded: 0,
        empty: 0,
      })
      expect({
        degradedWarns: typeof degraded.warning === 'string' && degraded.warning.length > 0,
        emptyWarns: empty.warning !== undefined,
      }).toEqual({ degradedWarns: true, emptyWarns: false })
    })

    it('carries the warning under the same key as skill_outdated (ADR-171 § 10)', async () => {
      // ADR-171 § 10 fixes the key as `warning` in BOTH tools, so a consumer
      // can write one `if (res.warning)`. Pinned by comparing the two tools'
      // responses for the SAME manifest rather than by naming the string
      // twice: a per-tool key divergence is exactly what this cannot pass.
      await writeManifest(BYTES_UNPARSEABLE)
      const fromOutdated = await runOutdated()
      const fromUpdates = await runUpdates()

      expect({
        outdatedHasWarning: 'warning' in fromOutdated,
        updatesHasWarning: 'warning' in fromUpdates,
        sameText: fromOutdated.warning === fromUpdates.warning,
      }).toEqual({ outdatedHasWarning: true, updatesHasWarning: true, sameText: true })
    })
  })

  // -------------------------------------------------------------------------
  // Step 6 / SMI-6886. The value arrives through the reader's SUCCESS path.
  // -------------------------------------------------------------------------
  describe('a nullish installedSkills does not crash the read tools (SMI-6886)', () => {
    it('skill_outdated answers, and answers identically to an empty manifest', async () => {
      // `Object.values(null)` throws `TypeError: Cannot convert undefined or
      // null to object` at `outdated.action.ts:51`, and `executeOutdatedImpl`
      // has no enclosing try — only `withTelemetry` — so it escapes the tool.
      //
      // The assertion is not "it did not throw". It is that `null` and `{}`
      // are INDISTINGUISHABLE to a consumer, which is the entire justification
      // for ADR-171 § 5 classifying `null` as `ok` rather than `corrupt`. A
      // fix that merely stopped the throw while reporting something different
      // for the two inputs would fail this, and asserting only `total_installed
      // === 0` would not have noticed.
      await writeManifest(BYTES_OK_NULL)
      const nullish = await runOutdated()

      await writeManifest(BYTES_OK_EMPTY)
      const empty = await runOutdated()

      expect(nullish).toEqual(empty)
      expect(nullish.summary).toEqual(ZERO_SUMMARY)
    })

    it('skill_updates already answers — its own guard is what makes that true', async () => {
      // CONTROL, NOT A RED TEST, and it is recorded as one deliberately.
      //
      // The Phase 2 plan's § 2b sweep table lists `skill-updates.ts:151` as
      // THROWS. Measured against the file, it does not: `:148` short-circuits
      // on a falsy `installedSkills`, and `null` is falsy. The same is true of
      // `manifest-skill-ids.helpers.ts:41`, which bounds `skillIds`. So this
      // passes before Wave 2 as well as after, and the reason it is kept is
      // that it pins those two guards as load-bearing: delete either one and
      // this goes red.
      await writeManifest(BYTES_OK_NULL)
      const nullish = await runUpdates()
      expect(nullish.updatesAvailable).toBe(0)
    })
  })
})
