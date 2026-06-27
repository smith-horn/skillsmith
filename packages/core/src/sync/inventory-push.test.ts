/**
 * inventory-push tests (SMI-5392).
 *
 * Mocks the payload builder and upload client; keeps the real (pure)
 * `isInventorySyncDisabledLocally` + `shouldAutoPush` so the env-flag and
 * throttle paths exercise production logic, while `recordInventoryPush` and
 * `getLastInventoryPushAt` are stubbed for observation/control.
 *
 * IP-1: SKILLSMITH_INVENTORY_DISABLE set -> disabled_locally no-op, no upload.
 * IP-2: applied result -> recordInventoryPush called.
 * IP-3: consent-off result -> recordInventoryPush NOT called.
 * IP-4: maybeAutoPush throttled (recent lastPushAt) -> null without pushing.
 * IP-5: maybeAutoPush swallows an upload error and returns null.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

vi.mock('./inventory-builder.js', () => ({ buildInventoryPayload: vi.fn() }))
vi.mock('./inventory-client.js', () => ({ uploadInventory: vi.fn() }))
vi.mock('../config/device-identity.js', async (importActual) => {
  const actual = await importActual<typeof import('../config/device-identity.js')>()
  return {
    ...actual,
    recordInventoryPush: vi.fn(),
    getLastInventoryPushAt: vi.fn<() => string | undefined>(() => undefined),
  }
})

import { buildInventoryPayload } from './inventory-builder.js'
import { uploadInventory } from './inventory-client.js'
import { recordInventoryPush, getLastInventoryPushAt } from '../config/device-identity.js'
import { pushInventory, maybeAutoPush } from './inventory-push.js'

const samplePayload = { device: { device_id: 'd' }, skills: [] }

describe('inventory-push', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    delete process.env.SKILLSMITH_INVENTORY_DISABLE
    vi.mocked(buildInventoryPayload).mockResolvedValue(samplePayload)
    vi.mocked(getLastInventoryPushAt).mockReturnValue(undefined)
  })

  afterEach(() => {
    delete process.env.SKILLSMITH_INVENTORY_DISABLE
    vi.restoreAllMocks()
  })

  it('IP-1: returns disabled_locally without uploading when the env flag is set', async () => {
    process.env.SKILLSMITH_INVENTORY_DISABLE = '1'

    const result = await pushInventory()

    expect(result).toEqual({ ok: true, applied: false, reason: 'disabled_locally' })
    expect(buildInventoryPayload).not.toHaveBeenCalled()
    expect(uploadInventory).not.toHaveBeenCalled()
    expect(recordInventoryPush).not.toHaveBeenCalled()
  })

  it('IP-2: records the push timestamp when the result is applied', async () => {
    vi.mocked(uploadInventory).mockResolvedValue({ ok: true, applied: true, device_id: 'd' })

    const result = await pushInventory()

    expect(result.applied).toBe(true)
    expect(recordInventoryPush).toHaveBeenCalledTimes(1)
    expect(recordInventoryPush).toHaveBeenCalledWith(expect.any(String))
  })

  it('IP-3: does not record a push when consent is disabled server-side', async () => {
    vi.mocked(uploadInventory).mockResolvedValue({
      ok: true,
      applied: false,
      reason: 'consent_disabled',
    })

    const result = await pushInventory()

    expect(result.applied).toBe(false)
    expect(recordInventoryPush).not.toHaveBeenCalled()
  })

  it('IP-4: maybeAutoPush returns null without pushing when throttled', async () => {
    vi.mocked(getLastInventoryPushAt).mockReturnValue(new Date(Date.now() - 1_000).toISOString())

    const result = await maybeAutoPush({ now: Date.now() })

    expect(result).toBeNull()
    expect(buildInventoryPayload).not.toHaveBeenCalled()
    expect(uploadInventory).not.toHaveBeenCalled()
  })

  it('IP-5: maybeAutoPush swallows an upload error and returns null', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    vi.mocked(uploadInventory).mockRejectedValue(new Error('boom'))

    const result = await maybeAutoPush()

    expect(result).toBeNull()
    expect(errorSpy).toHaveBeenCalled()
  })
})
