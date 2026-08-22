/**
 * Personal Summary dashboard data loading + quota-banner rendering (M7).
 *
 * Extracted out of account/summary.astro's inline client script to keep the
 * page under the repo's 500-line-per-file standard (same extraction pattern
 * as account-nav.ts / team-access.ts / account-overview-data.ts).
 *
 * Summary never calls checkTeamAccess() — it's always accessible to
 * Community/Individual users (Decision #3). Its tier comes from
 * get_effective_subscription_summary, the same RPC used to resolve the
 * winning entitlement everywhere else in the account area.
 *
 * @see docs/internal/implementation/account-dashboard-ux-consolidation.md
 */

import type { SupabaseClient } from '@supabase/supabase-js'

export interface SummaryProfile {
  fullName: string
  email: string
  githubUsername: string | null
}

export interface SummaryQuota {
  totalUsage: number
  /** -1 means unlimited (enterprise). */
  quota: number
  oldQuota: number
  periodEnd: string
}

export interface SummaryData {
  profile: SummaryProfile
  tier: string
  activeKeyCount: number
  maxKeys: number
  quota: SummaryQuota
}

const QUOTA_LIMITS: Record<string, number> = {
  community: 100,
  individual: 1000,
  team: 10000,
  enterprise: -1,
}

// SMI-5558: prior (pre-cut) quota values, used only to compute the
// grandfathering window for the current billing period — see
// renderQuotaBanner() below.
const OLD_QUOTA_LIMITS: Record<string, number> = {
  community: 1000,
  individual: 10000,
  team: 100000,
  enterprise: -1,
}

const MAX_KEYS_BY_TIER: Record<string, number> = {
  community: 1,
  individual: 3,
  team: 10,
  enterprise: 50,
}

/**
 * M9 entitlement signal (Section 3, L2-8/L2-9) for the hub tab row's
 * lock affordance. Team and Enterprise tiers unlock team administration.
 */
const TEAM_ENTITLED_TIERS: ReadonlySet<string> = new Set(['team', 'enterprise'])

export function isEntitledTier(tier: string): boolean {
  return TEAM_ENTITLED_TIERS.has(tier)
}

/**
 * Fetch the reduced personal-dashboard data set: identity, resolved tier,
 * a license-key glance count (no list, no generate/revoke — Decision #6,
 * Open Question 3), and the billing-period usage figures the quota banner
 * needs. Deliberately does NOT call get_user_subscription or resolve
 * non-owner team membership — that RPC pair only ever fed the detailed
 * Subscription section (tier price, next billing date, cancellation
 * state), which Summary no longer renders (Decision #7), so the
 * team-non-owner redaction it existed to enforce has nothing left to
 * redact here.
 */
export async function loadSummaryData(
  supabase: SupabaseClient,
  userId: string,
  userEmail: string | null
): Promise<SummaryData> {
  const { data: profile } = await supabase
    .from('profiles')
    .select('tier, full_name, github_username, auth_provider')
    .eq('id', userId)
    .single()

  // Resolves the winning entitlement (personal or team) — correct even for
  // a user who belongs to more than one team (SMI-6086).
  const { data: effectiveRows, error: effectiveError } = await supabase.rpc(
    'get_effective_subscription_summary',
    { user_uuid: userId }
  )
  if (effectiveError) throw effectiveError
  const effectiveSubscription = effectiveRows?.[0]

  const tier = effectiveSubscription?.tier || profile?.tier || 'community'
  const fullName = profile?.full_name || userEmail?.split('@')[0] || 'User'

  const { data: licenseKeys } = await supabase
    .from('license_keys')
    .select('id, status')
    .eq('user_id', userId)

  const activeKeyCount = (licenseKeys ?? []).filter((k) => k.status === 'active').length
  // Matches the original ternary chain's fallback exactly: any tier that
  // isn't community/individual/team (including enterprise) gets 50.
  const maxKeys = MAX_KEYS_BY_TIER[tier] ?? 50

  // SMI-4463: tier-aware billing-period usage window (migration 084) —
  // calendar month for community/null, Stripe subscription period for paid
  // tiers, so a mid-month upgrade buys 30 days, not "until the 1st".
  const { data: usageSummary, error: usageError } = await supabase.rpc(
    'get_user_usage_for_billing_period',
    { p_user_id: userId }
  )
  if (usageError) {
    console.error('[summary] get_user_usage_for_billing_period failed:', usageError)
  }
  const totalUsage = Number(usageSummary?.[0]?.total_requests ?? 0)
  const periodEnd = usageSummary?.[0]?.period_end || ''
  const quota = QUOTA_LIMITS[tier] ?? 100
  const oldQuota = OLD_QUOTA_LIMITS[tier] ?? 1000

  return {
    profile: {
      fullName,
      email: userEmail || '',
      githubUsername: profile?.github_username || null,
    },
    tier,
    activeKeyCount,
    maxKeys,
    quota: { totalUsage, quota, oldQuota, periodEnd },
  }
}

export interface QuotaBannerResult {
  html: string
  visible: boolean
}

/**
 * Build the 80%+ quota warning/error banner markup (SMI-4463), including
 * the SMI-5558 current-period grandfathering carve-out: a user who was
 * well within the OLD (pre-cut) quota should not see the alarming "calls
 * will fail" error banner purely because their already-accrued usage now
 * reads as over a NEW, smaller quota. Grandfathering is naturally scoped
 * to the current billing period only — once it rolls over, totalUsage
 * resets to 0 and is evaluated fresh against the new quota.
 */
export function renderQuotaBanner(params: {
  tier: string
  totalUsage: number
  quota: number
  oldQuota: number
  periodEnd: string
}): QuotaBannerResult {
  const { tier, totalUsage, quota, oldQuota, periodEnd } = params
  if (quota <= 0) return { html: '', visible: false } // unlimited tier — never show

  const percentUsed = totalUsage / quota
  const percentUsedOld = oldQuota > 0 ? totalUsage / oldQuota : 0
  const isGrandfathered = percentUsed >= 1.0 && percentUsedOld < 1.0
  const resetsHuman = periodEnd
    ? new Date(periodEnd).toUTCString().replace('GMT', 'UTC')
    : 'next period'
  const tierName = tier.charAt(0).toUpperCase() + tier.slice(1)
  const isCommunity = tier === 'community'

  if (percentUsed >= 1.0 && !isGrandfathered) {
    const ctaHtml = isCommunity
      ? `<a href="/pricing" class="inline-block rounded-md bg-red-600 px-4 py-2 font-medium text-white hover:bg-red-700">Upgrade</a>`
      : `<a href="mailto:support@skillsmith.app" class="inline-block rounded-md bg-red-600 px-4 py-2 font-medium text-white hover:bg-red-700">Contact support</a>`
    const bodyHtml = isCommunity
      ? `New API calls will fail until your quota resets on <span class="text-white">${resetsHuman}</span>, or upgrade for higher limits.`
      : `Contact support to extend your limit before your next billing cycle (${resetsHuman}).`
    return {
      visible: true,
      html: `
        <div class="quota-banner quota-banner-error mb-6 rounded-xl border border-red-500/50 bg-red-500/10 p-4 text-sm" role="alert" data-resets-at="${periodEnd}">
          <div class="flex items-start gap-3">
            <svg class="h-6 w-6 flex-shrink-0 text-red-400" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z"/></svg>
            <div class="flex-1">
              <p class="font-medium text-white">You've used 100% of your <strong>${tierName}</strong> tier monthly quota.</p>
              <p class="mt-1 text-dark-300">${bodyHtml}</p>
              <p class="mt-3">${ctaHtml}</p>
            </div>
          </div>
        </div>`,
    }
  }

  if (isGrandfathered) {
    const upgradeLink = isCommunity
      ? ` <a href="/pricing" class="text-yellow-300 underline hover:text-yellow-200">View plans</a>`
      : ''
    return {
      visible: true,
      html: `
        <div class="quota-banner quota-banner-warn mb-6 rounded-xl border border-yellow-500/50 bg-yellow-500/10 p-4 text-sm" role="status" data-resets-at="${periodEnd}">
          <div class="flex items-start gap-3">
            <svg class="h-6 w-6 flex-shrink-0 text-yellow-400" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z"/></svg>
            <div class="flex-1">
              <p class="font-medium text-white">Your <strong>${tierName}</strong> tier's monthly quota has changed.</p>
              <p class="mt-1 text-dark-300">This billing cycle's usage is grandfathered at your prior limit and won't be interrupted. The new, lower quota applies starting ${resetsHuman}.${upgradeLink}</p>
            </div>
          </div>
        </div>`,
    }
  }

  if (percentUsed >= 0.8) {
    const percentDisplay = Math.round(percentUsed * 100)
    const upgradeLink = isCommunity
      ? ` <a href="/pricing" class="text-yellow-300 underline hover:text-yellow-200">Upgrade for more headroom</a>`
      : ''
    return {
      visible: true,
      html: `
        <div class="quota-banner quota-banner-warn mb-6 rounded-xl border border-yellow-500/50 bg-yellow-500/10 p-4 text-sm" role="status" data-resets-at="${periodEnd}">
          <div class="flex items-start gap-3">
            <svg class="h-6 w-6 flex-shrink-0 text-yellow-400" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z"/></svg>
            <div class="flex-1">
              <p class="font-medium text-white">You've used <strong>${percentDisplay}%</strong> of your monthly quota.</p>
              <p class="mt-1 text-dark-300">Resets ${resetsHuman}.${upgradeLink}</p>
            </div>
          </div>
        </div>`,
    }
  }

  return { html: '', visible: false }
}
