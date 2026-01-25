#!/usr/bin/env node
/**
 * SMI-1775: Local Skill Validation Script
 * SMI-1778: Added --help flag and --fix implementation
 *
 * Validates skills in .claude/skills/ and ~/.claude/skills/ directories.
 * Checks for required YAML frontmatter (name, description) and other quality checks.
 *
 * Usage:
 *   npm run validate:skills
 *   node scripts/validate-local-skills.mjs [--project-only] [--user-only] [--strict]
 *
 * Options:
 *   --project-only  Only validate .claude/skills/ (project skills)
 *   --user-only     Only validate ~/.claude/skills/ (user skills)
 *   --strict        Treat warnings as errors
 *   --fix           Attempt to fix common issues (missing frontmatter, formatting)
 *   --json          Output results as JSON
 *   --help, -h      Show this help message
 */

import { readFileSync, writeFileSync, existsSync, readdirSync, statSync } from 'fs'
import { join, basename, dirname } from 'path'
import { homedir } from 'os'

// =============================================================================
// Help
// =============================================================================

function showHelp() {
  console.log(`
${COLORS.bold}Local Skill Validation Script${COLORS.reset}

Validates skills in .claude/skills/ (project) and ~/.claude/skills/ (user) directories.
Checks for required YAML frontmatter (name, description) and other quality checks.

${COLORS.bold}USAGE${COLORS.reset}
  npm run validate:skills [options]
  node scripts/validate-local-skills.mjs [options]

${COLORS.bold}OPTIONS${COLORS.reset}
  --project-only    Only validate .claude/skills/ (project skills)
  --user-only       Only validate ~/.claude/skills/ (user skills)
  --strict          Treat warnings as errors (non-zero exit code)
  --fix             Attempt to fix common issues:
                    - Add missing YAML frontmatter with placeholder name/description
                    - Format malformed frontmatter delimiters
  --json            Output results as JSON (for CI integration)
  --help, -h        Show this help message

${COLORS.bold}EXAMPLES${COLORS.reset}
  ${COLORS.blue}# Validate all skills${COLORS.reset}
  npm run validate:skills

  ${COLORS.blue}# Validate only project skills with strict mode${COLORS.reset}
  npm run validate:skills -- --project-only --strict

  ${COLORS.blue}# Auto-fix common issues${COLORS.reset}
  npm run validate:skills -- --fix

  ${COLORS.blue}# Output JSON for CI pipeline${COLORS.reset}
  npm run validate:skills -- --json

${COLORS.bold}REQUIRED FRONTMATTER${COLORS.reset}
  ---
  name: "Skill Name"           # Required, max 100 chars
  description: "What it does"  # Required, max 500 chars
  ---

${COLORS.bold}EXIT CODES${COLORS.reset}
  0  All skills valid
  1  Validation errors found (or warnings with --strict)

${COLORS.bold}SEE ALSO${COLORS.reset}
  Skill Builder: .claude/skills/skill-builder/SKILL.md
  Skill Locations: .claude/skills/skill-builder/skill-locations.md
`)
  process.exit(0)
}

// =============================================================================
// Configuration
// =============================================================================

const COLORS = {
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  reset: '\x1b[0m',
  bold: '\x1b[1m',
}

const FIELD_LIMITS = {
  name: 100,
  description: 500,
  version: 20,
  author: 100,
  maxTags: 20,
  tagLength: 50,
}

const REQUIRED_FIELDS = ['name', 'description']
const RECOMMENDED_FIELDS = ['version']

// =============================================================================
// YAML Frontmatter Parser
// =============================================================================

/**
 * Parse YAML frontmatter from markdown content
 * Reuses logic from packages/mcp-server/src/tools/validate.helpers.ts
 */
function parseYamlFrontmatter(content) {
  const trimmed = content.trim()

  if (!trimmed.startsWith('---')) {
    return null
  }

  const endIndex = trimmed.indexOf('---', 3)
  if (endIndex === -1) {
    return null
  }

  const yamlContent = trimmed.slice(3, endIndex).trim()
  const result = {}
  const lines = yamlContent.split('\n')
  let currentKey = null
  let arrayBuffer = []
  let inArray = false

  for (const line of lines) {
    const trimmedLine = line.trim()

    if (!trimmedLine || trimmedLine.startsWith('#')) {
      continue
    }

    if (trimmedLine.startsWith('- ')) {
      if (currentKey && inArray) {
        const value = trimmedLine
          .slice(2)
          .trim()
          .replace(/^["']|["']$/g, '')
        arrayBuffer.push(value)
      }
      continue
    }

    const colonIndex = trimmedLine.indexOf(':')
    if (colonIndex > 0) {
      if (currentKey && inArray && arrayBuffer.length > 0) {
        result[currentKey] = arrayBuffer
        arrayBuffer = []
      }

      const key = trimmedLine.slice(0, colonIndex).trim()
      const value = trimmedLine.slice(colonIndex + 1).trim()

      if (value === '' || value === '|' || value === '>') {
        currentKey = key
        inArray = true
        arrayBuffer = []
      } else {
        currentKey = null
        inArray = false

        let parsedValue = value
        if (
          (value.startsWith('"') && value.endsWith('"')) ||
          (value.startsWith("'") && value.endsWith("'"))
        ) {
          parsedValue = value.slice(1, -1)
        } else if (value === 'true') {
          parsedValue = true
        } else if (value === 'false') {
          parsedValue = false
        } else if (/^-?\d+(\.\d+)?$/.test(value)) {
          parsedValue = parseFloat(value)
        } else if (value.startsWith('[') && value.endsWith(']')) {
          parsedValue = value
            .slice(1, -1)
            .split(',')
            .map((item) => item.trim().replace(/^["']|["']$/g, ''))
            .filter((item) => item.length > 0)
        }

        result[key] = parsedValue
      }
    }
  }

  if (currentKey && inArray && arrayBuffer.length > 0) {
    result[currentKey] = arrayBuffer
  }

  return result
}

// =============================================================================
// Validation Functions
// =============================================================================

/**
 * Validate skill metadata
 */
function validateMetadata(metadata, strict) {
  const errors = []

  // Check required fields
  for (const field of REQUIRED_FIELDS) {
    if (!metadata[field]) {
      errors.push({
        field,
        message: `Required field "${field}" is missing`,
        severity: 'error',
      })
    } else if (typeof metadata[field] !== 'string') {
      errors.push({
        field,
        message: `Field "${field}" must be a string`,
        severity: 'error',
      })
    } else if (metadata[field].length > FIELD_LIMITS[field]) {
      errors.push({
        field,
        message: `Field "${field}" exceeds maximum length of ${FIELD_LIMITS[field]} characters`,
        severity: 'error',
      })
    }
  }

  // Check recommended fields
  for (const field of RECOMMENDED_FIELDS) {
    if (!metadata[field]) {
      errors.push({
        field,
        message: `Recommended field "${field}" is missing`,
        severity: strict ? 'error' : 'warning',
      })
    }
  }

  // Check version format if present
  if (metadata.version && typeof metadata.version === 'string') {
    if (!/^\d+\.\d+\.\d+/.test(metadata.version)) {
      errors.push({
        field: 'version',
        message: 'Version should follow semver format (e.g., 1.0.0)',
        severity: 'warning',
      })
    }
  }

  // Check tags if present
  if (metadata.tags !== undefined) {
    if (!Array.isArray(metadata.tags)) {
      errors.push({
        field: 'tags',
        message: 'Field "tags" must be an array',
        severity: 'error',
      })
    } else if (metadata.tags.length > FIELD_LIMITS.maxTags) {
      errors.push({
        field: 'tags',
        message: `Field "tags" exceeds maximum count of ${FIELD_LIMITS.maxTags}`,
        severity: 'error',
      })
    }
  }

  return errors
}

/**
 * Generate default frontmatter for a skill
 */
function generateDefaultFrontmatter(skillName) {
  return `---
name: "${skillName}"
description: "TODO: Add a description of what this skill does and when to use it."
---

`
}

/**
 * Fix common issues in a skill file
 * Returns { fixed: boolean, changes: string[] }
 */
function fixSkill(skillPath, content) {
  const changes = []
  let newContent = content
  const skillName = basename(dirname(skillPath))
    .split('-')
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ')

  // Check if frontmatter is missing entirely
  const trimmed = content.trim()
  if (!trimmed.startsWith('---')) {
    // Add frontmatter at the beginning
    newContent = generateDefaultFrontmatter(skillName) + content
    changes.push('Added missing YAML frontmatter')
  } else {
    // Check if frontmatter is malformed (missing closing ---)
    const endIndex = trimmed.indexOf('---', 3)
    if (endIndex === -1) {
      // Find the first blank line and insert closing ---
      const lines = content.split('\n')
      let insertIndex = -1
      for (let i = 1; i < lines.length; i++) {
        if (lines[i].trim() === '') {
          insertIndex = i
          break
        }
      }
      if (insertIndex > 0) {
        lines.splice(insertIndex, 0, '---')
        newContent = lines.join('\n')
        changes.push('Added missing frontmatter closing delimiter (---)')
      }
    } else {
      // Frontmatter exists, check for missing required fields
      const metadata = parseYamlFrontmatter(content)
      if (metadata) {
        let frontmatterLines = trimmed.slice(3, endIndex).trim().split('\n')
        let needsUpdate = false

        if (!metadata.name) {
          frontmatterLines.push(`name: "${skillName}"`)
          changes.push('Added missing "name" field')
          needsUpdate = true
        }

        if (!metadata.description) {
          frontmatterLines.push(
            'description: "TODO: Add a description of what this skill does and when to use it."'
          )
          changes.push('Added missing "description" field')
          needsUpdate = true
        }

        if (needsUpdate) {
          const afterFrontmatter = trimmed.slice(endIndex + 3)
          newContent = '---\n' + frontmatterLines.join('\n') + '\n---' + afterFrontmatter
        }
      }
    }
  }

  if (changes.length > 0) {
    try {
      writeFileSync(skillPath, newContent, 'utf8')
      return { fixed: true, changes }
    } catch (err) {
      return { fixed: false, changes: [`Failed to write file: ${err.message}`] }
    }
  }

  return { fixed: false, changes: [] }
}

/**
 * Validate a single skill
 */
function validateSkill(skillPath) {
  const result = {
    path: skillPath,
    name: basename(dirname(skillPath)),
    valid: true,
    errors: [],
    warnings: [],
    metadata: null,
  }

  // Check if SKILL.md exists
  if (!existsSync(skillPath)) {
    result.valid = false
    result.errors.push({
      field: 'file',
      message: 'SKILL.md not found',
      severity: 'error',
    })
    return result
  }

  // Read and parse content
  let content
  try {
    content = readFileSync(skillPath, 'utf8')
  } catch (err) {
    result.valid = false
    result.errors.push({
      field: 'file',
      message: `Failed to read file: ${err.message}`,
      severity: 'error',
    })
    return result
  }

  // Check for frontmatter
  const metadata = parseYamlFrontmatter(content)
  if (!metadata) {
    result.valid = false
    result.errors.push({
      field: 'frontmatter',
      message: 'YAML frontmatter is missing or malformed',
      severity: 'error',
    })
    return result
  }

  result.metadata = metadata

  // Validate metadata
  const metadataErrors = validateMetadata(metadata, false)
  for (const error of metadataErrors) {
    if (error.severity === 'error') {
      result.valid = false
      result.errors.push(error)
    } else {
      result.warnings.push(error)
    }
  }

  return result
}

// =============================================================================
// Directory Scanning
// =============================================================================

/**
 * Find all skills in a directory
 */
function findSkills(baseDir) {
  const skills = []
  if (!existsSync(baseDir)) return skills

  try {
    const items = readdirSync(baseDir)
    for (const item of items) {
      const skillDir = join(baseDir, item)
      const stat = statSync(skillDir)
      if (stat.isDirectory()) {
        const skillFile = join(skillDir, 'SKILL.md')
        if (existsSync(skillFile)) {
          skills.push(skillFile)
        }
      }
    }
  } catch (err) {
    console.error(`${COLORS.yellow}Warning: Could not read directory ${baseDir}: ${err.message}${COLORS.reset}`)
  }

  return skills
}

// =============================================================================
// Main
// =============================================================================

function main() {
  const args = process.argv.slice(2)

  // Handle --help flag first
  if (args.includes('--help') || args.includes('-h')) {
    showHelp()
  }

  const projectOnly = args.includes('--project-only')
  const userOnly = args.includes('--user-only')
  const strict = args.includes('--strict')
  const jsonOutput = args.includes('--json')
  const fix = args.includes('--fix')

  // Determine directories to scan
  const directories = []

  if (!userOnly) {
    directories.push({
      name: 'Project Skills',
      path: join(process.cwd(), '.claude', 'skills'),
    })
  }

  if (!projectOnly) {
    directories.push({
      name: 'User Skills',
      path: join(homedir(), '.claude', 'skills'),
    })
  }

  // Collect all skills
  const allResults = []
  let totalErrors = 0
  let totalWarnings = 0
  let totalFixed = 0

  for (const dir of directories) {
    const skills = findSkills(dir.path)
    for (const skillPath of skills) {
      let result = validateSkill(skillPath)
      result.source = dir.name
      result.fixes = []

      // If --fix is enabled and there are errors, try to fix them
      if (fix && !result.valid) {
        try {
          const content = readFileSync(skillPath, 'utf8')
          const fixResult = fixSkill(skillPath, content)
          if (fixResult.fixed) {
            result.fixes = fixResult.changes
            totalFixed++
            // Re-validate after fix
            result = validateSkill(skillPath)
            result.source = dir.name
            result.fixes = fixResult.changes
          }
        } catch (err) {
          // Ignore fix errors, keep original validation result
        }
      }

      allResults.push(result)
      totalErrors += result.errors.length
      totalWarnings += result.warnings.length
    }
  }

  // Output results
  if (jsonOutput) {
    console.log(JSON.stringify({
      summary: {
        total: allResults.length,
        valid: allResults.filter(r => r.valid).length,
        invalid: allResults.filter(r => !r.valid).length,
        errors: totalErrors,
        warnings: totalWarnings,
        fixed: totalFixed,
      },
      skills: allResults,
    }, null, 2))
    process.exit(totalErrors > 0 || (strict && totalWarnings > 0) ? 1 : 0)
  }

  // Pretty output
  console.log(`\n${COLORS.bold}🔍 Local Skill Validation${COLORS.reset}\n`)
  console.log('━'.repeat(60) + '\n')

  if (allResults.length === 0) {
    console.log(`${COLORS.yellow}No skills found to validate${COLORS.reset}`)
    console.log(`\nSearched directories:`)
    for (const dir of directories) {
      console.log(`  - ${dir.path}`)
    }
    process.exit(0)
  }

  // Group by source
  const bySource = {}
  for (const result of allResults) {
    if (!bySource[result.source]) {
      bySource[result.source] = []
    }
    bySource[result.source].push(result)
  }

  for (const [source, results] of Object.entries(bySource)) {
    console.log(`${COLORS.bold}${source}${COLORS.reset}`)
    console.log('─'.repeat(40))

    for (const result of results) {
      const status = result.valid
        ? `${COLORS.green}✓${COLORS.reset}`
        : `${COLORS.red}✗${COLORS.reset}`

      console.log(`${status} ${result.name}`)

      for (const error of result.errors) {
        console.log(`  ${COLORS.red}✗ [${error.field}] ${error.message}${COLORS.reset}`)
      }

      for (const warning of result.warnings) {
        console.log(`  ${COLORS.yellow}⚠ [${warning.field}] ${warning.message}${COLORS.reset}`)
      }

      if (result.fixes && result.fixes.length > 0) {
        for (const fixMsg of result.fixes) {
          console.log(`  ${COLORS.blue}🔧 ${fixMsg}${COLORS.reset}`)
        }
      }
    }
    console.log('')
  }

  // Summary
  console.log('━'.repeat(60))
  const validCount = allResults.filter(r => r.valid).length
  const invalidCount = allResults.filter(r => !r.valid).length

  console.log(`\n${COLORS.bold}Summary${COLORS.reset}`)
  console.log(`  Total skills: ${allResults.length}`)
  console.log(`  ${COLORS.green}Valid: ${validCount}${COLORS.reset}`)
  if (invalidCount > 0) {
    console.log(`  ${COLORS.red}Invalid: ${invalidCount}${COLORS.reset}`)
  }
  if (totalWarnings > 0) {
    console.log(`  ${COLORS.yellow}Warnings: ${totalWarnings}${COLORS.reset}`)
  }
  if (totalFixed > 0) {
    console.log(`  ${COLORS.blue}Fixed: ${totalFixed}${COLORS.reset}`)
  }

  // Exit code
  const exitCode = totalErrors > 0 || (strict && totalWarnings > 0) ? 1 : 0
  if (exitCode === 0) {
    console.log(`\n${COLORS.green}✓ All skills valid${COLORS.reset}\n`)
  } else {
    console.log(`\n${COLORS.red}✗ Validation failed${COLORS.reset}`)
    console.log(`\n${COLORS.yellow}Fix the errors above before committing.${COLORS.reset}`)
    console.log(`${COLORS.yellow}Required frontmatter fields: name, description${COLORS.reset}\n`)
  }

  process.exit(exitCode)
}

main()
