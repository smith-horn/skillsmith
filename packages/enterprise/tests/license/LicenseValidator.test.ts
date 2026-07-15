/**
 * SMI-1053: LicenseValidator Test Suite
 *
 * Comprehensive tests for JWT-based license validation.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import * as jose from 'jose'

import { LicenseValidator } from '../../src/license/LicenseValidator.js'
import type { LicensePayload } from '../../src/license/types.js'

// ============================================================================
// Test Utilities
// ============================================================================

/**
 * Key type for jose operations
 */
type JoseKey = Awaited<ReturnType<typeof jose.generateKeyPair>>['publicKey']

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
async function exportPublicKey(publicKey: JoseKey): Promise<string> {
  return jose.exportSPKI(publicKey)
}

/**
 * Create a signed JWT license token
 */
async function createLicenseToken(
  payload: LicensePayload,
  privateKey: JoseKey,
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
  let publicKey: JoseKey
  let privateKey: JoseKey
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
})
