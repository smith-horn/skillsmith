/**
 * @fileoverview Dependency type definitions for Skill Dependency Intelligence
 * @module @skillsmith/core/types/dependencies
 * @see SMI-3142: Create dependency type definitions
 *
 * These types model the structured dependency declarations in SKILL.md
 * frontmatter and the corresponding database row shape in
 * skill_dependencies (migration v10).
 */

// ============================================================================
// Frontmatter declaration types
// ============================================================================

/** Top-level dependency declaration from SKILL.md frontmatter */
export interface DependencyDeclaration {
  skills?: SkillDep[]
  platform?: PlatformDep
  models?: ModelDep
  environment?: EnvironmentDep
}

/** A skill-to-skill dependency */
export interface SkillDep {
  name: string
  version?: string
  type: 'hard' | 'soft' | 'peer'
  reason?: string
}

/** Platform-level dependencies (CLI version, MCP servers) */
export interface PlatformDep {
  cli?: string
  mcp_servers?: McpServerDep[]
}

/** An MCP server dependency */
export interface McpServerDep {
  name: string
  package?: string
  required: boolean
}

/** Model-level requirements */
export interface ModelDep {
  minimum?: string
  recommended?: string
  capabilities?: string[]
  context_window?: number
}

/** Environment-level requirements (tools, OS, Node version) */
export interface EnvironmentDep {
  tools?: ToolDep[]
  os?: string[]
  node?: string
}

/** An external tool dependency */
export interface ToolDep {
  name: string
  required: boolean
  check?: string
}

/** A conflict declaration — skills that must not coexist */
export interface ConflictDeclaration {
  name: string
  versions?: string
  reason?: string
}

// ============================================================================
// Database row types (matches skill_dependencies table, migration v10)
// ============================================================================

/** Database row shape matching skill_dependencies table */
export interface SkillDependencyRow {
  id?: number
  skill_id: string
  dep_type: DepType
  dep_target: string
  dep_version: string | null
  dep_source: DepSource
  confidence: number | null
  metadata: string | null
  created_at?: string
  updated_at?: string
}

/**
 * Discriminated dependency type — maps to the dep_type CHECK constraint
 * in migration v10.
 */
export type DepType =
  | 'skill_hard'
  | 'skill_soft'
  | 'skill_peer'
  | 'mcp_server'
  | 'model_minimum'
  | 'model_capability'
  | 'env_tool'
  | 'env_os'
  | 'env_node'
  | 'cli_version'
  | 'conflict'

/**
 * How the dependency was discovered.
 * - declared: author wrote it in SKILL.md frontmatter
 * - inferred_static: detected via mcp__* tool-call analysis
 * - inferred_coinstall: derived from co-install behavioral data
 */
export type DepSource = 'declared' | 'inferred_static' | 'inferred_coinstall'
