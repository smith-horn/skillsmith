/**
 * SMI-1629: Node version detection with helpful errors
 *
 * Tests for the node-version utility that validates the runtime
 * Node.js version against the minimum required version.
 */

import { describe, it, expect, vi, afterEach } from 'vitest'

describe('SMI-1629: Node version detection', () => {
  // Store original process.version
  const originalVersion = process.version

  afterEach(() => {
    // Restore original version after each test
    vi.restoreAllMocks()
    Object.defineProperty(process, 'version', {
      value: originalVersion,
      writable: true,
      configurable: true,
    })
  })

  describe('getMinNodeVersion', () => {
    it('returns 22.0.0 as minimum version', async () => {
      const { getMinNodeVersion } = await import('../src/utils/node-version.js')

      expect(getMinNodeVersion()).toBe('22.0.0')
    })
  })

  describe('getCurrentNodeVersion', () => {
    it('returns the current Node.js version without v prefix', async () => {
      Object.defineProperty(process, 'version', {
        value: 'v22.5.0',
        writable: true,
        configurable: true,
      })

      // Re-import to get fresh module
      vi.resetModules()
      const { getCurrentNodeVersion } = await import('../src/utils/node-version.js')

      expect(getCurrentNodeVersion()).toBe('22.5.0')
    })

    it('handles versions with multiple digits', async () => {
      Object.defineProperty(process, 'version', {
        value: 'v18.19.1',
        writable: true,
        configurable: true,
      })

      vi.resetModules()
      const { getCurrentNodeVersion } = await import('../src/utils/node-version.js')

      expect(getCurrentNodeVersion()).toBe('18.19.1')
    })
  })

  describe('checkNodeVersion', () => {
    it('returns null when version meets requirement', async () => {
      Object.defineProperty(process, 'version', {
        value: 'v22.0.0',
        writable: true,
        configurable: true,
      })

      vi.resetModules()
      const { checkNodeVersion } = await import('../src/utils/node-version.js')

      const result = checkNodeVersion()

      expect(result).toBeNull()
    })

    it('returns null when version exceeds requirement', async () => {
      Object.defineProperty(process, 'version', {
        value: 'v22.5.1',
        writable: true,
        configurable: true,
      })

      vi.resetModules()
      const { checkNodeVersion } = await import('../src/utils/node-version.js')

      const result = checkNodeVersion()

      expect(result).toBeNull()
    })

    it('returns null for Node 23+', async () => {
      Object.defineProperty(process, 'version', {
        value: 'v23.0.0',
        writable: true,
        configurable: true,
      })

      vi.resetModules()
      const { checkNodeVersion } = await import('../src/utils/node-version.js')

      const result = checkNodeVersion()

      expect(result).toBeNull()
    })

    it('returns error message when version is too low', async () => {
      Object.defineProperty(process, 'version', {
        value: 'v18.19.0',
        writable: true,
        configurable: true,
      })

      vi.resetModules()
      const { checkNodeVersion } = await import('../src/utils/node-version.js')

      const result = checkNodeVersion()

      expect(result).not.toBeNull()
      expect(typeof result).toBe('string')
    })

    it('includes current version in error message', async () => {
      Object.defineProperty(process, 'version', {
        value: 'v20.10.0',
        writable: true,
        configurable: true,
      })

      vi.resetModules()
      const { checkNodeVersion } = await import('../src/utils/node-version.js')

      const result = checkNodeVersion()

      expect(result).toContain('20.10.0')
    })

    it('includes required version in error message', async () => {
      Object.defineProperty(process, 'version', {
        value: 'v18.0.0',
        writable: true,
        configurable: true,
      })

      vi.resetModules()
      const { checkNodeVersion } = await import('../src/utils/node-version.js')

      const result = checkNodeVersion()

      expect(result).toContain('22.0.0')
    })

    it('includes upgrade instructions in error message', async () => {
      Object.defineProperty(process, 'version', {
        value: 'v18.0.0',
        writable: true,
        configurable: true,
      })

      vi.resetModules()
      const { checkNodeVersion } = await import('../src/utils/node-version.js')

      const result = checkNodeVersion()

      expect(result).toMatch(/upgrade|install|nvm|download/i)
    })

    it('handles Node 21 as incompatible', async () => {
      Object.defineProperty(process, 'version', {
        value: 'v21.7.3',
        writable: true,
        configurable: true,
      })

      vi.resetModules()
      const { checkNodeVersion } = await import('../src/utils/node-version.js')

      const result = checkNodeVersion()

      expect(result).not.toBeNull()
      expect(result).toContain('21.7.3')
    })
  })

  describe('compareVersions', () => {
    it('returns 0 for equal versions', async () => {
      const { compareVersions } = await import('../src/utils/node-version.js')

      expect(compareVersions('22.0.0', '22.0.0')).toBe(0)
    })

    it('returns positive when first version is greater (major)', async () => {
      const { compareVersions } = await import('../src/utils/node-version.js')

      expect(compareVersions('23.0.0', '22.0.0')).toBeGreaterThan(0)
    })

    it('returns negative when first version is lesser (major)', async () => {
      const { compareVersions } = await import('../src/utils/node-version.js')

      expect(compareVersions('21.0.0', '22.0.0')).toBeLessThan(0)
    })

    it('returns positive when first version is greater (minor)', async () => {
      const { compareVersions } = await import('../src/utils/node-version.js')

      expect(compareVersions('22.5.0', '22.0.0')).toBeGreaterThan(0)
    })

    it('returns negative when first version is lesser (minor)', async () => {
      const { compareVersions } = await import('../src/utils/node-version.js')

      expect(compareVersions('22.0.0', '22.5.0')).toBeLessThan(0)
    })

    it('returns positive when first version is greater (patch)', async () => {
      const { compareVersions } = await import('../src/utils/node-version.js')

      expect(compareVersions('22.0.1', '22.0.0')).toBeGreaterThan(0)
    })

    it('returns negative when first version is lesser (patch)', async () => {
      const { compareVersions } = await import('../src/utils/node-version.js')

      expect(compareVersions('22.0.0', '22.0.1')).toBeLessThan(0)
    })

    it('handles versions with different segment counts', async () => {
      const { compareVersions } = await import('../src/utils/node-version.js')

      // 22 should be treated as 22.0.0
      expect(compareVersions('22', '22.0.0')).toBe(0)
    })

    it('handles pre-release version tags', async () => {
      const { compareVersions } = await import('../src/utils/node-version.js')

      // Pre-release suffix should be stripped, treating 22.0.0-beta.1 as 22.0.0
      expect(compareVersions('22.0.0-beta.1', '22.0.0')).toBe(0)
      expect(compareVersions('22.0.0-nightly', '21.0.0')).toBeGreaterThan(0)
      expect(compareVersions('22.0.0-alpha', '23.0.0')).toBeLessThan(0)
    })
  })

  describe('formatVersionError', () => {
    it('produces a well-formatted error message', async () => {
      const { formatVersionError } = await import('../src/utils/node-version.js')

      const error = formatVersionError('18.0.0', '22.0.0')

      // Should have clear structure
      expect(error).toContain('18.0.0')
      expect(error).toContain('22.0.0')
      expect(error.length).toBeGreaterThan(50) // Should be reasonably detailed
    })

    it('includes node version manager suggestions', async () => {
      const { formatVersionError } = await import('../src/utils/node-version.js')

      const error = formatVersionError('18.0.0', '22.0.0')

      // Should mention at least one version manager or download option
      expect(error).toMatch(/nvm|fnm|volta|nodejs\.org/i)
    })
  })
})
