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

import { TransformationService } from '../services/TransformationService.js'
import type { Database } from '../db/database-interface.js'
import type {
  DepIntelResult,
  OptimizationInfo,
  ProgressCallback,
  UninstallResult,
} from './skill-installation.types.js'

import type { ManifestManager } from './skill-manifest.js'

/**
 * Result of applying optimization to a skill's content.
 */
export interface OptimizationResult {
  finalSkillContent: string
  subSkillFiles: Array<{ filename: string; content: string }>
  subagentContent: string | undefined
  claudeMdSnippet: string | undefined
  optimizationInfo: OptimizationInfo
}

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

/**
 * Perform skill uninstall with manifest awareness and orphan fallback.
 */
export async function performUninstall(params: {
  skillName: string
  force: boolean
  skillsDir: string
  manifest: ManifestManager
  skillDependencyRepo: SkillDependencyRepository
  onProgress: ProgressCallback
}): Promise<UninstallResult> {
  const { skillName, force, skillsDir, manifest, skillDependencyRepo, onProgress } = params

  try {
    onProgress('manifest', 'Loading manifest')
    const manifestData = await manifest.load()
    const skillEntry = manifestData.installedSkills[skillName]

    if (!skillEntry) {
      const potentialPath = path.join(skillsDir, skillName)
      try {
        await fs.access(potentialPath)
        if (!force) {
          return {
            success: false,
            skillName,
            message:
              'Skill "' +
              skillName +
              '" not in manifest but exists on disk. Use force=true to remove.',
            warning: 'This skill was not installed via Skillsmith.',
          }
        }
        onProgress('remove', 'Removing orphan skill from disk')
        await fs.rm(potentialPath, { recursive: true, force: true })
        return {
          success: true,
          skillName,
          message: 'Skill "' + skillName + '" removed from disk (was not in manifest).',
          removedPath: potentialPath,
          warning:
            'Skill was not in the manifest. Use "skillsmith install" to register skills properly.',
        }
      } catch {
        return { success: false, skillName, message: 'Skill "' + skillName + '" is not installed.' }
      }
    }

    const installPath = skillEntry.installPath

    if (!force) {
      onProgress('check', 'Checking for modifications')
      const modified = await checkForModifications(installPath, skillEntry.installedAt)
      if (modified) {
        return {
          success: false,
          skillName,
          message:
            'Skill "' +
            skillName +
            '" has been modified since installation. Use force=true to remove anyway.',
          warning: 'Local modifications will be lost if you force uninstall.',
        }
      }
    }

    onProgress('remove', 'Removing skill directory')
    try {
      await fs.rm(installPath, { recursive: true, force: true })
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }

    try {
      skillDependencyRepo.clearAll(skillEntry.id)
    } catch {
      // Table may not exist pre-migration
    }

    onProgress('manifest', 'Updating manifest')
    delete manifestData.installedSkills[skillName]
    await manifest.save(manifestData)

    onProgress('done', 'Uninstall complete')
    return {
      success: true,
      skillName,
      message: 'Skill "' + skillName + '" has been uninstalled successfully.',
      removedPath: installPath,
    }
  } catch (error) {
    return {
      success: false,
      skillName,
      message: error instanceof Error ? error.message : 'Unknown error during uninstall',
    }
  }
}

/**
 * Apply skill optimization via TransformationService.
 * Returns original content if transformation fails or produces no changes.
 */
export async function applyOptimization(
  db: Database,
  skillId: string,
  skillName: string,
  skillMdContent: string
): Promise<OptimizationResult> {
  try {
    const transformService = new TransformationService(db, {
      cacheTtl: 3600,
      version: '1.0.0',
    })

    const nameMatch = skillMdContent.match(/^name:\s*(.+)$/m)
    const descMatch = skillMdContent.match(/^description:\s*(.+)$/m)
    const extractedName = nameMatch ? nameMatch[1].trim() : skillName
    const extractedDesc = descMatch ? descMatch[1].trim() : ''

    const transformResult = await transformService.transform(
      skillId,
      extractedName,
      extractedDesc,
      skillMdContent
    )

    if (transformResult.transformed) {
      return {
        finalSkillContent: transformResult.mainSkillContent,
        subSkillFiles: transformResult.subSkills,
        subagentContent: transformResult.subagent?.content,
        claudeMdSnippet: transformResult.claudeMdSnippet,
        optimizationInfo: {
          optimized: true,
          subSkills: transformResult.subSkills.map((s) => s.filename),
          subagentGenerated: !!transformResult.subagent?.content,
          tokenReductionPercent: transformResult.stats.tokenReductionPercent,
          originalLines: transformResult.stats.originalLines,
          optimizedLines: transformResult.stats.optimizedLines,
        },
      }
    }
  } catch {
    // Transformation failed — continue with original content
  }

  return {
    finalSkillContent: skillMdContent,
    subSkillFiles: [],
    subagentContent: undefined,
    claudeMdSnippet: undefined,
    optimizationInfo: { optimized: false },
  }
}
