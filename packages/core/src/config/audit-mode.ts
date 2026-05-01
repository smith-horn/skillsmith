/**
 * @fileoverview Audit-mode resolver for SMI-4587 consumer namespace audit.
 * @module @skillsmith/core/config/audit-mode
 *
 * Pure resolver mapping (tier, override) -> AuditMode for the inventory
 * collision detector. Lives in core (not mcp-server) so the CLI, web
 * surfaces, and MCP server can share one resolution path. Subpath export:
 * `@skillsmith/core/config/audit-mode`.
 *
 * Resolution rules (decision #1 in plan):
 *   1. If `override` is set and is a valid AuditMode, return it.
 *   2. Otherwise return the tier default:
 *      - community / individual -> 'preventative'
 *      - team                   -> 'power_user'
 *      - enterprise             -> 'governance'
 *   3. Unknown tier -> 'preventative' (fail-safe).
 *
 * `'off'` is only reachable via an explicit override. The detector treats
 * 'off' as a short-circuit (returns an empty InventoryAuditResult and
 * skips telemetry).
 */

/**
 * Audit-mode levels for the consumer namespace audit. Ordered roughly by
 * how much work the detector does on the critical path:
 *   - 'preventative': exact + generic only (no embedding service touched)
 *   - 'power_user':   adds the semantic-overlap pass
 *   - 'governance':   same as power_user; reserved for stricter Wave-3 policy
 *   - 'off':          short-circuit, no audit at all
 */
export type AuditMode = 'preventative' | 'power_user' | 'governance' | 'off'

/**
 * Subscription tier values consumed by the resolver. Mirrors the tier
 * enum used elsewhere in the codebase. Unknown strings fall through to
 * the fail-safe default.
 */
export type Tier = 'community' | 'individual' | 'team' | 'enterprise'

const VALID_MODES: ReadonlySet<AuditMode> = new Set([
  'preventative',
  'power_user',
  'governance',
  'off',
])

/**
 * Type guard: returns true when `value` is a valid AuditMode.
 */
export function isAuditMode(value: unknown): value is AuditMode {
  return typeof value === 'string' && VALID_MODES.has(value as AuditMode)
}

/**
 * Options for {@link resolveAuditMode}.
 */
export interface ResolveAuditModeOptions {
  /** Subscription tier of the caller. Drives the default when no override is set. */
  tier: Tier
  /**
   * Optional override read from `~/.skillsmith/config.json` `audit_mode`
   * field (or `SKILLSMITH_AUDIT_MODE` env var, resolved by the caller).
   * Invalid / nullish values are ignored and the tier default is used.
   */
  override?: AuditMode | null
}

/**
 * Resolve the effective audit-mode for a caller. Pure function — no IO.
 *
 * @example
 * ```ts
 * resolveAuditMode({ tier: 'community' })          // 'preventative'
 * resolveAuditMode({ tier: 'team' })               // 'power_user'
 * resolveAuditMode({ tier: 'enterprise' })         // 'governance'
 * resolveAuditMode({ tier: 'team', override: 'off' }) // 'off'
 * ```
 */
export function resolveAuditMode(opts: ResolveAuditModeOptions): AuditMode {
  if (opts.override != null && isAuditMode(opts.override)) {
    return opts.override
  }
  return tierDefault(opts.tier)
}

/**
 * Tier-default mapping (decision #1). Exported so consumers can render
 * "your default mode is X" hints without re-deriving the rule.
 */
export function tierDefault(tier: Tier | string): AuditMode {
  switch (tier) {
    case 'community':
    case 'individual':
      return 'preventative'
    case 'team':
      return 'power_user'
    case 'enterprise':
      return 'governance'
    default:
      // Unknown tier -> fail-safe to the cheapest mode.
      return 'preventative'
  }
}
