#!/usr/bin/env node
/**
 * SMI-3340: Remediate expiring pending_checkouts for paying customers
 *
 * Two customers completed checkout but never created Supabase accounts.
 * The process_pending_checkout() RPC still has issues with period dates
 * (uses created_at instead of actual Stripe billing period). This script
 * fetches real Stripe subscription data and creates subscriptions directly.
 *
 * Usage:
 *   varlock run -- node scripts/remediate-pending-checkouts.mjs           # Dry run
 *   varlock run -- node scripts/remediate-pending-checkouts.mjs --execute # Live run
 *
 * Environment (injected by Varlock):
 *   SUPABASE_URL            - Supabase project URL
 *   SUPABASE_SERVICE_ROLE_KEY - Service role key for admin access
 *   STRIPE_SECRET_KEY       - Stripe secret key for subscription lookups
 */

import { createClient } from '@supabase/supabase-js'
import Stripe from 'stripe'

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const DRY_RUN = !process.argv.includes('--execute')

const SUPABASE_URL = process.env.SUPABASE_URL
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY
const STRIPE_KEY = process.env.STRIPE_SECRET_KEY

if (!SUPABASE_URL || !SUPABASE_KEY || !STRIPE_KEY) {
  console.error(
    'Missing required env vars: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, STRIPE_SECRET_KEY'
  )
  console.error('Run via: varlock run -- node scripts/remediate-pending-checkouts.mjs')
  process.exit(1)
}

// Target emails for remediation
// TODO(SMI-3340): Delete this script after remediation is complete
const TARGET_EMAILS = ['tingsong.dai@gmail.com', 'robert@humanrace.ai']

// Tier mapping from Stripe price IDs to Skillsmith tiers
// Falls back to pending_checkout metadata if price lookup is ambiguous
const PRICE_TIER_MAP = {
  // Add known price IDs here if needed; the script also falls back to
  // the tier stored in pending_checkouts.tier (set from checkout metadata)
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function maskEmail(email) {
  const [local, domain] = email.split('@')
  const visible = local.slice(0, 3)
  return `${visible}***@${domain}`
}

function toISO(epoch) {
  if (!epoch) return null
  return new Date(epoch * 1000).toISOString()
}

function log(msg, data) {
  const prefix = DRY_RUN ? '[DRY RUN]' : '[EXECUTE]'
  if (data) {
    console.log(`${prefix} ${msg}`, data)
  } else {
    console.log(`${prefix} ${msg}`)
  }
}

function warn(msg, data) {
  const prefix = DRY_RUN ? '[DRY RUN]' : '[EXECUTE]'
  if (data) {
    console.warn(`${prefix} WARNING: ${msg}`, data)
  } else {
    console.warn(`${prefix} WARNING: ${msg}`)
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  log('=== Pending Checkout Remediation (SMI-3340) ===')
  log(`Mode: ${DRY_RUN ? 'DRY RUN (pass --execute to apply)' : 'LIVE EXECUTION'}`)
  log('')

  const supabase = createClient(SUPABASE_URL, SUPABASE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  })
  const stripe = new Stripe(STRIPE_KEY)

  let successCount = 0
  let skipCount = 0
  let errorCount = 0

  for (const email of TARGET_EMAILS) {
    const masked = maskEmail(email)
    log(`--- Processing ${masked} ---`)

    // Step 1: Fetch pending_checkout row
    const { data: pending, error: pendingErr } = await supabase
      .from('pending_checkouts')
      .select('*')
      .eq('email', email)
      .is('processed_at', null)
      .single()

    if (pendingErr || !pending) {
      warn(`No unprocessed pending_checkout found for ${masked}`, pendingErr?.message)
      skipCount++
      continue
    }

    log(`Found pending_checkout`, {
      id: pending.id,
      email: masked,
      stripe_sub: pending.stripe_subscription_id,
      tier: pending.tier,
      expires_at: pending.expires_at,
      trial_start: pending.trial_start,
      trial_end: pending.trial_end,
    })

    // Step 2: Fetch actual Stripe subscription
    let subscription
    try {
      subscription = await stripe.subscriptions.retrieve(pending.stripe_subscription_id)
    } catch (stripeErr) {
      warn(`Failed to retrieve Stripe subscription ${pending.stripe_subscription_id}`, {
        error: stripeErr.message,
      })
      errorCount++
      continue
    }

    const stripeData = {
      status: subscription.status,
      current_period_start: toISO(subscription.current_period_start),
      current_period_end: toISO(subscription.current_period_end),
      trial_start: toISO(subscription.trial_start),
      trial_end: toISO(subscription.trial_end),
      cancel_at_period_end: subscription.cancel_at_period_end,
      price_id: subscription.items?.data?.[0]?.price?.id,
      price_nickname: subscription.items?.data?.[0]?.price?.nickname,
    }

    log(`Stripe subscription data`, stripeData)

    // Determine tier: use price map if available, fall back to pending_checkout
    const tier = PRICE_TIER_MAP[stripeData.price_id] || pending.tier
    log(`Resolved tier: ${tier}`)

    // Step 3: Check if profile exists
    const { data: profile, error: profileErr } = await supabase
      .from('profiles')
      .select('id, email, tier')
      .eq('email', email)
      .single()

    if (profileErr || !profile) {
      warn(
        `No profile found for ${masked} -- user has not signed up yet.` +
          ' Cannot create subscription without user_id.' +
          ' The pending_checkout will be processed by the signup trigger IF it has not expired.' +
          ` Expires: ${pending.expires_at}`
      )
      // Extend expiry if close to expiration so the trigger can still fire
      const expiresAt = new Date(pending.expires_at)
      const now = new Date()
      const hoursUntilExpiry = (expiresAt - now) / (1000 * 60 * 60)

      if (hoursUntilExpiry < 48) {
        log(`Expiry is within 48 hours (${hoursUntilExpiry.toFixed(1)}h). Extending by 14 days.`)
        if (!DRY_RUN) {
          const { error: extendErr } = await supabase
            .from('pending_checkouts')
            .update({
              expires_at: new Date(now.getTime() + 14 * 24 * 60 * 60 * 1000).toISOString(),
            })
            .eq('id', pending.id)

          if (extendErr) {
            warn(`Failed to extend expiry`, extendErr.message)
            errorCount++
          } else {
            log(`Extended expiry by 14 days`)
          }
        } else {
          log(`Would extend expiry by 14 days`)
        }

        // Also update trial columns from Stripe if they were missing
        if (subscription.trial_start && !pending.trial_start) {
          log(`Pending checkout is missing trial dates -- updating from Stripe`)
          if (!DRY_RUN) {
            const { error: trialErr } = await supabase
              .from('pending_checkouts')
              .update({
                trial_start: toISO(subscription.trial_start),
                trial_end: toISO(subscription.trial_end),
              })
              .eq('id', pending.id)

            if (trialErr) {
              warn(`Failed to update trial dates`, trialErr.message)
            } else {
              log(`Updated trial dates on pending_checkout`)
            }
          } else {
            log(`Would update trial dates on pending_checkout`)
          }
        }
      }

      skipCount++
      continue
    }

    log(`Found profile`, { user_id: profile.id, current_tier: profile.tier })

    // Step 4: Check if subscription already exists (idempotency)
    const { data: existingSub } = await supabase
      .from('subscriptions')
      .select('id, stripe_subscription_id, status')
      .eq('stripe_subscription_id', pending.stripe_subscription_id)
      .single()

    if (existingSub) {
      log(`Subscription already exists -- skipping`, {
        id: existingSub.id,
        status: existingSub.status,
      })
      // Still mark pending_checkout as processed
      if (!DRY_RUN) {
        await supabase
          .from('pending_checkouts')
          .update({ processed_at: new Date().toISOString() })
          .eq('id', pending.id)
        log(`Marked pending_checkout as processed`)
      } else {
        log(`Would mark pending_checkout as processed`)
      }
      skipCount++
      continue
    }

    // Step 5: INSERT subscription with actual Stripe data
    const subscriptionRow = {
      user_id: profile.id,
      stripe_customer_id: pending.stripe_customer_id,
      stripe_subscription_id: pending.stripe_subscription_id,
      tier,
      status: subscription.status, // actual Stripe status (active or trialing)
      billing_period: pending.billing_period,
      seat_count: pending.seat_count,
      current_period_start: toISO(subscription.current_period_start),
      current_period_end: toISO(subscription.current_period_end),
      cancel_at_period_end: subscription.cancel_at_period_end,
      trial_start: toISO(subscription.trial_start),
      trial_end: toISO(subscription.trial_end),
      metadata: {
        ...(pending.metadata || {}),
        from_pending_checkout: true,
        checkout_session_id: pending.checkout_session_id,
        remediated_by: 'SMI-3340',
        remediated_at: new Date().toISOString(),
      },
    }

    log(`Will INSERT subscription:`, subscriptionRow)

    if (!DRY_RUN) {
      const { error: insertErr } = await supabase.from('subscriptions').insert(subscriptionRow)

      if (insertErr) {
        warn(`Failed to insert subscription`, insertErr.message)
        errorCount++
        continue
      }
      log(`Subscription created successfully`)
    } else {
      log(`Would INSERT subscription`)
    }

    // Step 6: UPDATE profile tier
    if (profile.tier !== tier) {
      log(`Updating profile tier: ${profile.tier} -> ${tier}`)
      if (!DRY_RUN) {
        const { error: tierErr } = await supabase
          .from('profiles')
          .update({ tier })
          .eq('id', profile.id)

        if (tierErr) {
          warn(`Failed to update profile tier`, tierErr.message)
          errorCount++
        } else {
          log(`Profile tier updated`)
        }
      } else {
        log(`Would update profile tier`)
      }
    } else {
      log(`Profile tier already ${tier} -- no update needed`)
    }

    // Step 7: Mark pending_checkout as processed
    if (!DRY_RUN) {
      const { error: processErr } = await supabase
        .from('pending_checkouts')
        .update({ processed_at: new Date().toISOString() })
        .eq('id', pending.id)

      if (processErr) {
        warn(`Failed to mark pending_checkout as processed`, processErr.message)
        errorCount++
      } else {
        log(`Marked pending_checkout as processed`)
      }
    } else {
      log(`Would mark pending_checkout as processed`)
    }

    // Step 8: License key note
    log(
      `NOTE: License key generation requires the generate-license edge function.` +
        ` After remediation, trigger manually:` +
        ` curl -X POST <SUPABASE_URL>/functions/v1/generate-license` +
        ` -H "Authorization: Bearer <service_role_key>"` +
        ` -H "Content-Type: application/json"` +
        ` -d '{"user_id":"${profile.id}","tier":"${tier}","stripe_subscription_id":"${pending.stripe_subscription_id}"}'`
    )

    successCount++
    log('')
  }

  // Summary
  log('')
  log('=== Summary ===')
  log(`Processed: ${successCount}`)
  log(`Skipped:   ${skipCount}`)
  log(`Errors:    ${errorCount}`)

  if (DRY_RUN) {
    log('')
    log('This was a DRY RUN. No changes were made.')
    log('Pass --execute to apply changes.')
  }

  process.exit(errorCount > 0 ? 1 : 0)
}

main().catch((err) => {
  console.error('Fatal error:', err.message)
  process.exit(2)
})
