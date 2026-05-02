/**
 * SMI-4578: paths.ts unit tests.
 */
import { homedir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  CANONICAL_CLIENT,
  CLIENT_IDS,
  CLIENT_NATIVE_PATHS,
  assertClientId,
  getCanonicalInstallPath,
  getInstallPath,
  resolveClientId,
  type ClientId,
} from '../../src/install/paths.js'

describe('install/paths', () => {
  describe('CLIENT_NATIVE_PATHS', () => {
    it.each<[ClientId, string]>([
      ['claude-code', join(homedir(), '.claude', 'skills')],
      ['cursor', join(homedir(), '.cursor', 'skills')],
      ['copilot', join(homedir(), '.copilot', 'skills')],
      ['windsurf', join(homedir(), '.codeium', 'windsurf', 'skills')],
      ['agents', join(homedir(), '.agents', 'skills')],
    ])('maps %s → %s', (client, expected) => {
      expect(CLIENT_NATIVE_PATHS[client]).toBe(expected)
    })

    it('does not include codex (uses agents path)', () => {
      expect((CLIENT_NATIVE_PATHS as Record<string, string>).codex).toBeUndefined()
    })
  })

  describe('CLIENT_IDS', () => {
    it('exposes the same keys as the path table', () => {
      expect([...CLIENT_IDS].sort()).toEqual(Object.keys(CLIENT_NATIVE_PATHS).sort())
    })

    it('is frozen', () => {
      expect(Object.isFrozen(CLIENT_IDS)).toBe(true)
    })
  })

  describe('CANONICAL_CLIENT', () => {
    it('is claude-code', () => {
      expect(CANONICAL_CLIENT).toBe('claude-code')
    })
  })

  describe('getCanonicalInstallPath', () => {
    it('returns the claude-code path', () => {
      expect(getCanonicalInstallPath()).toBe(join(homedir(), '.claude', 'skills'))
    })
  })

  describe('getInstallPath', () => {
    it('returns canonical when called with no argument', () => {
      expect(getInstallPath()).toBe(getCanonicalInstallPath())
    })

    it('returns the cursor path for cursor', () => {
      expect(getInstallPath('cursor')).toBe(join(homedir(), '.cursor', 'skills'))
    })
  })

  describe('assertClientId', () => {
    it.each<ClientId>(['claude-code', 'cursor', 'copilot', 'windsurf', 'agents'])(
      'accepts %s',
      (id) => {
        expect(() => assertClientId(id)).not.toThrow()
      }
    )

    it('rejects codex with a friendly hint', () => {
      expect(() => assertClientId('codex')).toThrow(/--client agents/)
    })

    it('rejects empty string', () => {
      expect(() => assertClientId('')).toThrow(/Invalid client/)
    })

    it('rejects non-string input', () => {
      expect(() => assertClientId(undefined)).toThrow(/Invalid client/)
      expect(() => assertClientId(42)).toThrow(/Invalid client/)
    })
  })

  describe('resolveClientId', () => {
    it('returns canonical for undefined', () => {
      expect(resolveClientId(undefined)).toBe(CANONICAL_CLIENT)
    })

    it('returns canonical for empty string', () => {
      expect(resolveClientId('')).toBe(CANONICAL_CLIENT)
    })

    it('returns the matching ClientId for a valid raw value', () => {
      expect(resolveClientId('cursor')).toBe('cursor')
    })

    it('throws on invalid raw value', () => {
      expect(() => resolveClientId('codex')).toThrow(/--client agents/)
    })
  })
})
