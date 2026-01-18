/**
 * POST /functions/v1/checkout - Create Stripe Checkout Session
 * @module checkout
 *
 * SMI-1071: Website Integration - Stripe Checkout Endpoint
 *
 * Accepts:
 * - tier: 'individual' | 'team' | 'enterprise' (required)
 * - period: 'monthly' | 'annual' (required)
 * - seatCount: number (optional, for team/enterprise)
 *
 * Returns:
 * - url: Stripe Checkout session URL
 * - sessionId: Stripe session ID
 */

import Stripe from 'https://esm.sh/stripe@14.5.0'
import {
  handleCorsPreflightRequest,
  jsonResponse,
  errorResponse,
  buildCorsHeaders,
} from '../_shared/cors.ts'

import { getRequestId, logInvocation } from '../_shared/supabase.ts'

// Valid tiers (excluding 'community' which is free)
const PAID_TIERS = ['individual', 'team', 'enterprise'] as const
type PaidTier = (typeof PAID_TIERS)[number]

// Valid billing periods
const BILLING_PERIODS = ['monthly', 'annual'] as const
type BillingPeriod = (typeof BILLING_PERIODS)[number]

// Request body interface
interface CheckoutRequest {
  tier: PaidTier
  period: BillingPeriod
  seatCount?: number
  email?: string
  successUrl?: string
  cancelUrl?: string
}

// Price IDs from environment (set in Supabase dashboard)
function getPriceIds(): Record<PaidTier, Record<BillingPeriod, string>> {
  return {
    individual: {
      monthly: Deno.env.get('STRIPE_PRICE_INDIVIDUAL_MONTHLY') || '',
      annual: Deno.env.get('STRIPE_PRICE_INDIVIDUAL_ANNUAL') || '',
    },
    team: {
      monthly: Deno.env.get('STRIPE_PRICE_TEAM_MONTHLY') || '',
      annual: Deno.env.get('STRIPE_PRICE_TEAM_ANNUAL') || '',
    },
    enterprise: {
      monthly: Deno.env.get('STRIPE_PRICE_ENTERPRISE_MONTHLY') || '',
      annual: Deno.env.get('STRIPE_PRICE_ENTERPRISE_ANNUAL') || '',
    },
  }
}

// Default URLs
const DEFAULT_SUCCESS_URL = Deno.env.get('APP_URL') + '/signup/success?session_id={CHECKOUT_SESSION_ID}'
const DEFAULT_CANCEL_URL = Deno.env.get('APP_URL') + '/pricing'

Deno.serve(async (req: Request) => {
  const origin = req.headers.get('origin')

  // Handle CORS preflight
  if (req.method === 'OPTIONS') {
    return handleCorsPreflightRequest(origin)
  }

  // Only allow POST requests
  if (req.method !== 'POST') {
    return errorResponse('Method not allowed', 405, undefined, origin)
  }

  const requestId = getRequestId(req.headers)
  logInvocation('checkout', requestId)

  try {
    // Parse and validate request body
    const body: CheckoutRequest = await req.json()

    // Validate tier
    if (!body.tier || !PAID_TIERS.includes(body.tier as PaidTier)) {
      return errorResponse(
        'Invalid tier. Must be one of: individual, team, enterprise',
        400,
        { received: body.tier },
        origin
      )
    }

    // Validate period
    if (!body.period || !BILLING_PERIODS.includes(body.period as BillingPeriod)) {
      return errorResponse(
        'Invalid period. Must be one of: monthly, annual',
        400,
        { received: body.period },
        origin
      )
    }

    // Validate seat count for team/enterprise
    const seatCount = body.seatCount ?? 1
    if (seatCount < 1 || seatCount > 1000) {
      return errorResponse(
        'Seat count must be between 1 and 1000',
        400,
        { received: seatCount },
        origin
      )
    }

    // Get Stripe secret key
    const stripeSecretKey = Deno.env.get('STRIPE_SECRET_KEY')
    if (!stripeSecretKey) {
      console.error('STRIPE_SECRET_KEY not configured')
      return errorResponse('Payment service not configured', 503, undefined, origin)
    }

    // Get price ID for tier/period combination
    const priceIds = getPriceIds()
    const priceId = priceIds[body.tier as PaidTier][body.period as BillingPeriod]

    if (!priceId) {
      console.error(`Price ID not configured for ${body.tier}/${body.period}`)
      return errorResponse(
        'Price not configured for selected plan',
        503,
        { tier: body.tier, period: body.period },
        origin
      )
    }

    // Initialize Stripe
    const stripe = new Stripe(stripeSecretKey, {
      apiVersion: '2023-10-16',
    })

    // Build success/cancel URLs
    const successUrl = body.successUrl || DEFAULT_SUCCESS_URL
    const cancelUrl = body.cancelUrl || DEFAULT_CANCEL_URL

    // Create checkout session
    const sessionParams: Stripe.Checkout.SessionCreateParams = {
      mode: 'subscription',
      line_items: [
        {
          price: priceId,
          quantity: seatCount,
        },
      ],
      success_url: successUrl,
      cancel_url: cancelUrl,
      metadata: {
        tier: body.tier,
        billingPeriod: body.period,
        seatCount: String(seatCount),
        source: 'skillsmith-website',
      },
      subscription_data: {
        metadata: {
          tier: body.tier,
          seatCount: String(seatCount),
        },
      },
    }

    // Add customer email if provided
    if (body.email) {
      sessionParams.customer_email = body.email
    }

    // Allow seat quantity changes for team/enterprise
    if (body.tier === 'team' || body.tier === 'enterprise') {
      sessionParams.line_items![0].adjustable_quantity = {
        enabled: true,
        minimum: 1,
        maximum: 1000,
      }
    }

    const session = await stripe.checkout.sessions.create(sessionParams)

    console.log('Checkout session created', {
      sessionId: session.id,
      tier: body.tier,
      period: body.period,
      seatCount,
    })

    // Return success response
    const responseData = {
      url: session.url,
      sessionId: session.id,
    }

    const jsonRes = jsonResponse(responseData)
    const headers = new Headers(jsonRes.headers)
    Object.entries(buildCorsHeaders(origin)).forEach(([key, value]) => {
      headers.set(key, value)
    })
    headers.set('X-Request-ID', requestId)

    return new Response(jsonRes.body, {
      status: 200,
      headers,
    })
  } catch (error) {
    console.error('Checkout error:', error)

    // Handle Stripe errors specifically
    if (error instanceof Stripe.errors.StripeError) {
      return errorResponse(
        error.message,
        error.statusCode || 500,
        { code: error.code, type: error.type },
        origin
      )
    }

    // Handle JSON parse errors
    if (error instanceof SyntaxError) {
      return errorResponse('Invalid JSON in request body', 400, undefined, origin)
    }

    return errorResponse('Internal server error', 500, { request_id: requestId }, origin)
  }
})
