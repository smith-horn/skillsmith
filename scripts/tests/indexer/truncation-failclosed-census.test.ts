/**
 * SMI-6020 (design §2.7 T2.27): anti-regression census — every quarantine
 * write path must call `shouldQuarantineFailClosed`, never the bare
 * `shouldQuarantine` (SMI-5358's pure score predicate). This is what stops a
 * future write path from silently reintroducing the truncation-bypass bug
 * Finding 2 fixed: a scan that hit its per-pattern iteration ceiling producing
 * a known-undercounted risk score that gets treated as authoritative for
 * de-quarantine.
 *
 * Source-grep, not behavioral — this is a structural guard on a PINNED CLOSED
 * SET of files. Adding a new quarantine write path means adding it here too
 * (deliberately not auto-discovered — an auto-discovered set could silently
 * shrink if a file is renamed and nobody notices the census stopped covering it).
 *
 * @module scripts/tests/indexer/truncation-failclosed-census
 */

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { isGitCryptEncrypted } from './parity-utils.ts'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)
// scripts/tests/indexer/truncation-failclosed-census.test.ts -> repo root is 3 levels up.
const REPO_ROOT = resolve(__dirname, '..', '..', '..')

/** The pinned closed set (design §2.7 T2.27) — do not auto-discover. */
const PINNED_FILES = [
  'scripts/indexer/skill-processor.ts',
  'supabase/functions/indexer/skill-processor.ts',
  'scripts/indexer/skill-processor.security.ts',
  'supabase/functions/indexer/skill-processor.security.ts',
  'scripts/indexer/stale-reconciliation.ts',
  'supabase/functions/indexer/stale-reconciliation.ts',
  'scripts/indexer/revalidate-stale-quarantines.ts',
  'scripts/indexer/dequarantine-false-positives.ts',
  'scripts/indexer/smi5879-simulate-full.helpers.ts',
] as const

/**
 * Strip `import { ... } from '...'` blocks (single- or multi-line) before
 * matching, so a legitimate `import { shouldQuarantineFailClosed } from ...`
 * line can never itself satisfy or trip the bare-call check below.
 */
function stripImports(source: string): string {
  return source.replace(/import\s*\{[^}]*\}\s*from\s*['"][^'"]+['"]/g, '')
}

/**
 * A "bare" shouldQuarantine( call — word-boundary before the identifier and
 * an open-paren immediately after. This naturally excludes
 * `shouldQuarantineFailClosed(` (the character after `shouldQuarantine` there
 * is `F`, not `(`) without needing a separate substring carve-out.
 */
const BARE_CALL_RE = /\bshouldQuarantine\(/

describe('SMI-6020 T2.27: every quarantine write path calls shouldQuarantineFailClosed, never shouldQuarantine', () => {
  for (const relPath of PINNED_FILES) {
    const absPath = resolve(REPO_ROOT, relPath)
    const isDeno = relPath.startsWith('supabase/functions/')

    it.skipIf(isDeno && isGitCryptEncrypted(absPath))(
      `${relPath} contains shouldQuarantineFailClosed( and no bare shouldQuarantine( call`,
      () => {
        const source = readFileSync(absPath, 'utf-8')
        const withoutImports = stripImports(source)

        expect(
          source.includes('shouldQuarantineFailClosed('),
          `${relPath} must call shouldQuarantineFailClosed(...) — a quarantine write path in ` +
            `this pinned set with no fail-closed call is exactly the regression this census guards against.`
        ).toBe(true)

        expect(
          BARE_CALL_RE.test(withoutImports),
          `${relPath} contains a bare shouldQuarantine(...) call outside any import — this bypasses ` +
            `the truncation fail-closed gate (SMI-6020). Use shouldQuarantineFailClosed(...) instead, ` +
            `or if the pure score predicate is genuinely needed, read scan.riskScore directly.`
        ).toBe(false)
      }
    )
  }
})
