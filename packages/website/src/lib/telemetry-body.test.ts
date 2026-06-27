/**
 * telemetry-body.test.ts
 *
 * SMI-5394: Unit coverage for the `parseInventorySyncEnabled` helper.
 *
 * Acceptance contract:
 *   - Absent field (undefined) → fallback value, no error.
 *   - Present boolean (true/false) → that value, no error.
 *   - Present non-boolean (string, null, number, object) → error string, null value.
 */

import { describe, expect, it } from 'vitest'
import { parseInventorySyncEnabled } from './telemetry-body'

describe('parseInventorySyncEnabled — absent field (undefined)', () => {
  it('returns fallback=false when value is undefined', () => {
    expect(parseInventorySyncEnabled(undefined, false)).toEqual({ value: false, error: null })
  })

  it('returns fallback=true when value is undefined and fallback is true', () => {
    expect(parseInventorySyncEnabled(undefined, true)).toEqual({ value: true, error: null })
  })
})

describe('parseInventorySyncEnabled — present boolean values', () => {
  it('returns true when value is true (ignores fallback)', () => {
    expect(parseInventorySyncEnabled(true, false)).toEqual({ value: true, error: null })
  })

  it('returns false when value is false (ignores fallback)', () => {
    expect(parseInventorySyncEnabled(false, true)).toEqual({ value: false, error: null })
  })
})

describe('parseInventorySyncEnabled — present non-boolean values (error cases)', () => {
  it('returns error when value is a string "true"', () => {
    expect(parseInventorySyncEnabled('true', false)).toEqual({
      value: null,
      error: 'invalid_inventory_sync_enabled',
    })
  })

  it('returns error when value is a string "false"', () => {
    expect(parseInventorySyncEnabled('false', true)).toEqual({
      value: null,
      error: 'invalid_inventory_sync_enabled',
    })
  })

  it('returns error when value is the number 1', () => {
    expect(parseInventorySyncEnabled(1, false)).toEqual({
      value: null,
      error: 'invalid_inventory_sync_enabled',
    })
  })

  it('returns error when value is the number 0', () => {
    expect(parseInventorySyncEnabled(0, false)).toEqual({
      value: null,
      error: 'invalid_inventory_sync_enabled',
    })
  })

  it('returns error when value is null (present but not boolean)', () => {
    expect(parseInventorySyncEnabled(null, false)).toEqual({
      value: null,
      error: 'invalid_inventory_sync_enabled',
    })
  })

  it('returns error when value is an object', () => {
    expect(parseInventorySyncEnabled({}, false)).toEqual({
      value: null,
      error: 'invalid_inventory_sync_enabled',
    })
  })

  it('returns error when value is an array', () => {
    expect(parseInventorySyncEnabled([], false)).toEqual({
      value: null,
      error: 'invalid_inventory_sync_enabled',
    })
  })
})
