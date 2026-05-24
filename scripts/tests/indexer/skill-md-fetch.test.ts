/**
 * SMI-5165: Unit tests for the shared SKILL.md fetch helper.
 *
 * The critical contract: a 404 is `not-found` (genuinely gone) but any other
 * non-200 (403 secondary-rate-limit, 429, 5xx, network, unexpected body) is
 * `transient` — never a false `not-found`. Callers re-tag rows as "repo gone"
 * only on `not-found`, so a misclassified transient would feed a live skill
 * into the destructive purge.
 */

import { describe, it, expect, vi, afterEach } from 'vitest'
import { fetchSkillMd, type ParsedSkillUrl } from '../../indexer/_shared/skill-md-fetch.ts'

const parsed: ParsedSkillUrl = {
  owner: 'acme',
  repo: 'skill',
  dir: '',
  apiUrl: 'https://api.github.com/repos/acme/skill/contents/SKILL.md',
}

const b64 = (s: string): string => Buffer.from(s, 'utf-8').toString('base64')

afterEach(() => vi.restoreAllMocks())

describe('fetchSkillMd', () => {
  it('returns content on 200 + valid base64 body', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
      status: 200,
      json: async () => ({ content: b64('# Skill'), encoding: 'base64' }),
    } as unknown as Response)
    const r = await fetchSkillMd(parsed, {})
    expect(r.kind).toBe('content')
    if (r.kind === 'content') expect(r.content).toBe('# Skill')
  })

  it('returns not-found on a genuine 404', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({ status: 404 } as unknown as Response)
    expect((await fetchSkillMd(parsed, {})).kind).toBe('not-found')
  })

  it('returns transient on 403 (secondary rate limit) — NOT not-found', async () => {
    const spy = vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      status: 403,
      headers: { get: () => null },
    } as unknown as Response)
    const r = await fetchSkillMd(parsed, {}, 0)
    expect(r).toEqual({ kind: 'transient', status: 403 })
    expect(spy).toHaveBeenCalledTimes(1)
  })

  it('treats an unexpected 200 body as transient (never a false not-found)', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
      status: 200,
      json: async () => ({}),
    } as unknown as Response)
    expect((await fetchSkillMd(parsed, {}, 0)).kind).toBe('transient')
  })

  it('returns transient on a network error after exhausting retries', async () => {
    const spy = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('ECONNRESET'))
    const r = await fetchSkillMd(parsed, {}, 0)
    expect(r).toEqual({ kind: 'transient', status: 0 })
    expect(spy).toHaveBeenCalledTimes(1)
  })

  it('retries a transient and then succeeds', async () => {
    const spy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce({ status: 403, headers: { get: () => null } } as unknown as Response)
      .mockResolvedValueOnce({
        status: 200,
        json: async () => ({ content: b64('ok'), encoding: 'base64' }),
      } as unknown as Response)
    const r = await fetchSkillMd(parsed, {}, 1)
    expect(r.kind).toBe('content')
    expect(spy).toHaveBeenCalledTimes(2)
  }, 10000)
})
