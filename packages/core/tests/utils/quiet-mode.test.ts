/**
 * SMI-5897 (C-18/C-19, Wave 4 fix): Unit tests for the shared
 * `isQuietModeEnabled()` guard, extracted from probe.ts's original inline
 * `envQuiet()` and later moved from `embeddings/quiet-mode.ts` to
 * `utils/quiet-mode.ts` so `db/createDatabase.ts` could share it too.
 * `probeEmbeddingCapability` (embeddings/probe.ts), `EmbeddingService.loadModel()`'s
 * fallback warning (embeddings/index.ts), and `createDatabaseAsync()`'s
 * WASM-driver fallback notice (db/createDatabase.ts) all share this single
 * implementation.
 */

import { afterEach, describe, expect, it } from 'vitest'
import { isQuietModeEnabled } from '../../src/utils/quiet-mode.js'

describe('isQuietModeEnabled', () => {
  afterEach(() => {
    delete process.env['SKILLSMITH_QUIET']
  })

  it('returns false when SKILLSMITH_QUIET is unset', () => {
    delete process.env['SKILLSMITH_QUIET']
    expect(isQuietModeEnabled()).toBe(false)
  })

  it('returns true when SKILLSMITH_QUIET=true', () => {
    process.env['SKILLSMITH_QUIET'] = 'true'
    expect(isQuietModeEnabled()).toBe(true)
  })

  it('is case-insensitive for the "true" value', () => {
    process.env['SKILLSMITH_QUIET'] = 'TRUE'
    expect(isQuietModeEnabled()).toBe(true)
  })

  it('returns true when SKILLSMITH_QUIET=1 (numeric truthy)', () => {
    process.env['SKILLSMITH_QUIET'] = '1'
    expect(isQuietModeEnabled()).toBe(true)
  })

  it('returns false for an unrecognized truthy-looking value', () => {
    process.env['SKILLSMITH_QUIET'] = 'yes'
    expect(isQuietModeEnabled()).toBe(false)
  })

  it('returns false when SKILLSMITH_QUIET=false', () => {
    process.env['SKILLSMITH_QUIET'] = 'false'
    expect(isQuietModeEnabled()).toBe(false)
  })
})
