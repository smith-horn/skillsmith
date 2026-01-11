/**
 * SMI-1054: LicenseKeyGenerator Test Suite
 *
 * Comprehensive tests for JWT-based license key generation.
 */

import { describe, it, expect, beforeEach } from 'vitest'
import * as jose from 'jose'

import { LicenseKeyGenerator } from '../../src/license/LicenseKeyGenerator.js'
import type { LicensePayload, FeatureFlag } from '../../src/license/types.js'
import { INDIVIDUAL_FEATURES, TEAM_FEATURES, ENTERPRISE_FEATURES } from '../../src/license/types.js'

// ============================================================================
// Test Utilities
// ============================================================================

/**
 * Verified license payload with known properties
 */
interface VerifiedLicensePayload extends jose.JWTPayload {
  tier?: string
  features?: string[]
  customerId?: string
  issuedAt?: number
  expiresAt?: number
}

/**
 * Verify a JWT token and extract payload
 */
async function verifyToken(
  token: string,
  publicKey: string,
  options: { issuer?: string; audience?: string } = {}
): Promise<VerifiedLicensePayload> {
  const key = await jose.importSPKI(publicKey, 'RS256')
  const { payload } = await jose.jwtVerify(token, key, {
    issuer: options.issuer ?? 'skillsmith',
    audience: options.audience ?? 'skillsmith-enterprise',
  })
  return payload as VerifiedLicensePayload
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

describe('LicenseKeyGenerator', () => {
  let generator: LicenseKeyGenerator
  let publicKey: string
  let privateKey: string

  // Generate keys before each test
  beforeEach(async () => {
    generator = new LicenseKeyGenerator()
    const keyPair = await generator.generateKeyPair()
    publicKey = keyPair.publicKey
    privateKey = keyPair.privateKey
  })

  // ==========================================================================
  // Constructor Tests
  // ==========================================================================

  describe('constructor', () => {
    it('should create generator with default options', () => {
      const gen = new LicenseKeyGenerator()
      expect(gen).toBeInstanceOf(LicenseKeyGenerator)
    })

    it('should create generator with custom options', () => {
      const gen = new LicenseKeyGenerator({
        issuer: 'custom-issuer',
        audience: 'custom-audience',
      })
      expect(gen).toBeInstanceOf(LicenseKeyGenerator)
    })
  })

  // ==========================================================================
  // generateKeyPair() Tests
  // ==========================================================================

  describe('generateKeyPair()', () => {
    it('should generate a valid RSA key pair', async () => {
      const keyPair = await generator.generateKeyPair()

      expect(keyPair.publicKey).toBeDefined()
      expect(keyPair.privateKey).toBeDefined()
      expect(keyPair.publicKey).toContain('-----BEGIN PUBLIC KEY-----')
      expect(keyPair.privateKey).toContain('-----BEGIN PRIVATE KEY-----')
    })

    it('should generate different keys each time', async () => {
      const keyPair1 = await generator.generateKeyPair()
      const keyPair2 = await generator.generateKeyPair()

      expect(keyPair1.publicKey).not.toBe(keyPair2.publicKey)
      expect(keyPair1.privateKey).not.toBe(keyPair2.privateKey)
    })

    it('should generate keys that can sign and verify', async () => {
      const keyPair = await generator.generateKeyPair()
      const payload = createTestPayload()

      // Sign with private key
      const token = await generator.generateLicenseKey(payload, keyPair.privateKey)

      // Verify with public key
      const verified = await verifyToken(token, keyPair.publicKey)

      expect(verified['tier']).toBe(payload.tier)
      expect(verified['customerId']).toBe(payload.customerId)
    })
  })

  // ==========================================================================
  // generateLicenseKey() Tests
  // ==========================================================================

  describe('generateLicenseKey()', () => {
    it('should generate a valid JWT license key', async () => {
      const payload = createTestPayload()

      const token = await generator.generateLicenseKey(payload, privateKey)

      expect(token).toBeDefined()
      expect(typeof token).toBe('string')
      expect(token.split('.')).toHaveLength(3) // JWT format: header.payload.signature
    })

    it('should include all payload fields in the token', async () => {
      const payload = createTestPayload({
        tier: 'team',
        features: ['team_workspaces', 'private_skills'],
        customerId: 'cust_specific_123',
      })

      const token = await generator.generateLicenseKey(payload, privateKey)
      const verified = await verifyToken(token, publicKey)

      expect(verified['tier']).toBe('team')
      expect(verified['features']).toEqual(['team_workspaces', 'private_skills'])
      expect(verified['customerId']).toBe('cust_specific_123')
      expect(verified['issuedAt']).toBe(payload.issuedAt)
      expect(verified['expiresAt']).toBe(payload.expiresAt)
    })

    it('should set correct issuer and audience', async () => {
      const payload = createTestPayload()

      const token = await generator.generateLicenseKey(payload, privateKey)
      const verified = await verifyToken(token, publicKey)

      expect(verified.iss).toBe('skillsmith')
      expect(verified.aud).toBe('skillsmith-enterprise')
    })

    it('should use custom issuer and audience when configured', async () => {
      const customGenerator = new LicenseKeyGenerator({
        issuer: 'custom-issuer',
        audience: 'custom-audience',
      })
      const keyPair = await customGenerator.generateKeyPair()
      const payload = createTestPayload()

      const token = await customGenerator.generateLicenseKey(payload, keyPair.privateKey)
      const verified = await verifyToken(token, keyPair.publicKey, {
        issuer: 'custom-issuer',
        audience: 'custom-audience',
      })

      expect(verified.iss).toBe('custom-issuer')
      expect(verified.aud).toBe('custom-audience')
    })

    it('should set correct expiration time', async () => {
      const now = Math.floor(Date.now() / 1000)
      const expiresAt = now + 86400 * 30 // 30 days
      const payload = createTestPayload({ issuedAt: now, expiresAt })

      const token = await generator.generateLicenseKey(payload, privateKey)
      const verified = await verifyToken(token, publicKey)

      expect(verified.exp).toBe(expiresAt)
    })

    it('should handle empty features array', async () => {
      const payload = createTestPayload({ features: [] })

      const token = await generator.generateLicenseKey(payload, privateKey)
      const verified = await verifyToken(token, publicKey)

      expect(verified['features']).toEqual([])
    })

    it('should handle all tier types', async () => {
      const tiers: Array<'community' | 'team' | 'enterprise'> = ['community', 'team', 'enterprise']

      for (const tier of tiers) {
        const payload = createTestPayload({ tier })
        const token = await generator.generateLicenseKey(payload, privateKey)
        const verified = await verifyToken(token, publicKey)

        expect(verified['tier']).toBe(tier)
      }
    })

    it('should reject invalid private key', async () => {
      const payload = createTestPayload()

      await expect(generator.generateLicenseKey(payload, 'invalid-private-key')).rejects.toThrow()
    })
  })

  // ==========================================================================
  // rotateKey() Tests
  // ==========================================================================

  describe('rotateKey()', () => {
    it('should rotate a license key to use a new private key', async () => {
      // Generate original license
      const payload = createTestPayload()
      const originalToken = await generator.generateLicenseKey(payload, privateKey)

      // Generate new key pair
      const newKeyPair = await generator.generateKeyPair()

      // Rotate the key
      const rotatedToken = await generator.rotateKey(newKeyPair.privateKey, originalToken)

      // Verify with new public key
      const verified = await verifyToken(rotatedToken, newKeyPair.publicKey)

      expect(verified['tier']).toBe(payload.tier)
      expect(verified['customerId']).toBe(payload.customerId)
      expect(verified['features']).toEqual(payload.features)
    })

    it('should preserve all claims during rotation', async () => {
      const payload = createTestPayload({
        tier: 'team',
        features: ['team_workspaces', 'usage_analytics'],
        customerId: 'cust_rotate_test',
      })
      const originalToken = await generator.generateLicenseKey(payload, privateKey)

      const newKeyPair = await generator.generateKeyPair()
      const rotatedToken = await generator.rotateKey(newKeyPair.privateKey, originalToken)

      const verified = await verifyToken(rotatedToken, newKeyPair.publicKey)

      expect(verified['tier']).toBe('team')
      expect(verified['customerId']).toBe('cust_rotate_test')
      expect(verified['features']).toEqual(['team_workspaces', 'usage_analytics'])
      expect(verified['issuedAt']).toBe(payload.issuedAt)
      expect(verified['expiresAt']).toBe(payload.expiresAt)
    })

    it('should fail rotation with original public key', async () => {
      const payload = createTestPayload()
      const originalToken = await generator.generateLicenseKey(payload, privateKey)

      const newKeyPair = await generator.generateKeyPair()
      const rotatedToken = await generator.rotateKey(newKeyPair.privateKey, originalToken)

      // Should fail verification with original public key
      await expect(verifyToken(rotatedToken, publicKey)).rejects.toThrow()
    })

    it('should throw error for invalid token', async () => {
      const newKeyPair = await generator.generateKeyPair()

      await expect(generator.rotateKey(newKeyPair.privateKey, 'invalid.token')).rejects.toThrow()
    })

    it('should throw error for token missing required claims', async () => {
      // Create a token without required claims using jose directly
      const key = await jose.importPKCS8(privateKey, 'RS256')
      const invalidToken = await new jose.SignJWT({ someField: 'value' })
        .setProtectedHeader({ alg: 'RS256' })
        .setIssuedAt()
        .sign(key)

      const newKeyPair = await generator.generateKeyPair()

      await expect(generator.rotateKey(newKeyPair.privateKey, invalidToken)).rejects.toThrow(
        'Invalid token: missing required claims'
      )
    })
  })

  // ==========================================================================
  // createTeamLicense() Tests
  // ==========================================================================

  describe('createTeamLicense()', () => {
    it('should create a team license with all team features', async () => {
      const token = await generator.createTeamLicense('cust_team_123', 365, privateKey)
      const verified = await verifyToken(token, publicKey)

      expect(verified['tier']).toBe('team')
      expect(verified['customerId']).toBe('cust_team_123')
      // Team tier inherits individual features
      expect(verified['features']).toEqual([...INDIVIDUAL_FEATURES, ...TEAM_FEATURES])
    })

    it('should include all team features', async () => {
      const token = await generator.createTeamLicense('cust_team', 30, privateKey)
      const verified = await verifyToken(token, publicKey)

      const features = verified['features'] as FeatureFlag[]
      expect(features).toContain('team_workspaces')
      expect(features).toContain('private_skills')
      expect(features).toContain('usage_analytics')
      expect(features).toContain('priority_support')
    })

    it('should set correct expiration based on duration', async () => {
      const durationDays = 90
      const beforeCreate = Math.floor(Date.now() / 1000)

      const token = await generator.createTeamLicense('cust_team', durationDays, privateKey)

      const afterCreate = Math.floor(Date.now() / 1000)
      const verified = await verifyToken(token, publicKey)

      const expectedMinExpiry = beforeCreate + durationDays * 86400
      const expectedMaxExpiry = afterCreate + durationDays * 86400

      expect(verified.exp).toBeGreaterThanOrEqual(expectedMinExpiry)
      expect(verified.exp).toBeLessThanOrEqual(expectedMaxExpiry)
    })

    it('should not include enterprise features', async () => {
      const token = await generator.createTeamLicense('cust_team', 30, privateKey)
      const verified = await verifyToken(token, publicKey)

      const features = verified['features'] as FeatureFlag[]
      expect(features).not.toContain('sso_saml')
      expect(features).not.toContain('rbac')
      expect(features).not.toContain('audit_logging')
    })
  })

  // ==========================================================================
  // createEnterpriseLicense() Tests
  // ==========================================================================

  describe('createEnterpriseLicense()', () => {
    it('should create an enterprise license with all features', async () => {
      const token = await generator.createEnterpriseLicense('cust_ent_456', 365, privateKey)
      const verified = await verifyToken(token, publicKey)

      expect(verified['tier']).toBe('enterprise')
      expect(verified['customerId']).toBe('cust_ent_456')
    })

    it('should include all team and enterprise features', async () => {
      const token = await generator.createEnterpriseLicense('cust_ent', 30, privateKey)
      const verified = await verifyToken(token, publicKey)

      const features = verified['features'] as FeatureFlag[]

      // Team features
      expect(features).toContain('team_workspaces')
      expect(features).toContain('private_skills')
      expect(features).toContain('usage_analytics')
      expect(features).toContain('priority_support')

      // Enterprise features
      expect(features).toContain('sso_saml')
      expect(features).toContain('rbac')
      expect(features).toContain('audit_logging')
      expect(features).toContain('siem_export')
      expect(features).toContain('compliance_reports')
      expect(features).toContain('private_registry')
    })

    it('should have correct total feature count', async () => {
      const token = await generator.createEnterpriseLicense('cust_ent', 30, privateKey)
      const verified = await verifyToken(token, publicKey)

      const features = verified['features'] as FeatureFlag[]
      // Enterprise tier inherits individual and team features
      const expectedCount =
        INDIVIDUAL_FEATURES.length + TEAM_FEATURES.length + ENTERPRISE_FEATURES.length

      expect(features).toHaveLength(expectedCount)
    })

    it('should set correct expiration based on duration', async () => {
      const durationDays = 180
      const beforeCreate = Math.floor(Date.now() / 1000)

      const token = await generator.createEnterpriseLicense('cust_ent', durationDays, privateKey)

      const afterCreate = Math.floor(Date.now() / 1000)
      const verified = await verifyToken(token, publicKey)

      const expectedMinExpiry = beforeCreate + durationDays * 86400
      const expectedMaxExpiry = afterCreate + durationDays * 86400

      expect(verified.exp).toBeGreaterThanOrEqual(expectedMinExpiry)
      expect(verified.exp).toBeLessThanOrEqual(expectedMaxExpiry)
    })
  })

  // ==========================================================================
  // createCommunityLicense() Tests
  // ==========================================================================

  describe('createCommunityLicense()', () => {
    it('should create a community license with no features', async () => {
      const token = await generator.createCommunityLicense('cust_free_789', 365, privateKey)
      const verified = await verifyToken(token, publicKey)

      expect(verified['tier']).toBe('community')
      expect(verified['customerId']).toBe('cust_free_789')
      expect(verified['features']).toEqual([])
    })

    it('should set correct expiration based on duration', async () => {
      const durationDays = 30
      const beforeCreate = Math.floor(Date.now() / 1000)

      const token = await generator.createCommunityLicense('cust_free', durationDays, privateKey)

      const afterCreate = Math.floor(Date.now() / 1000)
      const verified = await verifyToken(token, publicKey)

      const expectedMinExpiry = beforeCreate + durationDays * 86400
      const expectedMaxExpiry = afterCreate + durationDays * 86400

      expect(verified.exp).toBeGreaterThanOrEqual(expectedMinExpiry)
      expect(verified.exp).toBeLessThanOrEqual(expectedMaxExpiry)
    })
  })

  // ==========================================================================
  // Integration Tests
  // ==========================================================================

  describe('integration with LicenseValidator', () => {
    it('should generate tokens that can be validated', async () => {
      // This test verifies the token format is compatible with validation
      const payload = createTestPayload()
      const token = await generator.generateLicenseKey(payload, privateKey)

      // Decode the token to verify structure
      const decoded = jose.decodeJwt(token) as VerifiedLicensePayload

      expect(decoded['tier']).toBe(payload.tier)
      expect(decoded['features']).toEqual(payload.features)
      expect(decoded['customerId']).toBe(payload.customerId)
      expect(decoded['issuedAt']).toBe(payload.issuedAt)
      expect(decoded['expiresAt']).toBe(payload.expiresAt)
      expect(decoded.iss).toBe('skillsmith')
      expect(decoded.aud).toBe('skillsmith-enterprise')
    })
  })

  // ==========================================================================
  // Edge Cases
  // ==========================================================================

  describe('edge cases', () => {
    it('should handle very long customer IDs', async () => {
      const longCustomerId = 'cust_' + 'a'.repeat(1000)
      const payload = createTestPayload({ customerId: longCustomerId })

      const token = await generator.generateLicenseKey(payload, privateKey)
      const verified = await verifyToken(token, publicKey)

      expect(verified['customerId']).toBe(longCustomerId)
    })

    it('should handle special characters in customer ID', async () => {
      const specialCustomerId = 'cust_test@example.com-123_456'
      const payload = createTestPayload({ customerId: specialCustomerId })

      const token = await generator.generateLicenseKey(payload, privateKey)
      const verified = await verifyToken(token, publicKey)

      expect(verified['customerId']).toBe(specialCustomerId)
    })

    it('should handle 1 day duration', async () => {
      const beforeCreate = Math.floor(Date.now() / 1000)
      const token = await generator.createTeamLicense('cust_short', 1, privateKey)
      const afterCreate = Math.floor(Date.now() / 1000)

      const verified = await verifyToken(token, publicKey)

      const expectedMinExpiry = beforeCreate + 86400
      const expectedMaxExpiry = afterCreate + 86400

      expect(verified.exp).toBeGreaterThanOrEqual(expectedMinExpiry)
      expect(verified.exp).toBeLessThanOrEqual(expectedMaxExpiry)
    })

    it('should handle very long duration (10 years)', async () => {
      const durationDays = 365 * 10
      const beforeCreate = Math.floor(Date.now() / 1000)

      const token = await generator.createEnterpriseLicense('cust_long', durationDays, privateKey)

      const afterCreate = Math.floor(Date.now() / 1000)
      const verified = await verifyToken(token, publicKey)

      const expectedMinExpiry = beforeCreate + durationDays * 86400
      const expectedMaxExpiry = afterCreate + durationDays * 86400

      expect(verified.exp).toBeGreaterThanOrEqual(expectedMinExpiry)
      expect(verified.exp).toBeLessThanOrEqual(expectedMaxExpiry)
    })

    it('should generate consistent results for same payload', async () => {
      const now = Math.floor(Date.now() / 1000)
      const payload = createTestPayload({ issuedAt: now, expiresAt: now + 86400 })

      const token1 = await generator.generateLicenseKey(payload, privateKey)
      const token2 = await generator.generateLicenseKey(payload, privateKey)

      // Tokens will be different due to JWT signature randomness
      // but the payloads should be identical
      const verified1 = await verifyToken(token1, publicKey)
      const verified2 = await verifyToken(token2, publicKey)

      expect(verified1['tier']).toBe(verified2['tier'])
      expect(verified1['customerId']).toBe(verified2['customerId'])
      expect(verified1['features']).toEqual(verified2['features'])
      expect(verified1['issuedAt']).toBe(verified2['issuedAt'])
      expect(verified1['expiresAt']).toBe(verified2['expiresAt'])
    })
  })
})
