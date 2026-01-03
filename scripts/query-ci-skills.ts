#!/usr/bin/env npx tsx
/**
 * Query skill database for CI/DevOps related skills
 */

import Database from 'better-sqlite3'

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
  console.log('🔍 Skillsmith CI/DevOps Skill Discovery\n')
  console.log('Problem Statement:')
  console.log('─'.repeat(60))
  console.log(PROBLEM_STATEMENT.trim())
  console.log('─'.repeat(60))

  const db = new Database('data/phase-5-full-import/skills.db', { readonly: true })

  // Query for CI/DevOps related skills
  const keywords = [
    'ci',
    'cd',
    'github',
    'action',
    'docker',
    'workflow',
    'devops',
    'deploy',
    'test',
    'lint',
    'build',
    'pipeline',
    'cache',
    'security',
    'audit',
    'node',
    'npm',
    'version',
  ]

  const query = `
    SELECT id, name, description, tags, trust_tier, quality_score, source
    FROM skills
    WHERE ${keywords.map((k) => `(LOWER(name) LIKE '%${k}%' OR LOWER(description) LIKE '%${k}%' OR LOWER(tags) LIKE '%${k}%')`).join(' OR ')}
    ORDER BY quality_score DESC
    LIMIT 50
  `

  const skills = db.prepare(query).all() as Array<{
    id: string
    name: string
    description: string
    tags: string
    trust_tier: string
    quality_score: number
    source: string
  }>

  console.log(`\n📊 Found ${skills.length} CI/DevOps related skills:\n`)

  // Group by source
  const bySource = new Map<string, typeof skills>()
  for (const skill of skills) {
    const src = skill.source || 'unknown'
    if (!bySource.has(src)) bySource.set(src, [])
    bySource.get(src)!.push(skill)
  }

  for (const [source, srcSkills] of bySource) {
    console.log(`\n### ${source.toUpperCase()} (${srcSkills.length} skills)`)
    srcSkills.slice(0, 5).forEach((s) => {
      console.log(`  - ${s.id} (${s.trust_tier}, score: ${s.quality_score})`)
      console.log(`    ${s.description?.substring(0, 80)}...`)
    })
  }

  // Gap Analysis
  console.log('\n' + '═'.repeat(60))
  console.log('📋 GAP ANALYSIS - Specific Skill Needs vs Available:')
  console.log('═'.repeat(60))

  const gaps = [
    { need: 'GitHub Actions Workflow Management', search: 'github action workflow' },
    { need: 'Flaky Test Detection/Retry', search: 'flaky retry intermittent' },
    { need: 'Node.js Version Synchronization', search: 'nvm volta node version' },
    { need: 'Docker Layer Optimization', search: 'docker layer cache multi-stage' },
    { need: 'npm Security Audit Automation', search: 'npm audit security vulnerability' },
    { need: 'CI Cache Optimization', search: 'ci cache artifact' },
    { need: 'ADR (Architecture Decision Records)', search: 'adr architecture decision' },
  ]

  for (const gap of gaps) {
    const terms = gap.search.split(' ')
    const found = skills.filter((s) => {
      const text = `${s.name} ${s.description}`.toLowerCase()
      return terms.some((t) => text.includes(t))
    })

    const status = found.length > 0 ? '✅ AVAILABLE' : '❌ GAP'
    console.log(`\n${status}: ${gap.need}`)
    if (found.length > 0) {
      found.slice(0, 2).forEach((s) => console.log(`   → ${s.id}`))
    } else {
      console.log(`   → No skills found for: "${gap.search}"`)
      console.log(`   → OPPORTUNITY: Build a new skill for this need`)
    }
  }

  // Current installed skills check
  console.log('\n' + '═'.repeat(60))
  console.log('🔧 CURRENTLY INSTALLED SKILLS (user has):')
  console.log('═'.repeat(60))
  const installed = [
    'docker',
    'linear',
    'clerk',
    'astro',
    'varlock',
    'dev-browser',
    'doc-screenshots',
    'governance',
    'vercel-github-actions',
    'e2e-patterns',
    '021-design',
  ]
  installed.forEach((s) => console.log(`  - ${s}`))

  console.log('\n' + '═'.repeat(60))
  console.log('💡 NEW SKILL RECOMMENDATIONS:')
  console.log('═'.repeat(60))

  const recommendations = [
    {
      name: 'ci-doctor',
      description: 'Diagnose and fix common CI/CD pipeline issues',
      triggers: ['CI failing', 'workflow broken', 'pipeline error'],
      value: 'Auto-detect Node version mismatches, caching issues, flaky tests',
    },
    {
      name: 'flaky-test-detector',
      description: 'Identify and fix timing-sensitive tests',
      triggers: ['flaky test', 'intermittent failure', 'race condition'],
      value: 'Audit tests for TTL, timeout, sleep patterns',
    },
    {
      name: 'version-sync',
      description: 'Synchronize versions across config files',
      triggers: ['version mismatch', 'upgrade node', 'sync versions'],
      value: 'Keep Dockerfile, CI, nvmrc, package.json in sync',
    },
    {
      name: 'docker-optimizer',
      description: 'Optimize Dockerfile for faster builds',
      triggers: ['slow build', 'optimize docker', 'layer caching'],
      value: 'Multi-stage builds, layer ordering, cache optimization',
    },
    {
      name: 'security-auditor',
      description: 'Structured security audit with remediation',
      triggers: ['npm audit', 'vulnerability', 'security check'],
      value: 'Parse audit output, suggest fixes, track resolution',
    },
  ]

  recommendations.forEach((r, i) => {
    console.log(`\n${i + 1}. ${r.name}`)
    console.log(`   Description: ${r.description}`)
    console.log(`   Triggers: ${r.triggers.join(', ')}`)
    console.log(`   Value: ${r.value}`)
  })

  db.close()
  console.log('\n\n✅ Analysis complete')
}

main().catch(console.error)
