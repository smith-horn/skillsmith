/**
 * SMI-1054: LicenseKeyGenerator Test Suite
 *
 * Comprehensive tests for JWT-based license key generation.
 */

import { describe, it, expect, beforeEach } from 'vitest'
import * as jose from 'jose'

import { LicenseKeyGenerator } from '../../src/license/LicenseKeyGenerator.js'
import type { LicensePayload } from '../../src/license/types.js'

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
})
