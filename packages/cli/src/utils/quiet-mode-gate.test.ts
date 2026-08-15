import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { applyRootQuietOption } from './quiet-mode-gate.js'

describe('SMI-5893 (Wave 7 Step 4) quiet-mode-gate', () => {
  // SMI-5893: process.env.SKILLSMITH_QUIET is process-level shared state —
  // isolate and restore it around every case so this suite can't leak into
  // (or be polluted by) any other test file's env.
  const ORIGINAL = process.env['SKILLSMITH_QUIET']

  beforeEach(() => {
    delete process.env['SKILLSMITH_QUIET']
  })

  afterEach(() => {
    if (ORIGINAL === undefined) {
      delete process.env['SKILLSMITH_QUIET']
    } else {
      process.env['SKILLSMITH_QUIET'] = ORIGINAL
    }
  })

  describe('applyRootQuietOption', () => {
    it('sets SKILLSMITH_QUIET=true when the root --quiet option was passed', () => {
      applyRootQuietOption(true)
      expect(process.env['SKILLSMITH_QUIET']).toBe('true')
    })

    it('does not set SKILLSMITH_QUIET when the root --quiet option was not passed', () => {
      applyRootQuietOption(undefined)
      expect(process.env['SKILLSMITH_QUIET']).toBeUndefined()
    })

    it('does not set SKILLSMITH_QUIET when the root --quiet option resolved to false', () => {
      applyRootQuietOption(false)
      expect(process.env['SKILLSMITH_QUIET']).toBeUndefined()
    })

    it('does not clobber an externally-set SKILLSMITH_QUIET when root --quiet is absent', () => {
      process.env['SKILLSMITH_QUIET'] = 'true'
      applyRootQuietOption(undefined)
      expect(process.env['SKILLSMITH_QUIET']).toBe('true')
    })
  })
})
