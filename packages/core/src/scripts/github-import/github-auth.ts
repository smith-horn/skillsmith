/**
 * SMI-1445: GitHub App Authentication
 *
 * Provides GitHub App authentication for higher rate limits.
 * Extracted from github-client.ts for file size compliance.
 */

import { webcrypto } from 'crypto'
import { CONFIG } from './types.js'
import { log } from './utils.js'

type CryptoKey = webcrypto.CryptoKey

// Cache for GitHub App installation token
let cachedInstallationToken: { token: string; expiresAt: number } | null = null

/**
 * Normalize a PEM key string that may have lost newlines in env var storage.
 * Also handles base64-encoded PEM keys.
 */
function normalizePemKey(key: string): string {
  let normalized = key

  // Check if the key is base64-encoded (doesn't start with -----)
  if (!normalized.startsWith('-----') && normalized.startsWith('LS0tLS')) {
    try {
      normalized = Buffer.from(normalized, 'base64').toString('utf-8')
      log('Decoded base64-encoded PEM key')
    } catch {
      log('Key appears to be base64 but failed to decode', 'warn')
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
    const lines = base64.match(/.{1,64}/g) || []
    normalized = `${headerMatch}\n${lines.join('\n')}\n${footerMatch}`
  }

  return normalized
}

/**
 * Import a PEM private key for use with Web Crypto.
 * Handles both PKCS#1 (RSA PRIVATE KEY) and PKCS#8 (PRIVATE KEY) formats.
 */
async function importPrivateKey(pem: string): Promise<CryptoKey> {
  const normalized = normalizePemKey(pem)
  const isPkcs1 = normalized.includes('-----BEGIN RSA PRIVATE KEY-----')

  // Extract base64 content
  const base64 = normalized
    .replace(/-----BEGIN [A-Z ]+-----/, '')
    .replace(/-----END [A-Z ]+-----/, '')
    .replace(/\s/g, '')

  const binaryDer = Buffer.from(base64, 'base64')

  if (isPkcs1) {
    // PKCS#1 to PKCS#8 conversion
    const pkcs8Header = Buffer.from([
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

    const totalLen = pkcs8Header.length - 4 + binaryDer.length
    const pkcs8 = Buffer.alloc(4 + totalLen)
    pkcs8Header.copy(pkcs8)
    binaryDer.copy(pkcs8, pkcs8Header.length)

    // Set outer SEQUENCE length
    pkcs8[2] = (totalLen >> 8) & 0xff
    pkcs8[3] = totalLen & 0xff

    // Set OCTET STRING length
    pkcs8[pkcs8Header.length - 2] = (binaryDer.length >> 8) & 0xff
    pkcs8[pkcs8Header.length - 1] = binaryDer.length & 0xff

    return await webcrypto.subtle.importKey(
      'pkcs8',
      pkcs8,
      { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
      false,
      ['sign']
    )
  } else {
    return await webcrypto.subtle.importKey(
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
function base64UrlEncode(data: Buffer | string): string {
  const buffer = typeof data === 'string' ? Buffer.from(data) : data
  return buffer.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

/**
 * Create a JWT for GitHub App authentication
 */
async function createAppJwt(appId: string, privateKey: string): Promise<string> {
  log('Creating JWT for GitHub App authentication...')

  try {
    const cryptoKey = await importPrivateKey(privateKey)

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

    const signature = await webcrypto.subtle.sign(
      'RSASSA-PKCS1-v1_5',
      cryptoKey,
      Buffer.from(unsignedToken)
    )

    const jwt = `${unsignedToken}.${base64UrlEncode(Buffer.from(signature))}`
    log('JWT created successfully')
    return jwt
  } catch (error) {
    log(`Failed to create JWT: ${error}`, 'error')
    throw error
  }
}

/**
 * Get GitHub App installation access token.
 * Returns cached token if valid, otherwise requests new one.
 */
export async function getInstallationToken(): Promise<string | null> {
  const { GITHUB_APP_ID, GITHUB_APP_INSTALLATION_ID, GITHUB_APP_PRIVATE_KEY } = CONFIG

  if (!GITHUB_APP_ID || !GITHUB_APP_INSTALLATION_ID || !GITHUB_APP_PRIVATE_KEY) {
    return null
  }

  // Check cache
  if (cachedInstallationToken && cachedInstallationToken.expiresAt > Date.now()) {
    log('Using cached GitHub App installation token')
    return cachedInstallationToken.token
  }

  try {
    const jwt = await createAppJwt(GITHUB_APP_ID, GITHUB_APP_PRIVATE_KEY)

    const response = await fetch(
      `https://api.github.com/app/installations/${GITHUB_APP_INSTALLATION_ID}/access_tokens`,
      {
        method: 'POST',
        headers: {
          Accept: 'application/vnd.github.v3+json',
          Authorization: `Bearer ${jwt}`,
          'User-Agent': 'Skillsmith-Import/1.0',
        },
      }
    )

    if (!response.ok) {
      const errorText = await response.text()
      log(`Failed to get installation token: ${response.status} - ${errorText}`, 'error')
      return null
    }

    const data = (await response.json()) as { token: string; expires_at: string }

    // Cache the token (expire 5 minutes early for safety)
    cachedInstallationToken = {
      token: data.token,
      expiresAt: new Date(data.expires_at).getTime() - 5 * 60 * 1000,
    }

    log('GitHub App installation token obtained successfully')
    return data.token
  } catch (error) {
    log(`Error getting installation token: ${error}`, 'error')
    return null
  }
}

/**
 * Get GitHub API headers.
 * Tries GitHub App authentication first (5K req/hr), then falls back to PAT.
 */
export async function getGitHubHeaders(): Promise<Record<string, string>> {
  const headers: Record<string, string> = {
    Accept: 'application/vnd.github.v3+json',
    'User-Agent': 'Skillsmith-Import/1.0',
  }

  // Try GitHub App authentication first
  const installationToken = await getInstallationToken()
  if (installationToken) {
    headers['Authorization'] = `Bearer ${installationToken}`
    return headers
  }

  // Fall back to PAT
  if (CONFIG.GITHUB_TOKEN) {
    headers['Authorization'] = `Bearer ${CONFIG.GITHUB_TOKEN}`
  }

  return headers
}
