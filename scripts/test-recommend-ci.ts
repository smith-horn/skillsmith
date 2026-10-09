#!/usr/bin/env npx tsx
/**
 * Test Skillsmith recommend with CI/DevOps problem statement
 * Simulating a user asking for help with CI pipeline issues
 */

import { SkillRepository, createDatabase, closeDatabase } from '@skillsmith/core'
import type { Skill } from '@skillsmith/core'
import * as path from 'path'
import * as os from 'os'

const PROBLEM_STATEMENT = `
I'm working on a GitHub Actions CI/CD pipeline and experiencing several issues:
1. Flaky tests that fail intermittently due to timing issues
2. Node.js version inconsistencies between local development, Docker, and CI
3. Slow CI runs because dependencies are installed multiple times
4. Security audit warnings being masked instead of properly handled
5. Docker image builds taking too long without proper layer caching

I need help with CI/CD best practices, Docker optimization, test reliability,
and maintaining consistent development environments across the team.
`

async function main() {
  console.log('🔍 Testing Skillsmith Recommendations\n')
  console.log('Problem Statement:')
  console.log('─'.repeat(60))
  console.log(PROBLEM_STATEMENT.trim())
  console.log('─'.repeat(60))
  console.log('\n📊 Fetching skill recommendations...\n')

  // Initialize services
  const dbPath = path.join(os.tmpdir(), 'skillsmith-test-' + Date.now() + '.db')
  const db = createDatabase(dbPath)
  const repo = new SkillRepository(db)

  // Get all skills from repository. findAll() returns PaginatedResults<Skill>
  // (an { items, total, limit, offset, hasMore } envelope), not a bare array --
  // the array itself is `.items`. SMI-6975: `allSkills` used to be the whole
  // envelope with no type annotation (implicit any from the `await`'s inferred
  // type being treated as array-like downstream), so `.length`/`.filter` below
  // silently resolved to `undefined`/a missing method at runtime rather than
  // failing -- strict mode now catches the shape mismatch at compile time.
  const allSkills: Skill[] = (await repo.findAll({ limit: 200 })).items

  console.log(`Found ${allSkills.length} skills in database\n`)

  // Simple keyword matching for demo
  const keywords = [
    'ci',
    'cd',
    'github',
    'actions',
    'docker',
    'test',
    'node',
    'npm',
    'devops',
    'pipeline',
    'build',
    'deploy',
    'cache',
    'security',
    'audit',
    'workflow',
    'automation',
    'commit',
    'git',
    'lint',
    'format',
  ]

  const relevantSkills = allSkills.filter((skill) => {
    // SMI-6975: `Skill` has no `category` field (that's `SearchOptions.category`,
    // a query filter, not a row property) -- `skill.category` was always
    // `undefined` here under the prior implicit-any typing. `tags` is the real
    // per-skill classification data, so it replaces the dead reference rather
    // than being silenced with `any`.
    const searchText = `${skill.name} ${skill.description} ${skill.tags.join(' ')}`.toLowerCase()
    return keywords.some((kw) => searchText.includes(kw))
  })

  console.log(`🎯 Relevant skills for CI/DevOps context (${relevantSkills.length} found):\n`)

  if (relevantSkills.length === 0) {
    console.log('No skills found matching CI/DevOps keywords.')
    console.log('\nThis indicates an opportunity to build new skills for:')
    console.log('- GitHub Actions workflow management')
    console.log('- Docker optimization')
    console.log('- Test reliability/flaky test detection')
    console.log('- Node.js version management')
    console.log('- CI/CD security auditing')
  } else {
    relevantSkills.slice(0, 15).forEach((skill, i) => {
      console.log(`${i + 1}. ${skill.id}`)
      console.log(`   Name: ${skill.name}`)
      console.log(`   Tags: ${skill.tags.join(', ') || 'none'}`)
      console.log(`   Trust: ${skill.trustTier}`)
      console.log(`   Description: ${skill.description?.substring(0, 100)}...`)
      console.log('')
    })
  }

  // Gap analysis
  console.log('\n' + '═'.repeat(60))
  console.log('📋 GAP ANALYSIS - Skills NOT in database but NEEDED:')
  console.log('═'.repeat(60))

  const gapAreas = [
    {
      area: 'Flaky Test Detection',
      keywords: ['flaky', 'retry', 'intermittent'],
      found: relevantSkills.some(
        (s) =>
          s.description?.toLowerCase().includes('flaky') ||
          s.description?.toLowerCase().includes('retry')
      ),
    },
    {
      area: 'Node.js Version Management',
      keywords: ['nvm', 'volta', 'node version'],
      found: relevantSkills.some(
        (s) =>
          s.description?.toLowerCase().includes('nvm') ||
          s.description?.toLowerCase().includes('volta')
      ),
    },
    {
      area: 'CI Cache Optimization',
      keywords: ['cache', 'layer', 'artifact'],
      found: relevantSkills.some(
        (s) =>
          s.description?.toLowerCase().includes('cache') &&
          s.description?.toLowerCase().includes('ci')
      ),
    },
    {
      area: 'Security Audit Automation',
      keywords: ['npm audit', 'security', 'vulnerability'],
      found: relevantSkills.some(
        (s) =>
          s.description?.toLowerCase().includes('audit') ||
          s.description?.toLowerCase().includes('vulnerability')
      ),
    },
    {
      area: 'Docker Layer Optimization',
      keywords: ['dockerfile', 'multi-stage', 'layer'],
      found: relevantSkills.some(
        (s) =>
          s.description?.toLowerCase().includes('dockerfile') ||
          s.description?.toLowerCase().includes('multi-stage')
      ),
    },
    {
      area: 'GitHub Actions Workflow',
      keywords: ['github actions', 'workflow', 'matrix'],
      found: relevantSkills.some(
        (s) =>
          s.description?.toLowerCase().includes('github actions') ||
          s.name?.toLowerCase().includes('github-actions')
      ),
    },
  ]

  gapAreas.forEach((gap) => {
    const status = gap.found ? '✅ COVERED' : '❌ GAP'
    console.log(`\n${status}: ${gap.area}`)
    console.log(`   Keywords: ${gap.keywords.join(', ')}`)
  })

  // Cleanup
  closeDatabase(db)

  console.log('\n\n✅ Recommendation test complete')
}

main().catch(console.error)
