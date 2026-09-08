/**
 * SMI-6441 Wave 1, item 5 (L2): three-way LITERAL payload-identity parity
 * for the generated weak-password lexicon.
 * @module scripts/tests/indexer/security-scanner-edge.weak-passwords-parity
 *
 * Net-new parity layer, stronger than L1's whitespace-normalised Deno<->Node
 * comparison (security-scanner-edge.test.ts's PATHS_FAMILY_TWINS): this
 * asserts core === Node-edge === Deno-edge with a literal `===`, not
 * normalizeWs. A generated, import-free, logic-free module has no
 * legitimate reason to differ across substrates beyond its `@module`
 * line, which sits above the `@generated` marker extractGeneratedPayload
 * anchors on — so everything from that marker onward must be byte-for-byte
 * identical in all three copies.
 *
 * L1 covers Deno<->Node only (never core); this suite is what actually
 * proves core agrees with both edge twins.
 */

import { describe, it, expect } from 'vitest'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { extractGeneratedPayload, isGitCryptEncrypted } from './parity-utils.ts'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)
// scripts/tests/indexer/security-scanner-edge.weak-passwords-parity.test.ts
// -> repo root is 3 levels up.
const REPO_ROOT = resolve(__dirname, '..', '..', '..')

const CORE_PATH = resolve(
  REPO_ROOT,
  'packages/core/src/security/scanner/SecurityScanner.weak-passwords.ts'
)
const NODE_EDGE_PATH = resolve(
  REPO_ROOT,
  'scripts/indexer/_shared/security-scanner-edge.weak-passwords.ts'
)
const DENO_EDGE_PATH = resolve(
  REPO_ROOT,
  'supabase/functions/_shared/security-scanner-edge.weak-passwords.ts'
)

describe('SMI-6441 L2: three-way literal payload identity (weak-password lexicon)', () => {
  it.skipIf(isGitCryptEncrypted(DENO_EDGE_PATH))(
    'core, Node edge, and Deno edge are byte-identical from the @generated banner onward',
    () => {
      const core = extractGeneratedPayload(CORE_PATH)
      const nodeEdge = extractGeneratedPayload(NODE_EDGE_PATH)
      const denoEdge = extractGeneratedPayload(DENO_EDGE_PATH)

      expect(
        nodeEdge,
        'core vs Node-edge generated payload diverged (beyond the @module line)'
      ).toBe(core)
      expect(
        denoEdge,
        'core vs Deno-edge generated payload diverged (beyond the @module line)'
      ).toBe(core)
    }
  )
})
