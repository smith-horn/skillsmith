/**
 * SMI-6531 (A1 step 1): `verifyEntryAgainstRegistry` must let a
 * `LockOrderError` from the registry lookup propagate. The catch used to turn
 * it into `{ verified: false, reason: 'network-error' }`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { LockOrderError } from '@skillsmith/core'

vi.mock('../../src/tools/install.helpers.js', () => ({
  lookupSkillFromRegistry: vi.fn(),
}))

import { lookupSkillFromRegistry } from '../../src/tools/install.helpers.js'
import {
  validateRelinkIdentity,
  verifyEntryAgainstRegistry,
} from '../../src/tools/apply-manifest-reconcile.helpers.js'
import type { SkillManifestEntry } from '../../src/tools/install.types.js'
import type { ToolContext } from '../../src/context.js'

const mockedLookup = vi.mocked(lookupSkillFromRegistry)

let dir: string
let entry: SkillManifestEntry

beforeEach(() => {
  vi.clearAllMocks()
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'reconcile-lock-order-'))
  fs.writeFileSync(path.join(dir, 'SKILL.md'), '# installed content\n')
  entry = {
    id: 'community/lock-order-skill',
    name: 'lock-order-skill',
    version: '1.0.0',
    source: 'registry',
    installPath: dir,
    installedAt: '2026-01-01T00:00:00Z',
    lastUpdated: '2026-01-01T00:00:00Z',
  }
})

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true })
})

const context = (): ToolContext =>
  ({ apiClient: { isOffline: () => false } }) as unknown as ToolContext

describe('verifyEntryAgainstRegistry: lock-order refusal from the lookup', () => {
  it('propagates a LockOrderError instead of reporting network-error', async () => {
    mockedLookup.mockRejectedValue(new LockOrderError('held-while-planning', 'x'))
    await expect(
      verifyEntryAgainstRegistry(entry, context(), () => {}, false)
    ).rejects.toBeInstanceOf(LockOrderError)
  })

  it('control: an ordinary error is still reported as network-error', async () => {
    mockedLookup.mockRejectedValue(new Error('ECONNRESET'))
    await expect(verifyEntryAgainstRegistry(entry, context(), () => {}, false)).resolves.toEqual({
      verified: false,
      reason: 'network-error',
    })
  })
})

describe('validateRelinkIdentity: lock-order refusal from the lookup', () => {
  it('rejects with the same LockOrderError instance instead of returning ok:false', async () => {
    const refusal = new LockOrderError('held-while-planning', 'x')
    mockedLookup.mockRejectedValue(refusal)
    await expect(validateRelinkIdentity('community/lock-order-skill', context())).rejects.toBe(
      refusal
    )
  })

  it('control: an ordinary error is still reported as a validation failure', async () => {
    mockedLookup.mockRejectedValue(new Error('boom'))
    await expect(validateRelinkIdentity('community/lock-order-skill', context())).resolves.toEqual({
      ok: false,
      detail: 'boom',
    })
  })
})
