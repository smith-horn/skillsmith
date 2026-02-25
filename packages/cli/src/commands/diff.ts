/**
 * @fileoverview skillsmith diff — section-level skill content diff
 * @module @skillsmith/cli/commands/diff
 * @see SMI-skill-version-tracking Wave 2
 *
 * Compares an installed skill against its latest registry version using
 * heading-level (H2/H3) section analysis. Produces a human-readable
 * summary: sections removed (major), added (minor), or modified (patch).
 *
 * Tier gate: Individual (requires requireTier('individual')).
 */

import { Command } from 'commander'
import chalk from 'chalk'
import { readFile } from 'fs/promises'
import { join } from 'path'
import { homedir } from 'os'
import { classifyChange } from '@skillsmith/core'
import { requireTier } from '../utils/require-tier.js'
import { sanitizeError } from '../utils/sanitize.js'
import { loadManifest } from '../utils/manifest.js'

// ============================================================================
// Heading / section analysis helpers
// ============================================================================

interface SectionDiff {
  added: string[]
  removed: string[]
  modified: string[]
}

function extractHeadings(content: string): Map<string, string> {
  const headings = new Map<string, string>()
  for (const line of content.split('\n')) {
    const m = /^#{2,3}\s+(.+)/.exec(line)
    if (m && m[1] !== undefined) {
      const title = m[1].trim()
      headings.set(title.toLowerCase(), title)
    }
  }
  return headings
}

function extractSectionBodies(content: string): Map<string, string> {
  const result = new Map<string, string>()
  const lines = content.split('\n')
  let currentHeading: string | null = null
  const bodyLines: string[] = []

  const flush = (): void => {
    if (currentHeading !== null) {
      result.set(currentHeading, bodyLines.join('\n').trim())
      bodyLines.length = 0
    }
  }

  for (const line of lines) {
    const m = /^#{2,3}\s+(.+)/.exec(line)
    if (m && m[1] !== undefined) {
      flush()
      currentHeading = m[1].trim().toLowerCase()
    } else if (currentHeading !== null) {
      bodyLines.push(line)
    }
  }
  flush()
  return result
}

function diffSections(oldContent: string, newContent: string): SectionDiff {
  const oldH = extractHeadings(oldContent)
  const newH = extractHeadings(newContent)
  const oldBodies = extractSectionBodies(oldContent)
  const newBodies = extractSectionBodies(newContent)

  const removed = [...oldH.values()].filter((t) => !newH.has(t.toLowerCase()))
  const added = [...newH.values()].filter((t) => !oldH.has(t.toLowerCase()))
  const modified: string[] = []

  for (const [key, title] of newH) {
    if (oldH.has(key)) {
      const oldBody = oldBodies.get(key) ?? ''
      const newBody = newBodies.get(key) ?? ''
      if (oldBody !== newBody) modified.push(title)
    }
  }

  return { added, removed, modified }
}

// ============================================================================
// Content resolution helpers
// ============================================================================

async function readInstalledSkillContent(skillName: string): Promise<string | null> {
  const skillPath = join(homedir(), '.claude', 'skills', skillName, 'SKILL.md')
  try {
    return await readFile(skillPath, 'utf-8')
  } catch {
    return null
  }
}

/**
 * Convert a GitHub repo URL to the raw SKILL.md URL.
 * Returns null for non-GitHub or unrecognised URL shapes.
 */
function buildRawUrl(source: string): string | null {
  if (source.startsWith('https://raw.githubusercontent.com/')) return source

  const m = /^https:\/\/github\.com\/([^/]+)\/([^/]+)(?:\/tree\/([^/]+))?/.exec(source)
  if (!m) return null

  const [, owner, repo, ref = 'main'] = m
  return `https://raw.githubusercontent.com/${owner}/${repo}/${ref}/SKILL.md`
}

async function fetchLatestContent(skillName: string): Promise<string | null> {
  try {
    const manifest = await loadManifest()
    const entry = manifest.installedSkills[skillName]
    if (!entry?.source) return null

    const rawUrl = buildRawUrl(entry.source)
    if (!rawUrl) return null

    const response = await fetch(rawUrl, {
      headers: { Accept: 'text/plain' },
      signal: AbortSignal.timeout(10_000),
    })

    if (!response.ok) return null
    return await response.text()
  } catch {
    return null
  }
}

// ============================================================================
// Display
// ============================================================================

function printDiff(skillName: string, diff: SectionDiff, changeType: string): void {
  const totalChanges = diff.removed.length + diff.added.length + diff.modified.length

  console.log(
    '\n' +
      chalk.bold(skillName) +
      '  ' +
      chalk.dim(`[${changeType.toUpperCase()}]`) +
      `  ${totalChanges} section(s) changed`
  )

  for (const s of diff.removed) console.log(chalk.red(`  - ${s}`))
  for (const s of diff.added) console.log(chalk.green(`  + ${s}`))
  for (const s of diff.modified) console.log(chalk.yellow(`  ~ ${s}`))

  if (totalChanges === 0) {
    console.log(chalk.dim('  No section-level changes detected'))
  }

  console.log()
}

// ============================================================================
// Command factory
// ============================================================================

/**
 * Create the diff command
 */
export function createDiffCommand(): Command {
  return new Command('diff')
    .description(
      'Show section-level diff between installed and latest version of a skill (Individual tier)'
    )
    .argument('<skill>', 'Skill name to diff')
    .option('--old-content <path>', 'Path to old SKILL.md (uses installed skill if omitted)')
    .option('--new-content <path>', 'Path to new SKILL.md (fetches from registry if omitted)')
    .action(
      async (
        skillName: string,
        opts: { oldContent?: string; newContent?: string }
      ): Promise<void> => {
        try {
          await requireTier('individual')

          // Resolve old content
          let oldContent: string | null = null
          if (opts.oldContent) {
            oldContent = await readFile(opts.oldContent, 'utf-8')
          } else {
            oldContent = await readInstalledSkillContent(skillName)
          }

          if (!oldContent) {
            console.error(
              chalk.red(`Skill "${skillName}" is not installed or SKILL.md not found.`)
            )
            process.exit(1)
          }

          // Resolve new content
          let newContent: string | null = null
          if (opts.newContent) {
            newContent = await readFile(opts.newContent, 'utf-8')
          } else {
            newContent = await fetchLatestContent(skillName)
          }

          if (!newContent) {
            console.error(
              chalk.red(
                `Could not fetch latest version for "${skillName}". ` +
                  `Check your network connection or provide --new-content.`
              )
            )
            process.exit(1)
          }

          const diff = diffSections(oldContent, newContent)
          const changeType = classifyChange(oldContent, newContent)
          printDiff(skillName, diff, changeType)
        } catch (error) {
          console.error(chalk.red('Error:'), sanitizeError(error))
          process.exit(1)
        }
      }
    )
}
