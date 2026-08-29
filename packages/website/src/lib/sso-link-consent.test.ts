import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import {
  dismissSsoLinkCandidate,
  fetchOwnSsoLinkCandidate,
  fetchPendingSsoLinkRequest,
  formatConsentDeadline,
  mapConsentErrorToCopy,
  mapLinkErrorToCopy,
  mapRestoreErrorToCopy,
  notifySsoLinkComplete,
  recordSsoLinkConsent,
  undismissSsoLinkCandidate,
} from './sso-link-consent'

function makeClient(opts?: {
  rpcData?: unknown
  rpcError?: string
  rpcThrows?: boolean
  accessToken?: string | null
  supabaseUrl?: string | null
  onRpc?: (name: string, args: unknown) => void
}): SupabaseClient {
  return {
    rpc: vi.fn(async (name: string, args: unknown) => {
      opts?.onRpc?.(name, args)
      if (opts?.rpcThrows) throw new Error('rpc-throw')
      return {
        data: opts?.rpcData ?? null,
        error: opts?.rpcError ? { message: opts.rpcError } : null,
      }
    }),
    auth: {
      getSession: vi.fn(async () => ({
        data: {
          session:
            opts?.accessToken === null
              ? null
              : { access_token: opts?.accessToken ?? 'tok', user: { id: 'u' } },
        },
      })),
    },
    supabaseUrl:
      opts?.supabaseUrl === null ? undefined : (opts?.supabaseUrl ?? 'https://p.supabase.co'),
  } as unknown as SupabaseClient
}

const ROW = {
  sso_user_id: 'sso_1',
  team_id: 'team_1',
  team_name: 'Acme Corp',
  requested_at: '2026-08-28T00:00:00Z',
  consent_expires_at: '2026-09-04T00:00:00Z',
  consented_at: null,
}

describe('fetchPendingSsoLinkRequest', () => {
  it('reports a pending request when consented_at is null', async () => {
    const lookup = await fetchPendingSsoLinkRequest(makeClient({ rpcData: [ROW] }))
    expect(lookup.status).toBe('pending')
    expect(lookup.status === 'pending' && lookup.request.sso_user_id).toBe('sso_1')
  })

  it('reports "consented" rather than dropping an already-confirmed row', async () => {
    const lookup = await fetchPendingSsoLinkRequest(
      makeClient({ rpcData: [{ ...ROW, consented_at: '2026-08-28T01:00:00Z' }] })
    )
    // Dropping it would look to the user like their confirmation was lost.
    expect(lookup.status).toBe('consented')
  })

  it('reports "none" for an empty result, a null result, or a non-array body', async () => {
    for (const rpcData of [[], null, {}]) {
      const lookup = await fetchPendingSsoLinkRequest(makeClient({ rpcData }))
      expect(lookup.status).toBe('none')
    }
  })

  it('surfaces an authored message on RPC error, never raw upstream text', async () => {
    const lookup = await fetchPendingSsoLinkRequest(
      makeClient({ rpcError: 'permission denied for function' })
    )
    expect(lookup.status).toBe('error')
    expect(lookup.status === 'error' && lookup.message).not.toContain('permission denied')
  })

  it('catches a thrown RPC rather than propagating it into the page', async () => {
    const lookup = await fetchPendingSsoLinkRequest(makeClient({ rpcThrows: true }))
    expect(lookup.status).toBe('error')
  })

  it('takes only the first (oldest) request when several are pending', async () => {
    const lookup = await fetchPendingSsoLinkRequest(
      makeClient({ rpcData: [ROW, { ...ROW, sso_user_id: 'sso_2' }] })
    )
    expect(lookup.status === 'pending' && lookup.request.sso_user_id).toBe('sso_1')
  })

  it('passes NO arguments — the RPC is keyed solely on auth.uid()', async () => {
    const calls: Array<[string, unknown]> = []
    await fetchPendingSsoLinkRequest(
      makeClient({ rpcData: [], onRpc: (n, a) => calls.push([n, a]) })
    )
    expect(calls).toHaveLength(1)
    expect(calls[0][0]).toBe('get_pending_sso_link_requests')
    expect(calls[0][1]).toBeUndefined()
  })
})

describe('fetchOwnSsoLinkCandidate', () => {
  const OWN_ROW = { legacy_user_id: 'legacy_1', legacy_email: 'alex@old.example' }

  it('reads through get_own_sso_link_candidate, NEVER the side-effecting record_sso_login', async () => {
    // SMI-6205 confirmation round N-3/N-4. record_sso_login() appends an
    // 'sso:login_recorded' audit_logs row and re-arms the candidate's 7-day
    // consent window on EVERY call, so resolving this datum through it made a
    // page view forge a login record and reopen a window H3 exists to close.
    const calls: Array<[string, unknown]> = []
    await fetchOwnSsoLinkCandidate(
      makeClient({ rpcData: [OWN_ROW], onRpc: (n, a) => calls.push([n, a]) })
    )
    expect(calls).toHaveLength(1)
    expect(calls[0][0]).toBe('get_own_sso_link_candidate')
    expect(calls.map(([name]) => name)).not.toContain('record_sso_login')
  })

  it('passes NO arguments — the RPC is keyed solely on auth.uid()', async () => {
    const calls: Array<[string, unknown]> = []
    await fetchOwnSsoLinkCandidate(makeClient({ rpcData: [], onRpc: (n, a) => calls.push([n, a]) }))
    expect(calls[0][1]).toBeUndefined()
  })

  it('returns the first (oldest) row, matching the RPC ORDER BY created_at ASC', async () => {
    const candidate = await fetchOwnSsoLinkCandidate(
      makeClient({ rpcData: [OWN_ROW, { ...OWN_ROW, legacy_user_id: 'legacy_2' }] })
    )
    expect(candidate?.legacy_user_id).toBe('legacy_1')
    expect(candidate?.legacy_email).toBe('alex@old.example')
  })

  it('normalizes a missing legacy_email to null rather than rendering "undefined"', async () => {
    const candidate = await fetchOwnSsoLinkCandidate(
      makeClient({ rpcData: [{ legacy_user_id: 'legacy_1' }] })
    )
    expect(candidate).toEqual({ legacy_user_id: 'legacy_1', legacy_email: null })
  })

  it('returns null for an empty result, a null body, or a non-array body', async () => {
    for (const rpcData of [[], null, {}]) {
      await expect(fetchOwnSsoLinkCandidate(makeClient({ rpcData }))).resolves.toBeNull()
    }
  })

  it('returns null on an RPC error or a thrown RPC — the page renders "no pending link"', async () => {
    await expect(
      fetchOwnSsoLinkCandidate(makeClient({ rpcError: 'permission denied for function' }))
    ).resolves.toBeNull()
    await expect(fetchOwnSsoLinkCandidate(makeClient({ rpcThrows: true }))).resolves.toBeNull()
  })
})

describe('dismissSsoLinkCandidate / undismissSsoLinkCandidate', () => {
  it('dismiss and restore are mirror RPCs taking the same p_legacy_user_id', async () => {
    // Both are keyed server-side on sso_user_id = auth.uid(), so the id names
    // WHICH offer, never WHO is acting on it.
    const calls: Array<[string, unknown]> = []
    const client = makeClient({ onRpc: (n, a) => calls.push([n, a]) })
    await dismissSsoLinkCandidate(client, 'legacy_1')
    await undismissSsoLinkCandidate(client, 'legacy_1')
    expect(calls).toEqual([
      ['dismiss_sso_link_candidate', { p_legacy_user_id: 'legacy_1' }],
      ['undismiss_sso_link_candidate', { p_legacy_user_id: 'legacy_1' }],
    ])
  })

  it('restore SURFACES its failure, unlike the fire-and-forget dismissal', async () => {
    // "Not now" must navigate away whether or not it landed (H3). "Restore" is
    // the opposite: the user is asking for something back, so a silent failure
    // would look like the request was gone for good.
    const res = await undismissSsoLinkCandidate(
      makeClient({ rpcError: 'forbidden: no dismissed link candidate for this account' }),
      'legacy_1'
    )
    expect(res.ok).toBe(false)
    expect(res.ok === false && res.message).toMatch(/nothing to restore/i)
  })

  it('catches a thrown restore RPC', async () => {
    const res = await undismissSsoLinkCandidate(makeClient({ rpcThrows: true }), 'legacy_1')
    expect(res.ok).toBe(false)
  })
})

describe('mapRestoreErrorToCopy', () => {
  it('stays as undifferentiated as the server refusal it mirrors', () => {
    // undismiss_sso_link_candidate() collapses "no candidate", "never
    // dismissed", "already linked" and "not yours" into ONE message so a
    // signed-in caller cannot probe for links between two specific accounts.
    const copy = mapRestoreErrorToCopy('forbidden: no dismissed link candidate for this account')
    expect(copy).toMatch(/nothing to restore/i)
    expect(copy).not.toMatch(/already linked/i)
    expect(copy).not.toMatch(/you dismissed/i)
  })

  it('names the session-expiry case, which IS actionable', () => {
    expect(
      mapRestoreErrorToCopy(
        'forbidden: a link candidate can only be restored while signed in as the SSO account it was offered to'
      )
    ).toMatch(/sign in again/i)
  })

  it('never surfaces raw upstream text for an unrecognized refusal', () => {
    const raw = 'internal_sql_diagnostic_7734: constraint violation on xyz'
    const copy = mapRestoreErrorToCopy(raw)
    expect(copy).not.toContain(raw)
    expect(copy).toMatch(/could not restore/i)
  })
})

describe('recordSsoLinkConsent', () => {
  it('calls the RPC with p_sso_user_id and reports success', async () => {
    const calls: Array<[string, unknown]> = []
    const res = await recordSsoLinkConsent(
      makeClient({ onRpc: (n, a) => calls.push([n, a]) }),
      'sso_1'
    )
    expect(res.ok).toBe(true)
    expect(calls[0]).toEqual(['record_sso_link_consent', { p_sso_user_id: 'sso_1' }])
  })

  it('maps a refusal to authored copy instead of throwing', async () => {
    const res = await recordSsoLinkConsent(
      makeClient({
        rpcError: 'forbidden: no pending link request for this account, or it has expired',
      }),
      'sso_1'
    )
    expect(res.ok).toBe(false)
    expect(res.ok === false && res.message).toMatch(/no longer available/i)
  })

  it('catches a thrown RPC', async () => {
    const res = await recordSsoLinkConsent(makeClient({ rpcThrows: true }), 'sso_1')
    expect(res.ok).toBe(false)
  })
})

describe('mapConsentErrorToCopy', () => {
  it('stays as undifferentiated as the server refusal it mirrors', () => {
    // record_sso_link_consent() deliberately collapses "no candidate",
    // "already linked" and "expired" into ONE message so a signed-in caller
    // cannot probe for candidates. The copy must not invent specificity.
    const copy = mapConsentErrorToCopy(
      'forbidden: no pending link request for this account, or it has expired'
    )
    expect(copy).toMatch(/no longer available/i)
    expect(copy).not.toMatch(/already linked/i)
  })

  it('names the session-expiry case, which IS actionable', () => {
    expect(
      mapConsentErrorToCopy(
        'forbidden: consent must be recorded while signed in as the legacy account'
      )
    ).toMatch(/sign in again/i)
  })

  it('never surfaces raw upstream text for an unrecognized refusal', () => {
    const raw = 'internal_sql_diagnostic_7734: constraint violation on xyz'
    const copy = mapConsentErrorToCopy(raw)
    expect(copy).not.toContain(raw)
    expect(copy).toMatch(/something went wrong/i)
  })
})

describe('mapLinkErrorToCopy', () => {
  it('matches on "owns a team", the migration\'s real wording, not "owner"', () => {
    const copy = mapLinkErrorToCopy(
      'forbidden: the legacy account owns a team -- transfer ownership first'
    )
    expect(copy).toMatch(/team owner/i)
    expect(copy).toMatch(/ownership transfer/i)
  })

  it('maps the consent-pending refusal to the re-authentication channel, not an email', () => {
    const copy = mapLinkErrorToCopy(
      'forbidden: link_consent_required -- the legacy account must confirm this link from its own verified email before it can be executed'
    )
    expect(copy).toMatch(/waiting for confirmation/i)
    // The shipped channel is re-authentication; there is no consent email to check.
    expect(copy).not.toMatch(/check their inbox/i)
  })

  it('never surfaces raw upstream text for an unrecognized refusal', () => {
    const raw = 'internal_sql_diagnostic_7734: constraint violation on xyz'
    expect(mapLinkErrorToCopy(raw)).not.toContain(raw)
  })
})

describe('notifySsoLinkComplete', () => {
  const originalFetch = globalThis.fetch

  beforeEach(() => {
    globalThis.fetch = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ ok: true, sent: true }),
    })) as unknown as typeof fetch
  })

  afterEach(() => {
    globalThis.fetch = originalFetch
  })

  it('POSTs the legacy_user_id to sso-link-notify with the caller bearer', async () => {
    const ok = await notifySsoLinkComplete(makeClient(), 'legacy_1')
    expect(ok).toBe(true)
    const spy = globalThis.fetch as unknown as ReturnType<typeof vi.fn>
    const [url, init] = spy.mock.calls[0] as [string, RequestInit]
    expect(url).toBe('https://p.supabase.co/functions/v1/sso-link-notify')
    expect((init.headers as Record<string, string>)['Authorization']).toBe('Bearer tok')
    expect(JSON.parse(String(init.body))).toEqual({ legacy_user_id: 'legacy_1' })
  })

  it('is non-fatal on a non-2xx response — the link already committed', async () => {
    globalThis.fetch = vi.fn(async () => ({
      ok: false,
      status: 500,
      json: async () => ({}),
    })) as unknown as typeof fetch
    await expect(notifySsoLinkComplete(makeClient(), 'legacy_1')).resolves.toBe(false)
  })

  it('is non-fatal when the function reports ok:false', async () => {
    globalThis.fetch = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ ok: false, error: 'email_send_failed' }),
    })) as unknown as typeof fetch
    await expect(notifySsoLinkComplete(makeClient(), 'legacy_1')).resolves.toBe(false)
  })

  it('is non-fatal when fetch itself throws', async () => {
    globalThis.fetch = vi.fn(async () => {
      throw new Error('network down')
    }) as unknown as typeof fetch
    await expect(notifySsoLinkComplete(makeClient(), 'legacy_1')).resolves.toBe(false)
  })

  it('does not call fetch at all without a session or a resolvable base URL', async () => {
    await expect(notifySsoLinkComplete(makeClient({ accessToken: null }), 'l')).resolves.toBe(false)
    await expect(notifySsoLinkComplete(makeClient({ supabaseUrl: null }), 'l')).resolves.toBe(false)
    expect(globalThis.fetch).not.toHaveBeenCalled()
  })
})

describe('formatConsentDeadline', () => {
  it('formats a valid ISO timestamp in UTC', () => {
    expect(formatConsentDeadline('2026-09-04T00:00:00Z')).toBe('September 4, 2026')
  })

  it('returns null for missing or unparseable input rather than an invented date', () => {
    expect(formatConsentDeadline(null)).toBeNull()
    expect(formatConsentDeadline(undefined)).toBeNull()
    expect(formatConsentDeadline('not-a-date')).toBeNull()
  })
})
