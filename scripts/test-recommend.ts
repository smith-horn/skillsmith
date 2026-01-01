#!/usr/bin/env npx tsx
/**
 * SMI-904: CLI script for testing recommend tool with real database
 *
 * Usage:
 *   npm run recommend -- --context "React TypeScript frontend" --limit 10
 *   npx tsx scripts/test-recommend.ts --context "Docker Kubernetes DevOps" --limit 5
 *   npx tsx scripts/test-recommend.ts --installed "anthropic/commit,community/jest-helper"
 *
 * Options:
 *   --context, -c   Project context for recommendations
 *   --installed, -i Comma-separated list of installed skill IDs
 *   --limit, -l     Maximum recommendations (default: 10)
 *   --overlap       Enable overlap detection (default: true)
 *   --min-score     Minimum similarity threshold 0-1 (default: 0.3)
 *   --json          Output as JSON instead of formatted table
 *   --help, -h      Show help
 */

import { createTestDatabase } from '../packages/mcp-server/tests/integration/setup.js'
import {
  executeRecommend,
  formatRecommendations,
} from '../packages/mcp-server/src/tools/recommend.js'
import type { ToolContext } from '../packages/mcp-server/src/context.js'

interface CliArgs {
  context?: string
  installed: string[]
  limit: number
  detectOverlap: boolean
  minSimilarity: number
  json: boolean
  help: boolean
}

function parseArgs(): CliArgs {
  const args = process.argv.slice(2)
  const result: CliArgs = {
    installed: [],
    limit: 10,
    detectOverlap: true,
    minSimilarity: 0.3,
    json: false,
    help: false,
  }

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    const next = args[i + 1]

    switch (arg) {
      case '--context':
      case '-c':
        result.context = next
        i++
        break
      case '--installed':
      case '-i':
        result.installed = next?.split(',').map((s) => s.trim()) ?? []
        i++
        break
      case '--limit':
      case '-l':
        result.limit = parseInt(next, 10) || 10
        i++
        break
      case '--overlap':
        result.detectOverlap = next?.toLowerCase() !== 'false'
        i++
        break
      case '--min-score':
        result.minSimilarity = parseFloat(next) || 0.3
        i++
        break
      case '--json':
        result.json = true
        break
      case '--help':
      case '-h':
        result.help = true
        break
    }
  }

  return result
}

function showHelp(): void {
  console.log(`
Skillsmith Recommend CLI - Test skill recommendations

Usage:
  npx tsx scripts/test-recommend.ts [options]

Options:
  --context, -c <text>     Project context for recommendations
                           Example: "React TypeScript frontend with Jest testing"

  --installed, -i <ids>    Comma-separated list of installed skill IDs
                           Example: "anthropic/commit,community/jest-helper"

  --limit, -l <number>     Maximum recommendations to return (default: 10)

  --overlap <true|false>   Enable overlap detection (default: true)

  --min-score <0-1>        Minimum similarity threshold (default: 0.3)

  --json                   Output as JSON instead of formatted table

  --help, -h               Show this help message

Examples:
  # Recommend skills for a React project
  npx tsx scripts/test-recommend.ts --context "React TypeScript frontend"

  # Recommend based on installed skills
  npx tsx scripts/test-recommend.ts --installed "anthropic/commit"

  # Get JSON output for programmatic use
  npx tsx scripts/test-recommend.ts --context "Node.js API" --json

  # Full example with all options
  npx tsx scripts/test-recommend.ts \\
    --context "Docker Kubernetes DevOps" \\
    --installed "community/docker-compose" \\
    --limit 5 \\
    --min-score 0.5
`)
}

function formatTable(result: Awaited<ReturnType<typeof executeRecommend>>): void {
  console.log('\n┌─────────────────────────────────────────────────────────────────────────────┐')
  console.log('│                         SKILL RECOMMENDATIONS                              │')
  console.log('├─────────────────────────────────────────────────────────────────────────────┤')

  if (result.recommendations.length === 0) {
    console.log('│  No recommendations found. Try adjusting your search parameters.           │')
  } else {
    console.log('│  #  │ Skill                    │ Trust      │ Score │ Match │ Reason        │')
    console.log('├─────┼──────────────────────────┼────────────┼───────┼───────┼───────────────┤')

    result.recommendations.forEach((rec, idx) => {
      const num = String(idx + 1).padStart(2)
      const name = rec.name.slice(0, 22).padEnd(22)
      const trust = rec.trust_tier.slice(0, 10).padEnd(10)
      const score = String(rec.quality_score).padStart(3)
      const match = `${Math.round(rec.similarity_score * 100)}%`.padStart(4)
      const reason = rec.reason.slice(0, 13).padEnd(13)

      console.log(`│ ${num}  │ ${name} │ ${trust} │  ${score}  │ ${match}  │ ${reason} │`)
    })
  }

  console.log('├─────────────────────────────────────────────────────────────────────────────┤')
  console.log(
    `│  Candidates: ${String(result.candidates_considered).padStart(3)} │ Filtered: ${String(result.overlap_filtered).padStart(2)} │ Time: ${String(result.timing.totalMs).padStart(4)}ms │ Semantic: ${result.context.using_semantic_matching ? 'ON ' : 'OFF'}     │`
  )
  console.log('└─────────────────────────────────────────────────────────────────────────────┘')

  // Show skill IDs for easy copying
  if (result.recommendations.length > 0) {
    console.log('\nSkill IDs (for installation):')
    result.recommendations.forEach((rec) => {
      console.log(`  ${rec.skill_id}`)
    })
  }
}

async function main(): Promise<void> {
  const args = parseArgs()

  if (args.help) {
    showHelp()
    process.exit(0)
  }

  console.log('Initializing test database...')
  const ctx = await createTestDatabase()
  const toolContext: ToolContext = {
    db: ctx.db,
    searchService: ctx.searchService,
    skillRepository: ctx.skillRepository,
  }

  try {
    console.log('Running recommendations...')
    const result = await executeRecommend(
      {
        installed_skills: args.installed,
        project_context: args.context,
        limit: args.limit,
        detect_overlap: args.detectOverlap,
        min_similarity: args.minSimilarity,
      },
      toolContext
    )

    if (args.json) {
      console.log(JSON.stringify(result, null, 2))
    } else {
      formatTable(result)

      // Also show the standard format
      console.log('\n--- Standard Format ---')
      console.log(formatRecommendations(result))
    }
  } finally {
    await ctx.cleanup()
  }
}

main().catch((err) => {
  console.error('Error:', err.message)
  process.exit(1)
})
