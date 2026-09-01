/**
 * Shared live-Postgres primitives for two-session concurrency suites.
 *
 * WHY A SHARED MODULE. `purge-departed-toctou.test-helpers.ts` (SMI-6321) introduced the
 * persistent-psql-session harness this repo now uses for every "prove a lock" test: the
 * property under test is what one session can observe while another is mid-transaction,
 * and to a lone session a locked read and an unlocked read are indistinguishable. The
 * SMI-6345 device-lock suite needs exactly the same primitives against a different
 * schema, so they live here rather than being copied — a copy would drift, and the whole
 * point of {@link extractLatestFunction} is that these suites execute the SHIPPED
 * function bodies rather than a stale transcription of them.
 *
 * This module deliberately contains NO connection/env logic and NO module-level side
 * effects: each suite owns its own env-var namespace and its own skip warning, so
 * importing one suite's helpers never emits another suite's diagnostics.
 *
 * @module scripts/tests/supabase/pg-session
 */

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

export interface TestConn {
  host: string
  port: string
  user: string
  password: string
  database: string
}

/**
 * A persistent `psql` process, so a transaction can be held OPEN across awaits while
 * another session runs against it. Per-call helpers that spawn a fresh psql cannot
 * express that, and an interleaving is the entire point.
 *
 * The completion sentinel is `\echo`, a psql meta-command, NOT `SELECT '<mark>'`:
 * inside a transaction that a prior statement aborted, every subsequent SELECT fails
 * with 25P02 and the mark would never arrive, hanging the read. `\echo` prints
 * regardless of transaction state, so an errored statement still returns control —
 * which matters because these suites deliberately provoke errors.
 */
export class PsqlSession {
  private readonly proc: ChildProcessWithoutNullStreams
  private out = ''
  private err = ''
  private seq = 0
  private exited = false

  constructor(
    conn: TestConn,
    readonly name: string
  ) {
    this.proc = spawn(
      'psql',
      [
        '-X',
        '-q',
        '-A',
        '-t',
        '-h',
        conn.host,
        '-p',
        conn.port,
        '-U',
        conn.user,
        '-d',
        conn.database,
      ],
      { env: { ...process.env, PGPASSWORD: conn.password }, stdio: ['pipe', 'pipe', 'pipe'] }
    )
    this.proc.stdout.setEncoding('utf8')
    this.proc.stderr.setEncoding('utf8')
    this.proc.stdout.on('data', (d: string) => (this.out += d))
    this.proc.stderr.on('data', (d: string) => (this.err += d))
    this.proc.on('exit', () => (this.exited = true))
  }

  /**
   * Run `sql` and resolve with `{ stdout, stderr }` once psql reports back.
   * Rejects on timeout — a hang here means a lock wait that never resolved, which is
   * itself a finding, so it must never be swallowed.
   */
  async send(sql: string, timeoutMs = 30_000): Promise<{ stdout: string; stderr: string }> {
    if (this.exited) throw new Error(`[${this.name}] psql session already exited`)
    const mark = `__PGSESSION_MARK_${++this.seq}__`
    this.out = ''
    this.err = ''
    this.proc.stdin.write(`${sql}\n\\echo ${mark}\n`)

    const deadline = Date.now() + timeoutMs
    for (;;) {
      if (this.out.includes(mark) || this.err.includes(mark)) {
        return {
          stdout: this.out.replace(mark, '').trim(),
          stderr: this.err.replace(mark, '').trim(),
        }
      }
      if (this.exited) throw new Error(`[${this.name}] psql exited early: ${this.err}`)
      if (Date.now() > deadline) {
        throw new Error(
          `[${this.name}] timed out after ${timeoutMs}ms running:\n${sql}\n` +
            `stdout so far: ${this.out}\nstderr so far: ${this.err}`
        )
      }
      await new Promise((r) => setTimeout(r, 20))
    }
  }

  /** Fire `sql` WITHOUT awaiting it, so the caller can interleave another session. */
  fire(sql: string, timeoutMs = 30_000): Promise<{ stdout: string; stderr: string }> {
    return this.send(sql, timeoutMs)
  }

  async close(): Promise<void> {
    if (this.exited) return
    this.proc.stdin.end('\\q\n')
    await new Promise((r) => setTimeout(r, 100))
    if (!this.exited) this.proc.kill('SIGKILL')
  }
}

/**
 * Pull one `CREATE OR REPLACE FUNCTION <name>(...) ... $tag$;` block verbatim out of a
 * migration file, so a suite executes the SHIPPED body rather than a copy that can
 * silently drift from it.
 *
 * NOTE: `supabase/migrations/` is git-crypt encrypted. In a normal unlocked checkout
 * these files are plaintext; in an environment where they are still ciphertext this
 * throws with a clear message rather than executing garbage — but that environment
 * also has no live Postgres configured, so the suite has already skipped.
 */
export function extractFunction(
  migrationFile: string,
  functionName: string,
  label = 'live-pg harness'
): string {
  const path = join(process.cwd(), 'supabase/migrations', migrationFile)
  return extractFunctionFromFile(path, functionName, migrationFile, label)
}

/**
 * Resolve the LATEST migration that defines `functionName` and extract it from there.
 *
 * Pinning a filename would make a suite test a body production no longer runs: a future
 * migration replacing the function would leave the tests happily exercising the old,
 * correct copy and passing, which is worse than no coverage. Migration names are
 * timestamp-prefixed and lexically sortable, so "last one that defines it" is the
 * deployed one.
 */
export function extractLatestFunction(functionName: string, label = 'live-pg harness'): string {
  const dir = join(process.cwd(), 'supabase/migrations')
  const defining = readdirSync(dir)
    .filter((f) => f.endsWith('.sql') && !f.endsWith('.disabled'))
    .sort()
    .filter((f) => {
      const body = readFileSync(join(dir, f), 'utf8')
      return !body.includes('\u0000') && body.includes(`CREATE OR REPLACE FUNCTION ${functionName}`)
    })
  const latest = defining.at(-1)
  if (!latest) {
    throw new Error(
      `${label}: no migration in supabase/migrations defines ${functionName}. If the repo is ` +
        `git-crypt locked these files are ciphertext — unlock it (see CLAUDE.md § Git-Crypt).`
    )
  }
  return extractFunctionFromFile(join(dir, latest), functionName, latest, label)
}

function extractFunctionFromFile(
  path: string,
  functionName: string,
  migrationFile: string,
  label: string
): string {
  const src = readFileSync(path, 'utf8')
  assertPlaintext(src, migrationFile, label)

  const startRe = new RegExp(`CREATE OR REPLACE FUNCTION ${functionName}\\s*\\(`, 'g')
  const start = startRe.exec(src)
  if (!start) {
    throw new Error(`${label}: ${functionName} not found in ${migrationFile}`)
  }
  // The body delimiter is whatever dollar-quote tag opens after the AS keyword.
  const afterAs = src.slice(start.index)
  const tagMatch = /\bAS\s+(\$[A-Za-z0-9_]*\$)/.exec(afterAs)
  if (!tagMatch) {
    throw new Error(`${label}: could not find the body delimiter for ${functionName}`)
  }
  const tag = tagMatch[1]
  const bodyOpen = afterAs.indexOf(tag, tagMatch.index)
  const bodyClose = afterAs.indexOf(tag, bodyOpen + tag.length)
  if (bodyClose === -1) {
    throw new Error(`${label}: unterminated ${tag} body for ${functionName}`)
  }
  const end = afterAs.indexOf(';', bodyClose + tag.length)
  return afterAs.slice(0, end + 1)
}

/**
 * Pull one plain DDL statement (no dollar-quoted body) verbatim out of a migration,
 * starting at the first match of `startPattern` and ending at its terminating `;`.
 *
 * Paren-aware, string-aware and comment-aware, so `CHECK (...)` clauses, string
 * literals, and `--` comments containing apostrophes or parentheses do not end the
 * statement early or unbalance the scan. Used to build a test schema whose CONSTRAINTS
 * are the shipped ones: a hand-transcribed CHECK would let a migration tighten or
 * loosen a constraint without any test noticing, which is precisely the drift
 * {@link extractLatestFunction} exists to prevent for function bodies.
 *
 * The scan runs over a MASKED copy (comment bodies and string contents blanked out) and
 * the slice is taken from the ORIGINAL, so the returned SQL is verbatim including its
 * comments.
 */
export function extractStatement(
  migrationFile: string,
  startPattern: RegExp,
  label = 'live-pg harness'
): string {
  const path = join(process.cwd(), 'supabase/migrations', migrationFile)
  const src = readFileSync(path, 'utf8')
  assertPlaintext(src, migrationFile, label)

  const start = startPattern.exec(src)
  if (!start) {
    throw new Error(`${label}: ${startPattern} not found in ${migrationFile}`)
  }

  const masked = maskCommentsAndStrings(src)
  let depth = 0
  for (let i = start.index; i < masked.length; i++) {
    const ch = masked[i]
    if (ch === '(') depth++
    else if (ch === ')') depth--
    else if (ch === ';' && depth === 0) return src.slice(start.index, i + 1)
  }
  throw new Error(`${label}: unterminated statement for ${startPattern} in ${migrationFile}`)
}

/**
 * Replace the contents of `--` line comments and `'...'` string literals with spaces,
 * preserving length and newlines so indices still map onto the original text.
 */
function maskCommentsAndStrings(src: string): string {
  const out = src.split('')
  let i = 0
  while (i < src.length) {
    if (src[i] === '-' && src[i + 1] === '-') {
      while (i < src.length && src[i] !== '\n') out[i++] = ' '
    } else if (src[i] === "'") {
      out[i++] = ' '
      while (i < src.length) {
        // '' is an escaped quote inside a literal, not a terminator.
        if (src[i] === "'" && src[i + 1] === "'") {
          out[i++] = ' '
          out[i++] = ' '
          continue
        }
        const done = src[i] === "'"
        out[i] = src[i] === '\n' ? '\n' : ' '
        i++
        if (done) break
      }
    } else {
      i++
    }
  }
  return out.join('')
}

function assertPlaintext(src: string, migrationFile: string, label: string): void {
  if (src.includes('\u0000')) {
    throw new Error(
      `${label}: ${migrationFile} appears to be git-crypt ciphertext, not SQL. Unlock the ` +
        `repo (see CLAUDE.md § Git-Crypt) before running this suite.`
    )
  }
}
