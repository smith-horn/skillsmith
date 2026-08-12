/**
 * SMI-5980 (Wave 3): `ensureAgentsDirectory()` must resolve its default
 * directory via `resolveCompanionAgentDir()` (`@skillsmith/core/install`)
 * instead of a hardcoded `join(homedir(), '.claude', 'agents')` literal, and
 * `--output` (the `customPath` param) must still win as an explicit
 * override regardless of `client`.
 *
 * `mkdir` is mocked so no test ever touches the real filesystem — the
 * assertions only need the RETURNED path, not an actual directory.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

vi.mock('fs/promises', () => ({
  mkdir: vi.fn().mockResolvedValue(undefined),
  access: vi.fn(),
}))

describe('ensureAgentsDirectory (SMI-5980 Wave 3)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('with no customPath and no client, matches resolveCompanionAgentDir() (regression: unchanged default)', async () => {
    const { ensureAgentsDirectory } = await import('../src/commands/author/utils.js')
    const { resolveCompanionAgentDir } = await import('@skillsmith/core/install')

    const result = await ensureAgentsDirectory()

    expect(result).toBe(resolveCompanionAgentDir())
    // The pre-Wave-3 default was literally `~/.claude/agents` — confirm the
    // resolved default still ends there for the canonical client.
    expect(result.endsWith('/.claude/agents')).toBe(true)
  })

  it('with no customPath, resolves per client via COMPANION_AGENT_TARGETS', async () => {
    const { ensureAgentsDirectory } = await import('../src/commands/author/utils.js')
    const { resolveCompanionAgentDir } = await import('@skillsmith/core/install')

    const copilotResult = await ensureAgentsDirectory(undefined, 'copilot')
    const claudeCodeResult = await ensureAgentsDirectory(undefined, 'claude-code')

    expect(copilotResult).toBe(resolveCompanionAgentDir('copilot'))
    expect(claudeCodeResult).toBe(resolveCompanionAgentDir('claude-code'))
    // copilot has independent AGENT_SHIM_TARGETS evidence — must differ from claude-code.
    expect(copilotResult).not.toBe(claudeCodeResult)
  })

  it('an explicit customPath (--output) always wins over the client-derived default', async () => {
    const { ensureAgentsDirectory } = await import('../src/commands/author/utils.js')

    const result = await ensureAgentsDirectory('/tmp/my-custom-agents-dir', 'copilot')

    expect(result).toBe('/tmp/my-custom-agents-dir')
  })
})
