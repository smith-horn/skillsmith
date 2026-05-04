/**
 * SMI-4693 — git-fixture isolation helpers (per-package copy).
 *
 * Mirrors the canonical helper at `scripts/tests/_lib/git-fixture-env.ts`.
 * Duplicated here because `composite: true` + `rootDir: "."` blocks
 * cross-package imports from `git-commits.test.ts`. Keep the two copies
 * in sync; the canonical version is authoritative. See the RCA at
 * `docs/internal/research/smi-4693-fixture-leak-rca.md` for the full
 * remediation rationale.
 */
import { mkdtempSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const GIT_DISCOVERY_VARS = [
  'GIT_DIR',
  'GIT_WORK_TREE',
  'GIT_INDEX_FILE',
  'GIT_OBJECT_DIRECTORY',
  'GIT_ALTERNATE_OBJECT_DIRECTORIES',
  'GIT_COMMON_DIR',
  'GIT_NAMESPACE',
  'GIT_PREFIX',
  'GIT_CEILING_DIRECTORIES',
  'GIT_DISCOVERY_ACROSS_FILESYSTEM',
] as const

const realpath: (p: string) => string =
  typeof realpathSync.native === 'function' ? realpathSync.native : realpathSync

export function makeFixtureEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env }
  for (const v of GIT_DISCOVERY_VARS) delete env[v]
  return {
    ...env,
    GIT_AUTHOR_NAME: 'Test',
    GIT_AUTHOR_EMAIL: 'test@test.com',
    GIT_COMMITTER_NAME: 'Test',
    GIT_COMMITTER_EMAIL: 'test@test.com',
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_SYSTEM: '/dev/null',
    ...extra,
  }
}

export function makeFixtureTempDir(prefix: string): string {
  const base = realpath(tmpdir())
  return mkdtempSync(join(base, `${prefix}-`))
}
