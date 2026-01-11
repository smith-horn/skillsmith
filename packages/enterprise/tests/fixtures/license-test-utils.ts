/**
 * SMI-1140: License Test Utilities
 *
 * Generates RSA key pairs and test JWT tokens for integration testing
 * the LicenseValidator with real RS256 JWT verification.
 */

import * as jose from 'jose'
import type { GenerateKeyPairResult } from 'jose'
import type { FeatureFlag, LicenseTier } from '../../src/license/types.js'

type JosePrivateKey = GenerateKeyPairResult['privateKey']

// ============================================================================
// Key Pair Generation
// ============================================================================

export interface TestKeyPair {
  publicKey: string
  privateKey: JosePrivateKey
}

/**
 * Generate an RSA key pair for testing
 * Uses RS256 algorithm matching production
 */
export async function generateTestKeyPair(): Promise<TestKeyPair> {
  const { publicKey, privateKey } = await jose.generateKeyPair('RS256', {
    modulusLength: 2048,
  })

  // Export public key as PEM for use with LicenseValidator
  const publicKeyPem = await jose.exportSPKI(publicKey)

  return {
    publicKey: publicKeyPem,
    privateKey,
  }
}

// ============================================================================
// Test Token Options
// ============================================================================

export interface TestTokenOptions {
  tier?: LicenseTier
  features?: FeatureFlag[]
  customerId?: string
  issuedAt?: Date
  expiresAt?: Date
  issuer?: string
  audience?: string
  /** Additional claims to include */
  additionalClaims?: Record<string, unknown>
}

const DEFAULT_OPTIONS: Required<Omit<TestTokenOptions, 'additionalClaims'>> = {
  tier: 'enterprise',
  features: ['sso_saml', 'audit_logging', 'rbac'],
  customerId: 'test-customer-123',
  issuedAt: new Date(),
  expiresAt: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000), // 1 year
  issuer: 'skillsmith',
  audience: 'skillsmith-enterprise',
}

// ============================================================================
// Token Generation
// ============================================================================

/**
 * Create a valid test license JWT
 */
export async function createTestLicenseToken(
  privateKey: JosePrivateKey,
  options: TestTokenOptions = {}
): Promise<string> {
  const opts = { ...DEFAULT_OPTIONS, ...options }

  const payload = {
    tier: opts.tier,
    features: opts.features,
    customerId: opts.customerId,
    issuedAt: Math.floor(opts.issuedAt.getTime() / 1000),
    expiresAt: Math.floor(opts.expiresAt.getTime() / 1000),
    ...opts.additionalClaims,
  }

  return await new jose.SignJWT(payload)
    .setProtectedHeader({ alg: 'RS256' })
    .setIssuer(opts.issuer)
    .setAudience(opts.audience)
    .setExpirationTime(opts.expiresAt)
    .setIssuedAt(opts.issuedAt)
    .sign(privateKey)
}

/**
 * Create an expired test token
 */
export async function createExpiredToken(privateKey: JosePrivateKey): Promise<string> {
  const pastDate = new Date(Date.now() - 24 * 60 * 60 * 1000) // 1 day ago
  return createTestLicenseToken(privateKey, {
    issuedAt: new Date(Date.now() - 48 * 60 * 60 * 1000), // 2 days ago
    expiresAt: pastDate,
  })
}

/**
 * Create a token that's not yet valid (future nbf)
 */
export async function createNotYetValidToken(privateKey: JosePrivateKey): Promise<string> {
  const futureDate = new Date(Date.now() + 24 * 60 * 60 * 1000) // 1 day from now

  const payload = {
    tier: 'enterprise',
    features: ['sso_saml'],
    customerId: 'test-customer',
    issuedAt: Math.floor(futureDate.getTime() / 1000),
    expiresAt: Math.floor((Date.now() + 365 * 24 * 60 * 60 * 1000) / 1000),
  }

  return await new jose.SignJWT(payload)
    .setProtectedHeader({ alg: 'RS256' })
    .setIssuer('skillsmith')
    .setAudience('skillsmith-enterprise')
    .setNotBefore(futureDate)
    .setExpirationTime(new Date(Date.now() + 365 * 24 * 60 * 60 * 1000))
    .sign(privateKey)
}

/**
 * Create a token with wrong issuer
 */
export async function createWrongIssuerToken(privateKey: JosePrivateKey): Promise<string> {
  return createTestLicenseToken(privateKey, {
    issuer: 'wrong-issuer',
  })
}

/**
 * Create a token with wrong audience
 */
export async function createWrongAudienceToken(privateKey: JosePrivateKey): Promise<string> {
  return createTestLicenseToken(privateKey, {
    audience: 'wrong-audience',
  })
}

/**
 * Create a malformed token (not valid JWT structure)
 */
export function createMalformedToken(): string {
  return 'not.a.valid.jwt.token'
}

/**
 * Create a token with invalid JSON payload
 */
export function createInvalidJsonToken(): string {
  const header = Buffer.from(JSON.stringify({ alg: 'RS256' })).toString('base64url')
  const payload = Buffer.from('not-valid-json{{{').toString('base64url')
  const signature = 'invalid-signature'
  return `${header}.${payload}.${signature}`
}

/**
 * Create a token signed with a different key (signature mismatch)
 */
export async function createWrongSignatureToken(
  differentPrivateKey: JosePrivateKey
): Promise<string> {
  return createTestLicenseToken(differentPrivateKey)
}

/**
 * Create a token missing required claims
 */
export async function createMissingClaimsToken(privateKey: JosePrivateKey): Promise<string> {
  const payload = {
    // Missing: tier, features, customerId, issuedAt, expiresAt
    someOtherClaim: 'value',
  }

  return await new jose.SignJWT(payload)
    .setProtectedHeader({ alg: 'RS256' })
    .setIssuer('skillsmith')
    .setAudience('skillsmith-enterprise')
    .setExpirationTime('1y')
    .sign(privateKey)
}

/**
 * Create a token with invalid tier
 */
export async function createInvalidTierToken(privateKey: JosePrivateKey): Promise<string> {
  return createTestLicenseToken(privateKey, {
    tier: 'invalid-tier' as LicenseTier,
  })
}

/**
 * Create a token with invalid features (non-array)
 */
export async function createInvalidFeaturesToken(privateKey: JosePrivateKey): Promise<string> {
  const payload = {
    tier: 'enterprise',
    features: 'not-an-array', // Should be array
    customerId: 'test-customer',
    issuedAt: Math.floor(Date.now() / 1000),
    expiresAt: Math.floor((Date.now() + 365 * 24 * 60 * 60 * 1000) / 1000),
  }

  return await new jose.SignJWT(payload)
    .setProtectedHeader({ alg: 'RS256' })
    .setIssuer('skillsmith')
    .setAudience('skillsmith-enterprise')
    .setExpirationTime('1y')
    .sign(privateKey)
}

/**
 * Create tokens for each tier
 */
export async function createTierTokens(
  privateKey: JosePrivateKey
): Promise<Record<LicenseTier, string>> {
  return {
    individual: await createTestLicenseToken(privateKey, {
      tier: 'individual',
      features: ['basic_analytics', 'email_support'],
    }),
    community: await createTestLicenseToken(privateKey, {
      tier: 'community',
      features: [],
    }),
    team: await createTestLicenseToken(privateKey, {
      tier: 'team',
      features: ['team_workspaces', 'private_skills'],
    }),
    enterprise: await createTestLicenseToken(privateKey, {
      tier: 'enterprise',
      features: ['sso_saml', 'audit_logging', 'rbac'],
    }),
  }
}
