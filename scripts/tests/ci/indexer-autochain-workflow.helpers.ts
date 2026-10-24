/**
 * Shared loader for the indexer-backfill-autochain.yml structure tests (SMI-7112, SMI-7121).
 */
import { spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parse as parseYaml } from 'yaml'

export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
export const WORKFLOW = join(REPO_ROOT, '.github', 'workflows', 'indexer-backfill-autochain.yml')

/**
 * SMI-7161: the presence check that is the first command of the dispatch step. Quoted
 * here once so the structure, defer and dispatch-token tests pin the same literal.
 */
export const DISPATCH_TOKEN_CHECK =
  '[ -n "$GH_TOKEN" ] || { echo "::error::BACKFILL_AUTOCHAIN_DISPATCH_PAT is not provisioned (empty token) -- refusing to dispatch. GITHUB_TOKEN is never used here: a run it dispatches never triggers the next link (SMI-7161). See docs/internal/runbooks/backfill-autochain-handover.md section 6.3."; exit 1; }'

export interface Step {
  name?: string
  id?: string
  if?: string
  env?: Record<string, string>
  run?: string
  uses?: string
}

export interface WorkflowDoc {
  on: Record<string, unknown>
  jobs: { autochain: { if: string; env: Record<string, string>; steps: Step[] } }
}

export function loadWorkflow(text: string = readFileSync(WORKFLOW, 'utf8')): WorkflowDoc {
  return parseYaml(text) as WorkflowDoc
}

/** Executable commands of a `run:` block: comments/blanks dropped, `\` continuations joined. */
export function commands(run: string): string[] {
  const out: string[] = []
  let acc = ''
  for (const raw of run.split('\n')) {
    const line = raw.trim()
    if (acc === '' && (line === '' || line.startsWith('#'))) continue
    if (line.endsWith('\\')) {
      acc += line.slice(0, -1).trim() + ' '
      continue
    }
    out.push((acc + line).trim())
    acc = ''
  }
  if (acc) out.push(acc.trim())
  return out
}

/**
 * Run a step's real `run:` text the way Actions does (`bash -e`), in a temp dir whose
 * `scripts/ci/*.sh` and `npx` are replaced by stubs. `${{ }}` text is blanked (it never
 * reaches the shell: values arrive through env). Returns status, marks and GITHUB_* files.
 */
export function runStepScript(
  run: string,
  opts: {
    stubs?: Record<string, string>
    env?: Record<string, string>
    shellFlags?: string[]
  } = {}
) {
  const dir = mkdtempSync(join(tmpdir(), 'smi7121-wf-'))
  mkdirSync(join(dir, 'scripts', 'ci'), { recursive: true })
  mkdirSync(join(dir, 'bin'))
  for (const [rel, body] of Object.entries(opts.stubs ?? {})) {
    const p = join(dir, rel)
    mkdirSync(dirname(p), { recursive: true })
    writeFileSync(p, body)
    chmodSync(p, 0o755)
  }
  const files = {
    out: join(dir, 'github_output'),
    env: join(dir, 'github_env'),
    summary: join(dir, 'summary'),
    marks: join(dir, 'marks'),
  }
  const script = join(dir, 'step.sh')
  writeFileSync(script, run.replace(/\$\{\{[^}]*\}\}/g, 'x'))
  const r = spawnSync('bash', [...(opts.shellFlags ?? ['-e']), script], {
    cwd: dir,
    encoding: 'utf8',
    env: {
      ...process.env,
      PATH: `${join(dir, 'bin')}:${process.env.PATH ?? ''}`,
      MARK: files.marks,
      GITHUB_OUTPUT: files.out,
      GITHUB_ENV: files.env,
      GITHUB_STEP_SUMMARY: files.summary,
      GITHUB_REPOSITORY: 'o/r',
      GITHUB_RUN_ID: '1',
      ...opts.env,
    },
  })
  const read = (f: string) => (existsSync(f) ? readFileSync(f, 'utf8') : '')
  const marks = read(files.marks).trim()
  return {
    status: r.status,
    marks: marks === '' ? [] : marks.split('\n'),
    output: read(files.out),
    githubEnv: read(files.env),
    err: (r.stdout ?? '') + (r.stderr ?? ''),
  }
}
