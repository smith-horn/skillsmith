/**
 * Static-assertion test for packages/mcp-server/Dockerfile's deps-stage
 * `npm install` retry loop (SMI-6286, Area 4 of the 2026-08 CI-failure
 * remediation plan — docs/internal/implementation/smi-6282-ci-failure-cluster-2026-08-remediation.md).
 *
 * Mirrors the static-source-assertion convention used by
 * scripts/tests/docker-entrypoint-native-rebuild.test.ts — asserts
 * structural properties of the Dockerfile text without running Docker.
 *
 * Background: this deps stage deliberately builds with no lockfile in
 * context (`npm install --omit=dev --ignore-scripts`), to reproduce exactly
 * what a real `npm install @skillsmith/mcp-server` consumer experiences. A
 * same-day-publish race can trip a known npm Arborist null-deref bug
 * (npm/cli#9787 / #8261) — a bare retry alone reproduces the identical crash
 * against identical cached registry metadata inside the same Docker layer,
 * so the fix must ALSO clear npm's on-disk cache and any partial
 * node_modules between attempts. This test asserts:
 *
 *   1. The deps-stage RUN block contains a 3-attempt retry loop.
 *   2. It clears npm's cache (`npm cache clean --force`) between attempts.
 *   3. It removes any partial `node_modules` between attempts.
 *   4. It logs a `[deps-retry]` marker on every attempt — required because a
 *      BuildKit RUN that eventually succeeds collapses in the build output,
 *      so without this marker a masked failure (bug fired twice, silently
 *      absorbed) would be indistinguishable from a clean success in the
 *      logs, defeating verification of Wave 3a's settled-registry data
 *      point.
 */
import { readFileSync } from 'fs'
import { resolve, dirname } from 'path'
import { fileURLToPath } from 'url'
import { describe, expect, it, beforeAll } from 'vitest'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)
const REPO_ROOT = resolve(__dirname, '..', '..')
const MCP_SERVER_DOCKERFILE_PATH = resolve(REPO_ROOT, 'packages', 'mcp-server', 'Dockerfile')

let dockerfileSrc: string

beforeAll(() => {
  dockerfileSrc = readFileSync(MCP_SERVER_DOCKERFILE_PATH, 'utf8')
})

/**
 * Extract the deps-stage `npm install` retry RUN block: from the `RUN for i
 * in 1 2 3; do` loop header through its closing `done` line (inclusive).
 * Returns null if no such loop is found.
 */
function extractDepsRetryBlock(src: string): string | null {
  const lines = src.split('\n')
  const startIdx = lines.findIndex((l) => /^RUN\s+for\s+i\s+in\s+1\s+2\s+3;\s*do\b/.test(l.trim()))
  if (startIdx === -1) return null

  for (let i = startIdx; i < lines.length; i++) {
    if (/^\s*done;?\s*\\?\s*$/.test(lines[i])) {
      return lines.slice(startIdx, i + 1).join('\n')
    }
  }
  return null
}

describe('SMI-6286: mcp-server Dockerfile deps-stage npm install retry', () => {
  it('no lockfile is added to the build context (would defeat the purpose of this stage)', () => {
    // The deps stage must not COPY a package-lock.json — that's the entire
    // point of this build test (reproduce an unpinned `npm install` like a
    // real consumer would experience).
    expect(dockerfileSrc).not.toMatch(/COPY\s+.*package-lock\.json/)
  })

  it('contains a 3-attempt retry loop (`for i in 1 2 3; do`) around npm install', () => {
    const block = extractDepsRetryBlock(dockerfileSrc)
    expect(block, 'expected a `RUN for i in 1 2 3; do … done` retry block').not.toBeNull()
    expect(block).toMatch(/npm\s+install\s+--omit=dev\s+--ignore-scripts/)
  })

  it('exits non-zero when the final (3rd) attempt fails, rather than silently continuing', () => {
    const block = extractDepsRetryBlock(dockerfileSrc)
    expect(block).not.toBeNull()
    expect(block).toMatch(/\[\s*\$i\s+-eq\s+3\s*\]\s*&&\s*exit\s+1/)
  })

  it('clears npm cache (`npm cache clean --force`) between retry attempts', () => {
    const block = extractDepsRetryBlock(dockerfileSrc)
    expect(block).not.toBeNull()
    expect(block).toMatch(/npm\s+cache\s+clean\s+--force/)
  })

  it('removes any partial node_modules between retry attempts', () => {
    const block = extractDepsRetryBlock(dockerfileSrc)
    expect(block).not.toBeNull()
    expect(block).toMatch(/rm\s+-rf\s+node_modules/)
  })

  it('the cache-clean and node_modules-removal steps run BEFORE any retry sleep, and only inside the failure branch — not on the success path', () => {
    const block = extractDepsRetryBlock(dockerfileSrc)
    expect(block).not.toBeNull()

    const cacheCleanIdx = block!.search(/npm\s+cache\s+clean\s+--force/)
    const rmNodeModulesIdx = block!.search(/rm\s+-rf\s+node_modules/)
    const sleepIdx = block!.search(/sleep\s+\$\(\(i\s*\*\s*30\)\)/)

    expect(cacheCleanIdx).toBeGreaterThan(-1)
    expect(rmNodeModulesIdx).toBeGreaterThan(-1)
    expect(sleepIdx).toBeGreaterThan(-1)
    expect(cacheCleanIdx).toBeLessThan(sleepIdx)
    expect(rmNodeModulesIdx).toBeLessThan(sleepIdx)

    // The success path is `npm install ... && break` — cache-clean/rm must
    // sit after the `||` (failure branch), not before it.
    const orIdx = block!.indexOf('||')
    expect(orIdx).toBeGreaterThan(-1)
    expect(cacheCleanIdx).toBeGreaterThan(orIdx)
    expect(rmNodeModulesIdx).toBeGreaterThan(orIdx)
  })

  it('logs a `[deps-retry]` marker on every attempt (required so a masked failure is diagnosable in collapsed BuildKit output)', () => {
    const block = extractDepsRetryBlock(dockerfileSrc)
    expect(block).not.toBeNull()

    // One marker announcing the attempt, one announcing a failed retry.
    expect(block).toMatch(/echo\s+"\[deps-retry\]\s+npm install attempt \$i\/3"/)
    expect(block).toMatch(
      /echo\s+"\[deps-retry\]\s+attempt \$i\/3 failed; clearing cache and retrying"/
    )
  })

  it('documents the deliberate deviation from the [1000,2000,4000]ms backoff convention at the point of use', () => {
    // Comment must sit immediately above the retry RUN block, not just
    // somewhere in the file, so a future reader sees the rationale in place.
    const lines = dockerfileSrc.split('\n')
    const runIdx = lines.findIndex((l) => /^RUN\s+for\s+i\s+in\s+1\s+2\s+3;\s*do\b/.test(l.trim()))
    expect(runIdx).toBeGreaterThan(-1)

    // Walk backwards from the RUN line collecting the contiguous comment
    // block immediately preceding it.
    let i = runIdx - 1
    const commentLines: string[] = []
    while (i >= 0 && /^\s*#/.test(lines[i])) {
      commentLines.unshift(lines[i])
      i--
    }
    const precedingComment = commentLines.join('\n')

    expect(precedingComment).toMatch(/SMI-6286/)
    expect(precedingComment).toMatch(/\[1000,\s*2000,\s*4000\]/)
    // Updated during implementation: the plan's original theory (this
    // failure class is registry-metadata propagation) was disproven by a
    // live reproduction — the retry loop is now documented as
    // defense-in-depth against transient registry issues distinct from the
    // (now separately fixed, via an npm upgrade) deterministic Arborist bug.
    // Strip newlines/comment markers before matching so a line-wrap doesn't
    // defeat the assertion.
    const flattened = precedingComment.replace(/\n\s*#\s*/g, ' ')
    expect(flattened).toMatch(/transient registry/)
  })

  it('upgrades npm to a pinned version BEFORE the retry loop — the actual root-cause fix', () => {
    // Root-cause correction made during implementation: a live reproduction
    // showed the Arborist null-deref crashes deterministically on
    // node:22-slim's bundled npm (10.9.8) and installing a newer npm first
    // makes the identical install succeed every time — this is a real
    // npm-CLI bug, not a transient registry-timing artifact, so the actual
    // fix is upgrading npm, not just retrying with the broken one.
    const lines = dockerfileSrc.split('\n')
    const npmUpgradeIdx = lines.findIndex((l) => /^RUN\s+npm\s+install\s+-g\s+npm@/.test(l.trim()))
    expect(
      npmUpgradeIdx,
      'expected a `RUN npm install -g npm@<pinned version>` line'
    ).toBeGreaterThan(-1)

    // Pinned to an exact version, not `npm@latest` — build reproducibility.
    expect(lines[npmUpgradeIdx]).toMatch(/npm@\d+\.\d+\.\d+/)
    expect(lines[npmUpgradeIdx]).not.toMatch(/npm@latest/)

    const retryLoopIdx = lines.findIndex((l) =>
      /^RUN\s+for\s+i\s+in\s+1\s+2\s+3;\s*do\b/.test(l.trim())
    )
    expect(retryLoopIdx).toBeGreaterThan(-1)
    expect(npmUpgradeIdx, 'npm upgrade must run before the retry loop').toBeLessThan(retryLoopIdx)
  })
})
