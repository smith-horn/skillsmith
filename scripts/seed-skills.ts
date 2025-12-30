#!/usr/bin/env npx tsx
/**
 * Seed Skills Script
 *
 * Loads seed data into the Skillsmith database for development and testing.
 * Can be run with Docker or directly with tsx.
 *
 * Usage:
 *   docker exec skillsmith-dev-1 npx tsx scripts/seed-skills.ts
 *   npx tsx scripts/seed-skills.ts --db ./test.db
 *
 * Options:
 *   --db <path>     Database path (default: ~/.skillsmith/skills.db)
 *   --clear         Clear existing skills before seeding
 *   --verbose       Show detailed output
 *
 * @see SMI-794: Add seed data for testing
 */

import { existsSync, mkdirSync, readFileSync } from 'fs'
import { dirname, join } from 'path'
import { homedir } from 'os'
import { fileURLToPath } from 'url'
import {
  createDatabase,
  initializeSchema,
  SkillRepository,
  type SkillCreateInput,
} from '@skillsmith/core'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)

interface SeedSkill {
  id: string
  name: string
  description: string
  author: string
  repoUrl: string
  qualityScore: number
  trustTier: 'verified' | 'community' | 'experimental' | 'unknown'
  tags: string[]
}

interface SeedData {
  description: string
  version: string
  skills: SeedSkill[]
}

function parseArgs(): { dbPath: string; clear: boolean; verbose: boolean } {
  const args = process.argv.slice(2)
  let dbPath = join(homedir(), '.skillsmith', 'skills.db')
  let clear = false
  let verbose = false

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--db' && args[i + 1]) {
      dbPath = args[i + 1]
      i++
    } else if (args[i] === '--clear') {
      clear = true
    } else if (args[i] === '--verbose') {
      verbose = true
    }
  }

  return { dbPath, clear, verbose }
}

function loadSeedData(): SeedData {
  const seedPath = join(__dirname, '../packages/core/tests/fixtures/skills/seed-skills.json')
  const content = readFileSync(seedPath, 'utf-8')
  return JSON.parse(content) as SeedData
}

async function main() {
  const { dbPath, clear, verbose } = parseArgs()

  console.log('Skillsmith Seed Data Loader')
  console.log('===========================')
  console.log(`Database: ${dbPath}`)
  console.log(`Clear existing: ${clear}`)
  console.log('')

  // Ensure directory exists
  const dbDir = dirname(dbPath)
  if (!existsSync(dbDir)) {
    mkdirSync(dbDir, { recursive: true })
    console.log(`Created directory: ${dbDir}`)
  }

  // Load seed data
  const seedData = loadSeedData()
  console.log(`Loaded ${seedData.skills.length} skills from seed file (v${seedData.version})`)
  console.log('')

  // Initialize database
  const db = createDatabase(dbPath)
  initializeSchema(db)

  // Create repository
  const skillRepository = new SkillRepository(db)

  // Clear existing skills if requested
  if (clear) {
    console.log('Clearing existing skills...')
    const allSkills = skillRepository.findAll(1000, 0)
    for (const skill of allSkills.items) {
      skillRepository.delete(skill.id)
    }
    console.log(`Deleted ${allSkills.items.length} existing skills`)
    console.log('')
  }

  // Insert seed skills
  console.log('Inserting seed skills...')
  let inserted = 0
  let skipped = 0
  let errors = 0

  for (const skill of seedData.skills) {
    try {
      // Check if skill already exists
      const existing = skillRepository.findById(skill.id)
      if (existing) {
        if (verbose) {
          console.log(`  [SKIP] ${skill.id} - already exists`)
        }
        skipped++
        continue
      }

      // Convert to SkillCreateInput
      const input: SkillCreateInput = {
        id: skill.id,
        name: skill.name,
        description: skill.description,
        author: skill.author,
        repoUrl: skill.repoUrl,
        qualityScore: skill.qualityScore,
        trustTier: skill.trustTier,
        tags: skill.tags,
      }

      skillRepository.create(input)
      if (verbose) {
        console.log(
          `  [OK] ${skill.id} (${skill.trustTier}, score: ${Math.round(skill.qualityScore * 100)})`
        )
      }
      inserted++
    } catch (error) {
      console.error(
        `  [ERROR] ${skill.id}: ${error instanceof Error ? error.message : 'Unknown error'}`
      )
      errors++
    }
  }

  console.log('')
  console.log('Summary')
  console.log('-------')
  console.log(`  Inserted: ${inserted}`)
  console.log(`  Skipped:  ${skipped}`)
  console.log(`  Errors:   ${errors}`)
  console.log(`  Total:    ${seedData.skills.length}`)
  console.log('')

  // Verify by counting
  const count = skillRepository.findAll(1000, 0)
  console.log(`Database now contains ${count.total} skills`)

  // Show breakdown by trust tier
  if (verbose) {
    console.log('')
    console.log('Skills by Trust Tier:')
    const verified = count.items.filter((s) => s.trustTier === 'verified').length
    const community = count.items.filter((s) => s.trustTier === 'community').length
    const experimental = count.items.filter((s) => s.trustTier === 'experimental').length
    const unknown = count.items.filter((s) => s.trustTier === 'unknown').length
    console.log(`  Verified:     ${verified}`)
    console.log(`  Community:    ${community}`)
    console.log(`  Experimental: ${experimental}`)
    console.log(`  Unknown:      ${unknown}`)
  }

  db.close()
  console.log('')
  console.log('Done!')
}

main().catch((error) => {
  console.error('Fatal error:', error)
  process.exit(1)
})
