/**
 * SMI-1054: LicenseKeyGenerator
 *
 * Generates signed JWT license keys for Skillsmith Enterprise.
 * Uses the jose library for secure JWT signing with RS256 algorithm.
 */

import * as jose from 'jose'

import type { FeatureFlag, LicensePayload, LicenseTier } from './types.js'
import { ENTERPRISE_FEATURES, INDIVIDUAL_FEATURES, TEAM_FEATURES } from './types.js'
import { TIER_QUOTAS } from './quotas.js'

// ============================================================================
// Default Configuration
// ============================================================================

const DEFAULT_ISSUER = 'skillsmith'
const DEFAULT_AUDIENCE = 'skillsmith-enterprise'

// ============================================================================
// Types
// ============================================================================

/**
 * Options for license key generation
 */
export interface LicenseKeyGeneratorOptions {
  /**
   * JWT issuer claim
   * @default 'skillsmith'
   */
  issuer?: string

  /**
   * JWT audience claim
   * @default 'skillsmith-enterprise'
   */
  audience?: string
}

/**
 * RSA key pair in PEM format
 */
export interface KeyPair {
  /** Public key in PEM format (SPKI) */
  publicKey: string
  /** Private key in PEM format (PKCS8) */
  privateKey: string
}

// ============================================================================
// LicenseKeyGenerator Class
// ============================================================================

/**
 * Generates signed JWT license keys for Skillsmith Enterprise
 *
 * @example
 * ```typescript
 * const generator = new LicenseKeyGenerator();
 *
 * // Generate a new key pair
 * const { publicKey, privateKey } = await generator.generateKeyPair();
 *
 * // Create a license key
 * const licenseKey = await generator.generateLicenseKey(payload, privateKey);
 *
 * // Or use helper methods
 * const teamLicense = await generator.createTeamLicense('cust_123', 365, privateKey);
 * const enterpriseLicense = await generator.createEnterpriseLicense('cust_456', 365, privateKey);
 * ```
 */
export class LicenseKeyGenerator {
  private readonly issuer: string
  private readonly audience: string

  /**
   * Create a new LicenseKeyGenerator
   *
   * @param options - Configuration options
   */
  constructor(options: LicenseKeyGeneratorOptions = {}) {
    this.issuer = options.issuer ?? DEFAULT_ISSUER
    this.audience = options.audience ?? DEFAULT_AUDIENCE
  }

  // ==========================================================================
  // Key Pair Generation
  // ==========================================================================

  /**
   * Generate an RSA key pair for license signing
   *
   * @returns Promise resolving to public and private keys in PEM format
   *
   * @example
   * ```typescript
   * const { publicKey, privateKey } = await generator.generateKeyPair();
   * // Store privateKey securely for license generation
   * // Distribute publicKey for license validation
   * ```
   */
  async generateKeyPair(): Promise<KeyPair> {
    const { publicKey, privateKey } = await jose.generateKeyPair('RS256', {
      extractable: true,
    })

    const publicKeyPem = await jose.exportSPKI(publicKey)
    const privateKeyPem = await jose.exportPKCS8(privateKey)

    return {
      publicKey: publicKeyPem,
      privateKey: privateKeyPem,
    }
  }

  // ==========================================================================
  // License Key Generation
  // ==========================================================================

  /**
   * Generate a signed JWT license key from a payload
   *
   * @param payload - The license payload containing tier, features, and metadata
   * @param privateKey - The private key in PEM format for signing
   * @returns Promise resolving to the signed JWT license key
   *
   * @example
   * ```typescript
   * const payload: LicensePayload = {
   *   tier: 'enterprise',
   *   features: ['sso_saml', 'rbac', 'audit_logging'],
   *   customerId: 'cust_123',
   *   issuedAt: Math.floor(Date.now() / 1000),
   *   expiresAt: Math.floor(Date.now() / 1000) + 86400 * 365,
   * };
   *
   * const licenseKey = await generator.generateLicenseKey(payload, privateKey);
   * ```
   */
  async generateLicenseKey(payload: LicensePayload, privateKey: string): Promise<string> {
    // Import the private key
    const key = await jose.importPKCS8(privateKey, 'RS256')

    // Create and sign the JWT
    const jwt = new jose.SignJWT({
      tier: payload.tier,
      features: payload.features,
      customerId: payload.customerId,
      issuedAt: payload.issuedAt,
      expiresAt: payload.expiresAt,
    })
      .setProtectedHeader({ alg: 'RS256' })
      .setIssuedAt(payload.issuedAt)
      .setExpirationTime(payload.expiresAt)
      .setIssuer(this.issuer)
      .setAudience(this.audience)

    return jwt.sign(key)
  }

  // ==========================================================================
  // Key Rotation
  // ==========================================================================

  /**
   * Rotate a license key to use a new private key
   *
   * This method decodes an existing token (without verifying the signature),
   * and re-signs it with a new private key. Useful when rotating signing keys.
   *
   * @param newPrivateKey - The new private key for re-signing
   * @param existingToken - The existing JWT token to re-sign
   * @returns Promise resolving to the newly signed JWT license key
   *
   * @example
   * ```typescript
   * // After generating a new key pair
   * const newKeyPair = await generator.generateKeyPair();
   *
   * // Rotate existing licenses
   * const rotatedLicense = await generator.rotateKey(
   *   newKeyPair.privateKey,
   *   existingLicenseKey
   * );
   * ```
   */
  async rotateKey(newPrivateKey: string, existingToken: string): Promise<string> {
    // Decode the existing token to extract the payload
    // We decode without verification since we're re-signing anyway
    const payload = jose.decodeJwt(existingToken) as Record<string, unknown>

    // Validate that we have all required fields BEFORE extracting
    if (!payload['tier'] || !payload['customerId']) {
      throw new Error('Invalid token: missing required claims')
    }

    // Extract the license-specific claims
    const licensePayload: LicensePayload = {
      tier: payload['tier'] as LicenseTier,
      features: payload['features'] as FeatureFlag[],
      customerId: payload['customerId'] as string,
      issuedAt: payload['issuedAt'] as number,
      expiresAt: payload['expiresAt'] as number,
    }

    // Re-sign with the new private key
    return this.generateLicenseKey(licensePayload, newPrivateKey)
  }

  // ==========================================================================
  // Helper Methods
  // ==========================================================================

  /**
   * Create an Individual tier license
   *
   * For solo developers at $9.99/month with 10,000 API calls/month.
   * Includes: basic_analytics, email_support
   *
   * @param customerId - The customer identifier
   * @param durationDays - License duration in days
   * @param privateKey - The private key for signing
   * @returns Promise resolving to the signed JWT license key
   *
   * @example
   * ```typescript
   * const individualLicense = await generator.createIndividualLicense(
   *   'cust_individual_123',
   *   30, // Monthly
   *   privateKey
   * );
   * ```
   */
  async createIndividualLicense(
    customerId: string,
    durationDays: number,
    privateKey: string
  ): Promise<string> {
    const now = Math.floor(Date.now() / 1000)

    const payload: LicensePayload = {
      tier: 'individual',
      features: [...INDIVIDUAL_FEATURES],
      customerId,
      issuedAt: now,
      expiresAt: now + durationDays * 86400,
      quotas: {
        apiCallsPerMonth: TIER_QUOTAS.individual.apiCallsPerMonth,
      },
    }

    return this.generateLicenseKey(payload, privateKey)
  }

  /**
   * Create a Team tier license
   *
   * Includes all individual and team features: basic_analytics, email_support,
   * team_workspaces, private_skills, usage_analytics, priority_support
   *
   * @param customerId - The customer identifier
   * @param durationDays - License duration in days
   * @param privateKey - The private key for signing
   * @returns Promise resolving to the signed JWT license key
   *
   * @example
   * ```typescript
   * const teamLicense = await generator.createTeamLicense(
   *   'cust_team_123',
   *   365, // 1 year
   *   privateKey
   * );
   * ```
   */
  async createTeamLicense(
    customerId: string,
    durationDays: number,
    privateKey: string
  ): Promise<string> {
    const now = Math.floor(Date.now() / 1000)

    const payload: LicensePayload = {
      tier: 'team',
      features: [...INDIVIDUAL_FEATURES, ...TEAM_FEATURES],
      customerId,
      issuedAt: now,
      expiresAt: now + durationDays * 86400,
      quotas: {
        apiCallsPerMonth: TIER_QUOTAS.team.apiCallsPerMonth,
      },
    }

    return this.generateLicenseKey(payload, privateKey)
  }

  /**
   * Create an Enterprise tier license
   *
   * Includes all individual, team, and enterprise features.
   * Unlimited API calls.
   *
   * @param customerId - The customer identifier
   * @param durationDays - License duration in days
   * @param privateKey - The private key for signing
   * @returns Promise resolving to the signed JWT license key
   *
   * @example
   * ```typescript
   * const enterpriseLicense = await generator.createEnterpriseLicense(
   *   'cust_enterprise_456',
   *   365, // 1 year
   *   privateKey
   * );
   * ```
   */
  async createEnterpriseLicense(
    customerId: string,
    durationDays: number,
    privateKey: string
  ): Promise<string> {
    const now = Math.floor(Date.now() / 1000)

    const payload: LicensePayload = {
      tier: 'enterprise',
      features: [...INDIVIDUAL_FEATURES, ...TEAM_FEATURES, ...ENTERPRISE_FEATURES],
      customerId,
      issuedAt: now,
      expiresAt: now + durationDays * 86400,
      quotas: {
        apiCallsPerMonth: TIER_QUOTAS.enterprise.apiCallsPerMonth, // -1 = unlimited
      },
    }

    return this.generateLicenseKey(payload, privateKey)
  }

  /**
   * Create a Community tier license (free tier)
   *
   * Community tier has no premium features but can be used
   * to establish a valid license structure.
   *
   * @param customerId - The customer identifier
   * @param durationDays - License duration in days
   * @param privateKey - The private key for signing
   * @returns Promise resolving to the signed JWT license key
   *
   * @example
   * ```typescript
   * const communityLicense = await generator.createCommunityLicense(
   *   'cust_free_789',
   *   365, // 1 year
   *   privateKey
   * );
   * ```
   */
  async createCommunityLicense(
    customerId: string,
    durationDays: number,
    privateKey: string
  ): Promise<string> {
    const now = Math.floor(Date.now() / 1000)

    const payload: LicensePayload = {
      tier: 'community',
      features: [],
      customerId,
      issuedAt: now,
      expiresAt: now + durationDays * 86400,
      quotas: {
        apiCallsPerMonth: TIER_QUOTAS.community.apiCallsPerMonth,
      },
    }

    return this.generateLicenseKey(payload, privateKey)
  }
}
