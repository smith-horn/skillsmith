/**
 * Skillsmith Agent pack — shared types + constants (SMI-5456 Wave 1 Step 4).
 *
 * The portable agent pack IS the Skillsmith Agent product: one prompt source
 * (the SKILL.md brain), thin per-harness shims that carry invocation sugar and
 * zero logic, and SessionStart/SessionEnd hook artifacts that feed the
 * mediation marker channel. Everything is generated from this one source at
 * build time and versioned with the `@skillsmith/mcp-server` release — the
 * mitigation for definition rot across harness targets (PRD §5.2 risk f).
 *
 * This module is intentionally free of any `@skillsmith/mcp-server` import: the
 * curated tool profile is passed in as {@link AgentPackInput.toolProfile} so the
 * dependency direction stays core → (consumed by) mcp-server, never circular.
 *
 * @see docs/internal/product/prd-skillsmith-agent.md
 * @see docs/internal/architecture/skillsmith-agent-architecture.md (artifacts A1-A6)
 */

/** Skill directory + agentskills.io `name` slug for the generated pack. */
export const AGENT_PACK_SKILL_NAME = 'skillsmith-agent'

/** Human-facing display name used in prose and shim descriptions. */
export const AGENT_PACK_DISPLAY_NAME = 'Skillsmith Agent'

/**
 * On-disk pack schema version. Bump on any breaking change to artifact SHAPE
 * (paths, frontmatter fields, hook contract) so the installer can detect an
 * incompatible pack. NOT the npm version — keeping it a fixed code constant is
 * what makes generation deterministic (no release-number churn in artifacts).
 */
export const AGENT_PACK_SCHEMA_VERSION = 1

/**
 * SKILL.md frontmatter `version` (semver string — the repo's own
 * `skill_validate` requires it). Static for Wave 1; bump when the pack's
 * CONTENT changes materially. Independent of {@link AGENT_PACK_SCHEMA_VERSION}
 * (artifact shape) and of the npm release number (determinism: artifacts must
 * not churn with every release).
 */
export const AGENT_PACK_VERSION = '1.0.0'

/** SKILL.md frontmatter `repository` (source transparency for a published skill). */
export const AGENT_PACK_REPOSITORY = 'https://github.com/smith-horn/skillsmith'

/**
 * SKILL.md frontmatter `compatibility`, constrained to the validator's SMI-2760
 * vocabulary (`KNOWN_IDES`/`KNOWN_LLMS` in mcp-server `utils/validation.ts`) so
 * the pack validates with ZERO warnings. In Tier order; `vscode` is that
 * vocabulary's designated slug for the Copilot/VS Code surface. `codex`,
 * `opencode`, and `hermes` are supported harnesses but have no slug in the
 * vocabulary yet — add them here when the SMI-2760 enum gains them.
 */
export const AGENT_PACK_COMPATIBILITY: readonly string[] = [
  'claude-code',
  'cursor',
  'vscode',
  'windsurf',
]

/**
 * Harness identifiers the pack targets. `antigravity` added SMI-6275 Wave 5
 * (closing the last unshipped ask of GH#2166): `agent install` can now
 * target AntiGravity's WORKSPACE-scoped `.agents/mcp_config.json` (see
 * `agent-pack-installer.antigravity-mcp.ts`) — the same recency precedent
 * `cursor` set as this enum's most-recently-added member before it. Note
 * AntiGravity does NOT get an entry in `AGENT_MCP_TARGETS`
 * (`agent-harness-targets.ts`) the way every other `McpHarnessId` member
 * does — its config path is workspace-anchored, not home-anchored, so it
 * structurally doesn't fit that Record's shape; see `McpHarnessId`'s own
 * doc comment.
 */
export type HarnessId = 'claude-code' | 'cursor' | 'codex' | 'copilot' | 'opencode' | 'antigravity'

/**
 * Harnesses that get a generated SessionStart/SessionEnd hook (PRD §3.1,
 * spike report §(e)). Hermes has no session-start equivalent (spike verified
 * absent) and Windsurf has no hook system — both excluded. Copilot/OpenCode
 * hooks (preview / JS-plugin format) are out of Wave-1 hook scope by decision;
 * they still get shims.
 *
 * `antigravity` (SMI-6275 Wave 5) is deliberately excluded too — a stated
 * decision, not an oversight: this wave's live web-search research (see
 * `agent-pack-installer.antigravity-mcp.ts`'s header) turned up AntiGravity's
 * documented MCP config format but no documented SessionStart/SessionEnd
 * hook system equivalent to Claude Code/Cursor/Codex's — unlike those three,
 * which each have a confirmed doc page. AntiGravity gets `.agents/mcp_config.json`
 * registration ONLY this wave (support tier 3, matching Windsurf's MCP-only
 * profile — see `HARNESS_SUPPORT_TIER` in `agent-pack-installer.types.ts`).
 * It also gets no named-agent shim file (`AGENT_SHIM_TARGETS.antigravity` is
 * `null` in `agent-harness-targets.ts`, for the same "no verified evidence
 * yet" reason). Revisit both if/when AntiGravity ships a documented
 * hook/shim equivalent.
 */
export const HOOK_HARNESSES: readonly HarnessId[] = ['claude-code', 'cursor', 'codex']

/** Artifact class. */
export type AgentArtifactKind = 'skill' | 'shim' | 'hook'

/**
 * A single generated artifact. `path` is POSIX-relative to the agent-pack root;
 * `content` is deterministic (no timestamps / randomness — snapshot tests depend
 * on it). The installer (Step 5) consumes this typed shape directly rather than
 * re-deriving intent from the path.
 */
export interface AgentPackArtifact {
  /** Path relative to the agent-pack root (POSIX separators). */
  path: string
  /** File contents. Byte-identical across runs for identical input. */
  content: string
  /** What kind of artifact this is. */
  kind: AgentArtifactKind
  /** Harness this artifact targets, or `null` for the harness-neutral skill pack. */
  harness: HarnessId | null
  /** True when the installer must mark the file executable (hook scripts). */
  executable: boolean
}

/** Input to {@link generateAgentPack}. */
export interface AgentPackInput {
  /**
   * The curated MCP tool profile — the single source of truth is
   * `@skillsmith/mcp-server`'s `AGENT_TOOL_PROFILE_NAMES`, passed in here by
   * the generation script and by tests. Every tool the prompt source references
   * must be a member, or {@link generateAgentPack} throws (build-time fail-fast).
   */
  toolProfile: readonly string[]
}

/**
 * A delegable job the pack teaches. Jobs 1-3 are full MVP orchestrations; jobs
 * 4/8/9 are routing-only (find/recommend, author-away, team-share).
 */
export interface JobDefinition {
  /** Stable id for assembly tests. */
  id: string
  /** Section heading (no leading `###`). */
  title: string
  /** Prose body — plain-language operating instructions for this job. */
  body: string
  /**
   * Tools this job orchestrates, by MCP name. Empty for routing-only jobs that
   * hand off to another skill/tier rather than calling tools. Every entry is
   * validated against {@link AgentPackInput.toolProfile}.
   */
  tools: readonly string[]
}

/** A trust/safety clause rendered verbatim-in-spirit from PRD §7. */
export interface TrustClause {
  id: string
  title: string
  body: string
}

/** A paywall trigger's wording + when-to-mention rule (PRD §8.1). */
export interface PaywallTrigger {
  id: string
  title: string
  body: string
}
