/**
 * GitHub authentication utilities for Edge Functions
 * @module _shared/github-auth
 *
 * SMI-1618: Extract shared GitHub auth for reuse across indexer and refresh functions
 *
 * Supports two authentication methods:
 * 1. GitHub App (preferred) - GITHUB_APP_ID, GITHUB_APP_INSTALLATION_ID, GITHUB_APP_PRIVATE_KEY
 * 2. Personal Access Token - GITHUB_TOKEN
 *
 * GitHub App auth provides 5000 requests/hour vs 60 for unauthenticated.
 */

// Cache for GitHub App installation token
let cachedInstallationToken: { token: string; expiresAt: number } | null = null

/**
 * Normalize a PEM key string that may have lost newlines in env var storage
 * Also handles base64-encoded PEM keys
 * Reconstructs proper PEM format with 64-character lines
 */
export function normalizePemKey(key: string): string {
  let normalized = key

  // Check if the key is base64-encoded (doesn't start with -----)
  // Base64 of "-----BEGIN" starts with "LS0tLS1CRUdJTg"
  if (!normalized.startsWith('-----') && normalized.startsWith('LS0tLS')) {
    try {
      // Decode from base64
      normalized = atob(normalized)
      console.log('Decoded base64-encoded PEM key')
    } catch {
      console.log('Key appears to be base64 but failed to decode')
    }
  }

  // Handle escaped newlines (\\n) that might come from JSON encoding
  normalized = normalized.replace(/\\n/g, '\n')

  // If key already has proper newlines, return as-is
  if (normalized.includes('\n') && normalized.split('\n').length > 3) {
    return normalized
  }

  // Extract header, footer, and base64 content
  const headerMatch = normalized.match(/(-----BEGIN [A-Z ]+-----)/)?.[1]
  const footerMatch = normalized.match(/(-----END [A-Z ]+-----)/)?.[1]

  if (headerMatch && footerMatch) {
    const base64 = normalized.replace(headerMatch, '').replace(footerMatch, '').replace(/\s/g, '')

    // Split base64 into 64-character lines
    const lines = base64.match(/.{1,64}/g) || []
    normalized = `${headerMatch}\n${lines.join('\n')}\n${footerMatch}`
  }

  return normalized
}

/**
 * Import a PEM private key for use with Web Crypto
 * Handles both PKCS#1 (RSA PRIVATE KEY) and PKCS#8 (PRIVATE KEY) formats
 */
export async function importPrivateKey(pem: string): Promise<CryptoKey> {
  const normalized = normalizePemKey(pem)
  const isPkcs1 = normalized.includes('-----BEGIN RSA PRIVATE KEY-----')

  // Extract base64 content
  const base64 = normalized
    .replace(/-----BEGIN [A-Z ]+-----/, '')
    .replace(/-----END [A-Z ]+-----/, '')
    .replace(/\s/g, '')

  const binaryDer = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0))

  if (isPkcs1) {
    // PKCS#1 to PKCS#8 conversion
    // PKCS#8 wrapper: SEQUENCE { version, algorithmIdentifier, privateKey }
    const pkcs8Header = new Uint8Array([
      0x30,
      0x82,
      0x00,
      0x00, // SEQUENCE (length TBD)
      0x02,
      0x01,
      0x00, // INTEGER 0 (version)
      0x30,
      0x0d, // SEQUENCE (AlgorithmIdentifier)
      0x06,
      0x09,
      0x2a,
      0x86,
      0x48,
      0x86,
      0xf7,
      0x0d,
      0x01,
      0x01,
      0x01, // OID rsaEncryption
      0x05,
      0x00, // NULL (parameters)
      0x04,
      0x82,
      0x00,
      0x00, // OCTET STRING (length TBD)
    ])

    // Calculate total length
    const totalLen = pkcs8Header.length - 4 + binaryDer.length

    // Create PKCS#8 structure
    const pkcs8 = new Uint8Array(4 + totalLen)
    pkcs8.set(pkcs8Header)
    pkcs8.set(binaryDer, pkcs8Header.length)

    // Set outer SEQUENCE length (total - 4 bytes for header)
    pkcs8[2] = (totalLen >> 8) & 0xff
    pkcs8[3] = totalLen & 0xff

    // Set OCTET STRING length
    pkcs8[pkcs8Header.length - 2] = (binaryDer.length >> 8) & 0xff
    pkcs8[pkcs8Header.length - 1] = binaryDer.length & 0xff

    return await crypto.subtle.importKey(
      'pkcs8',
      pkcs8,
      { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
      false,
      ['sign']
    )
  } else {
    // PKCS#8 format - import directly
    return await crypto.subtle.importKey(
      'pkcs8',
      binaryDer,
      { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
      false,
      ['sign']
    )
  }
}

/**
 * Base64URL encode for JWT
 */
export function base64UrlEncode(data: ArrayBuffer | Uint8Array | string): string {
  const bytes =
    typeof data === 'string'
      ? new TextEncoder().encode(data)
      : data instanceof ArrayBuffer
        ? new Uint8Array(data)
        : data
  const base64 = btoa(String.fromCharCode(...bytes))
  return base64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

/**
 * Create a JWT for GitHub App authentication
 */
export async function createAppJwt(appId: string, privateKey: string): Promise<string> {
  console.log('Creating JWT for GitHub App:', appId)
  console.log('Key length:', privateKey.length, 'chars')

  try {
    const cryptoKey = await importPrivateKey(privateKey)
    console.log('Private key imported successfully')

    const now = Math.floor(Date.now() / 1000)
    const header = { alg: 'RS256', typ: 'JWT' }
    const payload = {
      iat: now - 60, // Issued 60 seconds ago (clock skew)
      exp: now + 600, // Expires in 10 minutes
      iss: appId,
    }

    const headerB64 = base64UrlEncode(JSON.stringify(header))
    const payloadB64 = base64UrlEncode(JSON.stringify(payload))
    const unsignedToken = `${headerB64}.${payloadB64}`

    const signature = await crypto.subtle.sign(
      'RSASSA-PKCS1-v1_5',
      cryptoKey,
      new TextEncoder().encode(unsignedToken)
    )

    const jwt = `${unsignedToken}.${base64UrlEncode(signature)}`
    console.log('JWT created successfully')
    return jwt
  } catch (error) {
    console.error('Failed to create JWT:', error)
    throw error
  }
}

/**
 * Get GitHub App installation access token
 * Returns cached token if still valid
 */
export async function getInstallationToken(): Promise<string | null> {
  const appId = Deno.env.get('GITHUB_APP_ID')
  const installationId = Deno.env.get('GITHUB_APP_INSTALLATION_ID')
  const privateKey = Deno.env.get('GITHUB_APP_PRIVATE_KEY')

  if (!appId || !installationId || !privateKey) {
    return null
  }

  // Check cache
  if (cachedInstallationToken && cachedInstallationToken.expiresAt > Date.now()) {
    return cachedInstallationToken.token
  }

  try {
    const jwt = await createAppJwt(appId, privateKey)

    const response = await fetch(
      `https://api.github.com/app/installations/${installationId}/access_tokens`,
      {
        method: 'POST',
        headers: {
          Accept: 'application/vnd.github.v3+json',
          Authorization: `Bearer ${jwt}`,
          'User-Agent': 'skillsmith-indexer/1.0',
        },
      }
    )

    if (!response.ok) {
      console.error('Failed to get installation token:', response.status, await response.text())
      return null
    }

    const data = (await response.json()) as { token: string; expires_at: string }

    // Cache the token (expire 5 minutes early for safety)
    cachedInstallationToken = {
      token: data.token,
      expiresAt: new Date(data.expires_at).getTime() - 5 * 60 * 1000,
    }

    return data.token
  } catch (error) {
    console.error('Error getting installation token:', error)
    return null
  }
}

/**
 * Build GitHub API headers
 * Tries GitHub App auth first, then falls back to GITHUB_TOKEN (PAT)
 *
 * @param userAgent - Optional custom user agent (default: skillsmith-indexer/1.0)
 */
export async function buildGitHubHeaders(
  userAgent = 'skillsmith-indexer/1.0'
): Promise<Record<string, string>> {
  const headers: Record<string, string> = {
    Accept: 'application/vnd.github.v3+json',
    'User-Agent': userAgent,
  }

  // Try GitHub App authentication first
  const installationToken = await getInstallationToken()
  if (installationToken) {
    headers['Authorization'] = `Bearer ${installationToken}`
    return headers
  }

  // Fall back to PAT
  const token = Deno.env.get('GITHUB_TOKEN')
  if (token) {
    headers['Authorization'] = `Bearer ${token}`
  }

  return headers
}

/**
 * Clear the cached installation token
 * Useful for testing or when token needs to be refreshed
 */
export function clearTokenCache(): void {
  cachedInstallationToken = null
}
