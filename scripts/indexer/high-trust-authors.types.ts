/**
 * High-Trust Authors — shared type definition.
 *
 * SMI-2102: verified skill sources from trusted publishers.
 * Extracted from high-trust-authors.ts (SMI-4843 Phase 5b) so the entry data
 * could be split below the 500-line file limit. Byte-identical across the
 * Deno tree (`supabase/functions/indexer/`) and the Node tree
 * (`scripts/indexer/`).
 */

export interface HighTrustAuthor {
  /** GitHub org/user name */
  owner: string
  /** Repository name */
  repo: string
  /** License identifier */
  license: 'Apache-2.0' | 'MIT' | 'Mixed'
  /** SMI-2402: Vestigial — trustTier now selects the band. Field retained to avoid churn. */
  baseQualityScore: number
  /**
   * SMI-2381: Trust tier override. Use 'curated' for third-party publishers.
   * Default: 'verified' — applied via `highTrustAuthor.trustTier || 'verified'`
   * in repositoryToSkill() when this field is omitted.
   */
  trustTier?: 'verified' | 'curated'
  /** Skills to explicitly exclude (source-available, not open source) */
  excludeSkills?: string[]
  /** If set, only index these specific skills */
  includeSkills?: string[]
  /** Custom path(s) to check for skills (default: ['', 'skills']) */
  skillsPaths?: string[]
  /** Override installable flag. Default: true. Set false for cross-ecosystem skills. */
  installable?: boolean
  /** Description for audit logs */
  description: string
}
