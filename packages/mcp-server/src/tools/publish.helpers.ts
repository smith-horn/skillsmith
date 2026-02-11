/**
 * Publish Tool Helper Functions
 * @module @skillsmith/mcp-server/tools/publish.helpers
 * @see SMI-2440: MCP Publish Tool
 */

import { execFileSync } from 'child_process'
import { promises as fs } from 'fs'
import { join } from 'path'
import { createHash } from 'crypto'
import { SkillParser } from '@skillsmith/core'
import { hasPathTraversal } from './validate.helpers.js'
import type { PreflightResult, ReferenceWarning } from './publish.types.js'

/**
 * Validate skill path is safe (no path traversal, no shell metacharacters)
 */
export function validateSkillPath(skillPath: string): string | null {
  if (hasPathTraversal(skillPath)) {
    return 'Path contains path traversal pattern'
  }

  // Reject shell metacharacters
  if (/[;&|`$(){}[\]!<>]/.test(skillPath)) {
    return 'Path contains shell metacharacters'
  }

  return null
}

/**
 * Pre-flight check for GitHub CLI availability and authentication
 */
export function checkGhPreflight(): PreflightResult {
  let ghAvailable = false
  let ghAuthenticated = false

  try {
    execFileSync('gh', ['--version'], { stdio: 'pipe' })
    ghAvailable = true
  } catch {
    return { ghAvailable: false, ghAuthenticated: false }
  }

  try {
    execFileSync('gh', ['auth', 'status'], { stdio: 'pipe' })
    ghAuthenticated = true
  } catch {
    // gh is available but not authenticated
  }

  return { ghAvailable, ghAuthenticated }
}

/**
 * Generate SHA256 checksum of file content
 */
export function generateChecksum(content: string): string {
  return createHash('sha256').update(content).digest('hex')
}

/**
 * Scan skill directory for project-specific references
 * Max 20 .md files to prevent hangs on large repos
 */
export async function scanReferences(
  dirPath: string,
  customPatterns?: string[]
): Promise<ReferenceWarning[]> {
  const allWarnings: ReferenceWarning[] = []

  // Read all .md files (max 20)
  const allFiles = (await fs.readdir(dirPath, { recursive: true })) as string[]
  const mdFiles = allFiles.filter((f) => f.endsWith('.md')).slice(0, 20)

  // Parse custom patterns
  const parsedPatterns = customPatterns
    ?.map((p) => {
      if (p.length > 200) return null // C2: Prevent ReDoS
      try {
        return new RegExp(p, 'g')
      } catch {
        return null
      }
    })
    .filter((p): p is RegExp => p !== null)

  for (const mdFile of mdFiles) {
    const filePath = join(dirPath, mdFile)
    const content = await fs.readFile(filePath, 'utf-8')
    const result = SkillParser.checkReferences(content, parsedPatterns)

    for (const match of result.matches) {
      allWarnings.push({
        file: mdFile,
        line: match.line,
        text: match.text,
        pattern: match.pattern,
      })
    }
  }

  return allWarnings
}

/**
 * Write publish manifest to skill directory
 */
export async function writeManifest(
  dirPath: string,
  manifest: Record<string, unknown>
): Promise<string> {
  const manifestPath = join(dirPath, '.skillsmith-publish.json')
  await fs.writeFile(manifestPath, JSON.stringify(manifest, null, 2), 'utf-8')
  return manifestPath
}

/**
 * Create GitHub repository using gh CLI
 * Only call if pre-flight check passed
 */
export function createGitHubRepo(name: string, visibility: 'public' | 'private'): string | null {
  try {
    const output = execFileSync('gh', ['repo', 'create', name, `--${visibility}`], {
      stdio: 'pipe',
      encoding: 'utf-8',
    })
    // Extract repo URL from output
    const urlMatch = output.match(/https:\/\/github\.com\/[^\s]+/)
    return urlMatch ? urlMatch[0] : null
  } catch {
    return null
  }
}

/**
 * Add claude-skill topic to GitHub repo
 */
export function addClaudeSkillTopic(repoName: string): boolean {
  try {
    execFileSync('gh', ['repo', 'edit', repoName, '--add-topic', 'claude-skill'], {
      stdio: 'pipe',
    })
    return true
  } catch {
    return false
  }
}

/**
 * Format publish results for display
 */
export function formatPublishResults(
  success: boolean,
  metadata: { name: string; version: string; checksum: string; trustTier: string } | null,
  referenceWarnings: ReferenceWarning[],
  nextSteps: string[],
  repoUrl?: string,
  error?: string
): string {
  const lines: string[] = []

  lines.push('\n=== Skill Publish Results ===\n')

  if (!success) {
    lines.push(`Status: FAILED`)
    if (error) {
      lines.push(`Error: ${error}`)
    }
    lines.push('')
    return lines.join('\n')
  }

  lines.push('Status: READY TO PUBLISH')
  lines.push('')

  if (metadata) {
    lines.push('Metadata:')
    lines.push(`  Name: ${metadata.name}`)
    lines.push(`  Version: ${metadata.version}`)
    lines.push(`  Checksum: ${metadata.checksum.slice(0, 16)}...`)
    lines.push(`  Trust Tier: ${metadata.trustTier}`)
    lines.push('')
  }

  if (referenceWarnings.length > 0) {
    lines.push(`Reference Warnings: ${referenceWarnings.length}`)
    for (const warning of referenceWarnings) {
      lines.push(`  ${warning.file}:${warning.line}: ${warning.text} (${warning.pattern})`)
    }
    lines.push('')
  }

  if (repoUrl) {
    lines.push(`Repository: ${repoUrl}`)
    lines.push('')
  }

  if (nextSteps.length > 0) {
    lines.push('Next Steps:')
    for (const step of nextSteps) {
      lines.push(`  - ${step}`)
    }
  }

  lines.push('')
  lines.push('---')

  return lines.join('\n')
}
