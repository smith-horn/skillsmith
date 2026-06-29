import { describe, it, expect } from 'vitest'
import { resolveCommandPath, shouldShowStartupHeader } from './startup-header-gate.js'

describe('SMI-5427 startup-header-gate', () => {
  describe('resolveCommandPath', () => {
    it('returns the bare leaf for a top-level command (parent is the root)', () => {
      expect(resolveCommandPath('search', 'skillsmith', 'skillsmith')).toBe('search')
    })

    it('returns parent+leaf for a subcommand', () => {
      expect(resolveCommandPath('push', 'inventory', 'skillsmith')).toBe('inventory push')
    })

    it('returns the bare leaf when there is no parent', () => {
      expect(resolveCommandPath('login', undefined, 'skillsmith')).toBe('login')
    })

    it('resolves correctly under the sklx alias root', () => {
      expect(resolveCommandPath('search', 'sklx', 'sklx')).toBe('search')
    })
  })

  describe('shouldShowStartupHeader', () => {
    it('never shows on a non-TTY stream (piped/scripted)', () => {
      expect(shouldShowStartupHeader('search', false)).toBe(false)
      expect(shouldShowStartupHeader('inventory push', false)).toBe(false)
    })

    it('shows for a normal command on a TTY', () => {
      expect(shouldShowStartupHeader('search', true)).toBe(true)
      expect(shouldShowStartupHeader('install', true)).toBe(true)
    })

    it('suppresses the auth commands', () => {
      expect(shouldShowStartupHeader('login', true)).toBe(false)
      expect(shouldShowStartupHeader('logout', true)).toBe(false)
      expect(shouldShowStartupHeader('whoami', true)).toBe(false)
    })

    it('suppresses inventory machine-readable subcommands by full path', () => {
      expect(shouldShowStartupHeader('inventory push', true)).toBe(false)
      expect(shouldShowStartupHeader('inventory status', true)).toBe(false)
      expect(shouldShowStartupHeader('inventory forget-device', true)).toBe(false)
    })

    it('does NOT over-exempt same-leaf subcommands of other groups (collision guard)', () => {
      // `sync status` / `telemetry status` share the `status` leaf with
      // `inventory status` but must still show the header — the gate matches the
      // full parent+leaf path, not the bare leaf (review finding C8).
      expect(shouldShowStartupHeader('sync status', true)).toBe(true)
      expect(shouldShowStartupHeader('telemetry status', true)).toBe(true)
    })
  })
})
