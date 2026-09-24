/**
 * scripts/tests/ruflo-acceptance-tools.test.ts -- SMI-6744 A1.8, cross-family
 * gate finding PR-16 on PR #2931.
 *
 * Host-runnable vitest coverage for two of the three scripts/ruflo-acceptance/
 * tools the live-only harness (scripts/ruflo-acceptance/run.sh) exercises
 * only against a real Compose service: compare.mjs's § 2 arm-3 zero-canary
 * guard (P0a) and lib/jqlite.mjs's absent-field guard need no Docker at all,
 * so they run here, on the host, every time. store-reader.mjs's
 * backup-failure arm needs a real SQLite native binding (better-sqlite3) --
 * it SKIPS cleanly, printing why, wherever that binding is not loadable,
 * the same convention scripts/tests/ruflo-launch-guard.test.ts uses for its
 * own non-Linux skip (a non-skipped canary test always reports at least one
 * PASS naming why the rest skipped, never a silent all-skip).
 *
 * Every arm asserts on BOTH the process's exit code AND its output content
 * -- never one alone (CLAUDE.md: "a checkable claim about behaviour gets
 * executed ... in the actual runtime", and this repo's own recurring lesson
 * that a check watching only one signal misses the other's defect class).
 *
 * The store-reader.mjs arm's "red arm" is a MUTANT copy of the real script
 * (a scratch copy under the OS tmpdir, never touching the committed file),
 * generated at test time by wrapping the real script's own "steps 3 and 4 /
 * step 5" source lines (located by an exact two-line marker match, not a
 * hand-retyped duplicate) in a try/catch that falls back to querying the
 * LIVE database directly when the safe online-backup path fails -- the
 * exact defect class CLAUDE.md's "a fix for a race/lock-shaped bug needs
 * its own confirmation review" and "watching it fail is necessary" rules
 * describe. It must WRONGLY succeed (exit 0, row content leaked) against
 * the identical directory-collision fixture the real script correctly
 * refuses on, proving the real script's arm is a meaningful pin and not a
 * vacuous one (CLAUDE.md's "a regression test you have not run against the
 * unfixed code is unverified").
 */
import { describe, expect, it } from 'vitest'
import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO_ROOT = fileURLToPath(new URL('../..', import.meta.url))
const COMPARE_PATH = join(REPO_ROOT, 'scripts/ruflo-acceptance/compare.mjs')
const STORE_READER_PATH = join(REPO_ROOT, 'scripts/ruflo-acceptance/store-reader.mjs')
const JQLITE_PATH = join(REPO_ROOT, 'scripts/ruflo-acceptance/lib/jqlite.mjs')

// ---- better-sqlite3 loadability (host-portable; mirrors ruflo-launch-guard
// .test.ts's isLinux skip convention, but for a native-binding precondition
// instead of a platform one). A `require` alone would pass for a JS wrapper
// whose native .node addon is missing or ABI-mismatched -- CLAUDE.md's "a
// direct test of the property" over an inference -- so this actually opens
// an in-memory database, the same live check this repo's own Troubleshooting
// table uses to tell a real ABI break from a merely-unloaded module.
function findSqliteModule(): string | null {
  const candidate = join(REPO_ROOT, 'node_modules/better-sqlite3/lib/index.js')
  if (!existsSync(candidate)) return null
  try {
    execFileSync('node', [
      '-e',
      `const D = require(${JSON.stringify(candidate)}); const db = new D(':memory:'); db.exec('CREATE TABLE t(id INTEGER)'); db.close();`,
    ])
    return candidate
  } catch {
    return null
  }
}
const SQLITE_MODULE = findSqliteModule()
const sqliteSkipReason = SQLITE_MODULE
  ? ''
  : 'skipped: no loadable better-sqlite3 native binding under node_modules/better-sqlite3 on this host'

function scratchDir(): string {
  return mkdtempSync(join(tmpdir(), 'ruflo-acceptance-tools-test-'))
}

function writeJson(dir: string, name: string, data: unknown): string {
  const p = join(dir, name)
  writeFileSync(p, JSON.stringify(data))
  return p
}

describe('compare.mjs (PR-16: § 2 arm-3 zero-canary guard, P0a)', () => {
  it('exits 3 and names P0a when probe.canaries is an empty array', () => {
    const dir = scratchDir()
    try {
      const probe = writeJson(dir, 'probe.json', { outcome: 'ok', canaries: [], responses: [] })
      const reader = writeJson(dir, 'reader.json', {
        rows: {},
        table: 'memory_entries',
        namespace: 'a14-accept',
        walSizeBytes: null,
        mainFileOnly: {},
      })
      const recompute = writeJson(dir, 'recompute.json', {
        where: 'container',
        transformersVersion: '1.0.0',
        vectors: {},
      })
      const r = spawnSync(
        'node',
        [
          COMPARE_PATH,
          '--probe',
          probe,
          '--reader',
          reader,
          '--recompute',
          recompute,
          '--label',
          'empty',
        ],
        { encoding: 'utf8' }
      )
      expect(r.status, `stdout: ${r.stdout}\nstderr: ${r.stderr}`).toBe(3)
      expect(r.stdout).toContain('P0a')
      expect(r.stdout).toContain('FAILED')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('exits 0 on a minimal valid single-canary fixture (every predicate holds)', () => {
    const dir = scratchDir()
    try {
      // returned == persisted == recomputed, byte-for-byte, so P1/P2/P3 all
      // hold on the same literal array; the mutant embedding differs so P8
      // freshness holds too (CLAUDE.md: assert the property, not a value a
      // correct implementation happens to emit -- these three predicates are
      // exercised as EQUALITY, not merely "all present").
      const embedding = [0.1, 0.2, 0.3]
      const mutantEmbedding = [0.9, 0.8, 0.7]
      const probe = writeJson(dir, 'probe.json', {
        outcome: 'ok',
        canaries: [{ c: 'canary1', f: 'canary1-mutant' }],
        responses: [
          { label: 'generate:canary1', parsed: { embedding, metadata: {} } },
          {
            label: 'generate:canary1-mutant',
            parsed: { embedding: mutantEmbedding, metadata: {} },
          },
        ],
      })
      const reader = writeJson(dir, 'reader.json', {
        table: 'memory_entries',
        namespace: 'a14-accept',
        walSizeBytes: null,
        mainFileOnly: { canary1: { rowCount: 1 } },
        rows: {
          canary1: {
            rowCount: 1,
            id: 'id-1',
            embeddingModel: 'model-x',
            embeddingDimensions: 3,
            embedding,
            rowsWithThisKeyAnyNamespace: 1,
            rowsWithThisContentAnyNamespace: 1,
            rowsWithThisContent: [],
          },
        },
      })
      const recompute = writeJson(dir, 'recompute.json', {
        where: 'container',
        transformersVersion: '1.0.0',
        vectors: { canary1: embedding },
      })
      const r = spawnSync(
        'node',
        [
          COMPARE_PATH,
          '--probe',
          probe,
          '--reader',
          reader,
          '--recompute',
          recompute,
          '--label',
          'minimal',
        ],
        { encoding: 'utf8' }
      )
      expect(r.status, `stdout: ${r.stdout}\nstderr: ${r.stderr}`).toBe(0)
      expect(r.stdout).toContain('RESULT minimal: pass (0 failed predicates)')
      expect(r.stdout).not.toContain('FAILED')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('lib/jqlite.mjs (PR-16: absent-field guard)', () => {
  it('exits 3 when the requested dotted field is absent', () => {
    const dir = scratchDir()
    try {
      const file = writeJson(dir, 'data.json', { a: 1 })
      const r = spawnSync('node', [JQLITE_PATH, file, 'field', 'nonexistent'], { encoding: 'utf8' })
      expect(r.status, `stdout: ${r.stdout}\nstderr: ${r.stderr}`).toBe(3)
      expect(r.stderr).toContain('is absent')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

// M-5 (post-merge governance retro, PR #2931): run.sh:158 used to
// `exit 0` whenever ARMS_FAILED=0 and MUT_SURVIVED=0, with no check that
// anything actually ran -- ARMS_TOTAL was counted and printed but never
// gated, so a run that evaluated NOTHING (e.g. every selector flag happened
// to select zero sections) reported the identical bare exit 0 as a real
// pass. acceptance_exit_code() (lib/common.sh) is the fix; this suite
// drives it by spawning bash and sourcing common.sh directly, per this
// finding's own instruction not to re-create the H-4 gap with a new
// standalone .test.sh file for one function.
describe('lib/common.sh acceptance_exit_code() (M-5, post-merge governance retro on PR #2931)', () => {
  const COMMON_SH_PATH = join(REPO_ROOT, 'scripts', 'ruflo-acceptance', 'lib', 'common.sh')

  function runAcceptanceExitCode(total: string, failed: string, killed: string, survived: string) {
    return spawnSync(
      'bash',
      [
        '-c',
        'source "$1"; acceptance_exit_code "$2" "$3" "$4" "$5"; echo "exit=$?"',
        '_',
        COMMON_SH_PATH,
        total,
        failed,
        killed,
        survived,
      ],
      { encoding: 'utf8' }
    )
  }

  it('REFUSES (prints to stderr, exit 4) when nothing ran at all', () => {
    const r = runAcceptanceExitCode('0', '0', '0', '0')
    expect(r.stdout, `stderr: ${r.stderr}`).toContain('exit=4')
    expect(r.stderr).toContain('REFUSING: no predicate or mutation ran -- this is not a pass')
  })

  it('exits 3 when at least one predicate FAILED, even though arms_total > 0', () => {
    const r = runAcceptanceExitCode('5', '1', '0', '0')
    expect(r.stdout, `stderr: ${r.stderr}`).toContain('exit=3')
    expect(r.stderr).not.toContain('REFUSING')
  })

  it('exits 3 when at least one mutation SURVIVED, even with zero predicate failures', () => {
    const r = runAcceptanceExitCode('0', '0', '2', '1')
    expect(r.stdout, `stderr: ${r.stderr}`).toContain('exit=3')
  })

  it('exits 0 when predicates ran and all HELD, with mutations KILLED', () => {
    const r = runAcceptanceExitCode('4', '0', '2', '0')
    expect(r.stdout, `stderr: ${r.stderr}`).toContain('exit=0')
  })

  it('exits 0 when only mutations ran (arms_total=0, a --mutations-only invocation) and all were KILLED', () => {
    const r = runAcceptanceExitCode('0', '0', '3', '0')
    expect(r.stdout, `stderr: ${r.stderr}`).toContain('exit=0')
  })
})

describe(`store-reader.mjs (PR-16: backup-failure must not fall back to a live read) ${sqliteSkipReason}`, () => {
  const SCHEMA = `CREATE TABLE memory_entries (
    id TEXT PRIMARY KEY,
    key TEXT,
    namespace TEXT,
    content TEXT,
    embedding TEXT,
    embedding_model TEXT,
    embedding_dimensions INTEGER
  )`
  const SECRET_CONTENT = 'SECRET LIVE ROW CONTENT -- must never appear on a backup-failure path'

  // seedDb <dir> -- a scratch SQLite db carrying exactly the served schema
  // subset store-reader.mjs's own queries name (read directly from the file
  // before writing this: SELECT ... FROM memory_entries WHERE namespace = ?
  // AND key = ?, columns id/key/namespace/content/embedding/embedding_model/
  // embedding_dimensions), with one row.
  function seedDb(dir: string): string {
    const dbPath = join(dir, 'live.db')
    execFileSync('node', [
      '-e',
      `
      const Database = require(${JSON.stringify(SQLITE_MODULE)})
      const db = new Database(process.argv[1])
      db.exec(${JSON.stringify(SCHEMA)})
      db.prepare(
        'INSERT INTO memory_entries (id, key, namespace, content, embedding, embedding_model, embedding_dimensions) VALUES (?, ?, ?, ?, ?, ?, ?)'
      ).run('row-1', 'ck1', 'ns1', ${JSON.stringify(SECRET_CONTENT)}, JSON.stringify([0.1, 0.2, 0.3]), 'model-x', 3)
      db.close()
      `,
      dbPath,
    ])
    return dbPath
  }

  // runStoreReader <scriptPath> <dbPath> <scratchDirForReader> -- store-reader
  // .mjs's OWN backup destination is `<--scratch>/snapshot.db`; pre-creating
  // that exact path AS A DIRECTORY (not a file) makes its write fail while
  // leaving the scratch dir itself, and the main-file-only step's own
  // location, fully writable -- CLAUDE.md's "a path inside a read-only
  // directory, or a directory path" as the two sanctioned ways to make a
  // destination unwritable; this test uses the second, since the first would
  // also block the EARLIER main-file-only copy for an unrelated reason and
  // no longer isolate the backup step specifically.
  function runStoreReader(scriptPath: string, dbPath: string, readerScratch: string) {
    mkdirSync(readerScratch, { recursive: true })
    mkdirSync(join(readerScratch, 'snapshot.db'), { recursive: true })
    const outPath = join(readerScratch, 'out.json')
    const r = spawnSync(
      'node',
      [
        scriptPath,
        '--db',
        dbPath,
        '--table',
        'memory_entries',
        '--ns',
        'ns1',
        '--key',
        'ck1',
        '--out',
        outPath,
        '--scratch',
        readerScratch,
      ],
      { encoding: 'utf8', env: { ...process.env, RUFLO_SQLITE_MODULE: SQLITE_MODULE ?? '' } }
    )
    return { ...r, outPath }
  }

  // mutateToFallbackOnBackupFailure -- generates the scratch mutant copy
  // described in this file's own header. Locates the real script's "steps 3
  // and 4" section by an exact two-line marker match (not a hand-retyped
  // duplicate of its body), so a future edit to store-reader.mjs that moves
  // or renames this section makes the marker lookup below throw loudly
  // rather than silently mutating nothing (the same drift-guard discipline
  // scripts/tests/ruflo-service-entrypoint.test.sh's mutate_prefix_compare
  // uses for its own exact-line match).
  function mutateToFallbackOnBackupFailure(destDir: string): string {
    const src = readFileSync(STORE_READER_PATH, 'utf8')
    const lines = src.split('\n')
    const startMarker =
      '// ---- steps 3 and 4: read transaction + online backup ------------------------'
    const endMarker = 'fs.writeFileSync(opt.out, `${JSON.stringify(ev, null, 2)}\\n`)'
    const startIdx = lines.indexOf(startMarker)
    const endIdx = lines.indexOf(endMarker)
    if (startIdx === -1 || endIdx === -1) {
      throw new Error(
        `mutateToFallbackOnBackupFailure: marker(s) not found in ${STORE_READER_PATH} (startIdx=${startIdx} endIdx=${endIdx}) -- store-reader.mjs's own source drifted out from under this red arm; update the markers before trusting it`
      )
    }
    const before = lines.slice(0, startIdx)
    const body = lines.slice(startIdx, endIdx)
    const after = lines.slice(endIdx)
    // The mutation: wrap the real backup-and-read-from-backup logic in a
    // try/catch, and on ANY failure in it (including the directory-collision
    // this test's fixture creates), fall back to querying the LIVE,
    // unmutated database connection directly -- the exact defect class this
    // file's own header describes, and the one the real script's design
    // (an independent reader that "joins the WAL locking protocol rather
    // than reading around it") exists to rule out.
    const fallback = [
      'try {',
      ...body.map((l) => `  ${l}`),
      '} catch (mutantErr) {',
      '  ev.errors.push(`MUTANT fallback engaged after: ${mutantErr.message}`)',
      '  const live = new Database(opt.db, { readonly: true })',
      '  for (const key of opt.keys) {',
      '    const rows = live',
      '      .prepare(`SELECT id, key, namespace, content, embedding, embedding_model, embedding_dimensions FROM ${opt.table} WHERE namespace = ? AND key = ?`)',
      '      .all(opt.ns, key)',
      '    if (rows.length === 1) {',
      '      ev.rows[key] = {',
      '        rowCount: rows.length,',
      '        id: rows[0].id,',
      '        content: rows[0].content,',
      '        embeddingModel: rows[0].embedding_model,',
      '        embeddingDimensions: rows[0].embedding_dimensions,',
      '        embedding: JSON.parse(rows[0].embedding),',
      '        embeddingParseError: null,',
      '        rowsWithThisKeyAnyNamespace: 1,',
      '        rowsWithThisContentAnyNamespace: 1,',
      '        rowsWithThisContent: [],',
      '      }',
      '    }',
      '  }',
      '  live.close()',
      '}',
    ]
    const mutantSrc = [...before, ...fallback, ...after].join('\n')
    const mutantPath = join(destDir, 'store-reader-mutant.mjs')
    writeFileSync(mutantPath, mutantSrc)
    return mutantPath
  }

  it.skipIf(!SQLITE_MODULE)(
    `a backup destination that cannot be written exits non-zero and never prints row data (${sqliteSkipReason})`,
    () => {
      const dir = scratchDir()
      try {
        const dbPath = seedDb(dir)
        const readerScratch = join(dir, 'reader-scratch')
        const r = runStoreReader(STORE_READER_PATH, dbPath, readerScratch)
        expect(r.status, `stdout: ${r.stdout}\nstderr: ${r.stderr}`).not.toBe(0)
        // Never printed row data: no output file, no "store-reader ok" line,
        // and the secret content is absent from EVERY stream this process
        // could have written it to -- three independent checks of the same
        // "never printed row data" claim, not one proxy for it.
        expect(existsSync(r.outPath), 'the --out JSON file must not have been written').toBe(false)
        expect(r.stdout).not.toContain('store-reader ok')
        expect(r.stdout).not.toContain(SECRET_CONTENT)
        expect(r.stderr).not.toContain(SECRET_CONTENT)
      } finally {
        rmSync(dir, { recursive: true, force: true })
      }
    }
  )

  it.skipIf(!SQLITE_MODULE)(
    `red arm: a mutant that falls back to a live read on backup failure wrongly succeeds and leaks row content (${sqliteSkipReason})`,
    () => {
      const dir = scratchDir()
      try {
        const dbPath = seedDb(dir)
        const mutantPath = mutateToFallbackOnBackupFailure(dir)
        execFileSync('node', ['--check', mutantPath]) // the splice itself must be valid JS before trusting its output
        const readerScratch = join(dir, 'reader-scratch-mutant')
        const r = runStoreReader(mutantPath, dbPath, readerScratch)
        expect(r.status, `stdout: ${r.stdout}\nstderr: ${r.stderr}`).toBe(0)
        expect(existsSync(r.outPath), 'the mutant must have written its --out JSON file').toBe(true)
        const written = JSON.parse(readFileSync(r.outPath, 'utf8'))
        expect(written.rows?.ck1?.content, JSON.stringify(written)).toBe(SECRET_CONTENT)
        expect(r.stdout).toContain('store-reader ok')
      } finally {
        rmSync(dir, { recursive: true, force: true })
      }
    }
  )

  if (!SQLITE_MODULE) {
    it(`prints its skip reason (${sqliteSkipReason})`, () => {
      expect(sqliteSkipReason).toContain('better-sqlite3')
    })
  }
})
