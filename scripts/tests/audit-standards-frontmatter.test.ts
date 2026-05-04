/**
 * SMI-4450 Wave 1 Step 5 — tests for the retro frontmatter lint pipeline.
 *
 * Covers three surfaces:
 *   1. `scripts/retrieval-log-cli.mjs` — arg validation, DB-missing no-op,
 *      IS_DOCKER no-op, successful INSERT.
 *   2. `scripts/lib/retro-frontmatter.mjs` — required/optional field
 *      validation, git-log first-commit-date pre-Wave-1 filter (CI-stable;
 *      mtime is unreliable across fresh clones), CI-aware memory-file
 *      existence check, spawn-per-record telemetry, --paths traversal guard.
 *   3. `scripts/audit-standards.mjs` — `--only`, `--paths`, unknown-check
 *      exit 2, `--warn` vs `--error` exit codes.
 *
 * Also the S6 divergence guard: runtime PRAGMA introspection on the
 * frontmatter_lint_events table vs the hardcoded expected column schema,
 * and a source-text check that FRONTMATTER_LINT_EVENTS_DDL is a substring
 * of SCHEMA_SQL.
 */

import { spawnSync } from 'node:child_process'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
  FRONTMATTER_LINT_EVENTS_DDL,
  SCHEMA_SQL,
} from '../../packages/doc-retrieval-mcp/src/retrieval-log/schema.js'
import { makeFixtureEnv, makeFixtureTempDir } from './_lib/git-fixture-env.js'

const REPO_ROOT = join(import.meta.dirname ?? __dirname, '..', '..')
const CLI = join(REPO_ROOT, 'scripts', 'retrieval-log-cli.mjs')
const AUDIT = join(REPO_ROOT, 'scripts', 'audit-standards.mjs')

/**
 * Drive the .mjs scripts with a scratch $HOME so the CLI resolves its DB
 * path under a disposable directory. Each test case rebuilds `$HOME` and
 * writes fixture retros.
 */
let scratch: string
let origHome: string | undefined
let origCwd: string
let fixtureRoot: string

beforeEach(() => {
  // SMI-4693: realpath-canonical tmpdir + sanitised env on every git spawn.
  scratch = makeFixtureTempDir('retro-frontmatter')
  origHome = process.env.HOME
  origCwd = process.cwd()
  process.env.HOME = scratch
  fixtureRoot = join(scratch, 'fixture-project')
  mkdirSync(join(fixtureRoot, 'docs', 'internal', 'retros'), { recursive: true })
  // Initialize a git repo so firstCommitDate() has something to query.
  const env = makeFixtureEnv()
  spawnSync('git', ['init', '-q'], { cwd: fixtureRoot, env })
  spawnSync('git', ['config', 'user.email', 'test@example.com'], { cwd: fixtureRoot, env })
  spawnSync('git', ['config', 'user.name', 'Test'], { cwd: fixtureRoot, env })
  spawnSync('git', ['config', 'commit.gpgsign', 'false'], { cwd: fixtureRoot, env })
})

afterEach(() => {
  process.chdir(origCwd)
  if (origHome === undefined) delete process.env.HOME
  else process.env.HOME = origHome
  rmSync(scratch, { recursive: true, force: true })
})

function writeRetro(filename: string, body: string, commitDateIso?: string): string {
  const full = join(fixtureRoot, 'docs', 'internal', 'retros', filename)
  writeFileSync(full, body)
  spawnSync('git', ['add', full], { cwd: fixtureRoot, env: makeFixtureEnv() })
  // SMI-4693: makeFixtureEnv strips GIT_DISCOVERY_VARS; layer extra GIT_*_DATE
  // overrides on top so the commit date control still works.
  const extra: Record<string, string> = {}
  if (commitDateIso) {
    extra.GIT_AUTHOR_DATE = commitDateIso
    extra.GIT_COMMITTER_DATE = commitDateIso
  }
  spawnSync('git', ['commit', '-q', '-m', `add ${filename}`], {
    cwd: fixtureRoot,
    env: makeFixtureEnv(extra),
  })
  return full
}

function runCli(args: string[], env: NodeJS.ProcessEnv = {}) {
  return spawnSync('node', [CLI, ...args], {
    encoding: 'utf8',
    env: { ...process.env, ...env },
    cwd: fixtureRoot,
  })
}

function runAudit(args: string[], env: NodeJS.ProcessEnv = {}) {
  return spawnSync('node', [AUDIT, '--only', 'retro-frontmatter', ...args], {
    encoding: 'utf8',
    env: { ...process.env, ...env },
    cwd: fixtureRoot,
  })
}

const VALID_BODY = `---
smi: SMI-4450
date: 2026-04-24
kind: retro
class: [sparc, testing]
reversal_of: []
---

# Real retro body.
`

describe('retrieval-log-cli.mjs — arg validation', () => {
  it('exits 2 on missing subcommand', () => {
    const r = runCli([])
    expect(r.status).toBe(2)
    expect(r.stderr).toContain('Unknown subcommand')
  })

  it('exits 2 on unknown subcommand', () => {
    const r = runCli(['bogus', 'complete', 'foo.md'])
    expect(r.status).toBe(2)
    expect(r.stderr).toContain('Unknown subcommand: bogus')
  })

  it('exits 2 on invalid outcome', () => {
    const r = runCli(['frontmatter-lint', 'bogus', 'foo.md'])
    expect(r.status).toBe(2)
    expect(r.stderr).toContain('Invalid outcome')
  })

  it('exits 2 on missing retro-path', () => {
    const r = runCli(['frontmatter-lint', 'complete'])
    expect(r.status).toBe(2)
    expect(r.stderr).toContain('retro-path is required')
  })

  it('no-ops (exit 0) when IS_DOCKER=true', () => {
    const r = runCli(['frontmatter-lint', 'complete', 'foo.md'], { IS_DOCKER: 'true' })
    expect(r.status).toBe(0)
    expect(r.stdout).toBe('')
    expect(r.stderr).toBe('')
  })

  it('no-ops (exit 0) when DB does not exist', () => {
    const r = runCli(['frontmatter-lint', 'complete', 'foo.md'])
    expect(r.status).toBe(0)
  })
})

describe('retrieval-log-cli.mjs — successful INSERT', () => {
  it('inserts a row when schema exists', async () => {
    const dbDir = join(scratch, 'logs')
    mkdirSync(dbDir, { recursive: true })
    process.env.RETRIEVAL_LOG_DIR_OVERRIDE = dbDir

    // Seed a DB with the real writer to avoid schema duplication.
    const { logFrontmatterLintEvent, closeRetrievalLog } =
      await import('../../packages/doc-retrieval-mcp/src/retrieval-log/writer.js')
    logFrontmatterLintEvent({
      ts: new Date().toISOString(),
      retroPath: '__bootstrap__',
      outcome: 'complete',
    })
    closeRetrievalLog()

    const r = runCli(['frontmatter-lint', 'complete', 'docs/internal/retros/foo.md'], {
      RETRIEVAL_LOG_DIR_OVERRIDE: dbDir,
    })
    expect(r.status).toBe(0)
    expect(r.stderr).not.toContain('insert failed')

    const require = createRequire(import.meta.url)
    const Database = require('better-sqlite3')
    const db = new Database(join(dbDir, 'retrieval-logs.db'))
    const rows = db.prepare('SELECT outcome, retro_path FROM frontmatter_lint_events').all()
    db.close()
    expect(rows).toContainEqual({
      outcome: 'complete',
      retro_path: 'docs/internal/retros/foo.md',
    })
  })
})

describe('retro-frontmatter lib — required field validation', () => {
  it('passes on a complete valid retro', () => {
    writeRetro('2026-04-25-smi-4451-t.md', VALID_BODY)
    const r = runAudit(['--error'])
    expect(r.stdout).toMatch(/frontmatter: .*2026-04-25-smi-4451-t\.md/)
    expect(r.stdout).toContain('✓')
    expect(r.status).toBe(0)
  })

  it('fails on missing frontmatter', () => {
    writeRetro('2026-04-25-smi-x-plain.md', '# No frontmatter here\n')
    const r = runAudit(['--error'])
    expect(r.stdout).toContain('no-frontmatter')
    expect(r.status).toBe(1)
  })

  it('fails on invalid SMI pattern', () => {
    writeRetro(
      '2026-04-25-smi-bad.md',
      '---\nsmi: NOT-A-SMI\ndate: 2026-04-25\nkind: retro\nclass: [testing]\n---\n# body\n'
    )
    const r = runAudit(['--error'])
    expect(r.stdout).toContain('smi:invalid')
    expect(r.status).toBe(1)
  })

  it('fails on wrong kind', () => {
    writeRetro(
      '2026-04-25-smi-4999-k.md',
      '---\nsmi: SMI-4999\ndate: 2026-04-25\nkind: feedback\nclass: [testing]\n---\n# body\n'
    )
    const r = runAudit(['--error'])
    expect(r.stdout).toContain('kind:invalid')
  })

  it('fails on unknown class tag', () => {
    writeRetro(
      '2026-04-25-smi-4999-c.md',
      '---\nsmi: SMI-4999\ndate: 2026-04-25\nkind: retro\nclass: [not_in_vocabulary]\n---\n# body\n'
    )
    const r = runAudit(['--error'])
    expect(r.stdout).toContain('class:not_in_vocabulary')
  })

  it('fails on class arity > 3', () => {
    writeRetro(
      '2026-04-25-smi-4999-a.md',
      '---\nsmi: SMI-4999\ndate: 2026-04-25\nkind: retro\nclass: [testing, mcp, sparc, ci]\n---\n# body\n'
    )
    const r = runAudit(['--error'])
    expect(r.stdout).toContain('class:arity')
  })
})

describe('retro-frontmatter lib — optional field validation', () => {
  it('rejects reversal_of basename with invalid chars', () => {
    writeRetro(
      '2026-04-25-smi-4999-r.md',
      '---\nsmi: SMI-4999\ndate: 2026-04-25\nkind: retro\nclass: [testing]\nreversal_of: ["Invalid With Spaces"]\n---\n# body\n'
    )
    const r = runAudit(['--error'])
    expect(r.stdout).toContain('reversal_of:')
  })

  it('format-validates originates but skips existence on CI', () => {
    writeRetro(
      '2026-04-25-smi-4999-o.md',
      '---\nsmi: SMI-4999\ndate: 2026-04-25\nkind: retro\nclass: [testing]\noriginates: feedback_does_not_exist_locally\n---\n# body\n'
    )
    const r = runAudit(['--error'], { CI: 'true' })
    expect(r.status).toBe(0)
  })

  it('rejects ground_truth_query shorter than 8 chars', () => {
    writeRetro(
      '2026-04-25-smi-4999-g.md',
      '---\nsmi: SMI-4999\ndate: 2026-04-25\nkind: retro\nclass: [testing]\nground_truth_query: short\n---\n# body\n'
    )
    const r = runAudit(['--error'])
    expect(r.stdout).toContain('ground_truth_query:length')
  })
})

describe('retro-frontmatter lib — pre-Wave-1 filter', () => {
  it('skips retros with first-commit-date before 2026-04-24', () => {
    writeRetro('2026-03-01-old.md', '# old retro no frontmatter\n', '2026-03-01T00:00:00Z')
    const r = runAudit(['--error'])
    expect(r.stdout).not.toContain('2026-03-01-old.md')
    expect(r.status).toBe(0)
  })

  it('scans retros with first-commit-date on or after 2026-04-24', () => {
    writeRetro('2026-04-25-new.md', '# no frontmatter\n', '2026-04-25T00:00:00Z')
    const r = runAudit(['--error'])
    expect(r.stdout).toContain('2026-04-25-new.md')
    expect(r.stdout).toContain('no-frontmatter')
    expect(r.status).toBe(1)
  })
})

describe('audit-standards.mjs — --only dispatch', () => {
  it('exits 2 on unknown check name', () => {
    const r = spawnSync('node', [AUDIT, '--only', 'does-not-exist'], {
      encoding: 'utf8',
      cwd: fixtureRoot,
    })
    expect(r.status).toBe(2)
    expect(r.stderr).toContain('Unknown check: does-not-exist')
    expect(r.stderr).toContain('Valid: retro-frontmatter')
  })

  it('returns 0 in --warn mode even when failures present', () => {
    writeRetro('2026-04-25-smi-warn.md', '# no frontmatter\n', '2026-04-25T00:00:00Z')
    const r = runAudit(['--warn'])
    expect(r.stdout).toContain('⚠')
    expect(r.status).toBe(0)
  })

  it('returns 1 in --error mode when failures present', () => {
    writeRetro('2026-04-25-smi-err.md', '# no frontmatter\n', '2026-04-25T00:00:00Z')
    const r = runAudit(['--error'])
    expect(r.stdout).toContain('✗')
    expect(r.status).toBe(1)
  })

  it('--paths scopes the scan', () => {
    writeRetro('2026-04-25-smi-a.md', '# no frontmatter a\n', '2026-04-25T00:00:00Z')
    writeRetro('2026-04-25-smi-b.md', '# no frontmatter b\n', '2026-04-25T00:00:00Z')
    const r = runAudit(['--error', '--paths', 'docs/internal/retros/2026-04-25-smi-a.md'])
    expect(r.stdout).toContain('2026-04-25-smi-a.md')
    expect(r.stdout).not.toContain('2026-04-25-smi-b.md')
    expect(r.status).toBe(1)
  })

  it('rejects --paths entries outside docs/internal/retros/ (traversal guard)', () => {
    const r = runAudit(['--error', '--paths', '../../../etc/passwd,docs/internal/retros/../foo.md'])
    expect(r.stdout + r.stderr).toContain('retro path rejected')
    // No frontmatter findings (both rejected before validation).
    expect(r.stdout).not.toContain('frontmatter:')
    expect(r.status).toBe(0)
  })

  it('reads RETRO_FRONTMATTER_MODE env (warn overrides default error)', () => {
    writeRetro('2026-04-25-smi-env.md', '# no frontmatter\n', '2026-04-25T00:00:00Z')
    const r = runAudit([], { RETRO_FRONTMATTER_MODE: 'warn' })
    expect(r.stdout).toContain('⚠')
    expect(r.status).toBe(0)
  })
})

describe('S6 divergence guard — runtime schema introspection', () => {
  it('FRONTMATTER_LINT_EVENTS_DDL is a substring of SCHEMA_SQL', () => {
    // Normalize both for whitespace/trailing-semicolon tolerance: compare the
    // CREATE TABLE body (ignoring the final semicolon which SCHEMA_SQL also
    // has).
    expect(SCHEMA_SQL.replace(/\s+/g, ' ')).toContain(
      FRONTMATTER_LINT_EVENTS_DDL.replace(/;?\s*$/, '').replace(/\s+/g, ' ')
    )
  })

  it('runtime PRAGMA introspection matches expected columns', async () => {
    const dbDir = join(scratch, 'logs-pragma')
    mkdirSync(dbDir, { recursive: true })
    process.env.RETRIEVAL_LOG_DIR_OVERRIDE = dbDir

    const { logFrontmatterLintEvent, closeRetrievalLog } =
      await import('../../packages/doc-retrieval-mcp/src/retrieval-log/writer.js')
    logFrontmatterLintEvent({
      ts: new Date().toISOString(),
      retroPath: '__bootstrap__',
      outcome: 'complete',
    })
    closeRetrievalLog()

    const require = createRequire(import.meta.url)
    const Database = require('better-sqlite3')
    const db = new Database(join(dbDir, 'retrieval-logs.db'))
    const cols = db.prepare('PRAGMA table_info(frontmatter_lint_events)').all() as Array<{
      name: string
      type: string
      notnull: number
      pk: number
    }>
    db.close()

    expect(cols.map((c) => c.name)).toEqual(['id', 'ts', 'retro_path', 'outcome'])
    expect(cols.find((c) => c.name === 'id')?.pk).toBe(1)
    expect(cols.find((c) => c.name === 'ts')?.notnull).toBe(1)
    expect(cols.find((c) => c.name === 'retro_path')?.notnull).toBe(1)
    expect(cols.find((c) => c.name === 'outcome')?.notnull).toBe(1)
  })
})
