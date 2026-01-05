/**
 * SMI-1053: LicenseValidator Test Suite
 *
 * Comprehensive tests for JWT-based license validation.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import * as jose from 'jose'

import { LicenseValidator } from '../../src/license/LicenseValidator.js'
import type { FeatureFlag, LicensePayload } from '../../src/license/types.js'
import { LICENSE_KEY_ENV_VAR, LICENSE_PUBLIC_KEY_ENV_VAR } from '../../src/license/types.js'

// ============================================================================
// Test Utilities
// ============================================================================

/**
 * Generate an RSA key pair for testing
 */
async function generateTestKeyPair() {
  const { publicKey, privateKey } = await jose.generateKeyPair('RS256')
  return { publicKey, privateKey }
}

/**
 * Export public key as SPKI PEM
 */
async function exportPublicKey(publicKey: jose.KeyLike): Promise<string> {
  return jose.exportSPKI(publicKey)
}

/**
 * Create a signed JWT license token
 */
async function createLicenseToken(
  payload: LicensePayload,
  privateKey: jose.KeyLike,
  options: {
    issuer?: string
    audience?: string
    expiresIn?: string
  } = {}
): Promise<string> {
  const jwt = new jose.SignJWT({
    ...payload,
  })
    .setProtectedHeader({ alg: 'RS256' })
    .setIssuedAt()

  if (options.issuer) {
    jwt.setIssuer(options.issuer)
  }
  if (options.audience) {
    jwt.setAudience(options.audience)
  }
  if (options.expiresIn) {
    jwt.setExpirationTime(options.expiresIn)
  }

  return jwt.sign(privateKey)
}

/**
 * Create a valid test license payload
 */
function createTestPayload(overrides: Partial<LicensePayload> = {}): LicensePayload {
  const now = Math.floor(Date.now() / 1000)
  return {
    tier: 'enterprise',
    features: ['sso_saml', 'rbac', 'audit_logging'],
    customerId: 'cust_test123',
    issuedAt: now,
    expiresAt: now + 86400 * 365, // 1 year from now
    ...overrides,
  }
}

// ============================================================================
// Test Suite
// ============================================================================

describe('LicenseValidator', () => {
  let publicKey: jose.KeyLike
  let privateKey: jose.KeyLike
  let publicKeyPem: string

  // Generate keys before all tests
  beforeEach(async () => {
    const keyPair = await generateTestKeyPair()
    publicKey = keyPair.publicKey
    privateKey = keyPair.privateKey
    publicKeyPem = await exportPublicKey(publicKey)
  })

  afterEach(() => {
    vi.unstubAllEnvs()
  })

  // ==========================================================================
  // Constructor Tests
  // ==========================================================================

  describe('constructor', () => {
    it('should create validator with default options', () => {
      const validator = new LicenseValidator()
      expect(validator).toBeInstanceOf(LicenseValidator)
    })

    it('should create validator with custom options', () => {
      const validator = new LicenseValidator({
        publicKey: publicKeyPem,
        issuer: 'custom-issuer',
        audience: 'custom-audience',
        clockTolerance: 120,
      })
      expect(validator).toBeInstanceOf(LicenseValidator)
    })
  })

  // ==========================================================================
  // validate() Tests
  // ==========================================================================

  describe('validate()', () => {
    it('should validate a valid license token', async () => {
      const validator = new LicenseValidator({ publicKey: publicKeyPem })
      const payload = createTestPayload()
      const token = await createLicenseToken(payload, privateKey, {
        issuer: 'skillsmith',
        audience: 'skillsmith-enterprise',
      })

      const result = await validator.validate(token)

      expect(result.valid).toBe(true)
      expect(result.license).toBeDefined()
      expect(result.license?.tier).toBe('enterprise')
      expect(result.license?.customerId).toBe('cust_test123')
      expect(result.license?.features).toEqual(['sso_saml', 'rbac', 'audit_logging'])
    })

    it('should validate team tier license', async () => {
      const validator = new LicenseValidator({ publicKey: publicKeyPem })
      const payload = createTestPayload({
        tier: 'team',
        features: ['team_workspaces', 'private_skills'],
      })
      const token = await createLicenseToken(payload, privateKey, {
        issuer: 'skillsmith',
        audience: 'skillsmith-enterprise',
      })

      const result = await validator.validate(token)

      expect(result.valid).toBe(true)
      expect(result.license?.tier).toBe('team')
    })

    it('should validate community tier license', async () => {
      const validator = new LicenseValidator({ publicKey: publicKeyPem })
      const payload = createTestPayload({
        tier: 'community',
        features: [],
      })
      const token = await createLicenseToken(payload, privateKey, {
        issuer: 'skillsmith',
        audience: 'skillsmith-enterprise',
      })

      const result = await validator.validate(token)

      expect(result.valid).toBe(true)
      expect(result.license?.tier).toBe('community')
    })

    it('should reject expired token', async () => {
      const validator = new LicenseValidator({ publicKey: publicKeyPem })
      const now = Math.floor(Date.now() / 1000)
      const payload = createTestPayload({
        issuedAt: now - 86400 * 2,
        expiresAt: now - 86400, // Expired yesterday
      })
      const token = await createLicenseToken(payload, privateKey, {
        issuer: 'skillsmith',
        audience: 'skillsmith-enterprise',
        expiresIn: '-1d', // Already expired
      })

      const result = await validator.validate(token)

      expect(result.valid).toBe(false)
      expect(result.error?.code).toBe('TOKEN_EXPIRED')
    })

    it('should reject token with wrong issuer', async () => {
      const validator = new LicenseValidator({ publicKey: publicKeyPem })
      const payload = createTestPayload()
      const token = await createLicenseToken(payload, privateKey, {
        issuer: 'wrong-issuer',
        audience: 'skillsmith-enterprise',
      })

      const result = await validator.validate(token)

      expect(result.valid).toBe(false)
      expect(result.error?.code).toBe('INVALID_TOKEN')
    })

    it('should reject token with wrong audience', async () => {
      const validator = new LicenseValidator({ publicKey: publicKeyPem })
      const payload = createTestPayload()
      const token = await createLicenseToken(payload, privateKey, {
        issuer: 'skillsmith',
        audience: 'wrong-audience',
      })

      const result = await validator.validate(token)

      expect(result.valid).toBe(false)
      expect(result.error?.code).toBe('INVALID_TOKEN')
    })

    it('should reject token with invalid signature', async () => {
      const validator = new LicenseValidator({ publicKey: publicKeyPem })
      const payload = createTestPayload()
      const token = await createLicenseToken(payload, privateKey, {
        issuer: 'skillsmith',
        audience: 'skillsmith-enterprise',
      })

      // Tamper with the signature
      const parts = token.split('.')
      parts[2] = 'invalid_signature'
      const tamperedToken = parts.join('.')

      const result = await validator.validate(tamperedToken)

      expect(result.valid).toBe(false)
      expect(result.error?.code).toBe('INVALID_SIGNATURE')
    })

    it('should reject token with missing required claims', async () => {
      const validator = new LicenseValidator({ publicKey: publicKeyPem })

      // Create a token without required claims
      const jwt = new jose.SignJWT({ tier: 'enterprise' })
        .setProtectedHeader({ alg: 'RS256' })
        .setIssuedAt()
        .setIssuer('skillsmith')
        .setAudience('skillsmith-enterprise')
        .setExpirationTime('1y')

      const token = await jwt.sign(privateKey)
      const result = await validator.validate(token)

      expect(result.valid).toBe(false)
      expect(result.error?.code).toBe('MISSING_CLAIMS')
    })

    it('should reject token with invalid tier', async () => {
      const validator = new LicenseValidator({ publicKey: publicKeyPem })
      const now = Math.floor(Date.now() / 1000)

      const jwt = new jose.SignJWT({
        tier: 'invalid-tier',
        features: [],
        customerId: 'cust_123',
        issuedAt: now,
        expiresAt: now + 86400,
      })
        .setProtectedHeader({ alg: 'RS256' })
        .setIssuedAt()
        .setIssuer('skillsmith')
        .setAudience('skillsmith-enterprise')
        .setExpirationTime('1y')

      const token = await jwt.sign(privateKey)
      const result = await validator.validate(token)

      expect(result.valid).toBe(false)
      expect(result.error?.code).toBe('INVALID_TIER')
    })

    it('should reject completely invalid token', async () => {
      const validator = new LicenseValidator({ publicKey: publicKeyPem })

      const result = await validator.validate('not.a.valid.jwt.token')

      expect(result.valid).toBe(false)
    })

    it('should return error when no public key is configured', async () => {
      const validator = new LicenseValidator()

      const result = await validator.validate('any.token.here')

      expect(result.valid).toBe(false)
      expect(result.error?.code).toBe('INVALID_TOKEN')
      expect(result.error?.message).toContain('No public key configured')
    })
  })

  // ==========================================================================
  // hasFeature() Tests
  // ==========================================================================

  describe('hasFeature()', () => {
    it('should return false when no license is loaded', () => {
      const validator = new LicenseValidator({ publicKey: publicKeyPem })

      expect(validator.hasFeature('sso_saml')).toBe(false)
    })

    it('should return true for explicit license features', async () => {
      const validator = new LicenseValidator({ publicKey: publicKeyPem })
      const payload = createTestPayload({
        features: ['sso_saml', 'rbac'],
      })
      const token = await createLicenseToken(payload, privateKey, {
        issuer: 'skillsmith',
        audience: 'skillsmith-enterprise',
      })

      await validator.validate(token)

      expect(validator.hasFeature('sso_saml')).toBe(true)
      expect(validator.hasFeature('rbac')).toBe(true)
    })

    it('should return false for features not in license', async () => {
      const validator = new LicenseValidator({ publicKey: publicKeyPem })
      const payload = createTestPayload({
        tier: 'team',
        features: ['team_workspaces'],
      })
      const token = await createLicenseToken(payload, privateKey, {
        issuer: 'skillsmith',
        audience: 'skillsmith-enterprise',
      })

      await validator.validate(token)

      expect(validator.hasFeature('sso_saml')).toBe(false)
    })

    it('should return true for tier default features', async () => {
      const validator = new LicenseValidator({ publicKey: publicKeyPem })
      const payload = createTestPayload({
        tier: 'team',
        features: [], // No explicit features, but tier defaults apply
      })
      const token = await createLicenseToken(payload, privateKey, {
        issuer: 'skillsmith',
        audience: 'skillsmith-enterprise',
      })

      await validator.validate(token)

      // Team tier includes these by default
      expect(validator.hasFeature('team_workspaces')).toBe(true)
      expect(validator.hasFeature('private_skills')).toBe(true)
    })

    it('should include all team features for enterprise tier', async () => {
      const validator = new LicenseValidator({ publicKey: publicKeyPem })
      const payload = createTestPayload({
        tier: 'enterprise',
        features: [],
      })
      const token = await createLicenseToken(payload, privateKey, {
        issuer: 'skillsmith',
        audience: 'skillsmith-enterprise',
      })

      await validator.validate(token)

      // Enterprise includes team features
      expect(validator.hasFeature('team_workspaces')).toBe(true)
      expect(validator.hasFeature('sso_saml')).toBe(true)
    })

    it('should return false for all features with community tier', async () => {
      const validator = new LicenseValidator({ publicKey: publicKeyPem })
      const payload = createTestPayload({
        tier: 'community',
        features: [],
      })
      const token = await createLicenseToken(payload, privateKey, {
        issuer: 'skillsmith',
        audience: 'skillsmith-enterprise',
      })

      await validator.validate(token)

      expect(validator.hasFeature('team_workspaces')).toBe(false)
      expect(validator.hasFeature('sso_saml')).toBe(false)
    })
  })

  // ==========================================================================
  // getLicense() Tests
  // ==========================================================================

  describe('getLicense()', () => {
    it('should return null when no license is loaded', () => {
      const validator = new LicenseValidator({ publicKey: publicKeyPem })

      expect(validator.getLicense()).toBeNull()
    })

    it('should return license after successful validation', async () => {
      const validator = new LicenseValidator({ publicKey: publicKeyPem })
      const payload = createTestPayload()
      const token = await createLicenseToken(payload, privateKey, {
        issuer: 'skillsmith',
        audience: 'skillsmith-enterprise',
      })

      await validator.validate(token)
      const license = validator.getLicense()

      expect(license).not.toBeNull()
      expect(license?.tier).toBe('enterprise')
      expect(license?.customerId).toBe('cust_test123')
      expect(license?.rawToken).toBe(token)
    })

    it('should return null after failed validation', async () => {
      const validator = new LicenseValidator({ publicKey: publicKeyPem })

      await validator.validate('invalid.token')

      expect(validator.getLicense()).toBeNull()
    })
  })

  // ==========================================================================
  // getTier() Tests
  // ==========================================================================

  describe('getTier()', () => {
    it('should return community when no license is loaded', () => {
      const validator = new LicenseValidator({ publicKey: publicKeyPem })

      expect(validator.getTier()).toBe('community')
    })

    it('should return correct tier after validation', async () => {
      const validator = new LicenseValidator({ publicKey: publicKeyPem })
      const payload = createTestPayload({ tier: 'team' })
      const token = await createLicenseToken(payload, privateKey, {
        issuer: 'skillsmith',
        audience: 'skillsmith-enterprise',
      })

      await validator.validate(token)

      expect(validator.getTier()).toBe('team')
    })
  })

  // ==========================================================================
  // clearLicense() Tests
  // ==========================================================================

  describe('clearLicense()', () => {
    it('should clear the current license', async () => {
      const validator = new LicenseValidator({ publicKey: publicKeyPem })
      const payload = createTestPayload()
      const token = await createLicenseToken(payload, privateKey, {
        issuer: 'skillsmith',
        audience: 'skillsmith-enterprise',
      })

      await validator.validate(token)
      expect(validator.getLicense()).not.toBeNull()

      validator.clearLicense()

      expect(validator.getLicense()).toBeNull()
      expect(validator.getTier()).toBe('community')
    })
  })

  // ==========================================================================
  // validateFromEnvironment() Tests
  // ==========================================================================

  describe('validateFromEnvironment()', () => {
    it('should return error when no env var is set', async () => {
      const validator = new LicenseValidator({ publicKey: publicKeyPem })

      const result = await validator.validateFromEnvironment()

      expect(result.valid).toBe(false)
      expect(result.error?.code).toBe('MISSING_CLAIMS')
      expect(result.error?.message).toContain(LICENSE_KEY_ENV_VAR)
    })

    it('should validate license from environment variable', async () => {
      const payload = createTestPayload()
      const token = await createLicenseToken(payload, privateKey, {
        issuer: 'skillsmith',
        audience: 'skillsmith-enterprise',
      })

      vi.stubEnv(LICENSE_KEY_ENV_VAR, token)

      const validator = new LicenseValidator({ publicKey: publicKeyPem })
      const result = await validator.validateFromEnvironment()

      expect(result.valid).toBe(true)
      expect(result.license?.tier).toBe('enterprise')
    })
  })

  // ==========================================================================
  // Public Key Loading Tests
  // ==========================================================================

  describe('public key loading', () => {
    it('should load public key from environment variable', async () => {
      vi.stubEnv(LICENSE_PUBLIC_KEY_ENV_VAR, publicKeyPem)

      const validator = new LicenseValidator()
      const payload = createTestPayload()
      const token = await createLicenseToken(payload, privateKey, {
        issuer: 'skillsmith',
        audience: 'skillsmith-enterprise',
      })

      const result = await validator.validate(token)

      expect(result.valid).toBe(true)
    })

    it('should prefer options public key over environment variable', async () => {
      // Set a different (invalid) key in env
      const { publicKey: otherPublicKey } = await generateTestKeyPair()
      const otherPem = await exportPublicKey(otherPublicKey)
      vi.stubEnv(LICENSE_PUBLIC_KEY_ENV_VAR, otherPem)

      // Use the correct key in options
      const validator = new LicenseValidator({ publicKey: publicKeyPem })
      const payload = createTestPayload()
      const token = await createLicenseToken(payload, privateKey, {
        issuer: 'skillsmith',
        audience: 'skillsmith-enterprise',
      })

      const result = await validator.validate(token)

      expect(result.valid).toBe(true)
    })

    it('should support JWK format public key', async () => {
      const jwk = await jose.exportJWK(publicKey)
      const jwkString = JSON.stringify(jwk)

      const validator = new LicenseValidator({ publicKey: jwkString })
      const payload = createTestPayload()
      const token = await createLicenseToken(payload, privateKey, {
        issuer: 'skillsmith',
        audience: 'skillsmith-enterprise',
      })

      const result = await validator.validate(token)

      expect(result.valid).toBe(true)
    })
  })

  // ==========================================================================
  // Custom Options Tests
  // ==========================================================================

  describe('custom options', () => {
    it('should use custom issuer and audience', async () => {
      const validator = new LicenseValidator({
        publicKey: publicKeyPem,
        issuer: 'custom-issuer',
        audience: 'custom-audience',
      })
      const payload = createTestPayload()
      const token = await createLicenseToken(payload, privateKey, {
        issuer: 'custom-issuer',
        audience: 'custom-audience',
      })

      const result = await validator.validate(token)

      expect(result.valid).toBe(true)
    })

    it('should reject token with default issuer when custom is set', async () => {
      const validator = new LicenseValidator({
        publicKey: publicKeyPem,
        issuer: 'custom-issuer',
        audience: 'skillsmith-enterprise',
      })
      const payload = createTestPayload()
      const token = await createLicenseToken(payload, privateKey, {
        issuer: 'skillsmith', // Default issuer, but custom is expected
        audience: 'skillsmith-enterprise',
      })

      const result = await validator.validate(token)

      expect(result.valid).toBe(false)
    })
  })

  // ==========================================================================
  // Edge Cases
  // ==========================================================================

  describe('edge cases', () => {
    it('should handle multiple validations with different tokens', async () => {
      const validator = new LicenseValidator({ publicKey: publicKeyPem })

      // First validation - enterprise
      const payload1 = createTestPayload({ tier: 'enterprise', customerId: 'cust_1' })
      const token1 = await createLicenseToken(payload1, privateKey, {
        issuer: 'skillsmith',
        audience: 'skillsmith-enterprise',
      })
      await validator.validate(token1)
      expect(validator.getTier()).toBe('enterprise')

      // Second validation - team (should replace)
      const payload2 = createTestPayload({ tier: 'team', customerId: 'cust_2' })
      const token2 = await createLicenseToken(payload2, privateKey, {
        issuer: 'skillsmith',
        audience: 'skillsmith-enterprise',
      })
      await validator.validate(token2)
      expect(validator.getTier()).toBe('team')
      expect(validator.getLicense()?.customerId).toBe('cust_2')
    })

    it('should handle empty features array', async () => {
      const validator = new LicenseValidator({ publicKey: publicKeyPem })
      const payload = createTestPayload({ features: [] })
      const token = await createLicenseToken(payload, privateKey, {
        issuer: 'skillsmith',
        audience: 'skillsmith-enterprise',
      })

      const result = await validator.validate(token)

      expect(result.valid).toBe(true)
      expect(result.license?.features).toEqual([])
    })

    it('should preserve raw token in license object', async () => {
      const validator = new LicenseValidator({ publicKey: publicKeyPem })
      const payload = createTestPayload()
      const token = await createLicenseToken(payload, privateKey, {
        issuer: 'skillsmith',
        audience: 'skillsmith-enterprise',
      })

      await validator.validate(token)
      const license = validator.getLicense()

      expect(license?.rawToken).toBe(token)
    })

    it('should convert timestamps to Date objects correctly', async () => {
      const validator = new LicenseValidator({ publicKey: publicKeyPem })
      const now = Math.floor(Date.now() / 1000)
      const expiresAt = now + 86400 * 30 // 30 days

      const payload = createTestPayload({
        issuedAt: now,
        expiresAt: expiresAt,
      })
      const token = await createLicenseToken(payload, privateKey, {
        issuer: 'skillsmith',
        audience: 'skillsmith-enterprise',
      })

      await validator.validate(token)
      const license = validator.getLicense()

      expect(license?.issuedAt).toBeInstanceOf(Date)
      expect(license?.expiresAt).toBeInstanceOf(Date)
      expect(Math.floor(license!.issuedAt.getTime() / 1000)).toBe(now)
      expect(Math.floor(license!.expiresAt.getTime() / 1000)).toBe(expiresAt)
    })
  })

  // ==========================================================================
  // Public Key Cache Tests (SMI-1092)
  // ==========================================================================

  describe('clearKeyCache()', () => {
    it('should clear the cached public key', async () => {
      const validator = new LicenseValidator({ publicKey: publicKeyPem })
      const payload = createTestPayload()
      const token = await createLicenseToken(payload, privateKey, {
        issuer: 'skillsmith',
        audience: 'skillsmith-enterprise',
      })

      // First validation caches the key
      const result1 = await validator.validate(token)
      expect(result1.valid).toBe(true)

      // Clear the key cache
      validator.clearKeyCache()

      // Validation should still work (key is re-imported)
      const result2 = await validator.validate(token)
      expect(result2.valid).toBe(true)
    })

    it('should allow switching public keys after clearKeyCache()', async () => {
      // Generate a second key pair
      const keyPair2 = await generateTestKeyPair()
      const publicKey2 = keyPair2.publicKey
      const privateKey2 = keyPair2.privateKey
      const publicKeyPem2 = await exportPublicKey(publicKey2)

      // Start with first key
      const validator = new LicenseValidator({ publicKey: publicKeyPem })
      const payload = createTestPayload()
      const token1 = await createLicenseToken(payload, privateKey, {
        issuer: 'skillsmith',
        audience: 'skillsmith-enterprise',
      })

      const result1 = await validator.validate(token1)
      expect(result1.valid).toBe(true)

      // Token signed with second key should fail (wrong key cached)
      const token2 = await createLicenseToken(payload, privateKey2, {
        issuer: 'skillsmith',
        audience: 'skillsmith-enterprise',
      })
      const result2 = await validator.validate(token2)
      expect(result2.valid).toBe(false)
      expect(result2.error?.code).toBe('INVALID_SIGNATURE')

      // Clear cache and switch to second key via environment variable
      validator.clearKeyCache()
      vi.stubEnv(LICENSE_PUBLIC_KEY_ENV_VAR, publicKeyPem2)

      // Create a new validator that uses the env var (since options.publicKey takes precedence)
      const validator2 = new LicenseValidator()
      const result3 = await validator2.validate(token2)
      expect(result3.valid).toBe(true)
    })
  })

  describe('keyTtlMs option', () => {
    it('should re-import key after TTL expires', async () => {
      // Use a very short TTL for testing
      const validator = new LicenseValidator({
        publicKey: publicKeyPem,
        keyTtlMs: 50, // 50ms TTL
      })
      const payload = createTestPayload()
      const token = await createLicenseToken(payload, privateKey, {
        issuer: 'skillsmith',
        audience: 'skillsmith-enterprise',
      })

      // First validation caches the key
      const result1 = await validator.validate(token)
      expect(result1.valid).toBe(true)

      // Wait for TTL to expire
      await new Promise((resolve) => setTimeout(resolve, 60))

      // Key should be re-imported (this validation should still succeed)
      const result2 = await validator.validate(token)
      expect(result2.valid).toBe(true)
    })

    it('should use cached key within TTL period', async () => {
      const validator = new LicenseValidator({
        publicKey: publicKeyPem,
        keyTtlMs: 5000, // 5 second TTL
      })
      const payload = createTestPayload()
      const token = await createLicenseToken(payload, privateKey, {
        issuer: 'skillsmith',
        audience: 'skillsmith-enterprise',
      })

      // First validation
      const result1 = await validator.validate(token)
      expect(result1.valid).toBe(true)

      // Second validation within TTL should use cached key
      const result2 = await validator.validate(token)
      expect(result2.valid).toBe(true)
    })

    it('should never expire cache when keyTtlMs is 0 (default)', async () => {
      const validator = new LicenseValidator({
        publicKey: publicKeyPem,
        keyTtlMs: 0, // Default - no expiration
      })
      const payload = createTestPayload()
      const token = await createLicenseToken(payload, privateKey, {
        issuer: 'skillsmith',
        audience: 'skillsmith-enterprise',
      })

      // Multiple validations should all use cached key
      for (let i = 0; i < 5; i++) {
        const result = await validator.validate(token)
        expect(result.valid).toBe(true)
      }
    })

    it('should handle TTL expiration with env var key source', async () => {
      vi.stubEnv(LICENSE_PUBLIC_KEY_ENV_VAR, publicKeyPem)

      const validator = new LicenseValidator({
        keyTtlMs: 50, // 50ms TTL
      })
      const payload = createTestPayload()
      const token = await createLicenseToken(payload, privateKey, {
        issuer: 'skillsmith',
        audience: 'skillsmith-enterprise',
      })

      // First validation
      const result1 = await validator.validate(token)
      expect(result1.valid).toBe(true)

      // Wait for TTL to expire
      await new Promise((resolve) => setTimeout(resolve, 60))

      // Second validation should re-import from env var
      const result2 = await validator.validate(token)
      expect(result2.valid).toBe(true)
    })
  })

  // ==========================================================================
  // Feature Flag Constant Tests
  // ==========================================================================

  describe('feature flag constants', () => {
    it('should have correct team features', () => {
      const teamFeatures: FeatureFlag[] = [
        'team_workspaces',
        'private_skills',
        'usage_analytics',
        'priority_support',
      ]

      // Verify all team features work with hasFeature
      const validator = new LicenseValidator({ publicKey: publicKeyPem })
      // No license loaded, all should be false
      for (const feature of teamFeatures) {
        expect(validator.hasFeature(feature)).toBe(false)
      }
    })

    it('should have correct enterprise features', () => {
      const enterpriseFeatures: FeatureFlag[] = [
        'sso_saml',
        'rbac',
        'audit_logging',
        'siem_export',
        'compliance_reports',
        'private_registry',
      ]

      // Verify all enterprise features work with hasFeature
      const validator = new LicenseValidator({ publicKey: publicKeyPem })
      // No license loaded, all should be false
      for (const feature of enterpriseFeatures) {
        expect(validator.hasFeature(feature)).toBe(false)
      }
    })
  })
})
