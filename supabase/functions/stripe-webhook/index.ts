/**
 * POST /functions/v1/stripe-webhook - Handle Stripe Webhook Events
 * @module stripe-webhook
 *
 * SMI-1177: Stripe webhook handlers
 * SMI-1164: License key delivery after payment
 *
 * Handles:
 * - checkout.session.completed: Create subscription and generate license key
 * - customer.subscription.updated: Update subscription status
 * - customer.subscription.deleted: Mark subscription as canceled
 * - invoice.payment_succeeded: Track successful payments
 * - invoice.payment_failed: Handle failed payments
 */

import Stripe from 'https://esm.sh/stripe@14.5.0'
import { createSupabaseAdminClient, logInvocation, getRequestId } from '../_shared/supabase.ts'

// Stripe webhook secret for signature verification
const STRIPE_WEBHOOK_SECRET = Deno.env.get('STRIPE_WEBHOOK_SECRET')
const STRIPE_SECRET_KEY = Deno.env.get('STRIPE_SECRET_KEY')

// License key prefix
const LICENSE_KEY_PREFIX = 'sk_live_'

/**
 * Generate a secure license key
 */
function generateLicenseKey(): { key: string; hash: string; prefix: string } {
  // Generate 32 random bytes for the key
  const bytes = new Uint8Array(32)
  crypto.getRandomValues(bytes)

  // Convert to base64url (URL-safe)
  const keyBody = btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=/g, '')

  const key = `${LICENSE_KEY_PREFIX}${keyBody}`
  const prefix = key.substring(0, 16) + '...'

  // Hash the key for storage (we don't store the actual key)
  return {
    key,
    hash: '', // Will be computed below
    prefix,
  }
}

/**
 * Compute SHA-256 hash of a string
 */
async function hashKey(key: string): Promise<string> {
  const encoder = new TextEncoder()
  const data = encoder.encode(key)
  const hashBuffer = await crypto.subtle.digest('SHA-256', data)
  const hashArray = Array.from(new Uint8Array(hashBuffer))
  return hashArray.map((b) => b.toString(16).padStart(2, '0')).join('')
}

/**
 * Get rate limit based on tier
 */
function getRateLimitForTier(tier: string): number {
  switch (tier) {
    case 'individual':
      return 60 // 60 requests per minute
    case 'team':
      return 120 // 120 requests per minute
    case 'enterprise':
      return 300 // 300 requests per minute
    default:
      return 30 // Community tier
  }
}

Deno.serve(async (req: Request) => {
  // Only allow POST requests
  if (req.method !== 'POST') {
    return new Response('Method not allowed', { status: 405 })
  }

  const requestId = getRequestId(req.headers)
  logInvocation('stripe-webhook', requestId)

  // Verify Stripe webhook signature
  if (!STRIPE_WEBHOOK_SECRET || !STRIPE_SECRET_KEY) {
    console.error('Stripe configuration missing')
    return new Response('Webhook configuration error', { status: 500 })
  }

  const signature = req.headers.get('stripe-signature')
  if (!signature) {
    console.error('Missing stripe-signature header')
    return new Response('Missing signature', { status: 400 })
  }

  const body = await req.text()
  const stripe = new Stripe(STRIPE_SECRET_KEY, { apiVersion: '2023-10-16' })

  let event: Stripe.Event
  try {
    event = stripe.webhooks.constructEvent(body, signature, STRIPE_WEBHOOK_SECRET)
  } catch (err) {
    console.error('Webhook signature verification failed:', err)
    return new Response('Invalid signature', { status: 400 })
  }

  console.log(`Received webhook event: ${event.type}`, { eventId: event.id })

  const supabase = createSupabaseAdminClient()

  try {
    switch (event.type) {
      case 'checkout.session.completed': {
        const session = event.data.object as Stripe.Checkout.Session

        // Only handle subscription checkouts
        if (session.mode !== 'subscription') {
          console.log('Ignoring non-subscription checkout')
          break
        }

        const customerId = session.customer as string
        const subscriptionId = session.subscription as string
        const customerEmail = session.customer_email || session.customer_details?.email

        if (!customerEmail) {
          console.error('No customer email in checkout session')
          break
        }

        // Get metadata from session
        const tier = session.metadata?.tier || 'individual'
        const seatCount = parseInt(session.metadata?.seatCount || '1')
        const billingPeriod = session.metadata?.billingPeriod || 'monthly'

        console.log('Processing checkout completion', {
          customerId,
          subscriptionId,
          email: customerEmail,
          tier,
          seatCount,
        })

        // Find or create user profile by email
        const { data: existingUser } = await supabase
          .from('profiles')
          .select('id')
          .eq('email', customerEmail)
          .single()

        let userId: string

        if (existingUser) {
          userId = existingUser.id
        } else {
          // User doesn't exist - they need to sign up first
          // Store checkout info for later association
          console.log('User not found, checkout will be associated when user signs up')

          // We could store this in a pending_checkouts table
          // For now, just log it - the user should have signed up first
          break
        }

        // Get subscription details from Stripe
        const subscription = await stripe.subscriptions.retrieve(subscriptionId)

        // Create subscription record
        const { error: subError } = await supabase.from('subscriptions').insert({
          user_id: userId,
          stripe_customer_id: customerId,
          stripe_subscription_id: subscriptionId,
          tier,
          status: subscription.status,
          billing_period: billingPeriod,
          seat_count: seatCount,
          current_period_start: new Date(subscription.current_period_start * 1000).toISOString(),
          current_period_end: new Date(subscription.current_period_end * 1000).toISOString(),
          cancel_at_period_end: subscription.cancel_at_period_end,
          metadata: {
            checkout_session_id: session.id,
          },
        })

        if (subError) {
          console.error('Failed to create subscription:', subError)
          throw subError
        }

        // Update user's tier
        const { error: profileError } = await supabase
          .from('profiles')
          .update({ tier })
          .eq('id', userId)

        if (profileError) {
          console.error('Failed to update profile tier:', profileError)
        }

        // Generate license key
        const licenseKeyData = generateLicenseKey()
        const keyHash = await hashKey(licenseKeyData.key)

        const { error: keyError } = await supabase.from('license_keys').insert({
          user_id: userId,
          key_hash: keyHash,
          key_prefix: licenseKeyData.prefix,
          name: 'Default License Key',
          tier,
          status: 'active',
          rate_limit_per_minute: getRateLimitForTier(tier),
          metadata: {
            stripe_subscription_id: subscriptionId,
            generated_at: new Date().toISOString(),
          },
        })

        if (keyError) {
          console.error('Failed to create license key:', keyError)
        }

        console.log('Checkout completed successfully', {
          userId,
          tier,
          subscriptionId,
        })

        // TODO: Send welcome email with license key
        // This would integrate with an email service

        break
      }

      case 'customer.subscription.updated': {
        const subscription = event.data.object as Stripe.Subscription

        console.log('Subscription updated', {
          subscriptionId: subscription.id,
          status: subscription.status,
        })

        // Update subscription record
        const { error } = await supabase
          .from('subscriptions')
          .update({
            status: subscription.status,
            current_period_start: new Date(subscription.current_period_start * 1000).toISOString(),
            current_period_end: new Date(subscription.current_period_end * 1000).toISOString(),
            cancel_at_period_end: subscription.cancel_at_period_end,
            canceled_at: subscription.canceled_at
              ? new Date(subscription.canceled_at * 1000).toISOString()
              : null,
          })
          .eq('stripe_subscription_id', subscription.id)

        if (error) {
          console.error('Failed to update subscription:', error)
          throw error
        }

        // If subscription is canceled or past_due, update user tier
        if (subscription.status === 'canceled' || subscription.status === 'unpaid') {
          // Get user from subscription
          const { data: sub } = await supabase
            .from('subscriptions')
            .select('user_id')
            .eq('stripe_subscription_id', subscription.id)
            .single()

          if (sub) {
            // Downgrade to community tier
            await supabase.from('profiles').update({ tier: 'community' }).eq('id', sub.user_id)

            // Revoke license keys
            await supabase
              .from('license_keys')
              .update({ status: 'revoked', revoked_at: new Date().toISOString() })
              .eq('user_id', sub.user_id)
              .neq('tier', 'community')
          }
        }

        break
      }

      case 'customer.subscription.deleted': {
        const subscription = event.data.object as Stripe.Subscription

        console.log('Subscription deleted', { subscriptionId: subscription.id })

        // Mark subscription as canceled
        const { data: sub, error } = await supabase
          .from('subscriptions')
          .update({
            status: 'canceled',
            canceled_at: new Date().toISOString(),
          })
          .eq('stripe_subscription_id', subscription.id)
          .select('user_id')
          .single()

        if (error) {
          console.error('Failed to update deleted subscription:', error)
        }

        // Downgrade user to community
        if (sub) {
          await supabase.from('profiles').update({ tier: 'community' }).eq('id', sub.user_id)

          // Revoke non-community license keys
          await supabase
            .from('license_keys')
            .update({ status: 'revoked', revoked_at: new Date().toISOString() })
            .eq('user_id', sub.user_id)
            .neq('tier', 'community')
        }

        break
      }

      case 'invoice.payment_succeeded': {
        const invoice = event.data.object as Stripe.Invoice

        console.log('Payment succeeded', {
          invoiceId: invoice.id,
          subscriptionId: invoice.subscription,
          amount: invoice.amount_paid,
        })

        // Could log to audit_logs table for billing history
        break
      }

      case 'invoice.payment_failed': {
        const invoice = event.data.object as Stripe.Invoice

        console.log('Payment failed', {
          invoiceId: invoice.id,
          subscriptionId: invoice.subscription,
        })

        // Update subscription status
        if (invoice.subscription) {
          await supabase
            .from('subscriptions')
            .update({ status: 'past_due' })
            .eq('stripe_subscription_id', invoice.subscription)
        }

        // TODO: Send payment failed notification email
        break
      }

      default:
        console.log(`Unhandled event type: ${event.type}`)
    }

    return new Response(JSON.stringify({ received: true }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })
  } catch (error) {
    console.error('Webhook processing error:', error)
    return new Response(
      JSON.stringify({ error: 'Webhook processing failed' }),
      {
        status: 500,
        headers: { 'Content-Type': 'application/json' },
      }
    )
  }
})
