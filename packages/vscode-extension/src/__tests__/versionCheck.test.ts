import { describe, it, expect, vi } from 'vitest'

vi.mock('vscode', () => ({}))

import { parseVersion, meetsMinimum, promptIfOutdated } from '../mcp/versionCheck.js'

describe('parseVersion', () => {
  it('parses x.y.z', () => {
    expect(parseVersion('1.2.3')).toEqual([1, 2, 3])
  })
  it('strips pre-release suffix', () => {
    expect(parseVersion('0.5.0-beta.1')).toEqual([0, 5, 0])
  })
  it.each(['', '1.2', '1.2.3.4', 'abc', '1.x.0', null, undefined])('returns null for %s', (v) => {
    expect(parseVersion(v)).toBeNull()
  })
})

describe('meetsMinimum', () => {
  it('true on exact match', () => {
    expect(meetsMinimum('0.4.9', '0.4.9')).toBe(true)
  })
  it('true when higher', () => {
    expect(meetsMinimum('0.5.0', '0.4.9')).toBe(true)
    expect(meetsMinimum('1.0.0', '0.9.99')).toBe(true)
  })
  it('false when lower', () => {
    expect(meetsMinimum('0.4.8', '0.4.9')).toBe(false)
    expect(meetsMinimum('0.3.99', '0.4.0')).toBe(false)
  })
  it('fails open on unparseable (treat as compatible, no toast)', () => {
    expect(meetsMinimum(null, '0.4.9')).toBe(true)
    expect(meetsMinimum('nightly', '0.4.9')).toBe(true)
    expect(meetsMinimum('0.4.9', 'not-a-version')).toBe(true)
  })
})

describe('promptIfOutdated', () => {
  it('silent when version meets minimum', async () => {
    const show = vi.fn()
    const clip = vi.fn()
    await promptIfOutdated('0.4.9', '0.4.9', {
      showInformationMessage: show as never,
      clipboardWrite: clip,
    })
    expect(show).not.toHaveBeenCalled()
    expect(clip).not.toHaveBeenCalled()
  })

  it('prompts when outdated and copies on accept', async () => {
    const show = vi.fn().mockResolvedValue('Copy update command')
    const clip = vi.fn().mockResolvedValue(undefined)
    await promptIfOutdated('0.4.8', '0.4.9', {
      showInformationMessage: show as never,
      clipboardWrite: clip,
    })
    expect(show).toHaveBeenCalledOnce()
    const firstCallArgs = show.mock.calls[0] ?? []
    expect(firstCallArgs[0]).toContain('0.4.8')
    expect(firstCallArgs[0]).toContain('0.4.9')
    expect(clip).toHaveBeenCalledWith('npm install -g @skillsmith/mcp-server@latest')
  })

  it('does not copy when user dismisses', async () => {
    const show = vi.fn().mockResolvedValue(undefined)
    const clip = vi.fn()
    await promptIfOutdated('0.4.8', '0.4.9', {
      showInformationMessage: show as never,
      clipboardWrite: clip,
    })
    expect(show).toHaveBeenCalledOnce()
    expect(clip).not.toHaveBeenCalled()
  })

  it('silent when server version is null', async () => {
    const show = vi.fn()
    await promptIfOutdated(null, '0.4.9', {
      showInformationMessage: show as never,
      clipboardWrite: vi.fn(),
    })
    expect(show).not.toHaveBeenCalled()
  })
})
