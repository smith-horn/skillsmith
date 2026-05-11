/**
 * GitHub authentication for the Node indexer entrypoint
 * @module scripts/indexer/_shared/github-auth
 *
 * SMI-4852: Node-flavored sibling of `supabase/functions/_shared/github-auth.ts`.
 * Web Crypto API is available globally on Node ≥ 19. Bodies are byte-identical
 * for the pure-crypto helpers (`normalizePemKey`, `importPrivateKey`,
 * `base64UrlEncode`, `createAppJwt`) — only the env access swaps
 * `Deno.env.get(...)` for `process.env...`. Parity check via grep-equivalence
 * documented in the Deno parent file's docblock.
 */

let cachedInstallationToken: { token: string; expiresAt: number } | null = null

export function normalizePemKey(key: string): string {
  let normalized = key

  if (!normalized.startsWith('-----') && normalized.startsWith('LS0tLS')) {
    try {
      normalized = atob(normalized)
    } catch {
      // fall through
    }
  }

  normalized = normalized.replace(/\\n/g, '\n')

  if (normalized.includes('\n') && normalized.split('\n').length > 3) {
    return normalized
  }

  const headerMatch = normalized.match(/(-----BEGIN [A-Z ]+-----)/)?.[1]
  const footerMatch = normalized.match(/(-----END [A-Z ]+-----)/)?.[1]

  if (headerMatch && footerMatch) {
    const base64 = normalized.replace(headerMatch, '').replace(footerMatch, '').replace(/\s/g, '')
    const lines = base64.match(/.{1,64}/g) || []
    normalized = `${headerMatch}\n${lines.join('\n')}\n${footerMatch}`
  }

  return normalized
}

export async function importPrivateKey(pem: string): Promise<CryptoKey> {
  const normalized = normalizePemKey(pem)
  const isPkcs1 = normalized.includes('-----BEGIN RSA PRIVATE KEY-----')

  const base64 = normalized
    .replace(/-----BEGIN [A-Z ]+-----/, '')
    .replace(/-----END [A-Z ]+-----/, '')
    .replace(/\s/g, '')

  const binaryDer = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0))

  if (isPkcs1) {
    const pkcs8Header = new Uint8Array([
      0x30, 0x82, 0x00, 0x00, 0x02, 0x01, 0x00, 0x30, 0x0d, 0x06, 0x09, 0x2a, 0x86, 0x48, 0x86,
      0xf7, 0x0d, 0x01, 0x01, 0x01, 0x05, 0x00, 0x04, 0x82, 0x00, 0x00,
    ])

    const totalLen = pkcs8Header.length - 4 + binaryDer.length
    const pkcs8 = new Uint8Array(4 + totalLen)
    pkcs8.set(pkcs8Header)
    pkcs8.set(binaryDer, pkcs8Header.length)
    pkcs8[2] = (totalLen >> 8) & 0xff
    pkcs8[3] = totalLen & 0xff
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
    return await crypto.subtle.importKey(
      'pkcs8',
      binaryDer,
      { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
      false,
      ['sign']
    )
  }
}

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

export async function createAppJwt(appId: string, privateKey: string): Promise<string> {
  const cryptoKey = await importPrivateKey(privateKey)

  const now = Math.floor(Date.now() / 1000)
  const header = { alg: 'RS256', typ: 'JWT' }
  const payload = {
    iat: now - 60,
    exp: now + 600,
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

  return `${unsignedToken}.${base64UrlEncode(signature)}`
}

export async function getInstallationToken(): Promise<string | null> {
  const appId = process.env.GITHUB_APP_ID
  const installationId = process.env.GITHUB_APP_INSTALLATION_ID
  const privateKey = process.env.GITHUB_APP_PRIVATE_KEY

  if (!appId || !installationId || !privateKey) {
    return null
  }

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

export async function buildGitHubHeaders(
  userAgent = 'skillsmith-indexer/1.0'
): Promise<Record<string, string>> {
  const headers: Record<string, string> = {
    Accept: 'application/vnd.github.v3+json',
    'User-Agent': userAgent,
  }

  const installationToken = await getInstallationToken()
  if (installationToken) {
    headers['Authorization'] = `Bearer ${installationToken}`
    return headers
  }

  const token = process.env.GITHUB_TOKEN
  if (token) {
    headers['Authorization'] = `Bearer ${token}`
  }

  return headers
}

export function clearTokenCache(): void {
  cachedInstallationToken = null
}
