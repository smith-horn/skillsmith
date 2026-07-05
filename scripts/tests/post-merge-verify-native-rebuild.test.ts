/**
 * Static-assertion tests for the native-module rebuild step in
 * .github/workflows/post-merge-verify.yml (SMI-5547).
 *
 * Background: post-merge-verify.yml runs `npm ci --ignore-scripts` (repo
 * .npmrc sets ignore-scripts=true, SMI-4672/4673), which does NOT build
 * native bindings such as better-sqlite3. The workflow's root vitest step
 * (vitest.config.root-tests.ts) exercises code paths that call
 * new Database() / createTestDatabase(), so without a dedicated rebuild step
 * the job was chronically red on a host runner lacking a built
 * better-sqlite3 binding.
 *
 * This test guards against silent removal or reordering of that rebuild
 * step (the SMI-4673-W3b class of regression), and against the stale
 * SMI-4239 comment claim (that `npm ci` alone provides native bindings)
 * creeping back in.
 *
 * Mirrors the structural-assertion convention from
 * scripts/tests/docker-entrypoint-native-rebuild.test.ts: read the target
 * file once, assert string/order properties on its contents rather than
 * executing it.
 */
import { readFileSync } from 'fs'
import { resolve, dirname } from 'path'
import { fileURLToPath } from 'url'
import { describe, expect, it, beforeAll } from 'vitest'

// ---------------------------------------------------------------------------
// File resolution — locate from the test file's directory, then walk up to
// the repo root (same pattern as docker-entrypoint-native-rebuild.test.ts).
// ---------------------------------------------------------------------------

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)

// Repo root is two levels up from scripts/tests/
const REPO_ROOT = resolve(__dirname, '..', '..')

const WORKFLOW_PATH = resolve(REPO_ROOT, '.github', 'workflows', 'post-merge-verify.yml')

// ---------------------------------------------------------------------------
// Load file once
// ---------------------------------------------------------------------------

let workflowSrc: string

beforeAll(() => {
  workflowSrc = readFileSync(WORKFLOW_PATH, 'utf8')
})

// ---------------------------------------------------------------------------
// 1. The rebuild command is present
// ---------------------------------------------------------------------------

describe('native module rebuild step', () => {
  it('contains the better-sqlite3 rebuild command with --ignore-scripts=false', () => {
    expect(workflowSrc).toContain('npm rebuild better-sqlite3 --ignore-scripts=false')
  })

  // -------------------------------------------------------------------------
  // 2. A probe that actually loads and opens better-sqlite3
  // -------------------------------------------------------------------------

  it('contains a probe that requires better-sqlite3', () => {
    expect(workflowSrc).toMatch(/require\(['"]better-sqlite3['"]\)/)
  })

  it('contains a probe that opens an in-memory database', () => {
    expect(workflowSrc).toMatch(/new\s+\w+\(['"]:memory:['"]\)/)
  })

  // -------------------------------------------------------------------------
  // 3. Order: the rebuild must occur BEFORE the root vitest runner
  // -------------------------------------------------------------------------

  it('the rebuild step occurs before the root vitest config step', () => {
    // Anchor on the step `name:` headers, not a bare path mention: the comment
    // block references vitest.config.root-tests.ts, so indexOf on the path
    // would match the comment (which precedes the rebuild step) rather than the
    // actual runner step, giving a false failure (SMI-5547 guard robustness).
    const rebuildStepIdx = workflowSrc.indexOf('name: Rebuild native modules')
    const vitestStepIdx = workflowSrc.indexOf('name: Root vitest config')

    expect(rebuildStepIdx, 'Rebuild native modules step not found').toBeGreaterThan(-1)
    expect(vitestStepIdx, 'Root vitest config step not found').toBeGreaterThan(-1)
    expect(
      rebuildStepIdx,
      'rebuild step must run before the root vitest step (a rebuild after the runner is useless)'
    ).toBeLessThan(vitestStepIdx)
  })

  // -------------------------------------------------------------------------
  // 4. Comment/code coherence
  // -------------------------------------------------------------------------

  it('still uses npm ci --ignore-scripts for the install step', () => {
    expect(workflowSrc).toContain('npm ci --ignore-scripts')
  })

  it('does not contain the stale SMI-4239 claim that npm ci alone provides native bindings', () => {
    expect(workflowSrc).not.toMatch(/npm ci runs install lifecycle scripts/)
  })
})
