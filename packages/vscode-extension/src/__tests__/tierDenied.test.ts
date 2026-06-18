import { describe, it, expect, vi, beforeEach } from 'vitest'

const { showWarningMessage, openExternal, track } = vi.hoisted(() => ({
  showWarningMessage: vi.fn(),
  openExternal: vi.fn(),
  track: vi.fn(),
}))

vi.mock('vscode', () => ({
  window: { showWarningMessage },
  env: { openExternal },
  Uri: { parse: (s: string) => ({ toString: () => s, __raw: s }) },
}))

vi.mock('../services/Telemetry.js', () => ({
  track: (...args: unknown[]) => track(...args),
}))

import { handleTierDenied, parseRequiredTier } from '../mcp/tierDenied.js'
import { McpToolError } from '../mcp/McpToolError.js'

describe('parseRequiredTier (SMI-5288)', () => {
  it('extracts tier name from "requires the Team plan"', () => {
    expect(parseRequiredTier('TierDenied: requires the Team plan')).toBe('Team')
  })
  it('extracts tier name from "requires Enterprise tier"', () => {
    expect(parseRequiredTier('requires Enterprise tier')).toBe('Enterprise')
  })
  it('returns undefined when no tier token present', () => {
    expect(parseRequiredTier('access denied')).toBeUndefined()
    expect(parseRequiredTier(undefined)).toBeUndefined()
  })
})

describe('handleTierDenied (SMI-5288)', () => {
  beforeEach(() => {
    showWarningMessage.mockReset()
    openExternal.mockReset()
    track.mockReset()
  })

  it('emits vscode_tier_denied telemetry with cmd + required_tier', async () => {
    showWarningMessage.mockResolvedValue(undefined)
    const err = new McpToolError('install_skill', 'TierDenied', 'requires the Team plan')

    await handleTierDenied('skillsmith.installSkill', err)

    expect(track).toHaveBeenCalledWith('vscode_tier_denied', {
      cmd: 'skillsmith.installSkill',
      required_tier: 'Team',
    })
  })

  it('shows a warning with Open Billing and Learn more actions', async () => {
    showWarningMessage.mockResolvedValue(undefined)
    const err = new McpToolError('install_skill', 'TierDenied', 'requires the Team plan')

    await handleTierDenied('skillsmith.installSkill', err)

    expect(showWarningMessage).toHaveBeenCalledWith(
      'requires the Team plan',
      'Open Billing',
      'Learn more'
    )
  })

  it('opens billing URL with ?src=vscode&cmd=<command> on Open Billing', async () => {
    showWarningMessage.mockResolvedValue('Open Billing')
    const err = new McpToolError('uninstall_skill', 'TierDenied', 'requires the Team plan')

    await handleTierDenied('skillsmith.uninstallSkill', err)

    expect(openExternal).toHaveBeenCalledTimes(1)
    const arg = openExternal.mock.calls[0]?.[0] as { toString: () => string }
    const url = arg.toString()
    expect(url).toContain('https://skillsmith.app/billing')
    expect(url).toContain('?src=vscode&cmd=skillsmith.uninstallSkill')
  })

  it('opens the pricing page on Learn more', async () => {
    showWarningMessage.mockResolvedValue('Learn more')
    const err = new McpToolError('search', 'TierDenied', 'requires the Team plan')

    await handleTierDenied('skillsmith.searchSkills', err)

    const arg = openExternal.mock.calls[0]?.[0] as { toString: () => string }
    expect(arg.toString()).toBe('https://skillsmith.app/pricing')
  })

  it('does not open anything when the warning is dismissed', async () => {
    showWarningMessage.mockResolvedValue(undefined)
    const err = new McpToolError('search', 'TierDenied', 'requires the Team plan')

    await handleTierDenied('skillsmith.searchSkills', err)

    expect(openExternal).not.toHaveBeenCalled()
  })

  it('falls back to a generic message when err.message is empty', async () => {
    showWarningMessage.mockResolvedValue(undefined)
    const err = new McpToolError('search', 'TierDenied', '')

    await handleTierDenied('skillsmith.searchSkills', err)

    expect(showWarningMessage).toHaveBeenCalledWith(
      'This feature requires a higher plan.',
      'Open Billing',
      'Learn more'
    )
    expect(track).toHaveBeenCalledWith('vscode_tier_denied', {
      cmd: 'skillsmith.searchSkills',
      required_tier: undefined,
    })
  })
})
