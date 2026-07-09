/**
 * SMI-4790 Wave 1 Step 1.5: Test `installBundledSkills` routing + idempotency
 *
 * The MCP startup hook calls `installBundledSkills()` on every non-first-run
 * boot to ensure the bundled `skillsmith` slash-command skill is present.
 * The call must:
 * 1. Honour `SKILLSMITH_CLIENT` env var (Claude Code default; cursor/copilot/
 *    windsurf via env) — routing delegated to core's `resolveClientPath`.
 * 2. Be idempotent — second call when skill already exists is a no-op.
 *
 * This test pins the env-var contract at the boundary the MCP server depends
 * on. Core's own tests cover `resolveClientPath` semantics in depth; we
 * just verify the contract holds end-to-end here.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { existsSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'

import { resolveClientPath } from '@skillsmith/core/install'
import { installBundledSkills } from '../src/onboarding/install-assets.js'

describe('SMI-4790: installBundledSkills routing via SKILLSMITH_CLIENT', () => {
  const ORIGINAL_CLIENT = process.env.SKILLSMITH_CLIENT

  beforeEach(() => {
    delete process.env.SKILLSMITH_CLIENT
  })

  afterEach(() => {
    if (ORIGINAL_CLIENT === undefined) {
      delete process.env.SKILLSMITH_CLIENT
    } else {
      process.env.SKILLSMITH_CLIENT = ORIGINAL_CLIENT
    }
  })

  it('defaults to ~/.claude/skills when SKILLSMITH_CLIENT is unset', () => {
    expect(resolveClientPath()).toBe(join(homedir(), '.claude', 'skills'))
  })

  it('routes to ~/.cursor/skills when SKILLSMITH_CLIENT=cursor', () => {
    process.env.SKILLSMITH_CLIENT = 'cursor'
    expect(resolveClientPath()).toBe(join(homedir(), '.cursor', 'skills'))
  })

  it('routes to ~/.copilot/skills when SKILLSMITH_CLIENT=copilot', () => {
    process.env.SKILLSMITH_CLIENT = 'copilot'
    expect(resolveClientPath()).toBe(join(homedir(), '.copilot', 'skills'))
  })

  it('routes to ~/.codeium/windsurf/skills when SKILLSMITH_CLIENT=windsurf', () => {
    process.env.SKILLSMITH_CLIENT = 'windsurf'
    expect(resolveClientPath()).toBe(join(homedir(), '.codeium', 'windsurf', 'skills'))
  })

  it('routes to ~/.agents/skills when SKILLSMITH_CLIENT=agents (Codex)', () => {
    process.env.SKILLSMITH_CLIENT = 'agents'
    expect(resolveClientPath()).toBe(join(homedir(), '.agents', 'skills'))
  })

  it('throws when SKILLSMITH_CLIENT is invalid (boundary contract)', () => {
    process.env.SKILLSMITH_CLIENT = 'not-a-real-runtime'
    expect(() => resolveClientPath()).toThrow(/Invalid client/)
  })
})

describe('SMI-4790: installBundledSkills idempotency', () => {
  it('exports a callable function returning string[]', () => {
    expect(typeof installBundledSkills).toBe('function')
    const result = installBundledSkills()
    expect(Array.isArray(result)).toBe(true)
    result.forEach((skillName) => expect(typeof skillName).toBe('string'))
  })

  it('second call when skills already installed returns empty array', () => {
    // First call may or may not install (depends on real filesystem state);
    // second call MUST observe the post-first state and skip everything.
    installBundledSkills()
    const second = installBundledSkills()
    expect(second).toEqual([])
  })
})

describe('SMI-5582: installBundledSkills installs both bundled skills', () => {
  it('installs both the varlock and skillsmith skills onto the real filesystem', () => {
    // This suite hits the real filesystem with no mocking, and
    // `installBundledSkills()` is idempotent: only the very first call in a
    // given test run actually copies anything — every later call (including
    // ones from other tests in this file) observes the already-installed
    // state and returns []. So we don't assert on THIS call's return value;
    // we assert on the real directory contents, which prove both bundled
    // skills landed on disk regardless of which call installed them.
    installBundledSkills()

    const clientSkillsDir = resolveClientPath()
    expect(existsSync(join(clientSkillsDir, 'varlock', 'SKILL.md'))).toBe(true)
    expect(existsSync(join(clientSkillsDir, 'skillsmith', 'SKILL.md'))).toBe(true)
  })
})
