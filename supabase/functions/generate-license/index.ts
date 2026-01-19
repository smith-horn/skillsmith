/**
 * POST /functions/v1/generate-license - Generate License Key for User
 * @module generate-license
 *
 * SMI-1164: License key delivery after payment
 *
 * Generates a new license key for an authenticated user.
 * Requires valid JWT token.
 *
 * Request body (optional):
 * - name: string - Custom name for the key (default: "API Key")
 *
 * Returns:
 * - key: string - The full license key (ONLY shown once!)
 * - id: string - License key ID
 * - prefix: string - Key prefix for identification
 * - tier: string - User's current tier
 */

import {
  createSupabaseClient,
  createSupabaseAdminClient,
  logInvocation,
  getRequestId,
} from '../_shared/supabase.ts'
import {
  handleCorsPreflightRequest,
  jsonResponse,
  errorResponse,
  buildCorsHeaders,
} from '../_shared/cors.ts'
import {
  generateLicenseKey,
  hashLicenseKey,
  getRateLimitForTier,
  getMaxKeysForTier,
} from '../_shared/license.ts'

interface GenerateKeyRequest {
  name?: string
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
  logInvocation('generate-license', requestId)

  // Require authentication
  const authHeader = req.headers.get('Authorization')
  if (!authHeader) {
    return errorResponse('Authentication required', 401, undefined, origin)
  }

  try {
    // Get user from auth token
    const supabase = createSupabaseClient(authHeader)
    const {
      data: { user },
      error: authError,
    } = await supabase.auth.getUser()

    if (authError || !user) {
      return errorResponse('Invalid or expired token', 401, undefined, origin)
    }

    // Get user's profile to check tier
    const adminClient = createSupabaseAdminClient()
    const { data: profile, error: profileError } = await adminClient
      .from('profiles')
      .select('tier')
      .eq('id', user.id)
      .single()

    if (profileError || !profile) {
      return errorResponse('User profile not found', 404, undefined, origin)
    }

    const tier = profile.tier || 'community'
    const maxKeys = getMaxKeysForTier(tier)

    // Count existing active keys
    const { count, error: countError } = await adminClient
      .from('license_keys')
      .select('id', { count: 'exact', head: true })
      .eq('user_id', user.id)
      .eq('status', 'active')

    if (countError) {
      console.error('Failed to count keys:', countError)
      return errorResponse('Failed to check existing keys', 500, undefined, origin)
    }

    if ((count || 0) >= maxKeys) {
      return errorResponse(
        `Maximum ${maxKeys} active key(s) allowed for ${tier} tier. Revoke an existing key first.`,
        400,
        { current: count, max: maxKeys, tier },
        origin
      )
    }

    // Parse request body
    let body: GenerateKeyRequest = {}
    try {
      const text = await req.text()
      if (text) {
        body = JSON.parse(text)
      }
    } catch (parseError) {
      // Log parse error for debugging, but empty body is fine
      console.debug('Request body parse skipped (empty or invalid):', parseError)
    }

    const keyName = body.name?.trim().slice(0, 100) || 'API Key'

    // Generate the key
    const { key, prefix } = generateLicenseKey()
    const keyHash = await hashLicenseKey(key)

    // Store the key
    const { data: newKey, error: insertError } = await adminClient
      .from('license_keys')
      .insert({
        user_id: user.id,
        key_hash: keyHash,
        key_prefix: prefix,
        name: keyName,
        tier,
        status: 'active',
        rate_limit_per_minute: getRateLimitForTier(tier),
        metadata: {
          generated_via: 'api',
          generated_at: new Date().toISOString(),
        },
      })
      .select('id, key_prefix, name, tier, rate_limit_per_minute, created_at')
      .single()

    if (insertError) {
      console.error('Failed to create key:', insertError)
      return errorResponse('Failed to generate key', 500, undefined, origin)
    }

    console.log('License key generated', {
      userId: user.id,
      keyId: newKey.id,
      tier,
    })

    // Return the key - this is the ONLY time the full key is shown!
    const responseData = {
      key, // Full key - only shown once!
      id: newKey.id,
      prefix: newKey.key_prefix,
      name: newKey.name,
      tier: newKey.tier,
      rateLimit: newKey.rate_limit_per_minute,
      createdAt: newKey.created_at,
      warning: 'Save this key securely. It will not be shown again.',
    }

    const jsonRes = jsonResponse(responseData)
    const headers = new Headers(jsonRes.headers)
    Object.entries(buildCorsHeaders(origin)).forEach(([k, v]) => {
      headers.set(k, v)
    })
    headers.set('X-Request-ID', requestId)

    return new Response(jsonRes.body, {
      status: 200,
      headers,
    })
  } catch (error) {
    console.error('Generate license error:', error)
    return errorResponse('Internal server error', 500, { request_id: requestId }, origin)
  }
})
