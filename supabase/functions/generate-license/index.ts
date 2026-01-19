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

import { createSupabaseClient, createSupabaseAdminClient, logInvocation, getRequestId } from '../_shared/supabase.ts'
import {
  handleCorsPreflightRequest,
  jsonResponse,
  errorResponse,
  buildCorsHeaders,
} from '../_shared/cors.ts'

// License key prefix
const LICENSE_KEY_PREFIX = 'sk_live_'

// Max keys per user by tier
const MAX_KEYS_BY_TIER: Record<string, number> = {
  community: 1,
  individual: 3,
  team: 10,
  enterprise: 50,
}

/**
 * Generate a secure license key
 */
function generateLicenseKey(): { key: string; prefix: string } {
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

  return { key, prefix }
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
      return 60
    case 'team':
      return 120
    case 'enterprise':
      return 300
    default:
      return 30
  }
}

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
    const { data: { user }, error: authError } = await supabase.auth.getUser()

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
    const maxKeys = MAX_KEYS_BY_TIER[tier] || 1

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
      body = await req.json()
    } catch {
      // Empty body is fine
    }

    const keyName = body.name?.trim().slice(0, 100) || 'API Key'

    // Generate the key
    const { key, prefix } = generateLicenseKey()
    const keyHash = await hashKey(key)

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
