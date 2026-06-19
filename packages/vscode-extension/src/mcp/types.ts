/**
 * MCP Client Type Definitions
 * Types for communicating with the Skillsmith MCP server
 */

/**
 * Skill search result from MCP search tool
 */
export interface McpSkillSearchResult {
  id: string
  name: string
  description: string
  author: string
  category: string
  trustTier: 'verified' | 'community' | 'experimental' | 'unknown' | 'local'
  score: number
  repository?: string
}

/**
 * Search filters for MCP search tool
 */
export interface McpSearchFilters {
  category?: string
  trustTier?: string
  minScore?: number
}

/**
 * Response from MCP search tool
 */
export interface McpSearchResponse {
  results: McpSkillSearchResult[]
  total: number
  query: string
  filters: McpSearchFilters
  timing: {
    searchMs: number
    totalMs: number
  }
}

/**
 * Score breakdown for a skill
 */
export interface McpScoreBreakdown {
  quality: number
  popularity: number
  maintenance: number
  security: number
  documentation: number
}

/**
 * Full skill details from MCP get_skill tool
 */
export interface McpSkillDetails {
  id: string
  name: string
  description: string
  author: string
  repository?: string
  version?: string
  category: string
  trustTier: 'verified' | 'community' | 'experimental' | 'unknown' | 'local'
  score: number
  scoreBreakdown?: McpScoreBreakdown
  tags?: string[]
  installCommand?: string
  /** SMI-3857: Security scan summary from registry */
  security?: {
    passed: boolean | null
    riskScore: number | null
    findingsCount: number
    scannedAt: string | null
  }
  createdAt?: string
  updatedAt?: string
}

/**
 * Response from MCP get_skill tool
 */
export interface McpGetSkillResponse {
  skill: McpSkillDetails
  installCommand: string
  /** SMI-3672: Raw SKILL.md content (markdown), when available */
  content?: string
  timing: {
    totalMs: number
  }
}

/**
 * Security scan finding
 */
export interface McpSecurityFinding {
  severity: 'critical' | 'high' | 'medium' | 'low' | 'info'
  message: string
  line?: number
}

/**
 * Security scan report
 */
export interface McpSecurityReport {
  passed: boolean
  findings: McpSecurityFinding[]
  scannedAt: string
}

/**
 * Response from MCP install_skill tool
 */
export interface McpInstallResponse {
  success: boolean
  skillId: string
  installPath: string
  securityReport?: McpSecurityReport
  tips?: string[]
  error?: string
}

/**
 * Response from MCP uninstall_skill tool
 */
export interface McpUninstallResponse {
  success: boolean
  skillId: string
  error?: string
}

/**
 * A single contextual recommendation from MCP skill_recommend (SMI-5314).
 */
export interface McpRecommendation {
  skill_id: string
  name: string
  reason: string
  /** Semantic similarity, 0–1. */
  similarity_score: number
  trust_tier: string
  /** Quality score, 0–100. */
  quality_score: number
  roles?: string[]
  installable?: boolean
}

/**
 * Response from MCP skill_recommend tool (SMI-5314 / #1455).
 */
export interface McpRecommendResponse {
  recommendations: McpRecommendation[]
  candidates_considered: number
  overlap_filtered: number
  role_filtered: number
  discovery_only_hidden?: number
  context: {
    installed_count: number
    has_project_context: boolean
    using_semantic_matching: boolean
    auto_detected: boolean
    role_filter?: string
  }
  timing: { totalMs: number }
}

/**
 * Per-skill summary inside a compare result. Note: `score_breakdown` and
 * `version` are currently always null, and `dependencies` always empty,
 * server-side — render must omit rather than print "null" (SMI-5315).
 */
export interface McpCompareSummary {
  id: string
  name: string
  description: string
  author: string
  /** Quality score, 0–100. */
  quality_score: number
  score_breakdown: McpScoreBreakdown | null
  trust_tier: string
  category: string
  tags: string[]
  version: string | null
  dependencies: string[]
}

/**
 * A single field-level difference between two compared skills.
 */
export interface McpSkillDifference {
  field: string
  a_value: unknown
  b_value: unknown
  winner?: 'a' | 'b' | 'tie'
}

/**
 * Response from MCP skill_compare tool (SMI-5315 / #1456). Exactly two skills.
 */
export interface McpCompareResponse {
  comparison: { a: McpCompareSummary; b: McpCompareSummary }
  differences: McpSkillDifference[]
  recommendation: string
  winner: 'a' | 'b' | 'tie'
  timing: { totalMs: number }
}

/**
 * Response from MCP skill_diff tool (SMI-5316 / #1457). Structured semantic
 * diff between two SKILL.md contents — this is the McpClient.patterns.md example.
 */
export interface McpSkillDiffResponse {
  skill: string
  changeType: 'major' | 'minor' | 'patch' | 'unknown'
  sectionsAdded: string[]
  sectionsRemoved: string[]
  sectionsModified: string[]
  riskScoreDelta: number | null
  changelog: string | null
  recommendation: 'auto-update' | 'review-then-update' | 'manual-review-required'
}

/**
 * A published security advisory for a skill (SMI-5317 / #1458). CVE-style — note
 * there is no per-finding `message`/`line` (that shape lives on the install
 * response's McpSecurityReport, not on skill_audit).
 */
export interface McpAdvisory {
  skillName: string
  severity: 'critical' | 'high' | 'medium' | 'low'
  title: string
  id: string
  fixAvailable: boolean
}

/**
 * Response from the MCP skill_audit tool (SMI-5317 / #1458). Team+ gated.
 * `summary`/`advisories` are present only when `advisoriesAvailable` is true.
 */
export interface McpSkillAuditResponse {
  advisoriesAvailable: boolean
  message?: string
  summary?: { critical: number; high: number; medium: number; low: number; total: number }
  advisories?: McpAdvisory[]
}

/**
 * One entry in the local inventory scanned by skill_inventory_audit
 * (SMI-5318 / #1459). `CollisionId`/`AuditId` are branded strings server-side;
 * on the wire they are plain strings.
 */
export interface McpInventoryEntry {
  kind: 'skill' | 'command' | 'agent' | 'claude_md_rule'
  source_path: string
  identifier: string
  triggerSurface: string[]
  mtime?: number
  meta?: { author?: string; tags?: string[]; description?: string }
}

/** Exact identifier collision (severity always 'error'). */
export interface McpExactCollision {
  kind: 'exact'
  collisionId: string
  identifier: string
  entries: McpInventoryEntry[]
  severity: 'error'
  reason: string
}

/** Semantic-overlap collision (severity always 'warning'; deep pass only). */
export interface McpSemanticCollision {
  kind: 'semantic'
  collisionId: string
  entryA: McpInventoryEntry
  entryB: McpInventoryEntry
  cosineScore: number
  overlappingPhrases: Array<{ phrase1: string; phrase2: string; similarity: number }>
  severity: 'warning'
  reason: string
}

/** Generic-token flag (severity always 'warning'). */
export interface McpGenericFlag {
  kind: 'generic'
  collisionId: string
  identifier: string
  entry: McpInventoryEntry
  matchedTokens: string[]
  severity: 'warning'
  reason: string
}

/** A suggested rename to resolve a collision. */
export interface McpRenameSuggestion {
  collisionId: string
  entry: McpInventoryEntry
  currentName: string
  suggested: string
  applyAction: 'rename_command_file' | 'rename_agent_file' | 'rename_skill_dir_and_frontmatter'
  reason: string
}

/** A suggested prose edit (rendered read-only in PR-D3; apply deferred to SMI-5325). */
export interface McpRecommendedEdit {
  collisionId: string
  category: 'description_overlap' | 'claude_md_trigger_overlap'
  pattern: 'add_domain_qualifier' | 'narrow_scope' | 'reword_trigger_verb'
  filePath: string
  lineRange: { start: number; end: number }
  before: string
  after: string
  rationale: string
  applyAction: 'recommended_edit'
  applyMode: 'manual_review' | 'apply_with_confirmation'
  otherEntry: { identifier: string; sourcePath: string }
}

/**
 * Response from MCP skill_inventory_audit (SMI-5318 / #1459). UNGATED. The
 * server also writes a formatted report to `reportPath`.
 */
export interface McpInventoryAuditResponse {
  auditId: string
  inventory: McpInventoryEntry[]
  exactCollisions: McpExactCollision[]
  genericFlags: McpGenericFlag[]
  semanticCollisions: McpSemanticCollision[]
  renameSuggestions: McpRenameSuggestion[]
  recommendedEdits: McpRecommendedEdit[]
  reportPath: string
  summary: {
    totalEntries: number
    totalFlags: number
    errorCount: number
    warningCount: number
    durationMs: number
  }
}

/**
 * MCP connection status
 */
export type McpConnectionStatus = 'disconnected' | 'connecting' | 'connected' | 'error'

/**
 * MCP tool call parameters
 */
export interface McpToolCall {
  name: string
  arguments: Record<string, unknown>
}

/**
 * MCP tool result content
 */
export interface McpToolResultContent {
  type: 'text'
  text: string
}

/**
 * MCP tool result
 */
export interface McpToolResult {
  content: McpToolResultContent[]
  isError?: boolean
}

/**
 * Configuration for MCP client
 * @public Exported for use in extension settings
 */
export interface McpClientConfig {
  /** Path to the MCP server executable or command */
  serverCommand: string
  /** Arguments for the server command */
  serverArgs: string[]
  /** Connection timeout in milliseconds */
  connectionTimeout: number
  /** Whether to auto-reconnect on disconnect */
  autoReconnect: boolean
  /** Maximum reconnection attempts */
  maxReconnectAttempts: number
}

/**
 * Default MCP client configuration
 */
export const DEFAULT_MCP_CONFIG: McpClientConfig = {
  serverCommand: 'npx',
  serverArgs: ['@skillsmith/mcp-server'],
  connectionTimeout: 30000,
  autoReconnect: true,
  maxReconnectAttempts: 3,
}
