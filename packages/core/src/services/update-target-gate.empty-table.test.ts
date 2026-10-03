/**
 * @fileoverview `classifyUpdateTarget`'s own throw path — reached only when
 *   `CLASSIFICATION_RULES` is exhausted without a match (SMI-6841 finding 3).
 * @module @skillsmith/core/services/update-target-gate.empty-table.test
 * @see docs/internal/implementation/update-safety-and-source-resolution.md §4.3
 *
 * SEPARATE FILE, NOT A `describe` BLOCK INSIDE `update-target-gate.test.ts`
 * (deliberate). The only way to exercise this throw is an EMPTY
 * `CLASSIFICATION_RULES` table, and `vi.mock` is HOISTED and applies to the
 * whole test FILE it is written in, not scoped to one `it`/`describe` block
 * — mocking `update-target-gate.rules.js` to
 * `{ CLASSIFICATION_RULES: [], ROW_ORDER: [] }` inside
 * `update-target-gate.test.ts` would empty the table for every OTHER test in
 * that file too (every one of which needs the real table). A dedicated file
 * with its own top-of-file `vi.mock` keeps the empty table from ever leaking
 * into a sibling test — the same reason this module's own
 * `update-target-gate.purity.test.ts` and
 * `update-target.probe.git-ancestor.test.ts` already live apart from their
 * siblings rather than as a `describe` block bolted onto a larger file.
 *
 * `update-target-gate.test.ts`'s own former justification for skipping this
 * test — "there is nothing to construct a fixture for here that would not
 * require monkey-patching the exported const array" — was FALSE: `vi.mock`
 * IS exactly that monkey-patch, applied cleanly at the module-loader level
 * (this file's own scope only) rather than by mutating the real array in
 * place.
 */
import { describe, expect, it, vi } from 'vitest'

vi.mock('./update-target-gate.rules.js', () => ({
  CLASSIFICATION_RULES: [],
  ROW_ORDER: [],
}))

import { classifyUpdateTarget } from './update-target-gate.js'
import type { ManifestEvidence } from './update-target.evidence.js'
import type { ProbeOk } from './update-target.probe.js'
import type { UpdateTargetPlan } from './update-target-gate.types.js'

// Minimal fixtures — content is irrelevant here (no rule in the mocked,
// empty table ever runs against them); only their SHAPE needs to satisfy
// the types classifyUpdateTarget's signature requires.
const EVIDENCE: ManifestEvidence = {
  manifestKey: 'foo',
  entry: null,
  canonicalId: null,
  source: null,
  provenance: null,
  pinnedVersion: null,
  updatePolicy: null,
  disqualifiedBy: null,
}
const PROBE: ProbeOk = { kind: 'ok', gitAncestor: { kind: 'none' }, skillMdHash: null, files: [] }
const PLAN: UpdateTargetPlan = {
  dirName: 'foo',
  manifestUnreadable: false,
  recoveryRecordUnreadable: false,
  identityMismatch: null,
  fetchOutcome: 'ok',
  writeSet: [],
  originalContentHash: null,
  fileHashes: {},
}

describe('classifyUpdateTarget — throws rather than defaulting if no rule matches (SMI-6841 finding 3)', () => {
  it('throws the documented error, matching its exact message, when CLASSIFICATION_RULES is empty', () => {
    expect(() => classifyUpdateTarget(EVIDENCE, PROBE, PLAN)).toThrow(
      'classifyUpdateTarget: no rule in CLASSIFICATION_RULES matched — row 16 must be an ' +
        'unconditional catch-all; this indicates the rule table itself is broken, not that ' +
        'this target has no reason'
    )
  })
})
