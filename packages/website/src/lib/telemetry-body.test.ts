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
import {
  parseInventorySyncEnabled,
  buildTelemetryUpsertRow,
  type ExistingTelemetryRow,
} from './telemetry-body'

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

describe('buildTelemetryUpsertRow — preserve/clobber matrix (SMI-5394 governance)', () => {
  const NOW = '2026-06-26T12:00:00.000Z'
  const existing: ExistingTelemetryRow = {
    anonymous_id: 'anon-original',
    anonymous_id_created_at: '2026-01-01T00:00:00.000Z',
    inventory_sync_enabled: true,
  }

  it('preserves stored anonymous_id + created_at when the id is omitted', () => {
    const row = buildTelemetryUpsertRow({
      userId: 'u1',
      enabled: false,
      anonymousId: null,
      inventorySyncEnabled: true,
      existing,
      now: NOW,
    })
    expect(row.anonymous_id).toBe('anon-original')
    expect(row.anonymous_id_created_at).toBe('2026-01-01T00:00:00.000Z')
    expect(row.enabled).toBe(false)
    expect(row.inventory_sync_enabled).toBe(true)
    expect(row.updated_at).toBe(NOW)
  })

  it('stamps a fresh created_at when a NEW anonymous_id is supplied', () => {
    const row = buildTelemetryUpsertRow({
      userId: 'u1',
      enabled: true,
      anonymousId: 'anon-new',
      inventorySyncEnabled: false,
      existing,
      now: NOW,
    })
    expect(row.anonymous_id).toBe('anon-new')
    expect(row.anonymous_id_created_at).toBe(NOW)
  })

  it('retains created_at when the supplied id is unchanged', () => {
    const row = buildTelemetryUpsertRow({
      userId: 'u1',
      enabled: true,
      anonymousId: 'anon-original',
      inventorySyncEnabled: true,
      existing,
      now: NOW,
    })
    expect(row.anonymous_id_created_at).toBe('2026-01-01T00:00:00.000Z')
  })

  it('does not clobber inventory consent — passes the resolved value through', () => {
    // The route resolves omitted -> stored via parseInventorySyncEnabled BEFORE this
    // call, so here we just confirm the boolean is carried verbatim.
    expect(
      buildTelemetryUpsertRow({
        userId: 'u1',
        enabled: true,
        anonymousId: null,
        inventorySyncEnabled: false,
        existing,
        now: NOW,
      }).inventory_sync_enabled
    ).toBe(false)
  })

  it('handles a first-time row (no existing): new id gets created_at, null id stays null', () => {
    const withId = buildTelemetryUpsertRow({
      userId: 'u1',
      enabled: true,
      anonymousId: 'anon-first',
      inventorySyncEnabled: true,
      existing: null,
      now: NOW,
    })
    expect(withId.anonymous_id).toBe('anon-first')
    expect(withId.anonymous_id_created_at).toBe(NOW)

    const noId = buildTelemetryUpsertRow({
      userId: 'u1',
      enabled: false,
      anonymousId: null,
      inventorySyncEnabled: false,
      existing: null,
      now: NOW,
    })
    expect(noId.anonymous_id).toBeNull()
    expect(noId.anonymous_id_created_at).toBeNull()
  })
})
