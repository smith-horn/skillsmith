/**
 * SMI-4450 Wave 1 Step 5 — retro frontmatter lint.
 *
 * Validates YAML frontmatter on `docs/internal/retros/*.md` per SPARC §S5.
 * Required fields: smi, date, kind, class.
 * Optional fields: reversal_of, absorbed_by, supersedes, originates,
 *                  ground_truth_query.
 *
 * Spawns `scripts/retrieval-log-cli.mjs` per record to append a row to
 * `frontmatter_lint_events` — telemetry only, never gates the lint outcome.
 *
 * Entrypoint: `checkRetroFrontmatter({ paths?, mode })` returns `true` when
 * the lint passes (all complete, or any outcome in warn mode) and `false`
 * when failing outcomes exist AND mode === 'error'. The caller
 * (audit-standards.mjs) translates false → exit 1.
 */

import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { createRequire } from 'node:module'
import { homedir } from 'node:os'
import { basename, join } from 'node:path'

const require = createRequire(import.meta.url)
// eslint-disable-next-line @typescript-eslint/no-require-imports
const yaml = require('js-yaml')

const RED = '\x1b[31m'
const GREEN = '\x1b[32m'
const YELLOW = '\x1b[33m'
const RESET = '\x1b[0m'

const CLI_PATH = 'scripts/retrieval-log-cli.mjs'
const RETROS_DIR = 'docs/internal/retros'
const SHIP_DATE = '2026-04-24'
const MIN_QUERY_LEN = 8
const MAX_QUERY_LEN = 200

// SPARC §S5 vocabulary — amend via PR against this array per the L3 resolution.
const VALID_CLASSES = new Set([
  'supabase',
  'migration',
  'audit_logs',
  'workflow',
  'publish',
  'ci',
  'edge_function',
  'rls',
  'auth',
  'astro',
  'pooler',
  'git_crypt',
  'vscode',
  'release',
  'stripe',
  'testing',
  'mcp',
  'sparc',
  'plan_review',
])

const SMI_RE = /^SMI-\d{3,5}$/
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/
const BASENAME_RE = /^[a-z0-9_-]+$/

const firstCommitCache = new Map()

/**
 * Main entrypoint — dispatched from audit-standards.mjs `--only retro-frontmatter`.
 */
export async function checkRetroFrontmatter({ paths, mode }) {
  const isCI = process.env.CI === 'true'
  const errorMode = mode === 'error'
  const targets = normalizePaths(paths) ?? defaultRetros()

  const knownRetroBasenames = new Set(defaultRetros().map((p) => basename(p, '.md')))

  let failCount = 0
  for (const retroPath of targets) {
    const result = validateRetro(retroPath, { isCI, knownRetroBasenames })
    emit(result, errorMode)
    if (result.outcome === 'skipped') continue
    logToDb(retroPath, result.outcome)
    if (result.outcome !== 'complete') failCount++
  }

  if (errorMode && failCount > 0) return false
  return true
}

function validateRetro(retroPath, { isCI, knownRetroBasenames }) {
  const name = basename(retroPath)
  if (name === 'index.md' || name === 'template.md' || name.startsWith('skill-gap-analysis-')) {
    return { path: retroPath, outcome: 'skipped', reason: 'exempt-file' }
  }

  const firstCommit = firstCommitDate(retroPath)
  if (firstCommit && firstCommit < SHIP_DATE) {
    return { path: retroPath, outcome: 'skipped', reason: 'pre-wave-1' }
  }

  let text
  try {
    text = readFileSync(retroPath, 'utf8').slice(0, 4096)
  } catch (err) {
    return {
      path: retroPath,
      outcome: 'incomplete',
      reason: `read-failed: ${err.message}`,
    }
  }

  const fm = parseYamlFrontmatter(text)
  if (!fm) return { path: retroPath, outcome: 'incomplete', reason: 'no-frontmatter' }

  const required = checkRequired(fm)
  if (required) return { path: retroPath, outcome: 'incomplete', reason: required }

  const optional = checkOptional(fm, { isCI, knownRetroBasenames })
  if (optional) return { path: retroPath, outcome: 'incomplete', reason: optional }

  return { path: retroPath, outcome: 'complete' }
}

function checkRequired(fm) {
  if (!SMI_RE.test(fm.smi ?? '')) return 'smi:invalid'
  if (!DATE_RE.test(fm.date ?? '')) return 'date:invalid'
  if (fm.kind !== 'retro') return 'kind:invalid'
  if (!Array.isArray(fm.class)) return 'class:not-array'
  if (fm.class.length < 1 || fm.class.length > 3) return 'class:arity'
  for (const c of fm.class) {
    if (!VALID_CLASSES.has(c)) return `class:${c}`
  }
  return null
}

function checkOptional(fm, { isCI, knownRetroBasenames }) {
  if (fm.reversal_of !== undefined) {
    if (!Array.isArray(fm.reversal_of)) return 'reversal_of:not-array'
    for (const b of fm.reversal_of) {
      const err = checkBasename(b, 'reversal_of', { isCI, knownRetroBasenames })
      if (err) return err
    }
  }
  if (fm.absorbed_by) {
    const err = checkBasename(fm.absorbed_by, 'absorbed_by', {
      isCI,
      knownRetroBasenames,
    })
    if (err) return err
  }
  if (fm.supersedes) {
    if (!BASENAME_RE.test(fm.supersedes)) return `supersedes:${fm.supersedes}`
    if (!knownRetroBasenames.has(fm.supersedes)) return `supersedes:${fm.supersedes}`
  }
  if (fm.originates) {
    if (!BASENAME_RE.test(fm.originates)) return `originates:${fm.originates}`
    if (!isCI && !memoryFileExists(fm.originates)) {
      return `originates:${fm.originates}`
    }
  }
  if (fm.ground_truth_query) {
    const len = String(fm.ground_truth_query).length
    if (len < MIN_QUERY_LEN || len > MAX_QUERY_LEN) return 'ground_truth_query:length'
  }
  return null
}

function checkBasename(name, field, { isCI, knownRetroBasenames }) {
  if (typeof name !== 'string' || !BASENAME_RE.test(name)) return `${field}:${name}`
  if (knownRetroBasenames.has(name)) return null
  if (isCI) return null // CI has no ~/.claude/projects/; format-only
  if (memoryFileExists(name)) return null
  return `${field}:${name}`
}

function parseYamlFrontmatter(text) {
  const match = text.match(/^---\r?\n([\s\S]*?)\r?\n---/)
  if (!match) return null
  try {
    // JSON_SCHEMA disables YAML's date/timestamp auto-conversion so
    // `date: 2026-04-25` arrives as a string, not a Date object.
    const parsed = yaml.load(match[1], { schema: yaml.JSON_SCHEMA })
    return parsed && typeof parsed === 'object' ? parsed : null
  } catch {
    return null
  }
}

/**
 * Resolve the earliest commit date (git log first-commit-date) for a path.
 * Returns '' if the path is not tracked or git is unavailable.
 *
 * Retros live in a git submodule (`docs/internal/`), so the outer repo's
 * `git log` sees nothing for them. Run git with cwd set to the path's
 * parent so whichever repo / submodule owns the file answers. basename
 * is passed as the path arg so the cwd-relative lookup resolves.
 *
 * Cached per invocation so a scan across N retros runs N git invocations,
 * not N² when re-checking basenames.
 */
function firstCommitDate(path) {
  if (firstCommitCache.has(path)) return firstCommitCache.get(path)
  let result = ''
  try {
    const parent = path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '.'
    const leaf = path.includes('/') ? path.slice(path.lastIndexOf('/') + 1) : path
    const out = execFileSync(
      'git',
      ['log', '--diff-filter=A', '--follow', '--format=%aI', '--', leaf],
      { cwd: parent, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }
    )
    const lines = out.trim().split('\n').filter(Boolean)
    result = lines.length > 0 ? lines[lines.length - 1] : ''
  } catch {
    result = ''
  }
  firstCommitCache.set(path, result)
  return result
}

function memoryFileExists(fileBasename) {
  const cwd = process.cwd()
  if (!cwd.startsWith('/')) return false
  const encoded = '-' + cwd.slice(1).replace(/\//g, '-')
  const dir = join(homedir(), '.claude', 'projects', encoded, 'memory')
  return existsSync(join(dir, `${fileBasename}.md`))
}

function defaultRetros() {
  if (!existsSync(RETROS_DIR)) return []
  return readdirSync(RETROS_DIR)
    .filter((f) => f.endsWith('.md'))
    .map((f) => join(RETROS_DIR, f))
}

function normalizePaths(paths) {
  if (!paths) return null
  if (Array.isArray(paths) && paths.length > 0) return paths
  if (typeof paths === 'string' && paths.length > 0) {
    return paths
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
  }
  return null
}

function logToDb(retroPath, outcome) {
  spawnSync('node', [CLI_PATH, 'frontmatter-lint', outcome, retroPath], {
    stdio: 'inherit',
    timeout: 2000,
  })
}

function emit(result, errorMode) {
  if (result.outcome === 'skipped') return
  if (result.outcome === 'complete') {
    console.log(`${GREEN}✓${RESET} frontmatter: ${result.path}`)
    return
  }
  const marker = errorMode ? `${RED}✗` : `${YELLOW}⚠`
  console.log(`${marker}${RESET} frontmatter: ${result.path} — ${result.reason}`)
}
