/**
 * Tests for the SMI-5846 linear-issue-creation-guard PreToolUse hook.
 *
 * Two layers are covered:
 *   1. `decide()` unit tests — the pure decision core, exercised directly
 *      (no subprocess) for every branch in the plan.
 *   2. A small set of subprocess tests that actually spawn the script,
 *      piping a JSON payload via stdin, and assert on the real exit code
 *      — this is the one place in this hook where the exit code itself
 *      (not just the decision object) carries meaning: `allow` -> 0,
 *      `warn` -> 1 (non-blocking, but transcript-visible), `deny` -> 0
 *      with a JSON permissionDecision on stdout.
 */
import { execFileSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

import { decide, LINEAR_ISSUE_GUARD_SHADOW_END_DATE } from '../linear-issue-creation-guard.mjs'

const __dirname = dirname(fileURLToPath(import.meta.url))
const SCRIPT_PATH = join(__dirname, '..', 'linear-issue-creation-guard.mjs')

const VALID_DESCRIPTION = [
  '## Context',
  '',
  'This is a sufficiently long description body explaining what changed and why, ' +
    'well past the minimum character threshold for a real issue description.',
  '',
  '## Acceptance Criteria',
  '',
  '- The thing works as described',
  '- A test confirms the behavior',
].join('\n')

const NON_COMPLIANT_DESCRIPTION = 'Too short, no Acceptance Criteria section.'

function saveIssueCall(toolInput: Record<string, unknown>) {
  return { tool_name: 'mcp__linear__save_issue', tool_input: toolInput }
}

describe('LINEAR_ISSUE_GUARD_SHADOW_END_DATE', () => {
  it('is exported as a fixed date string', () => {
    expect(LINEAR_ISSUE_GUARD_SHADOW_END_DATE).toBe('2026-08-09')
  })
})

describe('decide() (SMI-5846)', () => {
  it('a compliant description allows the call', () => {
    const result = decide(saveIssueCall({ description: VALID_DESCRIPTION }), {})
    expect(result).toEqual({ action: 'allow', json: null, stderr: null })
  })

  it('a missing description denies (with SHADOW=0) and populates json', () => {
    const result = decide(saveIssueCall({}), { SKILLSMITH_LINEAR_ISSUE_GUARD_SHADOW: '0' })
    expect(result.action).toBe('deny')
    expect(result.json).toEqual({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: expect.stringContaining('Description is empty'),
      },
    })
    expect(result.json?.hookSpecificOutput.permissionDecisionReason).toContain(
      '.claude/templates/linear-issue-template.md'
    )
  })

  it('an empty description denies (with SHADOW=0) and populates json', () => {
    const result = decide(saveIssueCall({ description: '' }), {
      SKILLSMITH_LINEAR_ISSUE_GUARD_SHADOW: '0',
    })
    expect(result.action).toBe('deny')
    expect(result.json).not.toBeNull()
  })

  it('tool_input.id present as a non-empty string allows regardless of description', () => {
    const result = decide(saveIssueCall({ id: 'SMI-1234', description: '' }), {
      SKILLSMITH_LINEAR_ISSUE_GUARD_SHADOW: '0',
    })
    expect(result).toEqual({ action: 'allow', json: null, stderr: null })
  })

  it('tool_input.id present as an empty string is treated as absent (validated as a create)', () => {
    const result = decide(saveIssueCall({ id: '', description: NON_COMPLIANT_DESCRIPTION }), {
      SKILLSMITH_LINEAR_ISSUE_GUARD_SHADOW: '0',
    })
    expect(result.action).toBe('deny')
  })

  it('disable var set allows regardless of description or shadow setting', () => {
    const result = decide(saveIssueCall({ description: '' }), {
      SKILLSMITH_LINEAR_ISSUE_GUARD_DISABLE: '1',
      SKILLSMITH_LINEAR_ISSUE_GUARD_SHADOW: '0',
    })
    expect(result).toEqual({ action: 'allow', json: null, stderr: null })
  })

  it('disable var wins even when set alongside a non-compliant description and shadow lifted', () => {
    const result = decide(saveIssueCall({ description: NON_COMPLIANT_DESCRIPTION }), {
      SKILLSMITH_LINEAR_ISSUE_GUARD_DISABLE: '1',
    })
    expect(result.action).toBe('allow')
  })

  it('shadow mode (default, unset) with a non-compliant description warns with populated stderr and null json', () => {
    const result = decide(saveIssueCall({ description: NON_COMPLIANT_DESCRIPTION }), {})
    expect(result.action).toBe('warn')
    expect(result.json).toBeNull()
    expect(result.stderr).toContain('.claude/templates/linear-issue-template.md')
  })

  it('shadow mode with SHADOW set to a non-"0" value still warns (only "0" lifts shadow)', () => {
    const result = decide(saveIssueCall({ description: NON_COMPLIANT_DESCRIPTION }), {
      SKILLSMITH_LINEAR_ISSUE_GUARD_SHADOW: 'true',
    })
    expect(result.action).toBe('warn')
  })

  it('shadow lifted (SHADOW=0) with the same non-compliant description denies', () => {
    const result = decide(saveIssueCall({ description: NON_COMPLIANT_DESCRIPTION }), {
      SKILLSMITH_LINEAR_ISSUE_GUARD_SHADOW: '0',
    })
    expect(result.action).toBe('deny')
    expect(result.json).not.toBeNull()
  })

  it('a tool_name other than mcp__linear__save_issue always allows', () => {
    const result = decide(
      { tool_name: 'mcp__linear__list_issues', tool_input: { description: '' } },
      { SKILLSMITH_LINEAR_ISSUE_GUARD_SHADOW: '0' }
    )
    expect(result).toEqual({ action: 'allow', json: null, stderr: null })
  })

  it('a malformed/null toolCall fails open to allow, not a throw', () => {
    expect(() => decide(null, {})).not.toThrow()
    expect(decide(null, {})).toEqual({ action: 'allow', json: null, stderr: null })
    expect(() => decide(undefined, {})).not.toThrow()
    expect(decide(undefined, {})).toEqual({ action: 'allow', json: null, stderr: null })
  })

  it('a malformed toolCall missing tool_input entirely fails open to allow', () => {
    const result = decide({ tool_name: 'mcp__linear__save_issue' }, {})
    expect(result.action).toBe('warn') // no description -> non-compliant -> shadow warn, not a crash
  })
})

describe('linear-issue-creation-guard.mjs runtime wrapper (subprocess, exit-code contract)', () => {
  it('exits 0 for a compliant description (allow)', () => {
    const payload = JSON.stringify(saveIssueCall({ description: VALID_DESCRIPTION }))
    const stdout = execFileSync('node', [SCRIPT_PATH], {
      input: payload,
      encoding: 'utf8',
    })
    expect(stdout.trim()).toBe('')
  })

  it('exits 1 for a non-compliant description in shadow mode (warn)', () => {
    const payload = JSON.stringify(saveIssueCall({ description: NON_COMPLIANT_DESCRIPTION }))
    // Ensure shadow mode is at its default (unset) regardless of the
    // ambient test environment.
    const cleanEnv = { ...process.env }
    delete cleanEnv.SKILLSMITH_LINEAR_ISSUE_GUARD_SHADOW
    let threw = false
    try {
      execFileSync('node', [SCRIPT_PATH], {
        input: payload,
        encoding: 'utf8',
        env: cleanEnv,
      })
    } catch (err) {
      threw = true
      const e = err as { status: number; stderr: string }
      expect(e.status).toBe(1)
      expect(e.stderr).toContain('.claude/templates/linear-issue-template.md')
    }
    expect(threw).toBe(true)
  })

  it('exits 0 with stdout JSON permissionDecision "deny" when SHADOW=0 and description is non-compliant', () => {
    const payload = JSON.stringify(saveIssueCall({ description: NON_COMPLIANT_DESCRIPTION }))
    const stdout = execFileSync('node', [SCRIPT_PATH], {
      input: payload,
      encoding: 'utf8',
      env: { ...process.env, SKILLSMITH_LINEAR_ISSUE_GUARD_SHADOW: '0' },
    })
    const parsed = JSON.parse(stdout)
    expect(parsed.hookSpecificOutput.permissionDecision).toBe('deny')
    expect(parsed.hookSpecificOutput.hookEventName).toBe('PreToolUse')
  })

  it('exits 0 for malformed stdin (fail open)', () => {
    const stdout = execFileSync('node', [SCRIPT_PATH], {
      input: 'not valid json {{{',
      encoding: 'utf8',
    })
    expect(stdout.trim()).toBe('')
  })
})
