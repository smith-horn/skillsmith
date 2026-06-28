/**
 * @fileoverview Unit tests for the `inventory_push` MCP tool (SMI-5392, umbrella SMI-5382).
 *
 * Strategy: mock `pushInventory` from `@skillsmith/core` via vi.hoisted + vi.mock,
 * defining the typed error classes INSIDE the hoisted factory so the subject module
 * and this test share the SAME class identities — `instanceof` checks in
 * `buildErrorMessage` resolve regardless of how @skillsmith/core is physically
 * resolved (importActual would yield a second core instance under a git worktree).
 */

import { describe, it, expect, beforeEach, vi } from 'vitest'

// ---------------------------------------------------------------------------
// Hoist the mock function reference BEFORE vi.mock() is hoisted by Vitest.
// ---------------------------------------------------------------------------

// Define the typed error classes INSIDE the hoisted mock so the subject module
// (inventory-push.ts) and this test receive the SAME class identities — the
// `instanceof` checks in buildErrorMessage then resolve regardless of how
// @skillsmith/core is physically resolved (importActual would yield a second
// core instance under a git worktree and break instanceof).
const {
  mockPushInventory,
  InventoryAuthError,
  InventoryConflictError,
  InventoryValidationError,
  InventoryUploadError,
} = vi.hoisted(() => {
  class InventoryAuthError extends Error {}
  class InventoryConflictError extends Error {}
  class InventoryValidationError extends Error {}
  class InventoryUploadError extends Error {}
  return {
    mockPushInventory: vi.fn(),
    InventoryAuthError,
    InventoryConflictError,
    InventoryValidationError,
    InventoryUploadError,
  }
})

vi.mock('@skillsmith/core', () => ({
  pushInventory: mockPushInventory,
  InventoryAuthError,
  InventoryConflictError,
  InventoryValidationError,
  InventoryUploadError,
}))

// ---------------------------------------------------------------------------
// Import subject AFTER mock declaration.
// ---------------------------------------------------------------------------

import { inventoryPush } from './inventory-push.js'

// ---------------------------------------------------------------------------
// Helper
// ---------------------------------------------------------------------------

/** Extract the text body from the first content block of an MCP tool result. */
function contentText(result: Awaited<ReturnType<typeof inventoryPush>>): string {
  const block = result.content[0] as { type: string; text: string }
  return block.text
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('inventory_push MCP tool (SMI-5392)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  // --------------------------------------------------------------------------
  // Success: applied push with counts
  // --------------------------------------------------------------------------

  it('returns success content with device id and counts when applied', async () => {
    mockPushInventory.mockResolvedValue({
      ok: true,
      applied: true,
      device_id: 'dev-abc-123',
      skills_present: 12,
      skills_absent: 3,
    })

    const result = await inventoryPush({})

    expect(result.isError).toBe(false)
    expect(contentText(result)).toBe(
      'Pushed inventory for device dev-abc-123: 12 present, 3 marked absent.'
    )
  })

  // --------------------------------------------------------------------------
  // Success: server-side consent disabled
  // --------------------------------------------------------------------------

  it('returns consent-off message when server consent is disabled', async () => {
    mockPushInventory.mockResolvedValue({
      ok: true,
      applied: false,
      reason: 'consent_disabled',
    })

    const result = await inventoryPush({})

    expect(result.isError).toBe(false)
    expect(contentText(result)).toBe(
      'Inventory sync is off for your account; enable it in account settings. Nothing was stored.'
    )
  })

  // --------------------------------------------------------------------------
  // Success: local opt-out flag set
  // --------------------------------------------------------------------------

  it('returns disabled-locally message when SKILLSMITH_INVENTORY_DISABLE is set', async () => {
    mockPushInventory.mockResolvedValue({
      ok: true,
      applied: false,
      reason: 'disabled_locally',
    })

    const result = await inventoryPush({})

    expect(result.isError).toBe(false)
    expect(contentText(result)).toBe(
      'Inventory sync is disabled locally (SKILLSMITH_INVENTORY_DISABLE); nothing sent.'
    )
  })

  // --------------------------------------------------------------------------
  // Error: InventoryAuthError
  // --------------------------------------------------------------------------

  it('returns error content with login instruction on InventoryAuthError', async () => {
    mockPushInventory.mockRejectedValue(new InventoryAuthError())

    const result = await inventoryPush({})

    expect(result.isError).toBe(true)
    expect(contentText(result)).toBe(
      'Not authenticated. Run `skillsmith login` in a terminal, then retry.'
    )
  })

  // --------------------------------------------------------------------------
  // Error: InventoryConflictError
  // --------------------------------------------------------------------------

  it('returns error content with forget-device instruction on InventoryConflictError', async () => {
    mockPushInventory.mockRejectedValue(new InventoryConflictError('device_conflict'))

    const result = await inventoryPush({})

    expect(result.isError).toBe(true)
    expect(contentText(result)).toBe(
      'This device is registered to another account; run `skillsmith inventory forget-device` and retry.'
    )
  })

  // --------------------------------------------------------------------------
  // Error: InventoryValidationError
  // --------------------------------------------------------------------------

  it('returns the server validation message on InventoryValidationError', async () => {
    mockPushInventory.mockRejectedValue(new InventoryValidationError('too_many_skills'))

    const result = await inventoryPush({})

    expect(result.isError).toBe(true)
    expect(contentText(result)).toBe('too_many_skills')
  })

  // --------------------------------------------------------------------------
  // Error: InventoryUploadError
  // --------------------------------------------------------------------------

  it('returns upload-failed message on InventoryUploadError', async () => {
    mockPushInventory.mockRejectedValue(new InventoryUploadError('HTTP 503'))

    const result = await inventoryPush({})

    expect(result.isError).toBe(true)
    expect(contentText(result)).toBe('Inventory upload failed: HTTP 503')
  })

  // --------------------------------------------------------------------------
  // Error: unknown error does not escape as unhandled rejection
  // --------------------------------------------------------------------------

  it('returns generic error content on unknown errors without throwing', async () => {
    mockPushInventory.mockRejectedValue(new Error('unexpected network failure'))

    const result = await inventoryPush({})

    expect(result.isError).toBe(true)
    expect(contentText(result)).toContain('unexpected network failure')
  })

  // --------------------------------------------------------------------------
  // Defensive: edge-contract violation (applied:false, unrecognised reason)
  // --------------------------------------------------------------------------

  it('returns "was not applied (reason)" without "undefined" for an unrecognised non-applied reason', async () => {
    mockPushInventory.mockResolvedValue({
      ok: true,
      applied: false,
      reason: 'unexpected_state',
    })

    const result = await inventoryPush({})
    const text = contentText(result)

    expect(result.isError).toBe(false)
    expect(text).toContain('was not applied')
    expect(text).toContain('(unexpected_state)')
    expect(text).not.toContain('undefined')
  })
})
