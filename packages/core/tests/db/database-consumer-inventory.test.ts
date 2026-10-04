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
 * every package and compares them to the frozen table below. Add, move or
 * remove one and this goes red — which is the point. The red is not a defect
 * report; it is a prompt to answer one question for the new site: **when the
 * driver refuses a corrupt database, what does this caller do with the
 * refusal?** Then record the answer here.
 *
 * **Granularity: file plus call-site count, never line numbers.** Line numbers
 * churn on every unrelated edit, and a check that cries wolf gets disabled.
 * Freezing the file set alone was the first draft and a governance round
 * rejected it: a *second* call site added to an already-listed file would have
 * been invisible, so a new destructive open could join a file already marked
 * "inherits wrapper" without anything noticing. The per-file count closes that
 * without reintroducing the churn.
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
 * wrong-subject failure this file's controls exist to catch. Walking from
 * `import.meta.url` makes the answer identical under both. Verified that no
 * intermediate manifest between here and the root declares `workspaces`, so
 * the walk cannot stop early; if one ever does, the scan throws on a missing
 * `packages/` directory rather than quietly reporting an empty inventory.
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

/** file path → number of call sites in it. */
function inventory(root: string): Record<string, number> {
  const counts: Record<string, number> = {}
  for (const file of sourceFiles(root)) {
    const rel = relative(root, file).split(sep).join('/')
    const n = readFileSync(file, 'utf8').split('\n').filter(opensADatabase).length
    if (n > 0) counts[rel] = n
  }
  return counts
}

/**
 * The frozen inventory: every file that opens a database, how many times, and
 * what it does with a corruption refusal — the question the nine SMI-6931
 * reviews did not ask.
 */
const KNOWN_OPENERS: Readonly<Record<string, { sites: number; note: string }>> = {
  // --- The wrappers every other caller goes through ---
  // Both of open-database.ts's branches now rethrow untouched. SMI-6961 deleted
  // the read-write repair path — the substring matcher, the rename of the main
  // file, and the rebuild — which is why this count dropped by one: the repair
  // branch's own `createDatabaseAsync` is gone. No open window remains here.
  'packages/cli/src/utils/open-database.ts': {
    sites: 3,
    note: 'wrapper; both branches rethrow untouched',
  },
  'packages/core/src/db/createDatabase.ts': { sites: 2, note: 'factory; selects native or WASM' },
  'packages/core/src/db/schema.ts': { sites: 3, note: 'factory; legacy + async variants' },

  // --- CLI commands, all read-write through openCliDatabase ---
  // Each inherits the wrapper's behaviour; none handles the refusal itself.
  // SMI-6961's rethrow flipped this whole set from "rebuilt empty, command
  // proceeds" to "command aborts with the remedy" — uniformly, by owner
  // decision, including `search`, `info` and `remove`, which could each have
  // degraded to a remote or filesystem path instead. That is why the set is
  // enumerated here rather than summarised: the cost is per-command.
  'packages/cli/src/commands/audit-sources.action.ts': { sites: 1, note: 'read-write; wrapper' },
  'packages/cli/src/commands/audit.ts': { sites: 1, note: 'read-write; wrapper' },
  'packages/cli/src/commands/import-local.ts': { sites: 2, note: 'read-write; wrapper' },
  'packages/cli/src/commands/import.ts': { sites: 1, note: 'read-write; wrapper' },
  'packages/cli/src/commands/info.ts': { sites: 1, note: 'read-write; wrapper' },
  'packages/cli/src/commands/install.action.ts': { sites: 1, note: 'read-write; wrapper' },
  'packages/cli/src/commands/manage.action.ts': { sites: 1, note: 'read-write; wrapper' },
  'packages/cli/src/commands/manage.update.helpers.ts': { sites: 1, note: 'read-write; wrapper' },
  // `update` does not abort on a refusal the way every other command does: its
  // `getSkillDiff` call sits inside `updateSkillWithOutcome`'s try, whose catch
  // converts the refusal into a per-skill `failed` outcome and lets the loop
  // continue. On a corrupt database that means EVERY skill fails.
  //
  // `failed > 0` now sets `process.exitCode = 1` (SMI-6961 step 6), so the
  // condition is no longer invisible to a script. What remains is display only:
  // the catch prints `sanitizeError(error)` — the whole multi-line remedy —
  // once PER SKILL, so N installed skills produce N copies. Tracked as
  // SMI-6982, filed Low; it is cosmetic, not data loss and not a wrong exit.
  'packages/cli/src/commands/manage.update.ts': {
    sites: 1,
    note: 'read-write; per-skill failure, exits 1; remedy repeats (SMI-6982)',
  },
  'packages/cli/src/commands/registry-install.action.ts': { sites: 1, note: 'read-write; wrapper' },
  'packages/cli/src/commands/search.action.ts': { sites: 2, note: 'read-write; wrapper' },
  'packages/cli/src/commands/sync.action.ts': { sites: 2, note: 'read-write; wrapper' },
  'packages/cli/src/commands/sync.status-history.action.ts': {
    sites: 2,
    note: 'read-write; wrapper',
  },

  // --- The consumer SMI-6946 fixed ---
  'packages/cli/src/utils/skills-directory.ts': {
    sites: 1,
    note: 'READ-ONLY; classifies the refusal (ADR-175 § 5)',
  },

  // --- MCP server ---
  // Never had a destructive branch to converge — the refusal propagates to
  // startup. (It was confirmed to call neither of the two SMI-4484 helpers,
  // which no longer exist anywhere: SMI-6961 step 4 deleted them outright.)
  'packages/mcp-server/src/context.async.ts': {
    sites: 2,
    note: 'propagates; no destructive branch',
  },
  'packages/mcp-server/src/context.ts': { sites: 1, note: 'propagates; no destructive branch' },

  // --- Core internals, each owning its own database file, not skills.db ---
  'packages/core/src/analytics/storage.ts': { sites: 1, note: 'own analytics.db; propagates' },
  'packages/core/src/cache/sqlite.ts': { sites: 1, note: 'own L2 cache; propagates' },
  'packages/core/src/cache/TieredCache.ts': { sites: 1, note: 'own L2 cache; propagates' },
  'packages/core/src/embeddings/hnsw-store.ts': { sites: 1, note: 'own HNSW store; propagates' },
  'packages/core/src/embeddings/index.ts': { sites: 1, note: 'own store; propagates' },
  'packages/core/src/learning/PatternStore.ts': { sites: 1, note: 'own patterns db; propagates' },
  'packages/core/src/search/hybrid.ts': { sites: 1, note: 'own index; propagates' },
  'packages/core/src/benchmarks/IndexBenchmark.ts': { sites: 1, note: ':memory: only' },
  'packages/core/src/benchmarks/SearchBenchmark.ts': { sites: 1, note: ':memory: only' },
  'packages/core/src/scripts/import-to-database.ts': {
    sites: 1,
    note: 'maintenance script; propagates',
  },
  'packages/core/src/scripts/merge-skills.ts': { sites: 1, note: 'maintenance script; propagates' },
  'packages/core/src/scripts/review-lenny-skills.ts': {
    sites: 1,
    note: 'maintenance script; propagates',
  },
}

describe('the database-opening consumer inventory (ADR-175)', () => {
  const root = findRepoRoot()

  // --- Controls. The scan is the kind of instrument that answers rather than
  // --- failing when aimed wrongly, so both directions are pinned first.
  it('known-positive: the scan finds call sites that certainly exist', () => {
    const found = inventory(root)
    expect(found['packages/cli/src/utils/skills-directory.ts']).toBeGreaterThan(0)
    expect(found['packages/cli/src/utils/open-database.ts']).toBeGreaterThan(0)
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
    const unaccounted = Object.keys(inventory(root))
      .filter((f) => KNOWN_OPENERS[f] === undefined)
      .sort()

    // If you are reading this because it went red: a new file opens a
    // database. Answer the one question — when the driver refuses a corrupt
    // database, what does this caller do with the refusal? — then add it to
    // KNOWN_OPENERS with that answer. Do not delete this test to get green.
    expect(unaccounted).toEqual([])
  })

  it('has no stale entry for a file that no longer opens a database', () => {
    const found = inventory(root)
    const stale = Object.keys(KNOWN_OPENERS).filter((f) => found[f] === undefined)

    // The other direction, and the one that rots silently: an inventory
    // keeping entries for code that no longer exists reads as coverage it
    // does not give.
    expect(stale).toEqual([])
  })

  it('has no accounted file whose call-site count has changed', () => {
    const found = inventory(root)
    const drifted = Object.entries(KNOWN_OPENERS)
      .filter(([f, e]) => found[f] !== undefined && found[f] !== e.sites)
      .map(([f, e]) => `${f}: expected ${e.sites}, found ${String(found[f])}`)
      .sort()

    // This is the arm the file-set-only draft lacked. A second open added to
    // a file already marked "inherits wrapper" is a new destructive call site,
    // and without this it joins the tree silently.
    expect(drifted).toEqual([])
  })
})
