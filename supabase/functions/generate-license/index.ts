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

import { createSupabaseAdminClient, logInvocation, getRequestId } from '../_shared/supabase.ts'
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
    // Get user from auth token using admin client
    const token = authHeader.replace('Bearer ', '')

    // Decode JWT to inspect (without verification) for debugging
    let tokenPayload: Record<string, unknown> | null = null
    try {
      const parts = token.split('.')
      if (parts.length === 3) {
        const payload = parts[1]
        const decoded = atob(payload.replace(/-/g, '+').replace(/_/g, '/'))
        tokenPayload = JSON.parse(decoded)
      }
    } catch (e) {
      console.error('Failed to decode token:', e)
    }

    console.log('Token debug:', {
      tokenLength: token?.length,
      tokenParts: token?.split('.').length,
      payload: tokenPayload
        ? {
            sub: tokenPayload.sub,
            email: tokenPayload.email,
            role: tokenPayload.role,
            exp: tokenPayload.exp,
            iat: tokenPayload.iat,
            aud: tokenPayload.aud,
          }
        : null,
      isExpired: tokenPayload?.exp ? (tokenPayload.exp as number) < Date.now() / 1000 : 'unknown',
    })

    // Use admin client to validate token
    const adminClient = createSupabaseAdminClient()
    const {
      data: { user },
      error: authError,
    } = await adminClient.auth.getUser(token)

    console.log('getUser result:', {
      hasUser: !!user,
      userId: user?.id,
      errorMessage: authError?.message,
      errorName: authError?.name,
    })

    if (authError || !user) {
      return errorResponse(
        'Invalid or expired token',
        401,
        {
          debug: {
            errorMessage: authError?.message,
            tokenSub: tokenPayload?.sub,
            tokenExp: tokenPayload?.exp,
          },
        },
        origin
      )
    }

    // Get user's profile to check tier (reuse adminClient from auth)
    console.log('Fetching profile for user:', user.id)

    const { data: profile, error: profileError } = await adminClient
      .from('profiles')
      .select('tier')
      .eq('id', user.id)
      .single()

    console.log('Profile fetch result:', { profile, profileError })

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

    console.log('Generated key with prefix:', prefix)
    console.log('Attempting insert with:', {
      user_id: user.id,
      key_prefix: prefix,
      name: keyName,
      tier,
      rate_limit: getRateLimitForTier(tier),
    })

    // Store the key - use separate INSERT and SELECT for robustness
    // The combined .insert().select() pattern can fail due to RLS on RETURNING clause
    const { error: insertError } = await adminClient.from('license_keys').insert({
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

    if (insertError) {
      console.error('Failed to create key:', {
        code: insertError.code,
        message: insertError.message,
        details: insertError.details,
        hint: insertError.hint,
        userId: user.id,
        tier,
      })

      // Specific error handling for known PostgreSQL error codes
      if (insertError.code === '23505') {
        // Unique constraint violation - key already exists
        return errorResponse(
          'Key already exists. Please refresh and try again.',
          409,
          undefined,
          origin
        )
      }
      if (insertError.code === '23503') {
        // Foreign key violation - user profile doesn't exist
        return errorResponse('User profile not found', 404, undefined, origin)
      }
      if (insertError.code === '42501') {
        // Insufficient privilege - RLS or permission issue
        return errorResponse('Permission denied. Please contact support.', 403, undefined, origin)
      }

      return errorResponse('Failed to generate key', 500, undefined, origin)
    }

    // Fetch the created key separately to avoid RLS issues with RETURNING clause
    const { data: newKey, error: fetchError } = await adminClient
      .from('license_keys')
      .select('id, key_prefix, name, tier, rate_limit_per_minute, created_at')
      .eq('key_hash', keyHash)
      .single()

    // Prepare response data
    let responseData: Record<string, unknown>

    if (fetchError || !newKey) {
      // Key was created but couldn't be fetched - still return success with generated values
      console.warn('Key created but fetch failed:', fetchError)
      responseData = {
        key, // Full key - only shown once!
        prefix,
        name: keyName,
        tier,
        rateLimit: getRateLimitForTier(tier),
        createdAt: new Date().toISOString(),
        warning: 'Save this key securely. It will not be shown again.',
      }
    } else {
      console.log('License key generated', {
        userId: user.id,
        keyId: newKey.id,
        tier,
      })

      // Return the key - this is the ONLY time the full key is shown!
      responseData = {
        key, // Full key - only shown once!
        id: newKey.id,
        prefix: newKey.key_prefix,
        name: newKey.name,
        tier: newKey.tier,
        rateLimit: newKey.rate_limit_per_minute,
        createdAt: newKey.created_at,
        warning: 'Save this key securely. It will not be shown again.',
      }
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
