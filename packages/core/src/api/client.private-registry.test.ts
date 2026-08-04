/**
 * SMI-5905 Wave 4: getPrivateRegistrySkillContent() tests.
 *
 * Verifies the request shape (JWT-only Authorization, query params) and the
 * response-contract mapping to a typed result, against the response shape
 * documented in supabase/functions/private-registry-get/index.ts.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { getPrivateRegistrySkillContent } from './client.private-registry.js'

const ORIGINAL_FETCH = globalThis.fetch

const SUCCESS_DATA = {
  skill_id: 'my-team/internal-helper',
  team_id: 'team-123',
  version: '1.2.0',
  description: 'An internal helper skill',
  content_hash: 'abc123',
  deprecated: false,
  published_at: '2026-07-01T00:00:00.000Z',
  content: { 'SKILL.md': '---\nname: internal-helper\n---\nBody content.' },
}

function jsonResponse(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

describe('SMI-5905: getPrivateRegistrySkillContent()', () => {
  let fetchMock: ReturnType<typeof vi.fn>
  let capturedUrl: string
  let capturedInit: RequestInit | undefined

  beforeEach(() => {
    capturedUrl = ''
    capturedInit = undefined
    fetchMock = vi.fn((url: string, init?: RequestInit) => {
      capturedUrl = url
      capturedInit = init
      return Promise.resolve(jsonResponse({ data: SUCCESS_DATA }, 200))
    })
    globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch
  })

  afterEach(() => {
    globalThis.fetch = ORIGINAL_FETCH
    vi.clearAllMocks()
  })

  it('sends the skillId as a query param and the JWT as Authorization: Bearer', async () => {
    await getPrivateRegistrySkillContent({
      jwtToken: 'user-jwt-abc',
      skillId: 'my-team/internal-helper',
    })

    expect(capturedUrl).toContain('/private-registry-get?')
    expect(capturedUrl).toContain('skillId=my-team%2Finternal-helper')
    expect(capturedUrl).not.toContain('version=')

    const headers = capturedInit?.headers as Record<string, string>
    expect(headers['Authorization']).toBe('Bearer user-jwt-abc')
  })

  it('forwards an explicit --version as a query param', async () => {
    await getPrivateRegistrySkillContent({
      jwtToken: 'user-jwt-abc',
      skillId: 'my-team/internal-helper',
      version: '1.0.0',
    })

    expect(capturedUrl).toContain('version=1.0.0')
  })

  it('never sends an X-API-Key header — only the JWT bearer', async () => {
    await getPrivateRegistrySkillContent({
      jwtToken: 'user-jwt-abc',
      skillId: 'my-team/internal-helper',
    })

    const headers = capturedInit?.headers as Record<string, string>
    expect(headers['X-API-Key']).toBeUndefined()
  })

  it('returns ok:true with the parsed data on 200', async () => {
    const result = await getPrivateRegistrySkillContent({
      jwtToken: 'user-jwt-abc',
      skillId: 'my-team/internal-helper',
    })

    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.data).toEqual(SUCCESS_DATA)
    }
  })

  it.each([
    [400, 'invalid_request'],
    [401, 'unauthenticated'],
    [403, 'forbidden'],
    [404, 'not_found'],
    [429, 'rate_limited'],
    [500, 'server_error'],
    [405, 'server_error'],
  ] as const)('maps HTTP %i to error code %s', async (status, expectedCode) => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ error: `boom ${status}` }, status))

    const result = await getPrivateRegistrySkillContent({
      jwtToken: 'user-jwt-abc',
      skillId: 'my-team/internal-helper',
    })

    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.code).toBe(expectedCode)
      expect(result.status).toBe(status)
      expect(result.message).toContain(`boom ${status}`)
    }
  })

  it('returns network_error when fetch itself throws', async () => {
    fetchMock.mockRejectedValueOnce(new Error('ECONNREFUSED'))

    const result = await getPrivateRegistrySkillContent({
      jwtToken: 'user-jwt-abc',
      skillId: 'my-team/internal-helper',
    })

    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.code).toBe('network_error')
      expect(result.message).toContain('ECONNREFUSED')
    }
  })

  it('returns network_error on a 200 with an unexpected response shape', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ unexpected: true }, 200))

    const result = await getPrivateRegistrySkillContent({
      jwtToken: 'user-jwt-abc',
      skillId: 'my-team/internal-helper',
    })

    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.code).toBe('network_error')
    }
  })
})
