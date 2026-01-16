/**
 * SMI-XXXX: Install Bundled Assets on First Run
 *
 * Installs the skillsmith skill and user documentation
 * from the npm package's bundled assets.
 */

import { existsSync, cpSync, mkdirSync, readdirSync } from 'fs'
import { join, dirname } from 'path'
import { homedir } from 'os'
import { fileURLToPath } from 'url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)

/**
 * Path to bundled assets in the npm package
 * In development: src/assets
 * In production (dist): assets (copied by build)
 */
function getAssetsDir(): string {
  // Try production path first (dist/assets)
  const prodPath = join(__dirname, '..', 'assets')
  if (existsSync(prodPath)) {
    return prodPath
  }

  // Fall back to development path (src/assets)
  const devPath = join(__dirname, '..', '..', 'src', 'assets')
  if (existsSync(devPath)) {
    return devPath
  }

  // Return production path anyway (will fail gracefully later)
  return prodPath
}

const ASSETS_DIR = getAssetsDir()
const CLAUDE_SKILLS_DIR = join(homedir(), '.claude', 'skills')
const SKILLSMITH_DOCS_DIR = join(homedir(), '.skillsmith', 'docs')

/**
 * Install bundled skills from package assets
 *
 * Copies skills from src/assets/skills/ to ~/.claude/skills/
 *
 * @returns Array of installed skill names
 */
export function installBundledSkills(): string[] {
  const skillsDir = join(ASSETS_DIR, 'skills')
  const installed: string[] = []

  if (!existsSync(skillsDir)) {
    console.error('[skillsmith] No bundled skills found in package')
    return installed
  }

  // Ensure ~/.claude/skills exists
  if (!existsSync(CLAUDE_SKILLS_DIR)) {
    mkdirSync(CLAUDE_SKILLS_DIR, { recursive: true })
  }

  // Get all skill directories
  let skillDirs: string[]
  try {
    skillDirs = readdirSync(skillsDir, { withFileTypes: true })
      .filter((dirent) => dirent.isDirectory())
      .map((dirent) => dirent.name)
  } catch {
    console.error('[skillsmith] Failed to read bundled skills directory')
    return installed
  }

  // Install each skill
  for (const skillName of skillDirs) {
    const source = join(skillsDir, skillName)
    const dest = join(CLAUDE_SKILLS_DIR, skillName)

    // Skip if already installed
    if (existsSync(dest)) {
      console.error(`[skillsmith] Skill already installed: ${skillName}`)
      continue
    }

    try {
      cpSync(source, dest, { recursive: true })
      console.error(`[skillsmith] Installed bundled skill: ${skillName}`)
      installed.push(skillName)
    } catch (error) {
      console.error(
        `[skillsmith] Failed to install ${skillName}:`,
        error instanceof Error ? error.message : 'Unknown error'
      )
    }
  }

  return installed
}

/**
 * Install user documentation to ~/.skillsmith/docs/
 *
 * @returns true if docs were installed, false otherwise
 */
export function installUserDocs(): boolean {
  const docsSource = join(ASSETS_DIR, 'docs')

  if (!existsSync(docsSource)) {
    console.error('[skillsmith] No bundled docs found in package')
    return false
  }

  // Skip if already installed
  if (existsSync(SKILLSMITH_DOCS_DIR)) {
    console.error('[skillsmith] User docs already installed')
    return false
  }

  try {
    mkdirSync(SKILLSMITH_DOCS_DIR, { recursive: true })
    cpSync(docsSource, SKILLSMITH_DOCS_DIR, { recursive: true })
    console.error('[skillsmith] Installed user documentation to ~/.skillsmith/docs/')
    return true
  } catch (error) {
    console.error(
      '[skillsmith] Failed to install docs:',
      error instanceof Error ? error.message : 'Unknown error'
    )
    return false
  }
}

/**
 * Get path to user guide for --docs flag
 *
 * @returns Path to USER_GUIDE.md if it exists, undefined otherwise
 */
export function getUserGuidePath(): string | undefined {
  const userGuidePath = join(SKILLSMITH_DOCS_DIR, 'USER_GUIDE.md')
  return existsSync(userGuidePath) ? userGuidePath : undefined
}
