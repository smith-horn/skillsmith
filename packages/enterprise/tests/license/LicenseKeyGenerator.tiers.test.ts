/**
 * SMI-1054: LicenseKeyGenerator Test Suite — tier license helpers, integration
 *   with LicenseValidator, and edge cases.
 *
 * Split from LicenseKeyGenerator.test.ts to stay under the 500-line file gate.
 * The `constructor`, `generateKeyPair()`, `generateLicenseKey()`, and
 * `rotateKey()` describe blocks remain in LicenseKeyGenerator.test.ts.
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
      // SMI-3140: expanded to Team + Enterprise (2026-07-14)
      expect(features).toContain('compliance_reports')
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
