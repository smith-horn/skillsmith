/**
 * @fileoverview MCP Skill Publish Tool for preparing skills for sharing
 * @module @skillsmith/mcp-server/tools/publish
 * @see SMI-2440: MCP Publish Tool
 *
 * Prepares a skill for publishing:
 * - Validates the skill structure
 * - Scans for project-specific references
 * - Generates checksum and manifest
 * - Optionally creates GitHub repository
 *
 * @example
 * // Basic publish preparation
 * const result = await executePublish({
 *   skill_path: '/path/to/skill'
 * });
 *
 * @example
 * // Publish with GitHub repo creation
 * const result = await executePublish({
 *   skill_path: '/path/to/skill',
 *   create_repo: true,
 *   add_topic: true
 * });
 */

import { promises as fs } from 'fs'
import { dirname, join } from 'path'
import { SkillParser, SkillsmithError, ErrorCodes } from '@skillsmith/core'
import type { ToolContext } from '../context.js'

// Import types
import type { PublishInput, PublishResponse } from './publish.types.js'
import { publishInputSchema } from './publish.types.js'

// Import helpers
import {
  validateSkillPath,
  checkGhPreflight,
  generateChecksum,
  scanReferences,
  writeManifest,
  createGitHubRepo,
  addClaudeSkillTopic,
} from './publish.helpers.js'

// Re-export public API
export type {
  PublishInput,
  PublishResponse,
  ReferenceWarning,
  PreflightResult,
} from './publish.types.js'
export { publishInputSchema, publishToolSchema } from './publish.types.js'
export { formatPublishResults } from './publish.helpers.js'

/**
 * Execute skill publish preparation.
 *
 * Validates, checksums, and optionally creates GitHub repo for a skill.
 *
 * @param input - Publish parameters
 * @returns Promise resolving to publish response
 * @throws {SkillsmithError} When path is invalid or skill cannot be read
 */
export async function executePublish(
  input: PublishInput,
  _context?: ToolContext
): Promise<PublishResponse> {
  // Validate input with Zod
  const validated = publishInputSchema.parse(input)
  const { skill_path, check_references, reference_patterns, create_repo, visibility, add_topic } =
    validated

  // Security: Validate path
  const pathError = validateSkillPath(skill_path)
  if (pathError) {
    throw new SkillsmithError(ErrorCodes.VALIDATION_INVALID_TYPE, pathError, {
      details: { path: skill_path },
    })
  }

  // Determine skill directory
  let dirPath = skill_path
  try {
    const stats = await fs.stat(skill_path)
    if (!stats.isDirectory()) {
      dirPath = dirname(skill_path)
    }
  } catch {
    throw new SkillsmithError(ErrorCodes.SKILL_NOT_FOUND, `Path not found: ${skill_path}`, {
      details: { path: skill_path },
    })
  }

  const skillMdPath = join(dirPath, 'SKILL.md')
  const nextSteps: string[] = []

  // Read and validate skill
  let content: string
  try {
    content = await fs.readFile(skillMdPath, 'utf-8')
  } catch {
    return {
      success: false,
      metadata: null,
      referenceWarnings: [],
      nextSteps: ['Create a SKILL.md file in the skill directory'],
      error: `Cannot read file: ${skillMdPath}`,
    }
  }

  const parser = new SkillParser({ requireName: true })
  const { validation, metadata } = parser.parseWithValidation(content)

  if (!validation.valid || !metadata) {
    return {
      success: false,
      metadata: null,
      referenceWarnings: [],
      nextSteps: ['Fix validation errors in SKILL.md', ...validation.errors],
      error: `Skill validation failed: ${validation.errors.join('; ')}`,
    }
  }

  // Generate checksum
  const checksum = generateChecksum(content)
  const trustTier = parser.inferTrustTier(metadata)

  const publishMetadata = {
    name: metadata.name,
    version: metadata.version || '1.0.0',
    checksum,
    trustTier,
  }

  // Scan for project-specific references
  let referenceWarnings: PublishResponse['referenceWarnings'] = []
  if (check_references) {
    referenceWarnings = await scanReferences(dirPath, reference_patterns)

    if (referenceWarnings.length > 0) {
      nextSteps.push(
        `Review ${referenceWarnings.length} project-specific reference(s) before publishing`
      )
    }
  }

  // Write manifest
  await writeManifest(dirPath, {
    ...publishMetadata,
    publishedAt: new Date().toISOString(),
  })

  // GitHub operations (optional)
  let repoUrl: string | undefined
  let preflight: PublishResponse['preflight']

  if (create_repo || add_topic) {
    preflight = checkGhPreflight()

    if (!preflight.ghAvailable) {
      nextSteps.push('Install GitHub CLI (gh) for repo creation: https://cli.github.com/')
    } else if (!preflight.ghAuthenticated) {
      nextSteps.push('Authenticate GitHub CLI: gh auth login')
    } else {
      // Create repo if requested
      if (create_repo) {
        const url = createGitHubRepo(metadata.name, visibility)
        if (url) {
          repoUrl = url
          nextSteps.push(`Push skill to: ${url}`)
        } else {
          nextSteps.push(
            `Create GitHub repo manually: gh repo create ${metadata.name} --${visibility}`
          )
        }
      }

      // Add topic if requested
      if (add_topic && (repoUrl || !create_repo)) {
        const repoName = repoUrl ? repoUrl.replace('https://github.com/', '') : metadata.name
        const topicAdded = addClaudeSkillTopic(repoName)
        if (!topicAdded) {
          nextSteps.push(`Add topic manually: gh repo edit ${repoName} --add-topic claude-skill`)
        }
      }
    }
  }

  // Add standard next steps
  if (!repoUrl) {
    nextSteps.push('Push to a GitHub repository')
    nextSteps.push('Add topic "claude-skill" for registry discovery')
  }
  nextSteps.push('Skill will be indexed at the next daily run (2 AM UTC)')

  return {
    success: true,
    metadata: publishMetadata,
    referenceWarnings,
    repoUrl,
    preflight,
    nextSteps,
  }
}
