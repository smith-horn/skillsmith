#!/usr/bin/env node
/**
 * SMI-1775: Local Skill Validation Script
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
 *   --fix           Attempt to fix issues (not implemented yet)
 *   --json          Output results as JSON
 */

import { readFileSync, existsSync, readdirSync, statSync } from 'fs'
import { join, basename, dirname } from 'path'
import { homedir } from 'os'

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
  const projectOnly = args.includes('--project-only')
  const userOnly = args.includes('--user-only')
  const strict = args.includes('--strict')
  const jsonOutput = args.includes('--json')

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

  for (const dir of directories) {
    const skills = findSkills(dir.path)
    for (const skillPath of skills) {
      const result = validateSkill(skillPath)
      result.source = dir.name
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
