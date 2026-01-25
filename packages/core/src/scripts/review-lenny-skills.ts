/**
 * SMI-1757: Review and Approve Lenny Skills for Quarantine Release
 *
 * This script:
 * 1. Refines categories to be more specific (not "engineering" or "AI & Technology")
 * 2. Cites proper author attribution (sidbharath/Refound AI)
 * 3. Batch-approves high-quality skills (10+ guests)
 * 4. Identifies potential duplicates with existing skills
 *
 * Usage:
 *   npx tsx packages/core/src/scripts/review-lenny-skills.ts [--approve] [--dry-run]
 *
 * Source: https://github.com/sidbharath
 * Blog: https://sidbharath.com/blog/building-lenny-skills-database/
 */

import Database from 'better-sqlite3'
import { readFileSync, writeFileSync, existsSync } from 'fs'

import {
  AUTHOR_INFO,
  APPROVAL_CRITERIA,
  getRefinedCategoryAndTags,
  type RefinedCategory,
} from './review-categories.js'

// Re-export for backwards compatibility
export { AUTHOR_INFO, APPROVAL_CRITERIA, REFINED_CATEGORIES } from './review-categories.js'

interface Skill {
  id: string
  name: string
  description: string
  author: string
  repoUrl: string
  qualityScore: number
  trustTier: string
  tags: string[]
  source: string
  category: string
  guestCount?: number
  insightCount?: number
}

/**
 * Check if a skill should be auto-approved
 */
function shouldAutoApprove(skill: Skill): { approved: boolean; reason: string } {
  const guestCount = skill.guestCount || 0
  const insightCount = skill.insightCount || 0
  const qualityScore = skill.qualityScore || 0

  if (guestCount >= APPROVAL_CRITERIA.minGuestCount) {
    return { approved: true, reason: `${guestCount} expert guests` }
  }
  if (insightCount >= APPROVAL_CRITERIA.minInsightCount) {
    return { approved: true, reason: `${insightCount} insights` }
  }
  if (qualityScore >= APPROVAL_CRITERIA.minQualityScore) {
    return { approved: true, reason: `quality score ${qualityScore.toFixed(2)}` }
  }

  return { approved: false, reason: `${guestCount} guests, ${insightCount} insights` }
}

/**
 * Main review function
 */
export async function reviewLennySkills(options: {
  approve?: boolean
  dryRun?: boolean
  dbPath?: string
  inputPath?: string
}): Promise<void> {
  const {
    approve = false,
    dryRun = true,
    dbPath = './data/lenny-skills.db',
    inputPath = './data/lenny-skills.json',
  } = options

  console.log('[SMI-1757] Lenny Skills Review')
  console.log(`[SMI-1757] Mode: ${dryRun ? 'DRY RUN' : 'LIVE'}`)
  console.log(`[SMI-1757] Auto-approve: ${approve}`)
  console.log('')

  // Read skills from JSON
  if (!existsSync(inputPath)) {
    throw new Error(`Input file not found: ${inputPath}`)
  }
  const data = JSON.parse(readFileSync(inputPath, 'utf-8'))
  const skills: Skill[] = data.skills

  console.log(`[SMI-1757] Found ${skills.length} skills to review`)
  console.log('')

  // Categorize skills
  const toApprove: Array<{
    skill: Skill
    reason: string
    refined: RefinedCategory
  }> = []
  const toReview: Array<{
    skill: Skill
    reason: string
    refined: RefinedCategory
  }> = []

  for (const skill of skills) {
    const slug = skill.id.split('/').pop() || ''
    const refined = getRefinedCategoryAndTags(slug)
    const { approved, reason } = shouldAutoApprove(skill)

    if (approved) {
      toApprove.push({ skill, reason, refined })
    } else {
      toReview.push({ skill, reason, refined })
    }
  }

  console.log(`[SMI-1757] Auto-approve: ${toApprove.length} skills`)
  console.log(`[SMI-1757] Manual review: ${toReview.length} skills`)
  console.log('')

  // Show category distribution
  const byCategory = new Map<string, number>()
  for (const { refined } of [...toApprove, ...toReview]) {
    byCategory.set(refined.category, (byCategory.get(refined.category) || 0) + 1)
  }

  console.log('=== Refined Categories ===')
  Array.from(byCategory.entries())
    .sort((a, b) => b[1] - a[1])
    .forEach(([cat, count]) => {
      console.log(`  ${cat}: ${count}`)
    })
  console.log('')

  // Show auto-approve candidates
  console.log('=== Auto-Approve Candidates ===')
  for (const { skill, reason, refined } of toApprove.slice(0, 10)) {
    const slug = skill.id.split('/').pop()
    console.log(`  [ok] ${slug} (${reason}) -> ${refined.category}`)
  }
  if (toApprove.length > 10) {
    console.log(`  ... and ${toApprove.length - 10} more`)
  }
  console.log('')

  // Show manual review candidates
  console.log('=== Manual Review Required ===')
  for (const { skill, reason, refined } of toReview) {
    const slug = skill.id.split('/').pop()
    console.log(`  ? ${slug} (${reason}) -> ${refined.category}`)
  }
  console.log('')

  // Generate updated skills with proper attribution
  const updatedSkills = skills.map((skill) => {
    const slug = skill.id.split('/').pop() || ''
    const refined = getRefinedCategoryAndTags(slug)
    const { approved } = shouldAutoApprove(skill)

    return {
      ...skill,
      // Update author attribution
      author: AUTHOR_INFO.author,
      repoUrl: `${AUTHOR_INFO.sourceUrl}s/${slug}/`,
      // Update category and tags
      category: refined.category,
      tags: ['lenny-podcast', 'product-leadership', refined.category, ...refined.tags].filter(
        (v, i, a) => a.indexOf(v) === i
      ), // dedupe
      // Update trust tier based on approval
      trustTier: approved ? 'community' : 'experimental',
      // Add source metadata
      source: 'refoundai',
      metadata: {
        originalSource: AUTHOR_INFO.sourceUrl,
        authorGithub: AUTHOR_INFO.githubUrl,
        blogPost: AUTHOR_INFO.blogUrl,
        guestCount: skill.guestCount,
        insightCount: skill.insightCount,
      },
    }
  })

  // Save updated skills
  const outputPath = './data/lenny-skills-reviewed.json'
  const output = {
    ...data,
    description: `Lenny Skills from Refound AI - Reviewed and categorized. Source: ${AUTHOR_INFO.blogUrl}`,
    author: {
      name: AUTHOR_INFO.authorName,
      github: AUTHOR_INFO.githubUrl,
      organization: AUTHOR_INFO.organization,
    },
    metadata: {
      ...data.metadata,
      reviewedAt: new Date().toISOString(),
      autoApproved: toApprove.length,
      pendingReview: toReview.length,
      byCategory: Object.fromEntries(byCategory),
    },
    skills: updatedSkills,
  }

  if (!dryRun) {
    writeFileSync(outputPath, JSON.stringify(output, null, 2))
    console.log(`[SMI-1757] Saved reviewed skills to: ${outputPath}`)

    // Update database if approve flag is set
    if (approve && existsSync(dbPath)) {
      const db = new Database(dbPath)

      // Update skills table
      const updateSkill = db.prepare(`
        UPDATE skills SET
          author = ?,
          tags = ?,
          updated_at = datetime('now')
        WHERE id = ?
      `)

      // Update quarantine table
      const updateQuarantine = db.prepare(`
        UPDATE quarantine SET
          review_status = ?,
          reviewed_by = 'auto-review',
          review_notes = ?,
          review_date = datetime('now'),
          updated_at = datetime('now')
        WHERE skill_id = ?
      `)

      let approvedCount = 0
      for (const { skill, reason, refined } of toApprove) {
        const tags = JSON.stringify([
          'lenny-podcast',
          'product-leadership',
          refined.category,
          ...refined.tags,
        ])

        updateSkill.run(AUTHOR_INFO.author, tags, skill.id)
        updateQuarantine.run('approved', `Auto-approved: ${reason}`, skill.id)
        approvedCount++
      }

      db.close()
      console.log(`[SMI-1757] Approved ${approvedCount} skills in database`)
    }
  } else {
    console.log('[SMI-1757] DRY RUN - no changes made')
    console.log(`[SMI-1757] Would save to: ${outputPath}`)
  }

  // Print summary
  console.log('')
  console.log('=== Summary ===')
  console.log(`Total skills: ${skills.length}`)
  console.log(`Auto-approved: ${toApprove.length}`)
  console.log(`Pending review: ${toReview.length}`)
  console.log(`Author: ${AUTHOR_INFO.authorName} (${AUTHOR_INFO.githubUrl})`)
  console.log(`Source: ${AUTHOR_INFO.sourceUrl}`)
}

/**
 * CLI entry point
 */
async function main(): Promise<void> {
  const args = process.argv.slice(2)
  const approve = args.includes('--approve')
  const dryRun = !args.includes('--no-dry-run') && !approve

  await reviewLennySkills({ approve, dryRun })
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error('Fatal error:', error)
    process.exit(1)
  })
}
