/**
 * @fileoverview Helper functions for SkillInstallationService
 * @module @skillsmith/core/services/skill-installation.helpers
 * @see SMI-3483: Wave 0 — Extract SkillInstallationService into core
 *
 * Pure helper functions used by the service. Split from the main service
 * file to meet the 500-line standard.
 */

import * as fs from 'fs/promises'
import * as path from 'path'
import { createHash } from 'crypto'

import { extractMcpReferences } from '../analysis/McpReferenceExtractor.js'
import { mergeDependencies } from '../analysis/DependencyMerger.js'

import type { SkillDependencyRepository } from '../repositories/SkillDependencyRepository.js'
import type { SkillDependencyRow } from '../types/dependencies.js'

import type { DepIntelResult, OptimizationInfo } from './skill-installation.types.js'

// ============================================================================
// Skill ID Parsing
// ============================================================================

export interface ParsedSkillId {
  owner: string
  repo: string
  path: string
  isRegistryId: boolean
}

export function parseSkillIdInternal(input: string): ParsedSkillId {
  if (input.startsWith('https://github.com/')) {
    const url = new URL(input)
    const parts = url.pathname.split('/').filter(Boolean)
    return {
      owner: parts[0],
      repo: parts[1],
      path: parts.slice(2).join('/') || '',
      isRegistryId: false,
    }
  }

  if (input.includes('/')) {
    const parts = input.split('/')
    if (parts.length === 2) {
      return { owner: parts[0], repo: parts[1], path: '', isRegistryId: true }
    }
    return {
      owner: parts[0],
      repo: parts[1],
      path: parts.slice(2).join('/'),
      isRegistryId: false,
    }
  }

  const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
  if (UUID_REGEX.test(input)) {
    return { owner: '', repo: '', path: '', isRegistryId: true }
  }

  throw new Error('Invalid skill ID format: ' + input + '. Use owner/repo or GitHub URL.')
}

// ============================================================================
// Content Hashing
// ============================================================================

export function hashContent(content: string): string {
  return createHash('sha256').update(content).digest('hex')
}

// ============================================================================
// SKILL.md Validation
// ============================================================================

export interface SkillMdValidation {
  valid: boolean
  errors: string[]
}

export function validateSkillMd(content: string): SkillMdValidation {
  const errors: string[] = []
  if (!content.includes('# ')) {
    errors.push('Missing title (# heading)')
  }
  if (content.length < 100) {
    errors.push('SKILL.md is too short (minimum 100 characters)')
  }
  return { valid: errors.length === 0, errors }
}

// ============================================================================
// Git-Crypt Detection
// ============================================================================

export function assertNotEncrypted(content: string, filePath: string): void {
  if (content.startsWith('\x00GITCRYPT')) {
    throw new Error(
      'File "' +
        filePath +
        '" is git-crypt encrypted. ' +
        'The repository uses git-crypt and this file cannot be fetched from GitHub.'
    )
  }
}

// ============================================================================
// GitHub Content Fetching
// ============================================================================

export async function fetchFromGitHub(
  owner: string,
  repo: string,
  filePath: string,
  branch: string = 'main'
): Promise<string> {
  const url =
    'https://raw.githubusercontent.com/' + owner + '/' + repo + '/' + branch + '/' + filePath
  const response = await fetch(url)

  if (!response.ok) {
    if (branch === 'main') {
      const masterUrl =
        'https://raw.githubusercontent.com/' + owner + '/' + repo + '/master/' + filePath
      const masterResponse = await fetch(masterUrl)
      if (!masterResponse.ok) {
        throw new Error('Failed to fetch ' + filePath + ': ' + response.status)
      }
      const masterText = await masterResponse.text()
      assertNotEncrypted(masterText, filePath)
      return masterText
    }
    throw new Error('Failed to fetch ' + filePath + ': ' + response.status)
  }

  const text = await response.text()
  assertNotEncrypted(text, filePath)
  return text
}

// ============================================================================
// Modification Detection
// ============================================================================

export async function checkForModifications(
  skillPath: string,
  installedAt: string
): Promise<boolean> {
  try {
    const installDate = new Date(installedAt)
    const files = await fs.readdir(skillPath, { withFileTypes: true })

    for (const file of files) {
      if (file.isFile()) {
        const filePath = path.join(skillPath, file.name)
        const stats = await fs.stat(filePath)
        if (stats.mtime > installDate) {
          return true
        }
      }
    }
    return false
  } catch {
    return false
  }
}

// ============================================================================
// Tips Generation
// ============================================================================

export function generateTips(skillName: string, optimizationInfo: OptimizationInfo): string[] {
  const tips = [
    'Skill "' + skillName + '" installed successfully!',
    'To use this skill, mention it in Claude Code: "Use the ' + skillName + ' skill to..."',
    'View installed skills: ls ~/.claude/skills/',
  ]

  if (optimizationInfo.optimized) {
    tips.push('')
    tips.push('[Optimization] Skillsmith Optimization Applied:')
    if (optimizationInfo.tokenReductionPercent && optimizationInfo.tokenReductionPercent > 0) {
      tips.push('  - Estimated ' + optimizationInfo.tokenReductionPercent + '% token reduction')
    }
    if (optimizationInfo.subSkills && optimizationInfo.subSkills.length > 0) {
      tips.push('  - ' + optimizationInfo.subSkills.length + ' sub-skills created')
    }
    if (optimizationInfo.subagentGenerated && optimizationInfo.subagentPath) {
      tips.push('  - Companion subagent generated: ' + optimizationInfo.subagentPath)
    }
  }

  tips.push('')
  tips.push('To uninstall: use the uninstall_skill tool')

  return tips
}

// ============================================================================
// Dependency Intelligence
// ============================================================================

export function extractDepIntel(skillMdContent: string): DepIntelResult {
  const mcpResult = extractMcpReferences(skillMdContent)
  const warnings: string[] = []
  for (const server of mcpResult.highConfidenceServers) {
    warnings.push("MCP server '" + server + "' is referenced but may not be configured")
  }
  return {
    dep_inferred_servers: mcpResult.servers,
    dep_declared: undefined,
    dep_warnings: warnings,
  }
}

export function persistDependencies(
  repo: SkillDependencyRepository,
  skillId: string,
  content: string,
  declared: DepIntelResult['dep_declared']
): void {
  const mcpResult = extractMcpReferences(content)
  const merged = mergeDependencies(declared, mcpResult)
  if (merged.length === 0) return

  const rows: SkillDependencyRow[] = merged.map((dep) => ({
    skill_id: skillId,
    dep_type: dep.depType,
    dep_target: dep.depTarget,
    dep_version: dep.depVersion,
    dep_source: dep.depSource,
    confidence: dep.confidence,
    metadata: dep.metadata,
  }))

  const bySource = new Map<string, SkillDependencyRow[]>()
  for (const row of rows) {
    const existing = bySource.get(row.dep_source) ?? []
    existing.push(row)
    bySource.set(row.dep_source, existing)
  }

  for (const [source, sourceRows] of bySource) {
    repo.setDependencies(skillId, sourceRows, source as SkillDependencyRow['dep_source'])
  }
}
