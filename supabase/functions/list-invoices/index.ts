/**
 * GET /functions/v1/list-invoices - List User's Stripe Invoices
 * @module list-invoices
 *
 * SMI-1595: Invoice PDF Download
 *
 * Fetches invoices from Stripe for the authenticated user.
 * Returns invoice data including:
 * - Invoice number and ID
 * - Date and status
 * - Amount and currency
 * - PDF download URL
 *
 * Request:
 * - Authorization: Bearer <supabase_jwt>
 * - Query params: limit (default 12), starting_after (for pagination)
 *
 * Response:
 * - invoices: Array of invoice objects
 * - hasMore: Boolean indicating if more invoices exist
 */

import Stripe from 'https://esm.sh/stripe@14.5.0'
import {
  handleCorsPreflightRequest,
  jsonResponse,
  errorResponse,
  buildCorsHeaders,
} from '../_shared/cors.ts'
import { createSupabaseClient, getRequestId, logInvocation } from '../_shared/supabase.ts'

// Default and maximum limit
const DEFAULT_LIMIT = 12
const MAX_LIMIT = 100

interface InvoiceResponse {
  id: string
  number: string | null
  status: string
  amount: number
  currency: string
  date: string
  periodStart: string
  periodEnd: string
  pdfUrl: string | null
  hostedInvoiceUrl: string | null
  description: string | null
}

Deno.serve(async (req: Request) => {
  const origin = req.headers.get('origin')

  // Handle CORS preflight
  if (req.method === 'OPTIONS') {
    return handleCorsPreflightRequest(origin)
  }

  // Only allow GET requests
  if (req.method !== 'GET') {
    return errorResponse('Method not allowed', 405, undefined, origin)
  }

  const requestId = getRequestId(req.headers)
  logInvocation('list-invoices', requestId)

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
      .select('stripe_customer_id')
      .eq('user_id', user.id)
      .order('created_at', { ascending: false })
      .limit(1)
      .single()

    if (subError || !subscription?.stripe_customer_id) {
      // No subscription found - return empty invoice list (not an error)
      console.log('No subscription found for user', { userId: user.id })
      return jsonResponse(
        {
          invoices: [],
          hasMore: false,
        },
        200,
        origin
      )
    }

    // Parse query parameters
    const url = new URL(req.url)
    const limitParam = url.searchParams.get('limit')
    const startingAfter = url.searchParams.get('starting_after')

    // Validate and clamp limit
    let limit = DEFAULT_LIMIT
    if (limitParam) {
      const parsed = parseInt(limitParam, 10)
      if (!isNaN(parsed) && parsed > 0) {
        limit = Math.min(parsed, MAX_LIMIT)
      }
    }

    // Initialize Stripe
    const stripe = new Stripe(stripeSecretKey, {
      apiVersion: '2023-10-16',
    })

    // Build Stripe list params
    const listParams: Stripe.InvoiceListParams = {
      customer: subscription.stripe_customer_id,
      limit,
      expand: ['data.subscription'],
    }

    // Add pagination cursor if provided
    if (startingAfter) {
      listParams.starting_after = startingAfter
    }

    // Fetch invoices from Stripe
    const invoices = await stripe.invoices.list(listParams)

    // Transform invoices to response format
    const formattedInvoices: InvoiceResponse[] = invoices.data.map((invoice) => ({
      id: invoice.id,
      number: invoice.number,
      status: invoice.status || 'unknown',
      amount: invoice.amount_paid / 100, // Convert from cents
      currency: invoice.currency.toUpperCase(),
      date: new Date(invoice.created * 1000).toISOString(),
      periodStart: invoice.period_start
        ? new Date(invoice.period_start * 1000).toISOString()
        : new Date(invoice.created * 1000).toISOString(),
      periodEnd: invoice.period_end
        ? new Date(invoice.period_end * 1000).toISOString()
        : new Date(invoice.created * 1000).toISOString(),
      pdfUrl: invoice.invoice_pdf,
      hostedInvoiceUrl: invoice.hosted_invoice_url,
      description: invoice.description,
    }))

    console.log('Invoices retrieved', {
      userId: user.id,
      customerId: subscription.stripe_customer_id,
      count: formattedInvoices.length,
      hasMore: invoices.has_more,
    })

    const responseData = {
      invoices: formattedInvoices,
      hasMore: invoices.has_more,
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
    console.error('List invoices error:', error)

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
