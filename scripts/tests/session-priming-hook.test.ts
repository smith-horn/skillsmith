/**
 * SMI-4451 Wave 1 Step 7 — bash hook integration tests.
 *
 * Pipes synthetic SessionStart JSON events into the hook script via stdin and
 * asserts on the JSON line written to stdout. Covers the gate-fall-through
 * paths (gates 1-3, gate 1b non-git cwd) and idempotency. The full priming
 * path (gate 4 → tsx → search → primed) is exercised by S9 post-deploy smoke
 * per addendum, not in CI — mocking real search() through a bash subprocess
 * is more brittle than valuable.
 */

import { execFileSync } from 'node:child_process'
import { rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { makeFixtureEnv, makeFixtureTempDir } from './_lib/git-fixture-env.js'

const HOOK = join(__dirname, '..', 'session-start-priming.sh')

interface HookOutput {
  hookSpecificOutput: { hookEventName: 'SessionStart'; additionalContext: string }
}

function runHook(event: object, env: NodeJS.ProcessEnv = {}): HookOutput {
  // SMI-4693: route the hook subprocess through `makeFixtureEnv` so any `git`
  // it spawns inherits a sanitised environment. The hook itself reads
  // `event.cwd`, but defence-in-depth is cheap here.
  const stdout = execFileSync(HOOK, [], {
    input: JSON.stringify(event),
    encoding: 'utf8',
    env: { ...makeFixtureEnv(), ...env },
  })
  // Strip any trailing newline; first/only JSON object on stdout
  const line = stdout.trim().split('\n').pop() ?? ''
  return JSON.parse(line) as HookOutput
}

let tmpRepo: string

beforeEach(() => {
  // SMI-4693: every git invocation under test must use makeFixtureEnv() so
  // GIT_DISCOVERY_VARS cannot redirect the spawn into the parent worktree.
  tmpRepo = makeFixtureTempDir('priming-hook')
  const env = makeFixtureEnv()
  execFileSync('git', ['init', '-q'], { cwd: tmpRepo, env })
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: tmpRepo, env })
  execFileSync('git', ['config', 'user.name', 'test'], { cwd: tmpRepo, env })
  execFileSync('git', ['commit', '--allow-empty', '-m', 'init'], { cwd: tmpRepo, env })
})

afterEach(() => {
  rmSync(tmpRepo, { recursive: true, force: true })
})

describe('session-start-priming.sh — gate behavior', () => {
  it('returns empty additionalContext on non-startup source', () => {
    const out = runHook({ source: 'resume', session_id: 'test-1', cwd: tmpRepo })
    expect(out.hookSpecificOutput.additionalContext).toBe('')
  })

  it('returns empty on compact source', () => {
    const out = runHook({ source: 'compact', session_id: 'test-2', cwd: tmpRepo })
    expect(out.hookSpecificOutput.additionalContext).toBe('')
  })

  it('returns empty on missing cwd', () => {
    const out = runHook({ source: 'startup', session_id: 'test-3', cwd: '' })
    expect(out.hookSpecificOutput.additionalContext).toBe('')
  })

  it('returns empty on non-git cwd', () => {
    const nonGit = makeFixtureTempDir('non-git')
    try {
      const out = runHook({ source: 'startup', session_id: 'test-4', cwd: nonGit })
      expect(out.hookSpecificOutput.additionalContext).toBe('')
    } finally {
      rmSync(nonGit, { recursive: true, force: true })
    }
  })

  it('returns empty on main branch', () => {
    // Default branch in newer git is main; some configs use master. Force main.
    execFileSync('git', ['checkout', '-B', 'main'], { cwd: tmpRepo, env: makeFixtureEnv() })
    const out = runHook({ source: 'startup', session_id: 'test-5', cwd: tmpRepo })
    expect(out.hookSpecificOutput.additionalContext).toBe('')
  })

  it('returns empty on dependabot/* branch', () => {
    execFileSync('git', ['checkout', '-B', 'dependabot/npm/foo'], {
      cwd: tmpRepo,
      env: makeFixtureEnv(),
    })
    const out = runHook({ source: 'startup', session_id: 'test-6', cwd: tmpRepo })
    expect(out.hookSpecificOutput.additionalContext).toBe('')
  })

  it('returns empty on a non-smi/non-wave feature branch', () => {
    execFileSync('git', ['checkout', '-B', 'random-feature'], {
      cwd: tmpRepo,
      env: makeFixtureEnv(),
    })
    const out = runHook({ source: 'startup', session_id: 'test-7', cwd: tmpRepo })
    expect(out.hookSpecificOutput.additionalContext).toBe('')
  })

  it('reuses transient when < 60s old (gate 3 idempotency)', () => {
    execFileSync('git', ['checkout', '-B', 'smi-4451-test'], {
      cwd: tmpRepo,
      env: makeFixtureEnv(),
    })
    const sessionId = 'test-idempotent-' + Date.now()
    const transient = `/tmp/session-priming-${sessionId}.md`
    writeFileSync(transient, 'cached priming content', 'utf8')
    try {
      const out = runHook({ source: 'startup', session_id: sessionId, cwd: tmpRepo })
      expect(out.hookSpecificOutput.additionalContext).toBe('cached priming content')
    } finally {
      try {
        rmSync(transient)
      } catch {
        /* already gone */
      }
    }
  })

  it('produces valid JSON output on every code path', () => {
    // Spot-check that all gate paths emit parseable JSON with the expected shape
    const out = runHook({ source: 'unknown', session_id: 'shape-test', cwd: tmpRepo })
    expect(out).toHaveProperty('hookSpecificOutput')
    expect(out.hookSpecificOutput).toHaveProperty('additionalContext')
    expect(typeof out.hookSpecificOutput.additionalContext).toBe('string')
  })

  it('emits hookEventName: "SessionStart" on every gate path (validator contract)', () => {
    // SMI-4451 fix eeb12c64: Claude Code harness validator drops the payload
    // ("hookSpecificOutput is missing required field hookEventName") if this
    // field is absent, silently nullifying priming. Cover all four gate paths.
    const paths = [
      { source: 'resume', session_id: 'evt-1', cwd: tmpRepo }, // gate 1
      { source: 'startup', session_id: 'evt-2', cwd: '' }, // gate 1b
      { source: 'startup', session_id: 'evt-3', cwd: tmpRepo }, // gate 2 (no branch set)
      { source: 'unknown', session_id: 'evt-4', cwd: tmpRepo }, // malformed source
    ]
    for (const evt of paths) {
      const out = runHook(evt)
      expect(out.hookSpecificOutput.hookEventName).toBe('SessionStart')
    }
  })
})

describe('session-start-priming.sh — script integrity', () => {
  it('is executable', () => {
    const stat = statSync(HOOK)
    // 0o111 = any execute bit set (owner/group/world)
    expect(stat.mode & 0o111).toBeGreaterThan(0)
  })

  it('always exits 0 even on malformed input', () => {
    const stdout = execFileSync(HOOK, [], {
      input: 'not-json',
      encoding: 'utf8',
    })
    expect(stdout.trim().split('\n').pop()).toContain('hookSpecificOutput')
  })
})
