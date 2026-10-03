/**
 * Every database-opening consumer, enumerated as a CHECK (ADR-175, SMI-6946).
 *
 * Why this exists, and why it is a test rather than a paragraph. SMI-6931
 * passed nine independent reviews and still shipped a regression, because the
 * driver was correct in isolation and the consumer was correct before the
 * driver changed. Every one of those reviews scoped to the diff, and **a diff
 * does not contain its consumers.** ADR-175 therefore requires the inventory be
 * "re-run as a check rather than cited as a count": a count in a PR body is
 * true on the day it is written, and a check is true on the day it is read.
 *
 * What it does. It enumerates the call sites that open a SQLite database across
 * every package and compares them to the frozen list below. Add, move or remove
 * one and this goes red — which is the point. The red is not a defect report;
 * it is a prompt to answer one question for the new site: **when the driver
 * refuses a corrupt database, what does this caller do with the refusal?** Then
 * record the answer here.
 *
 * The instrument is a source scan, which is exactly the kind of check that
 * returns a plausible answer when it is pointed at the wrong thing — so it
 * carries its own known-positive and known-negative controls below. Without
 * those, a scan that silently matched nothing would report a clean inventory
 * forever (SMI-6488).
 */
import { describe, it, expect } from 'vitest'
import { readdirSync, readFileSync, existsSync, statSync } from 'node:fs'
import { join, dirname, relative, sep } from 'node:path'

/**
 * The monorepo root, found by walking up for the workspace manifest.
 *
 * Not `process.cwd()`: this suite runs from the repo root under the full
 * `npm test` and from `packages/core` under the per-package split, and a
 * cwd-relative path silently scans a different tree in the second case — the
 * wrong-subject failure this file's controls exist to catch.
 */
function findRepoRoot(): string {
  let dir = dirname(new URL(import.meta.url).pathname)
  for (let i = 0; i < 12; i++) {
    const manifest = join(dir, 'package.json')
    if (existsSync(manifest)) {
      const pkg = JSON.parse(readFileSync(manifest, 'utf8')) as { workspaces?: unknown }
      if (pkg.workspaces !== undefined) return dir
    }
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  throw new Error('could not locate the workspace root from this test file')
}

/** Every `.ts` under `packages/<name>/src`, excluding tests and build output. */
function sourceFiles(root: string): string[] {
  const out: string[] = []
  const pkgDir = join(root, 'packages')
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, entry.name)
      if (entry.isDirectory()) {
        if (entry.name === 'node_modules' || entry.name === 'dist' || entry.name.startsWith('.')) {
          continue
        }
        walk(p)
      } else if (entry.name.endsWith('.ts') && !/\.(test|spec)\.ts$/.test(entry.name)) {
        out.push(p)
      }
    }
  }
  for (const pkg of readdirSync(pkgDir, { withFileTypes: true })) {
    if (!pkg.isDirectory()) continue
    const src = join(pkgDir, pkg.name, 'src')
    if (existsSync(src) && statSync(src).isDirectory()) walk(src)
  }
  return out
}

/** The open functions. A caller of any of these can receive the refusal. */
const OPENERS = [
  'openCliDatabase',
  'openDatabaseAsync',
  'createDatabaseAsync',
  'createDatabase',
] as const

/**
 * A line that CALLS one of the openers, as opposed to naming one in prose.
 *
 * Comment lines are dropped before matching: this file's own subject matter
 * means docblocks, `@deprecated` notes and migration advice mention these names
 * constantly, and counting those would make the inventory unreadable and its
 * failures uninformative. The known-negative control below pins that exclusion.
 */
function opensADatabase(line: string): boolean {
  const t = line.trim()
  if (t.startsWith('//') || t.startsWith('*') || t.startsWith('/*')) return false
  return OPENERS.some((fn) => new RegExp(`\\b${fn}\\s*\\(`).test(line))
}

function inventory(root: string): string[] {
  const found: string[] = []
  for (const file of sourceFiles(root)) {
    const rel = relative(root, file).split(sep).join('/')
    const lines = readFileSync(file, 'utf8').split('\n')
    lines.forEach((line, i) => {
      if (opensADatabase(line)) found.push(`${rel}:${i + 1}`)
    })
  }
  return found.sort()
}

/**
 * The frozen inventory, by file. Line numbers are deliberately NOT frozen —
 * they churn on every unrelated edit, and a check that cries wolf gets
 * disabled. The FILE SET is the invariant worth holding.
 *
 * Each entry records what that file does with a corruption refusal, which is
 * the question the nine SMI-6931 reviews did not ask.
 */
const KNOWN_OPENERS: Readonly<Record<string, string>> = {
  // --- The two wrappers every other CLI caller goes through ---
  // Read-only branch rethrows cleanly. Read-write branch still feeds the
  // refusal to a substring matcher and renames the database aside: ADR-175 § 1
  // forbids it and defers removal to PR-2. THE ONE KNOWN OPEN WINDOW.
  'packages/cli/src/utils/open-database.ts': 'wrapper; read-write path still destructive (PR-2)',
  'packages/core/src/db/createDatabase.ts': 'factory; selects native or WASM',
  'packages/core/src/db/schema.ts': 'factory; legacy + async variants',

  // --- CLI commands, all read-write through openCliDatabase ---
  // Each inherits the wrapper's behaviour; none handles the refusal itself.
  // This is the set a PR-2 rethrow flips from "rebuilt empty, command
  // proceeds" to "command aborts", which is why it is enumerated here.
  'packages/cli/src/commands/audit-sources.action.ts': 'read-write; inherits wrapper',
  'packages/cli/src/commands/audit.ts': 'read-write; inherits wrapper',
  'packages/cli/src/commands/import-local.ts': 'read-write; inherits wrapper',
  'packages/cli/src/commands/import.ts': 'read-write; inherits wrapper',
  'packages/cli/src/commands/info.ts': 'read-write; inherits wrapper',
  'packages/cli/src/commands/install.action.ts': 'read-write; inherits wrapper',
  'packages/cli/src/commands/manage.action.ts': 'read-write; inherits wrapper',
  'packages/cli/src/commands/manage.update.helpers.ts': 'read-write; inherits wrapper',
  'packages/cli/src/commands/manage.update.ts': 'read-write; getSkillDiff, the open window',
  'packages/cli/src/commands/registry-install.action.ts': 'read-write; inherits wrapper',
  'packages/cli/src/commands/search.action.ts': 'read-write; inherits wrapper',
  'packages/cli/src/commands/sync.action.ts': 'read-write; inherits wrapper',
  'packages/cli/src/commands/sync.status-history.action.ts': 'read-write; inherits wrapper',

  // --- The consumer SMI-6946 fixed ---
  'packages/cli/src/utils/skills-directory.ts': 'READ-ONLY; classifies the refusal (ADR-175 § 5)',

  // --- MCP server ---
  // Confirmed to contain no isCorruptionError/backupCorruptDbFile, so it has
  // no destructive branch to converge; the refusal propagates to startup.
  'packages/mcp-server/src/context.async.ts': 'propagates; no destructive branch',
  'packages/mcp-server/src/context.ts': 'propagates; no destructive branch',

  // --- Core internals, each owning its own database file, not skills.db ---
  'packages/core/src/analytics/storage.ts': 'own analytics.db; propagates',
  'packages/core/src/cache/sqlite.ts': 'own L2 cache; propagates',
  'packages/core/src/cache/TieredCache.ts': 'own L2 cache; propagates',
  'packages/core/src/embeddings/hnsw-store.ts': 'own HNSW store; propagates',
  'packages/core/src/embeddings/index.ts': 'own store; propagates',
  'packages/core/src/learning/PatternStore.ts': 'own patterns db; propagates',
  'packages/core/src/search/hybrid.ts': 'own index; propagates',
  'packages/core/src/benchmarks/IndexBenchmark.ts': ':memory: only',
  'packages/core/src/benchmarks/SearchBenchmark.ts': ':memory: only',
  'packages/core/src/scripts/import-to-database.ts': 'maintenance script; propagates',
  'packages/core/src/scripts/merge-skills.ts': 'maintenance script; propagates',
  'packages/core/src/scripts/review-lenny-skills.ts': 'maintenance script; propagates',
}

describe('the database-opening consumer inventory (ADR-175)', () => {
  const root = findRepoRoot()

  // --- Controls. The scan is the kind of instrument that answers rather than
  // --- failing when aimed wrongly, so both directions are pinned first.
  it('known-positive: the scan finds a call site that certainly exists', () => {
    const files = new Set(inventory(root).map((e) => e.split(':')[0]))
    expect(files.has('packages/cli/src/utils/skills-directory.ts')).toBe(true)
    expect(files.has('packages/cli/src/utils/open-database.ts')).toBe(true)
  })

  it('known-negative: a prose mention is not counted as a call site', () => {
    expect(opensADatabase(' * const db = await createDatabaseAsync(path)')).toBe(false)
    expect(opensADatabase('// Use createDatabaseAsync() instead')).toBe(false)
    expect(opensADatabase('   * @deprecated Use openDatabaseAsync() for WASM support.')).toBe(false)
    // And the positive direction of the same predicate, so it is not simply
    // returning false for everything — which would make the inventory empty
    // and this whole suite vacuously green.
    expect(opensADatabase('  const db = await openCliDatabase(dbPath)')).toBe(true)
  })

  it('scanned a non-trivial number of source files', () => {
    // A denominator. An empty or near-empty file set would make every
    // assertion below pass while examining nothing.
    expect(sourceFiles(root).length).toBeGreaterThan(200)
  })

  // --- The inventory itself.
  it('contains no database-opening file that is not accounted for', () => {
    const files = [...new Set(inventory(root).map((e) => e.split(':')[0]))].sort()
    const unaccounted = files.filter((f) => KNOWN_OPENERS[f] === undefined)

    // If you are reading this because it went red: a new file opens a
    // database. Answer the one question — when the driver refuses a corrupt
    // database, what does this caller do with the refusal? — then add it to
    // KNOWN_OPENERS with that answer. Do not delete this test to get green.
    expect(unaccounted).toEqual([])
  })

  it('has no stale entry for a file that no longer opens a database', () => {
    const files = new Set(inventory(root).map((e) => e.split(':')[0]))
    const stale = Object.keys(KNOWN_OPENERS).filter((f) => !files.has(f))

    // The other direction, and the one that rots silently: an inventory
    // keeping entries for code that no longer exists reads as coverage it
    // does not give.
    expect(stale).toEqual([])
  })
})
