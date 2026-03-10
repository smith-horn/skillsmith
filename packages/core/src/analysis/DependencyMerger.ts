/**
 * @fileoverview Merges declared and inferred dependencies into a flat list
 * @module @skillsmith/core/analysis/DependencyMerger
 * @see SMI-3146: Build DependencyMerger
 *
 * Combines frontmatter-declared dependencies with statically inferred
 * MCP references, deduplicating where declared trumps inferred.
 */

import type { DependencyDeclaration, DepSource, DepType } from '../types/dependencies.js'
import type { McpExtractionResult } from './McpReferenceExtractor.js'

/** A single merged dependency ready for database insertion */
export interface MergedDependency {
  /** Dependency category, e.g. 'mcp_server', 'skill_hard' */
  depType: DepType
  /** Target identifier, e.g. 'linear', 'claude-flow' */
  depTarget: string
  /** Semver constraint or null */
  depVersion: string | null
  /** How the dependency was discovered */
  depSource: DepSource
  /** Confidence score (1.0 for declared, 0.9/0.5 for inferred) */
  confidence: number | null
  /** JSON-serialized metadata or null */
  metadata: string | null
}

/**
 * Merge declared dependencies from SKILL.md frontmatter with
 * inferred MCP references from static content analysis.
 *
 * Declared dependencies always take precedence: if a server appears
 * in both declared MCP servers and inferred references, only the
 * declared entry is included.
 *
 * @param declared - Parsed dependency declaration from frontmatter
 * @param inferred - MCP references extracted from content
 * @returns Flat array of merged dependencies
 */
export function mergeDependencies(
  declared: DependencyDeclaration | undefined,
  inferred: McpExtractionResult
): MergedDependency[] {
  const result: MergedDependency[] = []
  const declaredMcpServers = new Set<string>()

  if (declared) {
    addSkillDeps(declared, result)
    addPlatformDeps(declared, result, declaredMcpServers)
    addModelDeps(declared, result)
    addEnvironmentDeps(declared, result)
    addConflicts(declared, result)
  }

  addInferredMcp(inferred, declaredMcpServers, result)

  return result
}

/** Add skill-to-skill dependencies */
function addSkillDeps(declared: DependencyDeclaration, result: MergedDependency[]): void {
  if (!declared.skills) return

  for (const skill of declared.skills) {
    const depType: DepType =
      skill.type === 'hard' ? 'skill_hard' : skill.type === 'soft' ? 'skill_soft' : 'skill_peer'

    result.push({
      depType,
      depTarget: skill.name,
      depVersion: skill.version ?? null,
      depSource: 'declared',
      confidence: 1.0,
      metadata: skill.reason ? JSON.stringify({ reason: skill.reason }) : null,
    })
  }
}

/** Add platform dependencies (CLI version, MCP servers) */
function addPlatformDeps(
  declared: DependencyDeclaration,
  result: MergedDependency[],
  declaredMcpServers: Set<string>
): void {
  if (!declared.platform) return

  if (declared.platform.cli) {
    result.push({
      depType: 'cli_version',
      depTarget: 'claude',
      depVersion: declared.platform.cli,
      depSource: 'declared',
      confidence: 1.0,
      metadata: null,
    })
  }

  if (declared.platform.mcp_servers) {
    for (const server of declared.platform.mcp_servers) {
      declaredMcpServers.add(server.name)
      result.push({
        depType: 'mcp_server',
        depTarget: server.name,
        depVersion: null,
        depSource: 'declared',
        confidence: 1.0,
        metadata: server.package
          ? JSON.stringify({
              package: server.package,
              required: server.required,
            })
          : JSON.stringify({ required: server.required }),
      })
    }
  }
}

/** Add model dependencies */
function addModelDeps(declared: DependencyDeclaration, result: MergedDependency[]): void {
  if (!declared.models) return

  if (declared.models.minimum) {
    result.push({
      depType: 'model_minimum',
      depTarget: declared.models.minimum,
      depVersion: null,
      depSource: 'declared',
      confidence: 1.0,
      metadata: declared.models.context_window
        ? JSON.stringify({ context_window: declared.models.context_window })
        : null,
    })
  }

  if (declared.models.capabilities) {
    for (const cap of declared.models.capabilities) {
      result.push({
        depType: 'model_capability',
        depTarget: cap,
        depVersion: null,
        depSource: 'declared',
        confidence: 1.0,
        metadata: null,
      })
    }
  }
}

/** Add environment dependencies (tools, OS, Node) */
function addEnvironmentDeps(declared: DependencyDeclaration, result: MergedDependency[]): void {
  if (!declared.environment) return

  if (declared.environment.tools) {
    for (const tool of declared.environment.tools) {
      result.push({
        depType: 'env_tool',
        depTarget: tool.name,
        depVersion: null,
        depSource: 'declared',
        confidence: 1.0,
        metadata: JSON.stringify({
          required: tool.required,
          ...(tool.check ? { check: tool.check } : {}),
        }),
      })
    }
  }

  if (declared.environment.os) {
    for (const os of declared.environment.os) {
      result.push({
        depType: 'env_os',
        depTarget: os,
        depVersion: null,
        depSource: 'declared',
        confidence: 1.0,
        metadata: null,
      })
    }
  }

  if (declared.environment.node) {
    result.push({
      depType: 'env_node',
      depTarget: 'node',
      depVersion: declared.environment.node,
      depSource: 'declared',
      confidence: 1.0,
      metadata: null,
    })
  }
}

/** Add conflict declarations — note: DependencyDeclaration doesn't have conflicts field yet */
function addConflicts(declared: DependencyDeclaration, result: MergedDependency[]): void {
  // DependencyDeclaration type does not include a conflicts field.
  // This is a forward-looking handler for when the type is extended.
  // Access via type-safe indexing to avoid runtime errors.
  const withConflicts = declared as DependencyDeclaration & {
    conflicts?: Array<{ name: string; versions?: string; reason?: string }>
  }

  if (!withConflicts.conflicts) return

  for (const conflict of withConflicts.conflicts) {
    result.push({
      depType: 'conflict',
      depTarget: conflict.name,
      depVersion: conflict.versions ?? null,
      depSource: 'declared',
      confidence: 1.0,
      metadata: conflict.reason ? JSON.stringify({ reason: conflict.reason }) : null,
    })
  }
}

/** Add inferred MCP servers not already declared */
function addInferredMcp(
  inferred: McpExtractionResult,
  declaredMcpServers: Set<string>,
  result: MergedDependency[]
): void {
  const highConfidenceSet = new Set(inferred.highConfidenceServers)

  for (const server of inferred.servers) {
    // Declared trumps inferred — skip if already declared
    if (declaredMcpServers.has(server)) continue

    const isHighConfidence = highConfidenceSet.has(server)

    result.push({
      depType: 'mcp_server',
      depTarget: server,
      depVersion: null,
      depSource: 'inferred_static',
      confidence: isHighConfidence ? 0.9 : 0.5,
      metadata: null,
    })
  }
}
