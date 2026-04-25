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
import { mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

const HOOK = join(__dirname, '..', 'session-start-priming.sh')

interface HookOutput {
  hookSpecificOutput: { additionalContext: string }
}

function runHook(event: object, env: NodeJS.ProcessEnv = {}): HookOutput {
  const stdout = execFileSync(HOOK, [], {
    input: JSON.stringify(event),
    encoding: 'utf8',
    env: { ...process.env, ...env },
  })
  // Strip any trailing newline; first/only JSON object on stdout
  const line = stdout.trim().split('\n').pop() ?? ''
  return JSON.parse(line) as HookOutput
}

let tmpRepo: string

beforeEach(() => {
  tmpRepo = mkdtempSync(join(tmpdir(), 'priming-hook-'))
  execFileSync('git', ['init', '-q'], { cwd: tmpRepo })
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: tmpRepo })
  execFileSync('git', ['config', 'user.name', 'test'], { cwd: tmpRepo })
  execFileSync('git', ['commit', '--allow-empty', '-m', 'init'], { cwd: tmpRepo })
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
    const nonGit = mkdtempSync(join(tmpdir(), 'non-git-'))
    try {
      const out = runHook({ source: 'startup', session_id: 'test-4', cwd: nonGit })
      expect(out.hookSpecificOutput.additionalContext).toBe('')
    } finally {
      rmSync(nonGit, { recursive: true, force: true })
    }
  })

  it('returns empty on main branch', () => {
    // Default branch in newer git is main; some configs use master. Force main.
    execFileSync('git', ['checkout', '-B', 'main'], { cwd: tmpRepo })
    const out = runHook({ source: 'startup', session_id: 'test-5', cwd: tmpRepo })
    expect(out.hookSpecificOutput.additionalContext).toBe('')
  })

  it('returns empty on dependabot/* branch', () => {
    execFileSync('git', ['checkout', '-B', 'dependabot/npm/foo'], { cwd: tmpRepo })
    const out = runHook({ source: 'startup', session_id: 'test-6', cwd: tmpRepo })
    expect(out.hookSpecificOutput.additionalContext).toBe('')
  })

  it('returns empty on a non-smi/non-wave feature branch', () => {
    execFileSync('git', ['checkout', '-B', 'random-feature'], { cwd: tmpRepo })
    const out = runHook({ source: 'startup', session_id: 'test-7', cwd: tmpRepo })
    expect(out.hookSpecificOutput.additionalContext).toBe('')
  })

  it('reuses transient when < 60s old (gate 3 idempotency)', () => {
    execFileSync('git', ['checkout', '-B', 'smi-4451-test'], { cwd: tmpRepo })
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
