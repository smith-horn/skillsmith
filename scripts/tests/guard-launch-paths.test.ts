/**
 * Launch-path regression test for the three PreToolUse guards
 * (SMI-7157, SMI-7179).
 *
 * Each guard gates its runtime block on a main-module check. With the old
 * `import.meta.url === file://${process.argv[1]}` idiom the block never ran
 * when the launch path went through a symlink or contained a space: the guard
 * printed nothing and exited 0, which Claude Code reads as "allow". Each guard
 * is spawned three ways with a known-deny payload (canonical control, through
 * a symlink, through a path with a space) plus a known-allow payload on the
 * canonical path, so the same harness proves it can tell deny from allow.
 *
 * Spawn environments are built explicitly (PATH plus the listed variables),
 * never from process.env, so a stray *_DISABLE or *_SHADOW variable in the
 * runner's shell cannot change a row's meaning.
 */
import { spawnSync } from 'node:child_process'
import { cpSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { afterAll, beforeAll, describe, expect, it } from 'vitest'

const REAL_SCRIPTS_DIR = fileURLToPath(new URL('..', import.meta.url))

interface GuardCase {
  name: string
  file: string
  deny: unknown
  allow: unknown
  env: Record<string, string>
}

const bash = (command: string) => ({ tool_name: 'Bash', tool_input: { command } })

const GUARDS: GuardCase[] = [
  {
    name: 'ruflo-host-guard',
    file: 'ruflo-host-guard.mjs',
    deny: bash('npx ruflo --version'),
    allow: bash('echo hi'),
    env: {},
  },
  {
    name: 'env-read-guard',
    file: 'env-read-guard.mjs',
    deny: bash('cat .env'),
    allow: bash('echo hi'),
    env: {},
  },
  {
    name: 'linear-issue-creation-guard',
    file: 'linear-issue-creation-guard.mjs',
    deny: { tool_name: 'mcp__linear__save_issue', tool_input: { description: '' } },
    allow: {
      tool_name: 'mcp__linear__save_issue',
      tool_input: { id: 'SMI-1', description: 'update' },
    },
    env: { SKILLSMITH_LINEAR_ISSUE_GUARD_SHADOW: '0' },
  },
]

let fixtureRoot: string
let linkScriptsDir: string
let spaceScriptsDir: string
let entryDir: string

beforeAll(() => {
  fixtureRoot = mkdtempSync(join(tmpdir(), 'guard-launch-paths-'))
  linkScriptsDir = join(fixtureRoot, 'link')
  symlinkSync(REAL_SCRIPTS_DIR, linkScriptsDir)

  // A real directory holding COPIES, not a symlink, so the space is the only trigger.
  spaceScriptsDir = join(fixtureRoot, 'sp ace', 'scripts')
  mkdirSync(spaceScriptsDir, { recursive: true })
  for (const guard of GUARDS) {
    cpSync(join(REAL_SCRIPTS_DIR, guard.file), join(spaceScriptsDir, guard.file))
  }
  cpSync(join(REAL_SCRIPTS_DIR, 'lib'), join(spaceScriptsDir, 'lib'), { recursive: true })

  // Non-main control: an entry script with the SAME basename as a guard that only
  // imports the real guard. The imported guard must not treat itself as main; a
  // predicate that compared basenames would read stdin here and print a verdict.
  entryDir = join(fixtureRoot, 'entry')
  mkdirSync(entryDir)
  for (const guard of GUARDS) {
    const target = pathToFileURL(join(REAL_SCRIPTS_DIR, guard.file)).href
    writeFileSync(join(entryDir, guard.file), `import ${JSON.stringify(target)}\n`)
  }
})

afterAll(() => {
  rmSync(fixtureRoot, { recursive: true, force: true })
})

function run(scriptPath: string, payload: unknown, extraEnv: Record<string, string>) {
  return spawnSync(process.execPath, [scriptPath], {
    input: JSON.stringify(payload),
    encoding: 'utf8',
    env: { PATH: process.env.PATH ?? '', ...extraEnv },
  })
}

function expectDeny(result: ReturnType<typeof run>) {
  expect(result.status, `stderr: ${result.stderr}`).toBe(0)
  // Empty stdout with exit 0 is the defect itself: the main block never ran.
  expect(result.stdout, 'guard printed nothing: its main block was skipped').not.toBe('')
  const parsed = JSON.parse(result.stdout)
  expect(parsed.hookSpecificOutput.permissionDecision).toBe('deny')
}

describe.each(GUARDS)('$name launch paths (SMI-7157/SMI-7179)', (guard) => {
  it('canonical path (control) denies', () => {
    expectDeny(run(join(REAL_SCRIPTS_DIR, guard.file), guard.deny, guard.env))
  })

  it('through a symlinked directory denies', () => {
    expectDeny(run(join(linkScriptsDir, guard.file), guard.deny, guard.env))
  })

  it('through a path with a space denies', () => {
    expectDeny(run(join(spaceScriptsDir, guard.file), guard.deny, guard.env))
  })

  it('imported by a same-named entry script: the guard does not run as main', () => {
    // Paired with the canonical deny row above, which proves the same harness
    // sees a verdict when the guard does run.
    const result = run(join(entryDir, guard.file), guard.deny, guard.env)
    expect(result.status, `stderr: ${result.stderr}`).toBe(0)
    expect(result.stdout).toBe('')
  })

  it('canonical path, known-allow payload: empty stdout, exit 0', () => {
    const result = run(join(REAL_SCRIPTS_DIR, guard.file), guard.allow, guard.env)
    expect(result.status).toBe(0)
    expect(result.stdout).toBe('')
  })
})
