/**
 * SMI-6505 — core <-> edge BEHAVIOURAL parity for the embedded-key boolean-flag
 * carve-out in the MF-4 value gate.
 *
 * WHY THIS FILE EXISTS. The pre-existing twin guard
 * (security-scanner-edge.test.ts, PATHS_FAMILY_TWINS) asserts the two `_shared`
 * copies are BYTE-identical to each other modulo their @module line. It says
 * nothing about whether the edge pair agrees with `@skillsmith/core`, which is a
 * separate hand-maintained implementation. So a change ported to both edge twins
 * but not to core — or ported with a subtle difference — passes byte-identity
 * and still diverges in production. The SMI-6505 cross-model plan review named
 * this as the actual uncovered gap; the weak-credential lexicon parity test is
 * about generated payload identity, not gate behaviour, and does not cover it.
 *
 * Byte-identity then carries the Deno twin transitively: core == Node (here) and
 * Node == Deno (there).
 *
 * The table intentionally includes both SMI-6505 evasion guards. If someone
 * relaxes BOOLEAN_FLAG_VALUE on one side only, the divergence surfaces here even
 * if that side's own suite was updated to match.
 */

import { describe, it, expect } from 'vitest'
import { assignmentHasRealValue as edgeGate } from '../../indexer/_shared/security-scanner-edge.value-gate.ts'
import { assignmentHasRealValue as coreGate } from '../../../packages/core/src/security/scanner/SecurityScanner.value-gate.js'

/** [line, expectRealCredential] — must hold identically on both surfaces. */
const CASES: Array<[string, boolean]> = [
  // the reported false positive and its real formatting variants
  ['  - user: "Check FastAPI CORS setup" → verify origins when allow_credentials=True', false],
  ['    allow_credentials=True,', false],
  ['    allow_credentials = False)', false],
  ['allow_credentials: true', false],
  ['allow_credentials=TRUE', false],
  ['    allow_credentials=True;', false],

  // accepted residuals
  ['app.add_middleware(CORSMiddleware, allow_credentials=True, allow_methods=["*"])', true],
  ['    allow_credentials=True,  # allow cookies', true],

  // evasion guards — a one-sided relaxation flips exactly these
  ['my_credentials=true, Tr0ub4dor&3', true],
  ['my_credentials=true # Tr0ub4dor&3', true],

  // bare keys: the key, not the value, is the discriminator
  ['credentials: True', true],
  ['password: True', true],
  ['secrets: true', true],

  // must keep flagging (SMI-6508 shape) + quoted-string handling
  ['AWS_CREDENTIALS=hunter2', true],
  ['allow_credentials="true"', true],

  // the accepted cost
  ['DB_PASSWORD=true', false],

  // unchanged prior behaviour, including the SMI-6441 fixtures
  ['password: hunter2', true],
  ['password: monkey dragon', true],
  ['credentials: rotation policy', false],
  ['password: horse staple', false],
  ['allow_credentials=True, password: hunter2', true],
]

describe('SMI-6505 core <-> edge value-gate parity', () => {
  it.each(CASES)('core and edge agree on %s (expect %s)', (line, expected) => {
    const core = coreGate([line], 0)
    const edge = edgeGate([line], 0)
    expect(core, `core disagrees with the expected verdict for: ${line}`).toBe(expected)
    expect(edge, `edge disagrees with core for: ${line}`).toBe(core)
  })

  it('core and edge agree with the MF-4b veto disabled too', () => {
    // The carve-out must be independent of weakPasswordVeto on BOTH surfaces —
    // a port that accidentally coupled them would pass the table above.
    for (const [line] of CASES) {
      const core = coreGate([line], 0, { weakPasswordVeto: false })
      const edge = edgeGate([line], 0, { weakPasswordVeto: false })
      expect(edge, `edge disagrees with core (veto off) for: ${line}`).toBe(core)
    }
  })

  it('core and edge agree on the YAML next-line path', () => {
    for (const fixture of [
      ['my_credentials:', '  true'],
      ['credentials:', '  true'],
      ['password:', '  monkey dragon'],
    ]) {
      expect(edgeGate(fixture, 0)).toBe(coreGate(fixture, 0))
    }
  })
})
