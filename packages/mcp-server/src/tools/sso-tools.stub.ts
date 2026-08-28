/**
 * @fileoverview In-memory stub SSOConfigService — used whenever Supabase isn't configured
 * @module @skillsmith/mcp-server/tools/sso-tools.stub
 * @see SMI-3900: SSO/SAML Configuration MCP Tools (original stub)
 * @see SMI-6184: `simulated: true` / honest wording convention — the stub must never claim to
 *      have contacted a real IdP or DNS provider
 * @see SMI-6204 (Wave 3 of SMI-6200): `remove()`'s `memberDisposition` parameter and the new
 *      `claimDomain()`/`verifyDomain()` methods, added to match the live service's interface
 *
 * Split out of `sso-tools.ts` (mirroring `rbac-tools.stub.ts`'s split from `rbac-tools.ts`) to
 * keep that file under the 500-line `audit:standards` budget once Wave 3 added the live service,
 * the two new domain-claim actions, and their error mapping.
 */

import { markAsStub } from './stub-data-source.js'
import type { SSOConfig, SSOConfigService } from './sso-tools.types.js'

/** @internal Exported for testing */
export function createStubSSOService(): SSOConfigService {
  let currentConfig: SSOConfig | null = null

  return markAsStub({
    async set(config) {
      const entityId =
        config.idpEntityId ?? new URL(config.idpMetadataUrl).origin + '/saml/metadata'
      currentConfig = {
        protocol: config.protocol,
        idpMetadataUrl: config.idpMetadataUrl,
        idpEntityId: entityId,
        configuredAt: new Date().toISOString(),
        status: 'active',
      }
      return currentConfig
    },

    async test() {
      if (!currentConfig) {
        return {
          success: false,
          latencyMs: 0,
          simulated: true,
          message: 'No SSO configuration found. Use configure_sso with action "set" first.',
        }
      }
      // SMI-6184: no live SSO service exists yet, so this can only simulate a
      // connection test — it never actually contacts the IdP. `simulated: true`
      // and the message wording make that explicit rather than reporting a
      // fabricated real success.
      return {
        success: true,
        latencyMs: 142,
        simulated: true,
        message:
          `Simulated connection to ${currentConfig.idpEntityId} succeeded ` +
          `(${currentConfig.protocol.toUpperCase()}). This is stub data — no live SSO ` +
          `service is configured, so the IdP was never actually contacted.`,
      }
    },

    // SMI-6204: `memberDisposition` is unused here — the stub never creates SSO-provisioned
    // members in the first place, so there is nothing to convert. The parameter still exists so
    // this signature matches the live path's (required) one; a caller cannot tell from the type
    // alone which service is wired in.
    async remove(_memberDisposition) {
      if (!currentConfig) return false
      currentConfig = null
      return true
    },

    async get(includeMetadata: boolean) {
      if (!currentConfig) return null
      if (!includeMetadata) {
        // Return config without the full metadata URL details
        return { ...currentConfig }
      }
      return currentConfig
    },

    // SMI-6204: no live SSO service exists for the stub path, so this can only simulate token
    // issuance — it never actually reserves anything or contacts a DNS provider. `simulated: true`
    // makes that explicit, mirroring test()'s own honesty convention above.
    async claimDomain(domain: string) {
      const token = `skillsmith-verify-simulated-${Math.random().toString(36).slice(2, 10)}`
      return {
        domain,
        verificationToken: token,
        recordName: `_skillsmith-verify.${domain}`,
        recordType: 'TXT' as const,
        recordValue: token,
        simulated: true,
      }
    },

    // SMI-6204: always "verifies" successfully — no real DNS TXT lookup is ever performed. See
    // claimDomain()'s comment above; same convention.
    async verifyDomain(domain: string) {
      return {
        domain,
        verified: true,
        verifiedAt: new Date().toISOString(),
        simulated: true,
      }
    },
  })
}
