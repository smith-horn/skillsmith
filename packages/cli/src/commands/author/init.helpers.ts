/**
 * SMI-4289: author init error-handling helpers (closes #602)
 * SMI-4314: error-contract update — initSkill now throws InitSkillError on
 * expected user-facing failures. The createInitCommand() action wrapper
 * catches, prints the sanitized message exactly once, and exits with
 * InitSkillError.exitCode. Helpers here keep the library-to-library
 * { ok, error } signalling contract: they never call process.exit and never
 * print user-facing output directly.
 *
 * Design notes:
 * - scaffoldSkillDirectory catches all fs errors and returns { ok, error }.
 * - rollbackPartialScaffold removes the skill directory ONLY when the mkdir
 *   at line ~128 of init.ts created it fresh (createdFresh === true). When
 *   the user confirmed an overwrite of a pre-existing directory
 *   (createdFresh === false), rollback is a no-op to avoid destroying the
 *   user's existing files on mid-write failure.
 */

import { mkdir, writeFile, rm } from 'fs/promises'
import { join } from 'path'

import { SKILL_MD_TEMPLATE, README_MD_TEMPLATE } from '../../templates/index.js'
import { sanitizeError } from '../../utils/sanitize.js'

/**
 * Input for scaffoldSkillDirectory.
 */
export interface ScaffoldInput {
  /** Absolute path to the skill directory to populate. */
  skillDir: string
  /** Skill name (used in templates). */
  skillName: string
  /** Skill description (used in templates). */
  description: string
  /** Skill author (used in templates). */
  author: string
  /** Skill category (used in templates). */
  category: string
  /**
   * True if the skillDir was created by this invocation (fresh mkdir).
   * False if the directory pre-existed and the user confirmed overwrite.
   *
   * Controls rollback behaviour on failure:
   * - true: on error, rm -rf skillDir (best-effort cleanup)
   * - false: on error, leave skillDir alone (user's pre-existing files preserved)
   */
  createdFresh: boolean
}

/**
 * Result of scaffoldSkillDirectory. Never throws — callers should branch on `ok`.
 */
export type ScaffoldResult = { ok: true } | { ok: false; error: string }

/**
 * Create subdirectories, render templates, and write SKILL.md, README.md,
 * example.js, and .gitignore into `skillDir`.
 *
 * On any fs failure, best-effort rollback is attempted (see
 * `rollbackPartialScaffold`) and the sanitized error is returned as a string.
 * No exception escapes this function for fs-level failures.
 */
export async function scaffoldSkillDirectory(input: ScaffoldInput): Promise<ScaffoldResult> {
  const { skillDir, skillName, description, author, category, createdFresh } = input

  try {
    await mkdir(join(skillDir, 'scripts'), { recursive: true })
    await mkdir(join(skillDir, 'resources'), { recursive: true })

    const skillMdContent = SKILL_MD_TEMPLATE.replace(/\{\{name\}\}/g, skillName)
      .replace(/\{\{description\}\}/g, description)
      .replace(/\{\{author\}\}/g, author)
      .replace(/\{\{category\}\}/g, category)
      .replace(/\{\{date\}\}/g, new Date().toISOString().split('T')[0] || '')
      .replace(/\{\{behavioralClassification\}\}/g, '')

    await writeFile(join(skillDir, 'SKILL.md'), skillMdContent, 'utf-8')

    const readmeContent = README_MD_TEMPLATE.replace(/\{\{name\}\}/g, skillName).replace(
      /\{\{description\}\}/g,
      description
    )
    await writeFile(join(skillDir, 'README.md'), readmeContent, 'utf-8')

    const placeholderScript = `#!/usr/bin/env node
/**
 * ${skillName} - Example Script
 *
 * Add your skill's automation scripts here.
 */

console.log('${skillName} script executed');
`
    await writeFile(join(skillDir, 'scripts', 'example.js'), placeholderScript, 'utf-8')

    const gitignore = `# Dependencies
node_modules/

# Build output
dist/

# Environment
.env
.env.local

# OS files
.DS_Store
Thumbs.db
`
    await writeFile(join(skillDir, '.gitignore'), gitignore, 'utf-8')

    return { ok: true }
  } catch (error) {
    await rollbackPartialScaffold(skillDir, createdFresh)
    return { ok: false, error: sanitizeError(error) }
  }
}

/**
 * Best-effort cleanup of a partially-scaffolded skill directory.
 *
 * CRITICAL: This function must only remove `skillDir` (the skill directory
 * itself). It must NEVER receive or operate on `targetPath` (the parent
 * directory the user passed via --path) — doing so would rm -rf the user's
 * chosen parent directory.
 *
 * When `createdFresh === false`, the directory pre-existed before this init
 * invocation (user confirmed overwrite earlier). Removing it would destroy
 * the user's existing files, so this function no-ops.
 *
 * When `createdFresh === true`, the directory was created by the current
 * init invocation. Best-effort `rm -rf` is safe because only partial scaffold
 * output lives there.
 *
 * Any rollback failure is swallowed — the original scaffold error is the
 * user-facing failure; rollback is defence-in-depth.
 */
export async function rollbackPartialScaffold(
  skillDir: string,
  createdFresh: boolean
): Promise<void> {
  if (!createdFresh) {
    // User's pre-existing directory — do not remove.
    return
  }

  try {
    await rm(skillDir, { recursive: true, force: true })
  } catch {
    // Swallow — best-effort cleanup; original failure is what matters.
  }
}
