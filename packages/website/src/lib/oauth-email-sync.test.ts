/**
 * Unit tests for describeSyncOAuthEmailOutcome (SMI-5173)
 *
 * Pure function — no DOM, no network, no Supabase dependencies.
 *
 * Coverage:
 *   U-1:  200 + { updated:true, email:'a@b.com' }    → kind:'success', message contains email
 *   U-2:  200 + { skipped:'no_drift' }               → kind:'info', message mentions providerLabel + 'sign out'
 *   U-3:  200 + { skipped:'no_verified_identity' }   → kind:'info'
 *   U-4:  200 + { skipped:'lookup_failed' }          → kind:'error'
 *   U-5:  409 status                                 → kind:'error', mentions 'another Skillsmith account'
 *   U-6:  200 + { error:'email_conflict' } (body-level 409 signal) → kind:'error', mentions 'another Skillsmith account'
 *   U-7:  401                                        → kind:'error', mentions 'session'
 *   U-8:  500 + { error:'server_error' } (unknown)  → kind:'error', generic message
 *   U-9:  providerLabel appears in info messages     → no_drift and no_verified_identity mention label
 */

import { describe, it, expect } from 'vitest'
import { describeSyncOAuthEmailOutcome, type SyncOAuthEmailResponse } from './oauth-email-sync'

describe('describeSyncOAuthEmailOutcome', () => {
  it('U-1: 200 + updated:true → kind:success, message contains the new email', () => {
    const body: SyncOAuthEmailResponse = { ok: true, updated: true, email: 'a@b.com' }
    const outcome = describeSyncOAuthEmailOutcome(200, body, 'GitHub')
    expect(outcome.kind).toBe('success')
    expect(outcome.message).toContain('a@b.com')
  })

  it('U-2: 200 + skipped:no_drift → kind:info, message mentions providerLabel and "sign out"', () => {
    const body: SyncOAuthEmailResponse = { ok: true, skipped: 'no_drift' }
    const outcome = describeSyncOAuthEmailOutcome(200, body, 'GitHub')
    expect(outcome.kind).toBe('info')
    expect(outcome.message).toContain('GitHub')
    expect(outcome.message.toLowerCase()).toContain('sign out')
  })

  it('U-3: 200 + skipped:no_verified_identity → kind:info', () => {
    const body: SyncOAuthEmailResponse = { ok: true, skipped: 'no_verified_identity' }
    const outcome = describeSyncOAuthEmailOutcome(200, body, 'Google')
    expect(outcome.kind).toBe('info')
  })

  it('U-4: 200 + skipped:lookup_failed → kind:error', () => {
    const body: SyncOAuthEmailResponse = { ok: true, skipped: 'lookup_failed' }
    const outcome = describeSyncOAuthEmailOutcome(200, body, 'GitHub')
    expect(outcome.kind).toBe('error')
  })

  it('U-5: 409 status → kind:error, message mentions "another Skillsmith account"', () => {
    const body: SyncOAuthEmailResponse = { error: 'email_conflict' }
    const outcome = describeSyncOAuthEmailOutcome(409, body, 'GitHub')
    expect(outcome.kind).toBe('error')
    expect(outcome.message).toContain('another Skillsmith account')
  })

  it('U-6: 200 + body.error="email_conflict" (body-level conflict signal) → kind:error, mentions "another Skillsmith account"', () => {
    // The edge function can return 409 but clients may only check the body;
    // verify the body signal alone is sufficient.
    const body: SyncOAuthEmailResponse = { error: 'email_conflict' }
    const outcome = describeSyncOAuthEmailOutcome(200, body, 'Google')
    expect(outcome.kind).toBe('error')
    expect(outcome.message).toContain('another Skillsmith account')
  })

  it('U-7: 401 → kind:error, message mentions session expiry', () => {
    const body: SyncOAuthEmailResponse = { error: 'authentication_required' }
    const outcome = describeSyncOAuthEmailOutcome(401, body, 'GitHub')
    expect(outcome.kind).toBe('error')
    expect(outcome.message.toLowerCase()).toContain('session')
  })

  it('U-8: 500 + unknown error → kind:error, generic message', () => {
    const body: SyncOAuthEmailResponse = { error: 'server_error' }
    const outcome = describeSyncOAuthEmailOutcome(500, body, 'GitHub')
    expect(outcome.kind).toBe('error')
    // Should not be empty and should give some user guidance.
    expect(outcome.message.length).toBeGreaterThan(0)
  })

  it('U-9: providerLabel appears in no_drift and no_verified_identity messages', () => {
    const providerLabel = 'Google'

    const noDrift = describeSyncOAuthEmailOutcome(
      200,
      { ok: true, skipped: 'no_drift' },
      providerLabel
    )
    expect(noDrift.message).toContain(providerLabel)

    const noIdentity = describeSyncOAuthEmailOutcome(
      200,
      { ok: true, skipped: 'no_verified_identity' },
      providerLabel
    )
    expect(noIdentity.message).toContain(providerLabel)
  })
})
