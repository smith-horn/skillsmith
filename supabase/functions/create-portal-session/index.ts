/**
 * POST /functions/v1/create-portal-session - Create Stripe Billing Portal Session
 * @module create-portal-session
 *
 * SMI-1592: Stripe Billing Portal Integration
 *
 * Creates a Stripe Billing Portal session that allows users to:
 * - Update payment methods
 * - View invoice history
 * - Cancel subscriptions
 * - Manage subscription (with portal configuration)
 *
 * Request:
 * - Authorization: Bearer <supabase_jwt>
 * - Body: { returnUrl?: string }
 *
 * Response:
 * - url: Stripe billing portal URL
 */

import Stripe from 'https://esm.sh/stripe@14.5.0'
import {
  handleCorsPreflightRequest,
  jsonResponse,
  errorResponse,
  buildCorsHeaders,
} from '../_shared/cors.ts'
import { createSupabaseClient, getRequestId, logInvocation } from '../_shared/supabase.ts'

// Default return URL - handle undefined APP_URL gracefully
const APP_URL = Deno.env.get('APP_URL') || 'https://skillsmith.dev'
const DEFAULT_RETURN_URL = `${APP_URL}/account/subscription`

interface PortalRequest {
  returnUrl?: string
}

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
  logInvocation('create-portal-session', requestId)

  // Get Stripe secret key
  const stripeSecretKey = Deno.env.get('STRIPE_SECRET_KEY')
  if (!stripeSecretKey) {
    console.error('STRIPE_SECRET_KEY not configured')
    return errorResponse('Payment service not configured', 503, undefined, origin)
  }

  // Verify authorization
  const authHeader = req.headers.get('Authorization')
  if (!authHeader) {
    return errorResponse('Missing authorization header', 401, undefined, origin)
  }

  try {
    // Create Supabase client with user's auth
    const supabase = createSupabaseClient(authHeader)

    // Get current user
    const {
      data: { user },
      error: authError,
    } = await supabase.auth.getUser()
    if (authError || !user) {
      console.error('Auth error:', authError)
      return errorResponse('Unauthorized', 401, undefined, origin)
    }

    // Get user's subscription with Stripe customer ID
    const { data: subscription, error: subError } = await supabase
      .from('subscriptions')
      .select('stripe_customer_id, status')
      .eq('user_id', user.id)
      .order('created_at', { ascending: false })
      .limit(1)
      .single()

    if (subError || !subscription?.stripe_customer_id) {
      console.error('Subscription lookup error:', subError)
      return errorResponse(
        'No active subscription found. You must have an active subscription to access the billing portal.',
        404,
        undefined,
        origin
      )
    }

    // Parse request body for return URL
    let body: PortalRequest = {}
    try {
      const text = await req.text()
      if (text) {
        body = JSON.parse(text)
      }
    } catch {
      // Empty body is fine
    }

    const returnUrl = body.returnUrl || DEFAULT_RETURN_URL

    // Initialize Stripe
    const stripe = new Stripe(stripeSecretKey, {
      apiVersion: '2023-10-16',
    })

    // Create billing portal session
    const session = await stripe.billingPortal.sessions.create({
      customer: subscription.stripe_customer_id,
      return_url: returnUrl,
    })

    console.log('Billing portal session created', {
      customerId: subscription.stripe_customer_id,
      userId: user.id,
    })

    // Return portal URL
    const responseData = {
      url: session.url,
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
    console.error('Portal session error:', error)

    // Handle Stripe errors specifically
    if (error instanceof Stripe.errors.StripeError) {
      return errorResponse(
        error.message,
        error.statusCode || 500,
        { code: error.code, type: error.type },
        origin
      )
    }

    return errorResponse('Internal server error', 500, { request_id: requestId }, origin)
  }
})
