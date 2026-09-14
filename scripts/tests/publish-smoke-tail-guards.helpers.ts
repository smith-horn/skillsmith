/**
 * Predicates, YAML extraction and the `bash -e` harness for
 * scripts/tests/publish-smoke-tail-guards.test.ts. Split out only to keep both
 * files under 500 lines; the case tables that make these predicates evidence
 * rather than decoration live in the test file. Full rationale for every
 * clause here is in that file's header and in its per-case comments.
 *
 * CI WIRING: .github/workflows/validate-publish-verify.yml selects this surface
 * with an explicit `paths:` filter. That filter must name THIS file as well as
 * the .test.ts, or an edit to a predicate here changes behaviour without
 * scheduling the job that checks it.
 */

import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import { createRequire } from 'node:module'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
export const WORKFLOW_PATH = path.join(REPO_ROOT, '.github/workflows/publish.yml')
export const HELPER_PATH = path.join(REPO_ROOT, 'scripts/ci/verify-npm-publish.sh')
export const SELF_PATH = 'scripts/tests/publish-smoke-tail-guards.test.ts'

export const JOB_ID = 'publish-skillsmith-cli'
export const STEP_NAME = 'Smoke the npx wrapper'

/**
 * The `yaml` package, not js-yaml: it exposes a scalar node's representation
 * (`BLOCK_LITERAL` vs `BLOCK_FOLDED`), which js-yaml discards, and it is a
 * DECLARED dependency (packages/cli + packages/core pin 2.8.3) rather than the
 * undeclared js-yaml edge tracked in SMI-6597. Both re-derived, not assumed.
 */
const require = createRequire(import.meta.url)
type Scalar = { type?: string; value?: unknown }
type Collection = { get: (key: unknown, keepScalar?: boolean) => unknown; items?: unknown[] }
type YamlApi = {
  parse: (text: string) => unknown
  parseDocument: (text: string) => Collection
}
const YAML = require('yaml') as YamlApi

export const WORKFLOW_TEXT = fs.readFileSync(WORKFLOW_PATH, 'utf8')

type Step = { name?: string; run?: string }
type Job = { steps?: Step[] }
type Workflow = { jobs?: Record<string, Job> }

const WORKFLOW = YAML.parse(WORKFLOW_TEXT) as Workflow

/**
 * The re-anchor: the retired marker's exactly-once assertion becomes an
 * exactly-one-matching-step assertion. Called at module load, so an anchor
 * regression fails every test in the suite rather than one.
 */
export function resolveSingleStepRun(
  steps: Array<{ name?: string; run?: string }>,
  jobId: string,
  stepName: string
): string {
  const matches = steps.filter((s) => s.name === stepName)
  if (matches.length !== 1) {
    throw new Error(
      `fixture error: expected exactly 1 step named "${stepName}" in job "${jobId}", found ${matches.length}`
    )
  }
  const run = matches[0].run
  if (typeof run !== 'string') {
    throw new Error(`fixture error: no run body for "${jobId} :: ${stepName}"`)
  }
  return run
}

/** The RAW body: no trim, no strip, no normalisation. Whitespace is the point. */
export const REAL_TAIL = resolveSingleStepRun(
  WORKFLOW.jobs?.[JOB_ID]?.steps ?? [],
  JOB_ID,
  STEP_NAME
)

/** Every reachable `run:` body, keyed by (jobId, stepName). */
function allRunBodies(): Array<{ jobId: string; stepName: string; run: string }> {
  const out: Array<{ jobId: string; stepName: string; run: string }> = []
  for (const [jobId, job] of Object.entries(WORKFLOW.jobs ?? {})) {
    for (const step of job.steps ?? []) {
      if (typeof step.run === 'string') {
        out.push({ jobId, stepName: step.name ?? '<unnamed>', run: step.run })
      }
    }
  }
  return out
}
export const RUN_BODIES = allRunBodies()

/** Parse a YAML document node tree (used by the scalar-style arm's negative case). */
export function parseDocument(text: string): Collection {
  return YAML.parseDocument(text)
}

/** Scalar style of the smoke step's `run:`, read from the parsed node TYPE. */
export function smokeScalarType(): string {
  const doc = YAML.parseDocument(WORKFLOW_TEXT)
  const jobs = doc.get('jobs', true) as Collection
  const steps = (jobs.get(JOB_ID, true) as Collection).get('steps', true) as Collection
  for (const item of (steps.items ?? []) as Collection[]) {
    if (item.get('name') === STEP_NAME) return String((item.get('run', true) as Scalar).type)
  }
  throw new Error(`fixture error: no ${STEP_NAME} node for scalar-style lookup`)
}

// ---------------------------------------------------------------------------
// Predicates
// ---------------------------------------------------------------------------

/**
 * VERBATIM from the retired scripts/lib/verify-block-identity.mjs; do not
 * re-type it. `printf "%s" foo \<nl>bar` joins; `printf "%s" foo \ <nl>bar`
 * does not, and `.trim()` erases the difference.
 */
export const UNSAFE_BACKSLASH_RE = /\\[ \t]+$/

const WORD_END = new Set([' ', '\t', ';', '|', '&', '<', '>', '(', ')'])
const PRE_COMMENT = new Set([' ', '\t', ';', '|', '&', '(', ')'])

function closeQuote(line: string, start: number, q: string): number {
  for (let k = start + 1; k < line.length; k++) {
    if (q === '"' && line[k] === '\\') {
      k++
      continue
    }
    if (line[k] === q) return k
  }
  return -1
}

function closeAnsiC(line: string, start: number): number {
  for (let k = start + 2; k < line.length; k++) {
    if (line[k] === '\\') {
      k++
      continue
    }
    if (line[k] === "'") return k
  }
  return -1
}

/** Index of the `)` closing a `((` that starts at `start`, or -1. */
function closeArith(line: string, start: number): number {
  let depth = 0
  for (let k = start; k < line.length; k++) {
    if (line[k] === '(') depth++
    else if (line[k] === ')' && --depth === 0) return k
  }
  return -1
}

const DQ_ESCAPES = new Set(['"', '\\', '$', '`'])
const ANSI_C: Record<string, string> = { n: '\n', t: '\t', r: '\r', '\\': '\\', "'": "'" }

/**
 * Step 3: consume the delimiter as a WORD, accepting a sequence of bare,
 * single-quoted, double-quoted, backslash-escaped and ANSI-C pieces until
 * whitespace or a shell metacharacter ends it -- bash concatenates adjacent
 * pieces, so enumerating whole SPELLINGS misses every mixed composition.
 * It also RESOLVES the word, so the case table can compare against the
 * delimiter `bash -n` itself names; without that, no piece kind is killable
 * (measured: mutations MH6/MH7/MH8). Returns null when no word is present.
 */
function consumeDelimiterWord(
  line: string,
  from: number
): { end: number; resolved: string } | null {
  let j = from
  let saw = false
  let resolved = ''
  while (j < line.length) {
    const c = line[j]
    if (c === '\\') {
      if (j + 1 >= line.length) break
      resolved += line[j + 1]
      j += 2
      saw = true
      continue
    }
    if (c === "'") {
      const k = closeQuote(line, j, c)
      if (k < 0) break
      resolved += line.slice(j + 1, k)
      j = k + 1
      saw = true
      continue
    }
    if (c === '"') {
      const k = closeQuote(line, j, c)
      if (k < 0) break
      const body = line.slice(j + 1, k)
      for (let q = 0; q < body.length; q++) {
        if (body[q] === '\\' && DQ_ESCAPES.has(body[q + 1])) resolved += body[++q]
        else resolved += body[q]
      }
      j = k + 1
      saw = true
      continue
    }
    if (c === '$' && line[j + 1] === "'") {
      const k = closeAnsiC(line, j)
      if (k < 0) break
      const body = line.slice(j + 2, k)
      for (let q = 0; q < body.length; q++) {
        if (body[q] === '\\' && q + 1 < body.length) resolved += ANSI_C[body[++q]] ?? body[q]
        else resolved += body[q]
      }
      j = k + 1
      saw = true
      continue
    }
    if (WORD_END.has(c)) break
    if (c === '#' && !saw) break
    resolved += c
    j++
    saw = true
  }
  return saw ? { end: j, resolved } : null
}

/**
 * Does `line` open a heredoc? REBUILT, not ported -- the shipped predicate
 * scores 31/53 on the case table. Three pieces, in order: (1) skip arithmetic
 * spans; (2) match the heredoc operator, excluding the here-string `<<<` on
 * BOTH sides so it cannot be matched by sliding one character along it;
 * (3) consume the delimiter WORD.
 *
 * On (1): both arithmetic forms are covered -- expansion `$(( ))` and command
 * `(( ))` -- by ONE clause. The scanner reaches an expansion's inner `((`
 * independently of the `$`, so a separate `$((` branch was dead code: it
 * killed no case (mutation MH1) while the `((` branch kills six. A clause no
 * case can kill is decoration, so it is gone rather than kept for symmetry.
 */
export function findHeredocOpener(
  line: string
): { index: number; raw: string; delimiter: string } | null {
  let i = 0
  while (i < line.length) {
    const c = line[i]
    if (c === '\\') {
      i += 2
      continue
    }
    if (c === "'" || c === '"') {
      const k = closeQuote(line, i, c)
      if (k < 0) return null // unterminated quote: a line-local scan cannot see further
      i = k + 1
      continue
    }
    if (c === '(' && line[i + 1] === '(') {
      const k = closeArith(line, i)
      i = k < 0 ? i + 2 : k + 1
      continue
    }
    if (c === '#' && (i === 0 || PRE_COMMENT.has(line[i - 1]))) return null
    if (c === '<' && line[i + 1] === '<') {
      if (line[i + 2] === '<') {
        i += 3
        continue
      }
      let j = i + 2
      if (line[j] === '-') j++
      while (line[j] === ' ' || line[j] === '\t') j++
      const word = consumeDelimiterWord(line, j)
      if (word) return { index: i, raw: line.slice(j, word.end), delimiter: word.resolved }
      i += 2
      continue
    }
    i++
  }
  return null
}

/** Whole-line comments only -- never trailing `#`, which appears in `${VAR#x}`. */
export function stripWholeLineComments(text: string): string {
  return text
    .split('\n')
    .filter((l) => !l.trim().startsWith('#'))
    .join('\n')
}

/** Blank the CONTENT of quoted spans, preserving length so offsets still map. */
function maskQuoted(line: string): string {
  const out = line.split('')
  let i = 0
  while (i < line.length) {
    const c = line[i]
    if (c === '\\') {
      i += 2
      continue
    }
    if (c === "'" || c === '"') {
      let k = i + 1
      while (k < line.length) {
        if (c === '"' && line[k] === '\\') {
          k += 2
          continue
        }
        if (line[k] === c) break
        k++
      }
      for (let m = i + 1; m < Math.min(k, line.length); m++) out[m] = ' '
      i = k + 1
      continue
    }
    i++
  }
  return out.join('')
}

const FRAG_SPLIT = new Set([';', '|', '&', '(', ')', '{', '}'])
const LEADING_KEYWORDS = new Set(
  'if then else elif fi do done while until for case esac in ! time'.split(' ')
)

/** Split on command separators found in the MASKED copy; slice the ORIGINAL. */
function commandFragments(line: string): string[] {
  const masked = maskQuoted(line)
  const out: string[] = []
  let start = 0
  for (let i = 0; i < masked.length; i++) {
    if (FRAG_SPLIT.has(masked[i])) {
      out.push(line.slice(start, i))
      start = i + 1
    }
  }
  out.push(line.slice(start))
  return out
}

function headWord(fragment: string): { word: string; rest: string } {
  let f = fragment
  for (;;) {
    const m = /^\s*(\S+)\s*([\s\S]*)$/.exec(f)
    if (!m) return { word: '', rest: '' }
    if (LEADING_KEYWORDS.has(m[1])) {
      f = m[2]
      continue
    }
    return { word: m[1], rest: m[2] }
  }
}

function statusClass(rest: string): 'BARE' | 'ZERO' | 'NONZERO' | 'NONLITERAL' {
  const a = rest.trim().split(/\s+/)[0] ?? ''
  if (a === '') return 'BARE'
  const u = a.replace(/^(['"])([\s\S]*)\1$/, '$2')
  if (/^0+$/.test(u)) return 'ZERO'
  if (/^[0-9]+$/.test(u)) return 'NONZERO'
  return 'NONLITERAL'
}

const KILL_SELF = new Set(['$$', '"$$"', "'$$'", '$BASHPID', '"$BASHPID"', '0'])

/**
 * A bounded prohibition on EXPLICIT TERMINATION CONSTRUCTS. It does NOT prove
 * the step always exits zero and cannot -- see the test file's
 * "what is NOT claimed" case and the failure message emitted below, which
 * carry the full statement of the bound. Residuals: a `trap` handler is
 * evaluated only when it is a quoted literal on the same line; `kill` targets
 * are matched against a closed set of current-shell spellings; bare
 * `exit`/`return` are rejected because their status is `$?`, which this
 * predicate cannot evaluate.
 */
export function terminationViolations(text: string, depth = 0): string[] {
  const bad: string[] = []
  for (const [n, line] of text.split('\n').entries()) {
    if (line.trim().startsWith('#')) continue
    const where = `line ${n + 1}: ${JSON.stringify(line.trim())}`
    for (const frag of commandFragments(line)) {
      const { word, rest } = headWord(frag)
      if (word === 'exit' || word === 'return') {
        const s = statusClass(rest)
        if (s !== 'ZERO') bad.push(`${word} with a ${s.toLowerCase()} status -- ${where}`)
      } else if (word === 'kill') {
        const args = rest.trim().split(/\s+/).filter(Boolean)
        if (args.some((a) => KILL_SELF.has(a)))
          bad.push(`kill aimed at the current shell -- ${where}`)
      } else if (word === 'trap') {
        if (depth >= 3) {
          bad.push(`trap nesting too deep to evaluate -- ${where}`)
          continue
        }
        const t = rest.trim()
        if (t.startsWith('-')) continue
        const m = /^(['"])([\s\S]*?)\1/.exec(t)
        if (!m) {
          bad.push(`trap handler is not a quoted literal, so it cannot be evaluated -- ${where}`)
          continue
        }
        if (m[2].trim() === '') continue
        for (const v of terminationViolations(m[2], depth + 1))
          bad.push(`via trap handler: ${v} -- ${where}`)
      }
    }
  }
  return bad
}

/** Non-ASCII codepoints, reported with codepoint AND offset. Tab + LF allowed. */
export function nonAsciiHits(text: string): string[] {
  const hits: string[] = []
  for (let i = 0; i < text.length; i++) {
    const cp = text.codePointAt(i) as number
    if (cp === 9 || cp === 10) continue
    if (cp < 32 || cp > 126) {
      hits.push(`offset ${i}: U+${cp.toString(16).toUpperCase().padStart(4, '0')}`)
      if (cp > 0xffff) i++
    }
  }
  return hits
}

// ---------------------------------------------------------------------------
// bash harness
// ---------------------------------------------------------------------------

const scratchDirs: string[] = []

export function makeScratchDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
  scratchDirs.push(dir)
  return dir
}

/** Called from the test file's own `afterEach`; helpers import no vitest. */
export function cleanupScratchDirs(): void {
  for (const dir of scratchDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
}

export function writeFakeBin(dir: string, name: string, body: string): void {
  const p = path.join(dir, name)
  fs.writeFileSync(p, `#!/bin/sh\n${body}\n`)
  fs.chmodSync(p, 0o755)
}

type Harness = { binDir: string; sleepArgsLog: string; version: string; marker: string }

/**
 * Baseline stubs shared by K1..K5. `jq` prints a fixture version (the step body
 * now starts with `VERSION=$(jq -r .version ...)`); `sleep` records its
 * ARGUMENTS, not merely a call count -- without that the `8` in `sleep 8` is
 * unpinned, and that interval is one of the values the retired digest covered.
 */
export function harness(): Harness {
  const binDir = makeScratchDir('sk-smoke-bin-')
  const sleepArgsLog = path.join(makeScratchDir('sk-smoke-log-'), 'sleep-args.log')
  const version = '9.9.9-fixture'
  const marker = `SMOKE-MARKER-${Math.random().toString(36).slice(2, 10)}`
  writeFakeBin(binDir, 'jq', `echo '${version}'`)
  writeFakeBin(binDir, 'sleep', 'echo "$@" >> "$SLEEP_ARG_LOG"; exit 0')
  return { binDir, sleepArgsLog, version, marker }
}

export function runTail(
  script: string,
  h: Harness
): { status: number | null; combined: string; sleepArgs: string[] } {
  const r = spawnSync('bash', ['-e', '-c', script], {
    env: { ...process.env, PATH: `${h.binDir}:${process.env.PATH}`, SLEEP_ARG_LOG: h.sleepArgsLog },
    encoding: 'utf8',
  })
  const sleepArgs = fs.existsSync(h.sleepArgsLog)
    ? fs
        .readFileSync(h.sleepArgsLog, 'utf8')
        .split('\n')
        .filter((l) => l.trim().length > 0)
    : []
  return { status: r.status, combined: `${r.stdout ?? ''}${r.stderr ?? ''}`, sleepArgs }
}

/** Reverts the mktemp guard (SMI-6512) to the pre-fix bare assignment. */
export function revertMktempGuard(tail: string): string {
  const guarded = 'if ! SMOKE_DIR="$(mktemp -d)"; then'
  if (!tail.includes(guarded)) throw new Error('fixture error: mktemp guard text drifted')
  return tail
    .replace(guarded, 'SMOKE_DIR="$(mktemp -d)"')
    .replace(/^ {2}echo "::warning::mktemp -d failed[^\n]*\n {2}exit 0\nfi\n/m, '')
}

/** Reverts the sleep guard (SMI-6583, folded into SMI-6512) to bare `sleep 8`. */
export function revertSleepGuard(tail: string): string {
  const start = tail.indexOf('  sleep 8 || {')
  const end = tail.indexOf('\n  }\n', start)
  if (start < 0 || end < 0) throw new Error('fixture error: sleep guard text drifted')
  return `${tail.slice(0, start)}  sleep 8${tail.slice(end + '\n  }'.length)}`
}
