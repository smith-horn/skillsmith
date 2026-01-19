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
import { generateLicenseKey, hashLicenseKey, getRateLimitForTier } from '../_shared/license.ts'
import { sendWelcomeEmail, sendPaymentFailedEmail } from '../_shared/email.ts'

// Stripe webhook secret for signature verification
const STRIPE_WEBHOOK_SECRET = Deno.env.get('STRIPE_WEBHOOK_SECRET')
const STRIPE_SECRET_KEY = Deno.env.get('STRIPE_SECRET_KEY')

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

        // Find user profile by email
        const { data: existingUser } = await supabase
          .from('profiles')
          .select('id')
          .eq('email', customerEmail)
          .single()

        let userId: string

        if (existingUser) {
          userId = existingUser.id
        } else {
          // User doesn't exist yet - store pending checkout for later association
          console.log('User not found, storing pending checkout for later association')

          // Store in pending_checkouts for when user signs up
          // The pending_checkouts table has a 7-day TTL and a trigger that processes
          // the checkout when the user eventually signs up (see migration 012)
          const { error: pendingError } = await supabase.from('pending_checkouts').upsert(
            {
              email: customerEmail,
              stripe_customer_id: customerId,
              stripe_subscription_id: subscriptionId,
              tier,
              billing_period: billingPeriod,
              seat_count: seatCount,
              checkout_session_id: session.id,
              metadata: session.metadata,
            },
            { onConflict: 'email' }
          )

          if (pendingError) {
            console.error('Failed to store pending checkout:', pendingError)
            // Don't throw - return success to Stripe since payment was received
            // The user can contact support if their subscription isn't set up
          } else {
            console.log('Stored pending checkout for later association', { email: customerEmail })
          }

          // Still return success - Stripe expects 200
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
        const { key: licenseKey, prefix: keyPrefix } = generateLicenseKey()
        const keyHash = await hashLicenseKey(licenseKey)

        // Get subscription record to link the key
        const { data: subRecord } = await supabase
          .from('subscriptions')
          .select('id')
          .eq('stripe_subscription_id', subscriptionId)
          .single()

        const { error: keyError } = await supabase.from('license_keys').insert({
          user_id: userId,
          subscription_id: subRecord?.id || null,
          key_hash: keyHash,
          key_prefix: keyPrefix,
          name: 'Default License Key',
          tier,
          status: 'active',
          rate_limit_per_minute: getRateLimitForTier(tier),
          metadata: {
            stripe_subscription_id: subscriptionId,
            generated_at: new Date().toISOString(),
            // Note: The actual key was sent via email (see TODO below)
          },
        })

        if (keyError) {
          console.error('Failed to create license key:', keyError)
        }

        console.log('Checkout completed successfully', {
          userId,
          tier,
          subscriptionId,
          keyPrefix,
        })

        // Send welcome email with license key
        // The license key is included in this email since it's only shown once
        // Email failures are logged but don't fail the webhook
        const emailSent = await sendWelcomeEmail({
          to: customerEmail,
          licenseKey,
          tier,
          customerName: session.customer_details?.name || undefined,
          billingPeriod,
          seatCount,
        })

        if (emailSent) {
          console.log('Welcome email sent successfully', { email: customerEmail, keyPrefix })
        } else {
          // Email failed but don't fail the webhook - user can retrieve key from dashboard
          console.warn('Failed to send welcome email (non-fatal)', {
            email: customerEmail,
            keyPrefix,
          })
        }

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

        // If subscription is canceled or unpaid, downgrade user
        if (subscription.status === 'canceled' || subscription.status === 'unpaid') {
          const { data: sub } = await supabase
            .from('subscriptions')
            .select('user_id')
            .eq('stripe_subscription_id', subscription.id)
            .single()

          if (sub) {
            // Downgrade to community tier
            await supabase.from('profiles').update({ tier: 'community' }).eq('id', sub.user_id)

            // Revoke non-community license keys
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

        // Log to audit_logs for billing history (if table exists)
        await supabase
          .from('audit_logs')
          .insert({
            action: 'payment_succeeded',
            resource_type: 'invoice',
            resource_id: invoice.id,
            metadata: {
              subscription_id: invoice.subscription,
              amount: invoice.amount_paid,
              currency: invoice.currency,
            },
          })
          .catch((err) => {
            // Log but don't fail - table may not exist in all environments
            console.debug('Audit log insert skipped:', err.message || 'table may not exist')
          })

        break
      }

      case 'invoice.payment_failed': {
        const invoice = event.data.object as Stripe.Invoice

        console.log('Payment failed', {
          invoiceId: invoice.id,
          subscriptionId: invoice.subscription,
        })

        // Update subscription status to past_due
        if (invoice.subscription) {
          await supabase
            .from('subscriptions')
            .update({ status: 'past_due' })
            .eq('stripe_subscription_id', invoice.subscription)
        }

        // Log to audit_logs (if table exists)
        await supabase
          .from('audit_logs')
          .insert({
            action: 'payment_failed',
            resource_type: 'invoice',
            resource_id: invoice.id,
            metadata: {
              subscription_id: invoice.subscription,
              attempt_count: invoice.attempt_count,
            },
          })
          .catch((err) => {
            // Log but don't fail - table may not exist in all environments
            console.debug('Audit log insert skipped:', err.message || 'table may not exist')
          })

        // Send payment failed notification email
        const customerEmail = invoice.customer_email
        if (customerEmail) {
          const emailSent = await sendPaymentFailedEmail(customerEmail, invoice.attempt_count || 1)
          if (!emailSent) {
            console.warn('Failed to send payment failed email (non-fatal)', {
              email: customerEmail,
            })
          }
        }

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
    return new Response(JSON.stringify({ error: 'Webhook processing failed' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    })
  }
})
