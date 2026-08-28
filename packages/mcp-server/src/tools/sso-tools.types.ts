/**
 * @fileoverview Domain types for `sso-tools.ts` — shared by the stub, the live service, and the
 * handlers, none of which may import each other for these types (see each file's own header for
 * why: `sso-tools.ts` imports `createLiveSSOService` from `sso-tools.live.ts`, so the reverse
 * import would be circular at the type level; splitting types out here — mirroring
 * `rbac-tools.types.ts`'s split from `rbac-tools.ts`/`rbac-tools.live.ts` — removes the question
 * entirely rather than relying on `import type` erasure to make a circular edge harmless).
 * @module @skillsmith/mcp-server/tools/sso-tools.types
 * @see SMI-3900: SSO/SAML Configuration MCP Tools (original flat `SSOConfig` shape)
 * @see SMI-6204 (Wave 3 of SMI-6200): `SsoDomainClaim`/`SsoDomainVerification`, and the
 *      `remove()`/`claimDomain()`/`verifyDomain()` additions to `SSOConfigService`
 */

/**
 * SMI-6204: this stays the FLAT shape Wave 0 originally guessed (`idpEntityId`/`idpMetadataUrl`),
 * rather than being reshaped to GoTrue's real nested response (`{ id, disabled, saml: { entity_id,
 * metadata_url, ... }, domains: [...] }`). That is a deliberate choice, not an oversight — see
 * `sso-tools.live.ts`'s `mapProviderToConfig()` doc comment for the full rationale (existing
 * stub-mode test coverage across `sso-tools.test.ts`, and unchanged message-building either way).
 * `domains` is the one genuinely new piece of information the flat shape had no room for; added as
 * an additive optional field rather than smuggled into an existing one.
 */
export interface SSOConfig {
  protocol: 'saml' | 'oidc'
  idpMetadataUrl: string
  idpEntityId: string
  configuredAt: string
  status: 'active' | 'inactive'
  /** Domains claimed/verified for SSO auto-discovery. Absent (not `[]`) on the pre-Wave-3 stub. */
  domains?: string[]
}

/** The DNS TXT record a team must publish to prove control of a domain (SMI-6204 Wave 3). */
export interface SsoDomainClaim {
  domain: string
  verificationToken: string
  recordName: string
  recordType: 'TXT'
  recordValue: string
  /** True only under the stub — never contacts a real DNS provider. See `createStubSSOService()`. */
  simulated?: boolean
}

/** Result of re-checking a claimed domain's TXT record (SMI-6204 Wave 3). */
export interface SsoDomainVerification {
  domain: string
  verified: boolean
  verifiedAt?: string
  /** True only under the stub — never performs a real DNS lookup. See `createStubSSOService()`. */
  simulated?: boolean
}

export interface SSOConfigService {
  set(config: {
    idpMetadataUrl: string
    idpEntityId?: string
    protocol: 'saml' | 'oidc'
  }): Promise<SSOConfig>
  test(): Promise<{ success: boolean; latencyMs: number; message: string; simulated?: boolean }>
  /**
   * SMI-6204 Wave 3 corrected plan: `remove` now requires an explicit disposition for existing
   * SSO-provisioned members. Only `'convert_to_manual'` exists this wave — `'expire'` is a Wave 4
   * deliverable (`expire_stale_sso_members()` does not exist yet) and is refused with a typed
   * `501 sso_expire_unavailable` by the live path if ever requested.
   */
  remove(memberDisposition: 'convert_to_manual'): Promise<boolean>
  get(includeMetadata: boolean): Promise<SSOConfig | null>
  /** Issue (or re-issue) a DNS TXT verification token for `domain`. */
  claimDomain(domain: string): Promise<SsoDomainClaim>
  /** Re-check `domain`'s TXT record against its claimed token. */
  verifyDomain(domain: string): Promise<SsoDomainVerification>
}
