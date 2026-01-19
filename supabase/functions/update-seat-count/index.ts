/**
 * POST /functions/v1/update-seat-count - Update Subscription Seat Count
 * @module update-seat-count
 *
 * SMI-1594: Seat Quantity Updates
 *
 * Updates the seat count on a team/enterprise subscription.
 * Supports:
 * - Preview mode: Returns proration amount without applying changes
 * - Update mode: Applies the seat count change immediately
 *
 * Request:
 * - Authorization: Bearer <supabase_jwt>
 * - Body: { newSeatCount: number, preview?: boolean }
 *
 * Response (preview):
 * - prorationAmount: Amount that will be charged/credited
 * - newMonthlyAmount: New monthly total
 * - effectiveDate: When the change takes effect
 *
 * Response (update):
 * - success: true
 * - newSeatCount: Updated seat count
 * - prorationAmount: Amount charged/credited
 */

import Stripe from 'https://esm.sh/stripe@14.5.0'
import {
  handleCorsPreflightRequest,
  jsonResponse,
  errorResponse,
  buildCorsHeaders,
} from '../_shared/cors.ts'
import {
  createSupabaseClient,
  createSupabaseAdminClient,
  getRequestId,
  logInvocation,
} from '../_shared/supabase.ts'

interface UpdateSeatRequest {
  newSeatCount: number
  preview?: boolean
}

// Minimum and maximum seat counts
const MIN_SEATS = 1
const MAX_SEATS = 1000

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
  logInvocation('update-seat-count', requestId)

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
    // Parse and validate request body
    const body: UpdateSeatRequest = await req.json()

    // Validate seat count
    const newSeatCount = body.newSeatCount
    if (typeof newSeatCount !== 'number' || !Number.isInteger(newSeatCount)) {
      return errorResponse('newSeatCount must be an integer', 400, undefined, origin)
    }

    if (newSeatCount < MIN_SEATS || newSeatCount > MAX_SEATS) {
      return errorResponse(
        `Seat count must be between ${MIN_SEATS} and ${MAX_SEATS}`,
        400,
        { received: newSeatCount, min: MIN_SEATS, max: MAX_SEATS },
        origin
      )
    }

    const isPreview = body.preview === true

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

    // Get user's subscription with Stripe IDs
    const { data: subscription, error: subError } = await supabase
      .from('subscriptions')
      .select('id, stripe_customer_id, stripe_subscription_id, tier, seat_count, status')
      .eq('user_id', user.id)
      .order('created_at', { ascending: false })
      .limit(1)
      .single()

    if (subError || !subscription?.stripe_subscription_id) {
      console.error('Subscription lookup error:', subError)
      return errorResponse('No active subscription found', 404, undefined, origin)
    }

    // Only allow seat changes for team/enterprise tiers
    if (subscription.tier !== 'team' && subscription.tier !== 'enterprise') {
      return errorResponse(
        'Seat management is only available for Team and Enterprise plans',
        400,
        { currentTier: subscription.tier },
        origin
      )
    }

    // Check subscription status
    if (subscription.status !== 'active' && subscription.status !== 'trialing') {
      return errorResponse(
        'Cannot modify seats on an inactive subscription',
        400,
        { status: subscription.status },
        origin
      )
    }

    // Initialize Stripe
    const stripe = new Stripe(stripeSecretKey, {
      apiVersion: '2023-10-16',
    })

    // Retrieve the subscription to get the subscription item
    const stripeSubscription = await stripe.subscriptions.retrieve(
      subscription.stripe_subscription_id
    )

    if (!stripeSubscription.items.data.length) {
      console.error('No subscription items found')
      return errorResponse('Invalid subscription configuration', 500, undefined, origin)
    }

    const subscriptionItemId = stripeSubscription.items.data[0].id
    const currentQuantity = stripeSubscription.items.data[0].quantity || 1

    // If no change needed, return early
    if (currentQuantity === newSeatCount) {
      return jsonResponse(
        {
          success: true,
          message: 'No change needed',
          currentSeatCount: currentQuantity,
        },
        200,
        origin
      )
    }

    if (isPreview) {
      // Preview mode: Calculate proration without making changes
      const preview = await stripe.invoices.retrieveUpcoming({
        customer: subscription.stripe_customer_id,
        subscription: subscription.stripe_subscription_id,
        subscription_items: [
          {
            id: subscriptionItemId,
            quantity: newSeatCount,
          },
        ],
      })

      // Calculate proration amount (difference from current)
      const currentPeriodAmount = stripeSubscription.items.data[0].price.unit_amount || 0
      const prorationAmount = preview.amount_due - currentPeriodAmount * currentQuantity

      const pricePerSeat = stripeSubscription.items.data[0].price.unit_amount || 0
      const newMonthlyAmount = (pricePerSeat * newSeatCount) / 100

      const responseData = {
        preview: true,
        currentSeatCount: currentQuantity,
        newSeatCount,
        prorationAmount: prorationAmount / 100, // Convert to dollars
        newMonthlyAmount,
        currency: stripeSubscription.items.data[0].price.currency,
        effectiveDate: new Date().toISOString(),
      }

      console.log('Seat update preview', {
        userId: user.id,
        currentSeats: currentQuantity,
        newSeats: newSeatCount,
        proration: prorationAmount / 100,
      })

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
    }

    // Update mode: Apply the change
    const updatedSubscription = await stripe.subscriptions.update(
      subscription.stripe_subscription_id,
      {
        items: [
          {
            id: subscriptionItemId,
            quantity: newSeatCount,
          },
        ],
        proration_behavior: 'create_prorations',
        metadata: {
          seat_count_updated_at: new Date().toISOString(),
          previous_seat_count: String(currentQuantity),
        },
      }
    )

    // Update local database
    const adminSupabase = createSupabaseAdminClient()
    const { error: updateError } = await adminSupabase
      .from('subscriptions')
      .update({
        seat_count: newSeatCount,
        metadata: {
          seat_count_updated_at: new Date().toISOString(),
          previous_seat_count: currentQuantity,
        },
      })
      .eq('id', subscription.id)

    if (updateError) {
      console.error('Failed to update local subscription:', updateError)
      // Don't fail the request - Stripe update succeeded
    }

    console.log('Seat count updated', {
      userId: user.id,
      subscriptionId: subscription.stripe_subscription_id,
      previousSeats: currentQuantity,
      newSeats: newSeatCount,
    })

    const responseData = {
      success: true,
      newSeatCount,
      previousSeatCount: currentQuantity,
      status: updatedSubscription.status,
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
    console.error('Seat update error:', error)

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
