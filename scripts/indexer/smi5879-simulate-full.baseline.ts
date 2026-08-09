/**
 * Pre-port baseline materialization for smi5879-simulate-full.ts.
 * @module scripts/indexer/smi5879-simulate-full.baseline
 *
 * Design doc §8.2.3: "The baseline (pre-port) twin set is materialised into a
 * temp directory via a git-show of the merge-base commit and dynamically
 * imported at runtime... A feature flag inside the scanner was rejected — a
 * runtime branch in a production quarantine gate is a worse artifact than a
 * build-time import."
 *
 * The pinned commit is PR-2192a's own squash SHA (`b4368d04522993cab01b4026592f0bfb857a124d`,
 * "feat(indexer): SMI-5879 PR-2192a extract scanSkillBundle from
 * validateSkillMd (#2213)") — per the plan's PR-2192a interaction note, the
 * baseline must postdate PR-2192a's extraction so BOTH the post-port and
 * pre-port scans can call the identical `scanSkillBundle(...)` signature; an
 * earlier baseline would still have the inline enumerate-fetch-scan-merge
 * loop and no comparable entry point at all.
 */

import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { ScanSkillBundleFn } from './smi5879-simulate-full.types.ts'

/** PR-2192a's own squash SHA — see module header. Confirmed a real, reachable ancestor commit. */
export const BASELINE_COMMIT_SHA = 'b4368d04522993cab01b4026592f0bfb857a124d'

/**
 * Files the pre-port `scanSkillBundle` closure needs, resolved at the pinned
 * commit. Kept to the minimal transitive set `skill-processor.security.ts`
 * imports rather than the whole `scripts/indexer/` tree, so materialization
 * stays cheap per row-batch and a baseline-only file that doesn't exist yet
 * at the pinned SHA fails loudly (`git show` exits non-zero) instead of
 * silently missing.
 *
 * FULL closure, verified directly against the pinned commit's actual import
 * graph (`git show <sha>:<path> | grep '^import'` on every file transitively,
 * not just `skill-processor.security.ts`'s own top-level imports — the first
 * version of this list only checked the top level and silently omitted two
 * files `security-scanner-edge.ts` itself pulls in, which would have made
 * `importBaselineScanSkillBundle()` throw a module-not-found error the first
 * time the simulator actually ran):
 *   skill-processor.security.ts
 *     -> security-scanner-edge.ts, security-scanner-edge.context.ts,
 *        rate-limit.ts, github-auth.ts
 *   security-scanner-edge.ts
 *     -> (all four above, already listed) + security-scanner-edge.exec.ts,
 *        security-scanner-edge.patterns.ts
 *   security-scanner-edge.exec.ts -> security-scanner-edge.context.ts (already listed)
 *   security-scanner-edge.patterns.ts, security-scanner-edge.context.ts,
 *   rate-limit.ts, github-auth.ts -> no further imports (leaf files)
 */
export const BASELINE_FILES = [
  'scripts/indexer/skill-processor.security.ts',
  'scripts/indexer/_shared/security-scanner-edge.ts',
  'scripts/indexer/_shared/security-scanner-edge.context.ts',
  'scripts/indexer/_shared/security-scanner-edge.exec.ts',
  'scripts/indexer/_shared/security-scanner-edge.patterns.ts',
  'scripts/indexer/_shared/rate-limit.ts',
  'scripts/indexer/_shared/github-auth.ts',
] as const

/** Throws with an actionable message unless `commitSha` is a real, reachable commit object. */
export function assertBaselineCommitReachable(commitSha: string): void {
  try {
    execFileSync('git', ['cat-file', '-e', `${commitSha}^{commit}`], { stdio: 'pipe' })
  } catch {
    throw new Error(
      `SMI-5879: baseline commit ${commitSha} is not a reachable commit object in this repo's ` +
        `history. The simulator refuses to run against an unpinnable baseline.`
    )
  }
}

/**
 * `git show <commitSha>:<relPath>` for each of {@link BASELINE_FILES} into a
 * fresh temp directory, preserving relative paths so the materialized
 * `skill-processor.security.ts`'s own relative imports (`./_shared/...`)
 * resolve correctly. Returns the temp directory root.
 */
export function materializeBaseline(commitSha: string = BASELINE_COMMIT_SHA): string {
  assertBaselineCommitReachable(commitSha)
  const dir = mkdtempSync(join(tmpdir(), 'smi5879-baseline-'))
  for (const relPath of BASELINE_FILES) {
    let content: string
    try {
      content = execFileSync('git', ['show', `${commitSha}:${relPath}`], {
        encoding: 'utf8',
        maxBuffer: 16 * 1024 * 1024,
      })
    } catch (err) {
      throw new Error(
        `SMI-5879: failed to materialize baseline file ${relPath} at ${commitSha}: ${(err as Error).message}`
      )
    }
    const dest = join(dir, relPath)
    mkdirSync(dirname(dest), { recursive: true })
    writeFileSync(dest, content)
  }
  return dir
}

/**
 * Dynamically import the materialized baseline's `scanSkillBundle`. Requires
 * the host process to run under `tsx` (or another runtime whose loader
 * transforms `.ts` on `import()`) — true for every production invocation of
 * this tool. Tests inject a fake `ScanSkillBundleFn` directly instead of
 * exercising this path (see smi5879-simulate-full.test.ts's header for why).
 */
export async function importBaselineScanSkillBundle(baselineDir: string): Promise<{
  scanSkillBundle: ScanSkillBundleFn
}> {
  const entry = join(baselineDir, 'scripts/indexer/skill-processor.security.ts')
  const mod = (await import(pathToFileURL(entry).href)) as { scanSkillBundle: ScanSkillBundleFn }
  if (typeof mod.scanSkillBundle !== 'function') {
    throw new Error(
      `SMI-5879: materialized baseline at ${entry} has no scanSkillBundle export — ` +
        `the pinned commit predates PR-2192a's extraction, or BASELINE_FILES is stale.`
    )
  }
  return { scanSkillBundle: mod.scanSkillBundle }
}
