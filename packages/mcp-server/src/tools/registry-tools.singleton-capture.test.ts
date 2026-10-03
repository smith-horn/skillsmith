/**
 * @fileoverview SMI-6622 governance review — each registry handler reads the module-level service
 * singleton exactly once
 * @see SMI-6203: the same shape in sso/integration/rbac tools. `dataSourceFor(service)` labels the
 *      result, then `service.<method>()` populates it after an `await`; if
 *      `setPrivateRegistryService()` lands in between, the result carries one instance's provenance
 *      and another instance's data.
 *
 * The team-resolution mock swaps the service DURING its await, which is exactly that window.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { ToolContext } from '../context.js'

const swap = vi.hoisted(() => ({ next: null as unknown }))

vi.mock('./registry-tools.team.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./registry-tools.team.js')>()
  return {
    ...actual,
    resolveRegistryTeamId: vi.fn(async () => {
      if (swap.next) {
        // Imported at call time, not in the factory: registry-tools.js itself imports this module.
        const { setPrivateRegistryService } = await import('./registry-tools.js')
        setPrivateRegistryService(swap.next as Parameters<typeof setPrivateRegistryService>[0])
      }
      return { teamId: 'team-alpha', source: 'env:SKILLSMITH_LICENSE_KEY' }
    }),
  }
})

import {
  createStubRegistryService,
  executePrivateRegistryManage,
  executePrivateRegistryPublish,
  setPrivateRegistryService,
  type PrivateRegistryService,
  type RegistrySkill,
} from './registry-tools.js'

const ctx = {} as ToolContext

const SKILL = {
  skillId: 'acme/alpha',
  version: '1.0.0',
  description: null,
  deprecated: false,
  publishedAt: '2026-09-14T00:00:00Z',
  publishedBy: 'user-1',
  registryUrl: 'https://example.invalid/acme/alpha',
  approvalStatus: 'approved',
} as unknown as RegistrySkill

/** A live-labelled service (not produced by a stub factory, so `dataSourceFor` says 'live'). */
function makeLiveService(): PrivateRegistryService {
  return {
    publish: vi.fn(async () => SKILL),
    list: vi.fn(async () => [SKILL]),
    get: vi.fn(async () => SKILL),
    getContent: vi.fn(async () => null),
    deprecate: vi.fn(async () => true),
    undeprecate: vi.fn(async () => true),
    getNamespace: vi.fn(async () => null),
  } as unknown as PrivateRegistryService
}

describe('registry handlers read the service singleton once (SMI-6622 governance / SMI-6203 pattern)', () => {
  let original: PrivateRegistryService
  let swappedIn: ReturnType<typeof createStubRegistryService>

  beforeEach(() => {
    original = makeLiveService()
    swappedIn = createStubRegistryService()
    vi.spyOn(swappedIn, 'list')
    vi.spyOn(swappedIn, 'publish')
    vi.spyOn(swappedIn, 'getNamespace')
    setPrivateRegistryService(original)
    swap.next = swappedIn
  })

  it('manage list: provenance and data both come from the instance wired in at call time', async () => {
    const result = await executePrivateRegistryManage({ action: 'list' }, ctx)

    expect(result.dataSource).toBe('live')
    expect(original.list).toHaveBeenCalledTimes(1)
    expect(swappedIn.list).not.toHaveBeenCalled()
    expect(result.success).toBe(true)
    expect(result.skills).toEqual([SKILL])
  })

  it('publish: namespace pre-check and insert both use the instance wired in at call time', async () => {
    const result = await executePrivateRegistryPublish(
      { skillId: 'acme/alpha', version: '1.0.0', content: { 'SKILL.md': '# a' } },
      ctx
    )

    expect(result.dataSource).toBe('live')
    expect(original.getNamespace).toHaveBeenCalledTimes(1)
    expect(original.publish).toHaveBeenCalledTimes(1)
    expect(swappedIn.getNamespace).not.toHaveBeenCalled()
    expect(swappedIn.publish).not.toHaveBeenCalled()
    expect(result.success).toBe(true)
  })
})
