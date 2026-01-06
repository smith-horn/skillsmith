/**
 * SMI-1140: LicenseValidator Integration Tests
 *
 * Tests the LicenseValidator with real RS256 JWT verification.
 * Uses dynamically generated RSA key pairs for each test run.
 */

import { describe, it, expect, beforeAll } from 'vitest'
import { LicenseValidator } from '../../src/license/LicenseValidator.js'
import type { LicenseTier } from '../../src/license/types.js'
import {
  generateTestKeyPair,
  createTestLicenseToken,
  createExpiredToken,
  createNotYetValidToken,
  createWrongIssuerToken,
  createWrongAudienceToken,
  createMalformedToken,
  createWrongSignatureToken,
  createMissingClaimsToken,
  createInvalidTierToken,
  createInvalidFeaturesToken,
  createTierTokens,
  type TestKeyPair,
} from '../fixtures/license-test-utils.js'

describe('LicenseValidator Integration Tests', () => {
  let keyPair: TestKeyPair
  let alternateKeyPair: TestKeyPair

  beforeAll(async () => {
    // Generate key pairs for testing
    keyPair = await generateTestKeyPair()
    alternateKeyPair = await generateTestKeyPair()
  })

  // ==========================================================================
  // Valid Token Tests
  // ==========================================================================

  describe('Valid Token Validation', () => {
    it('should validate a valid enterprise license token', async () => {
      const validator = new LicenseValidator({
        publicKey: keyPair.publicKey,
      })

      const token = await createTestLicenseToken(keyPair.privateKey, {
        tier: 'enterprise',
        features: ['sso_saml', 'audit_logging', 'rbac'],
        customerId: 'customer-123',
      })

      const result = await validator.validate(token)

      expect(result.valid).toBe(true)
      expect(result.license).toBeDefined()
      expect(result.license?.tier).toBe('enterprise')
      expect(result.license?.features).toContain('sso_saml')
      expect(result.license?.customerId).toBe('customer-123')
      expect(result.error).toBeUndefined()
    })

    it('should validate a valid team license token', async () => {
      const validator = new LicenseValidator({
        publicKey: keyPair.publicKey,
      })

      const token = await createTestLicenseToken(keyPair.privateKey, {
        tier: 'team',
        features: ['team_workspaces', 'private_skills'],
      })

      const result = await validator.validate(token)

      expect(result.valid).toBe(true)
      expect(result.license?.tier).toBe('team')
      expect(result.license?.features).toContain('team_workspaces')
    })

    it('should validate tokens for all tiers', async () => {
      const validator = new LicenseValidator({
        publicKey: keyPair.publicKey,
      })

      const tierTokens = await createTierTokens(keyPair.privateKey)
      const tiers: LicenseTier[] = ['community', 'team', 'enterprise']

      for (const tier of tiers) {
        const result = await validator.validate(tierTokens[tier])
        expect(result.valid).toBe(true)
        expect(result.license?.tier).toBe(tier)
      }
    })

    it('should store validated license and allow feature checks', async () => {
      const validator = new LicenseValidator({
        publicKey: keyPair.publicKey,
      })

      const token = await createTestLicenseToken(keyPair.privateKey, {
        tier: 'enterprise',
        features: ['sso_saml', 'audit_logging'],
      })

      await validator.validate(token)

      expect(validator.hasFeature('sso_saml')).toBe(true)
      expect(validator.hasFeature('audit_logging')).toBe(true)
      expect(validator.getTier()).toBe('enterprise')
    })

    it('should include tier default features in hasFeature check', async () => {
      const validator = new LicenseValidator({
        publicKey: keyPair.publicKey,
      })

      // Token with enterprise tier but only sso_saml explicitly listed
      const token = await createTestLicenseToken(keyPair.privateKey, {
        tier: 'enterprise',
        features: ['sso_saml'],
      })

      await validator.validate(token)

      // Should have explicit feature
      expect(validator.hasFeature('sso_saml')).toBe(true)
      // Should also have tier default features
      expect(validator.hasFeature('rbac')).toBe(true)
      expect(validator.hasFeature('audit_logging')).toBe(true)
    })
  })

  // ==========================================================================
  // Expired Token Tests
  // ==========================================================================

  describe('Expired Token Handling', () => {
    it('should reject expired tokens', async () => {
      const validator = new LicenseValidator({
        publicKey: keyPair.publicKey,
      })

      const token = await createExpiredToken(keyPair.privateKey)
      const result = await validator.validate(token)

      expect(result.valid).toBe(false)
      expect(result.error?.code).toBe('TOKEN_EXPIRED')
      expect(result.license).toBeUndefined()
    })

    it('should accept tokens within clock tolerance', async () => {
      const validator = new LicenseValidator({
        publicKey: keyPair.publicKey,
        clockTolerance: 120, // 2 minutes
      })

      // Token that expired 30 seconds ago (within tolerance)
      const token = await createTestLicenseToken(keyPair.privateKey, {
        expiresAt: new Date(Date.now() - 30 * 1000),
      })

      const result = await validator.validate(token)

      // Should be valid due to clock tolerance
      expect(result.valid).toBe(true)
    })
  })

  // ==========================================================================
  // Not Yet Valid Token Tests
  // ==========================================================================

  describe('Not Yet Valid Token Handling', () => {
    it('should reject tokens with future nbf', async () => {
      const validator = new LicenseValidator({
        publicKey: keyPair.publicKey,
      })

      const token = await createNotYetValidToken(keyPair.privateKey)
      const result = await validator.validate(token)

      expect(result.valid).toBe(false)
      expect(result.error?.code).toBe('TOKEN_NOT_YET_VALID')
    })
  })

  // ==========================================================================
  // Invalid Signature Tests
  // ==========================================================================

  describe('Invalid Signature Handling', () => {
    it('should reject tokens signed with wrong key', async () => {
      const validator = new LicenseValidator({
        publicKey: keyPair.publicKey,
      })

      // Sign with alternate key, but validate against original key
      const token = await createWrongSignatureToken(alternateKeyPair.privateKey)
      const result = await validator.validate(token)

      expect(result.valid).toBe(false)
      expect(result.error?.code).toBe('INVALID_SIGNATURE')
    })

    it('should reject malformed tokens', async () => {
      const validator = new LicenseValidator({
        publicKey: keyPair.publicKey,
      })

      const token = createMalformedToken()
      const result = await validator.validate(token)

      expect(result.valid).toBe(false)
      expect(['INVALID_TOKEN', 'INVALID_SIGNATURE']).toContain(result.error?.code)
    })
  })

  // ==========================================================================
  // Issuer/Audience Validation Tests
  // ==========================================================================

  describe('Issuer and Audience Validation', () => {
    it('should reject tokens with wrong issuer', async () => {
      const validator = new LicenseValidator({
        publicKey: keyPair.publicKey,
        issuer: 'skillsmith',
      })

      const token = await createWrongIssuerToken(keyPair.privateKey)
      const result = await validator.validate(token)

      expect(result.valid).toBe(false)
      expect(result.error?.code).toBe('INVALID_TOKEN')
    })

    it('should reject tokens with wrong audience', async () => {
      const validator = new LicenseValidator({
        publicKey: keyPair.publicKey,
        audience: 'skillsmith-enterprise',
      })

      const token = await createWrongAudienceToken(keyPair.privateKey)
      const result = await validator.validate(token)

      expect(result.valid).toBe(false)
      expect(result.error?.code).toBe('INVALID_TOKEN')
    })

    it('should accept tokens with custom issuer and audience', async () => {
      const customIssuer = 'custom-issuer'
      const customAudience = 'custom-audience'

      const validator = new LicenseValidator({
        publicKey: keyPair.publicKey,
        issuer: customIssuer,
        audience: customAudience,
      })

      const token = await createTestLicenseToken(keyPair.privateKey, {
        issuer: customIssuer,
        audience: customAudience,
      })

      const result = await validator.validate(token)

      expect(result.valid).toBe(true)
    })
  })

  // ==========================================================================
  // Missing/Invalid Claims Tests
  // ==========================================================================

  describe('Missing and Invalid Claims', () => {
    it('should reject tokens with missing required claims', async () => {
      const validator = new LicenseValidator({
        publicKey: keyPair.publicKey,
      })

      const token = await createMissingClaimsToken(keyPair.privateKey)
      const result = await validator.validate(token)

      expect(result.valid).toBe(false)
      expect(result.error?.code).toBe('MISSING_CLAIMS')
    })

    it('should reject tokens with invalid tier', async () => {
      const validator = new LicenseValidator({
        publicKey: keyPair.publicKey,
      })

      const token = await createInvalidTierToken(keyPair.privateKey)
      const result = await validator.validate(token)

      expect(result.valid).toBe(false)
      expect(result.error?.code).toBe('INVALID_TIER')
    })

    it('should reject tokens with invalid features format', async () => {
      const validator = new LicenseValidator({
        publicKey: keyPair.publicKey,
      })

      const token = await createInvalidFeaturesToken(keyPair.privateKey)
      const result = await validator.validate(token)

      expect(result.valid).toBe(false)
      expect(result.error?.code).toBe('INVALID_FEATURES')
    })
  })

  // ==========================================================================
  // Public Key Configuration Tests
  // ==========================================================================

  describe('Public Key Configuration', () => {
    it('should return error when no public key is configured', async () => {
      const validator = new LicenseValidator({
        // No public key provided
      })

      const token = await createTestLicenseToken(keyPair.privateKey)
      const result = await validator.validate(token)

      expect(result.valid).toBe(false)
      expect(result.error?.code).toBe('INVALID_TOKEN')
      expect(result.error?.message).toContain('public key')
    })

    it('should cache public key between validations', async () => {
      const validator = new LicenseValidator({
        publicKey: keyPair.publicKey,
      })

      const token1 = await createTestLicenseToken(keyPair.privateKey, {
        customerId: 'customer-1',
      })
      const token2 = await createTestLicenseToken(keyPair.privateKey, {
        customerId: 'customer-2',
      })

      // Both validations should work with cached key
      const result1 = await validator.validate(token1)
      const result2 = await validator.validate(token2)

      expect(result1.valid).toBe(true)
      expect(result2.valid).toBe(true)
      expect(result1.license?.customerId).toBe('customer-1')
      expect(result2.license?.customerId).toBe('customer-2')
    })

    it('should clear key cache when requested', async () => {
      const validator = new LicenseValidator({
        publicKey: keyPair.publicKey,
      })

      const token = await createTestLicenseToken(keyPair.privateKey)

      // First validation
      await validator.validate(token)

      // Clear cache
      validator.clearKeyCache()

      // Should still work (key re-imported)
      const result = await validator.validate(token)
      expect(result.valid).toBe(true)
    })
  })

  // ==========================================================================
  // License State Management Tests
  // ==========================================================================

  describe('License State Management', () => {
    it('should return null license before validation', () => {
      const validator = new LicenseValidator({
        publicKey: keyPair.publicKey,
      })

      expect(validator.getLicense()).toBeNull()
      expect(validator.getTier()).toBe('community')
    })

    it('should clear license when requested', async () => {
      const validator = new LicenseValidator({
        publicKey: keyPair.publicKey,
      })

      const token = await createTestLicenseToken(keyPair.privateKey, {
        tier: 'enterprise',
      })

      await validator.validate(token)
      expect(validator.getTier()).toBe('enterprise')

      validator.clearLicense()
      expect(validator.getLicense()).toBeNull()
      expect(validator.getTier()).toBe('community')
    })

    it('should not have features after license is cleared', async () => {
      const validator = new LicenseValidator({
        publicKey: keyPair.publicKey,
      })

      const token = await createTestLicenseToken(keyPair.privateKey, {
        tier: 'enterprise',
        features: ['sso_saml'],
      })

      await validator.validate(token)
      expect(validator.hasFeature('sso_saml')).toBe(true)

      validator.clearLicense()
      expect(validator.hasFeature('sso_saml')).toBe(false)
    })
  })

  // ==========================================================================
  // Concurrent Validation Tests
  // ==========================================================================

  describe('Concurrent Validation', () => {
    it('should handle concurrent validations', async () => {
      const validator = new LicenseValidator({
        publicKey: keyPair.publicKey,
      })

      const tokens = await Promise.all([
        createTestLicenseToken(keyPair.privateKey, { customerId: 'c1' }),
        createTestLicenseToken(keyPair.privateKey, { customerId: 'c2' }),
        createTestLicenseToken(keyPair.privateKey, { customerId: 'c3' }),
      ])

      const results = await Promise.all(tokens.map((t) => validator.validate(t)))

      expect(results.every((r) => r.valid)).toBe(true)
    })
  })

  // ==========================================================================
  // Edge Cases
  // ==========================================================================

  describe('Edge Cases', () => {
    it('should handle empty features array', async () => {
      const validator = new LicenseValidator({
        publicKey: keyPair.publicKey,
      })

      const token = await createTestLicenseToken(keyPair.privateKey, {
        tier: 'community',
        features: [],
      })

      const result = await validator.validate(token)

      expect(result.valid).toBe(true)
      expect(result.license?.features).toEqual([])
    })

    it('should handle very long customer IDs', async () => {
      const validator = new LicenseValidator({
        publicKey: keyPair.publicKey,
      })

      const longCustomerId = 'customer-' + 'x'.repeat(1000)
      const token = await createTestLicenseToken(keyPair.privateKey, {
        customerId: longCustomerId,
      })

      const result = await validator.validate(token)

      expect(result.valid).toBe(true)
      expect(result.license?.customerId).toBe(longCustomerId)
    })

    it('should handle special characters in customer ID', async () => {
      const validator = new LicenseValidator({
        publicKey: keyPair.publicKey,
      })

      const specialCustomerId = 'customer-äöü-日本語-🎉'
      const token = await createTestLicenseToken(keyPair.privateKey, {
        customerId: specialCustomerId,
      })

      const result = await validator.validate(token)

      expect(result.valid).toBe(true)
      expect(result.license?.customerId).toBe(specialCustomerId)
    })
  })
})
