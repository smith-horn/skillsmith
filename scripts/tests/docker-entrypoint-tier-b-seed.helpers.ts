/**
 * Extraction + fixture helpers for docker-entrypoint-tier-b-seed.test.ts
 * (SMI-6050 Wave 2). Split out per CLAUDE.md's 500-line guidance — this file
 * holds the "how to isolate and exercise the live shell block" plumbing; the
 * sibling `.test.ts` holds only the `describe`/`it` suite.
 *
 * Mirrors the extraction/fixture/execution technique
 * docker-entrypoint-native-seed.helpers.ts already established for the
 * Tier-A (better-sqlite3/onnxruntime-node/esbuild/hnswlib-node) seed/restore
 * mechanism (SMI-5650) — `findIfBlockAfter` is reused unchanged from that
 * sibling file (identical if/elif/fi depth-counting need). Everything else
 * here is purpose-built for the SMI-6050 Tier-B restore loop's own,
 * structurally distinct shape: a single generic `find … -name '*.version'`
 * walk (not a fixed per-module list) plus a version-marker comparison the
 * Tier-A mechanism doesn't have — so the literal path substitutions
 * (`/opt/native-seed/tier-b/...`, `target="/app/${rel_path}"`) don't match
 * the Tier-A helpers' `/app/node_modules/`-shaped ones and aren't reused.
 *
 * The Tier-B block never calls `node`/`npm` (unlike the Tier-A blocks), so
 * no stub-binary PATH plumbing is needed here — real coreutils
 * (find/mkdir/cp/printf/cat/ls) are sufficient.
 */
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { findIfBlockAfter } from './docker-entrypoint-native-seed.helpers.js'

// ---------------------------------------------------------------------------
// Extraction — anchored on the SMI-6050 Wave 2 Tier-B block's unique leading
// comment, then reuse the shared if/elif/fi depth-counter.
// ---------------------------------------------------------------------------

/**
 * Extract the SMI-6050 Wave 2 Tier-B restore if/elif/elif/fi block verbatim
 * from the live docker-entrypoint.sh source:
 *   if [ "${SKILLSMITH_TIER_B_SEED_DISABLE:-}" = "1" ]; then
 *     ...
 *   elif [ -f "/app/.git" ] && [ -d "/opt/native-seed/tier-b" ]; then
 *     ...
 *     while IFS= read -r version_file; do ... done < <(find ...)
 *     ...
 *   elif [ -f "/app/.git" ]; then
 *     ...
 *   fi
 *
 * A future edit that removes or restructures the block fails LOUDLY here (a
 * thrown Error in beforeAll) rather than silently testing stale
 * copy-and-pasted logic.
 */
export function extractTierBRestoreBlock(src: string): string {
  const anchor = '# SMI-6050 Wave 2: restore Tier-B (build-tool / compiler platform binaries —'
  const lines = src.split('\n')
  const anchorIdx = lines.findIndex((l) => l.includes(anchor))
  if (anchorIdx === -1) {
    throw new Error(`extractTierBRestoreBlock: anchor not found in docker-entrypoint.sh: ${anchor}`)
  }

  const block = findIfBlockAfter(lines, anchorIdx)
  if (!block) {
    throw new Error(
      'extractTierBRestoreBlock: if/elif/elif/fi block not found after the SMI-6050 anchor'
    )
  }

  return lines.slice(block.startIdx, block.endIdx + 1).join('\n')
}

// ---------------------------------------------------------------------------
// Fixture-path substitution — purpose-built for Tier-B's own literal path
// shapes. Plain string split/join (not regex), same rationale as the Tier-A
// helpers' own substituteFixturePaths: no escaping hazards from the
// fixture's tmp-dir path.
// ---------------------------------------------------------------------------

export function substituteTierBFixturePaths(block: string, fixtureRoot: string): string {
  return block
    .split('/opt/native-seed/tier-b')
    .join(fixtureRoot + '/opt/native-seed/tier-b')
    .split('"/app/.git"')
    .join('"' + fixtureRoot + '/app/.git"')
    .split('target="/app/${rel_path}"')
    .join('target="' + fixtureRoot + '/app/${rel_path}"')
}

// ---------------------------------------------------------------------------
// Fixture: isolated root mirroring the real /opt/native-seed/tier-b +
// /app layout, plus the worktree marker (/app/.git as a FILE).
// ---------------------------------------------------------------------------

export interface TierBFixture {
  root: string
  /** /opt/native-seed/tier-b/<relPath> — the seeded package directory. */
  seedPackageDir: (relPath: string) => string
  /** /opt/native-seed/tier-b/<relPath>.version — the seed's version marker. */
  seedVersionMarker: (relPath: string) => string
  /** /app/<relPath> — the restore target (models the named-volume mount). */
  targetDir: (relPath: string) => string
  /** /app/<relPath>/.smi6050-seed-version — the target's own version marker. */
  targetVersionMarker: (relPath: string) => string
}

export function makeTierBFixture(): TierBFixture {
  const root = mkdtempSync(join(tmpdir(), 'skillsmith-tier-b-seed-'))
  mkdirSync(join(root, 'app'), { recursive: true })
  mkdirSync(join(root, 'opt', 'native-seed', 'tier-b'), { recursive: true })
  // Worktree signal: /app/.git must be a FILE (git's worktree marker) — same
  // convention as the Tier-A fixture (docker-entrypoint-native-seed.helpers.ts).
  writeFileSync(join(root, 'app', '.git'), 'gitdir: ../fixture-git/worktrees/x\n', 'utf8')

  return {
    root,
    seedPackageDir: (relPath: string) => join(root, 'opt', 'native-seed', 'tier-b', relPath),
    seedVersionMarker: (relPath: string) =>
      join(root, 'opt', 'native-seed', 'tier-b', `${relPath}.version`),
    targetDir: (relPath: string) => join(root, 'app', relPath),
    targetVersionMarker: (relPath: string) => join(root, 'app', relPath, '.smi6050-seed-version'),
  }
}

/**
 * Execute an already fixture-path-substituted Tier-B block via `bash -c`.
 * `set -e` matches docker-entrypoint.sh's own top-of-file setting — a
 * genuine crash inside the block surfaces as a non-zero exit here exactly as
 * it would in the real container.
 */
export function runTierBBlock(
  fixture: TierBFixture,
  blockSrc: string,
  extraEnv: Record<string, string> = {}
): { status: number; output: string } {
  const substituted = substituteTierBFixturePaths(blockSrc, fixture.root)
  const script = ['set -e', "YELLOW=''", "GREEN=''", "NC=''", substituted, ''].join('\n')

  const result = spawnSync('bash', ['-c', script], {
    encoding: 'utf8',
    env: {
      PATH: process.env['PATH'] ?? '/usr/bin:/bin',
      ...extraEnv,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 15_000,
  })
  return { status: result.status ?? 1, output: (result.stdout ?? '') + (result.stderr ?? '') }
}
