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

/**
 * Refined category mapping - specific and meaningful categories
 * Avoids broad terms like "engineering", "AI & Technology", "Hiring & Teams"
 */
const REFINED_CATEGORIES: Record<string, { category: string; tags: string[] }> = {
  // Product Strategy & Planning
  'writing-north-star-metrics': {
    category: 'product-strategy',
    tags: ['metrics', 'okrs', 'alignment'],
  },
  'defining-product-vision': {
    category: 'product-strategy',
    tags: ['vision', 'roadmap', 'planning'],
  },
  'prioritizing-roadmap': {
    category: 'product-strategy',
    tags: ['prioritization', 'roadmap', 'planning'],
  },
  'setting-okrs-goals': { category: 'product-strategy', tags: ['okrs', 'goals', 'metrics'] },
  'competitive-analysis': {
    category: 'product-strategy',
    tags: ['competition', 'market-research', 'strategy'],
  },
  'working-backwards': { category: 'product-strategy', tags: ['amazon', 'planning', 'prfaq'] },
  'product-taste-intuition': {
    category: 'product-strategy',
    tags: ['taste', 'intuition', 'craft'],
  },
  'startup-ideation': { category: 'product-strategy', tags: ['ideation', 'startup', 'ideas'] },
  'startup-pivoting': { category: 'product-strategy', tags: ['pivot', 'startup', 'strategy'] },

  // Product Execution & Shipping
  'writing-prds': { category: 'product-execution', tags: ['prd', 'specs', 'documentation'] },
  'problem-definition': { category: 'product-execution', tags: ['problem-framing', 'discovery'] },
  'writing-specs-designs': {
    category: 'product-execution',
    tags: ['specs', 'design-docs', 'documentation'],
  },
  'scoping-cutting': { category: 'product-execution', tags: ['scoping', 'mvp', 'prioritization'] },
  'shipping-products': {
    category: 'product-execution',
    tags: ['shipping', 'launches', 'execution'],
  },
  'managing-timelines': {
    category: 'product-execution',
    tags: ['timelines', 'project-management', 'deadlines'],
  },
  'product-operations': {
    category: 'product-execution',
    tags: ['product-ops', 'operations', 'process'],
  },
  dogfooding: {
    category: 'product-execution',
    tags: ['dogfooding', 'internal-testing', 'feedback'],
  },

  // User Research & Discovery
  'conducting-user-interviews': {
    category: 'user-research',
    tags: ['interviews', 'discovery', 'qualitative'],
  },
  'designing-surveys': { category: 'user-research', tags: ['surveys', 'quantitative', 'research'] },
  'analyzing-user-feedback': { category: 'user-research', tags: ['feedback', 'analysis', 'voc'] },
  'usability-testing': { category: 'user-research', tags: ['usability', 'testing', 'ux-research'] },
  'behavioral-product-design': {
    category: 'user-research',
    tags: ['behavioral', 'psychology', 'nudges'],
  },

  // Team Leadership & Management
  'running-effective-1-1s': {
    category: 'team-leadership',
    tags: ['one-on-ones', 'management', 'coaching'],
  },
  'having-difficult-conversations': {
    category: 'team-leadership',
    tags: ['feedback', 'difficult-conversations', 'management'],
  },
  'delegating-work': {
    category: 'team-leadership',
    tags: ['delegation', 'leverage', 'management'],
  },
  'managing-up': {
    category: 'team-leadership',
    tags: ['managing-up', 'stakeholders', 'influence'],
  },
  'coaching-pms': {
    category: 'team-leadership',
    tags: ['coaching', 'mentoring', 'pm-development'],
  },
  'building-team-culture': {
    category: 'team-leadership',
    tags: ['culture', 'team-building', 'values'],
  },
  'team-rituals': {
    category: 'team-leadership',
    tags: ['rituals', 'ceremonies', 'team-practices'],
  },
  'energy-management': {
    category: 'team-leadership',
    tags: ['energy', 'burnout', 'sustainability'],
  },

  // Talent & Recruiting (more specific than "Hiring & Teams")
  'writing-job-descriptions': {
    category: 'talent-recruiting',
    tags: ['job-descriptions', 'recruiting', 'hiring'],
  },
  'conducting-interviews': {
    category: 'talent-recruiting',
    tags: ['interviewing', 'hiring', 'assessment'],
  },
  'evaluating-candidates': {
    category: 'talent-recruiting',
    tags: ['evaluation', 'hiring', 'assessment'],
  },
  'onboarding-new-hires': {
    category: 'talent-recruiting',
    tags: ['onboarding', 'new-hires', 'ramping'],
  },

  // Decision Making & Execution
  'running-decision-processes': {
    category: 'decision-making',
    tags: ['decisions', 'frameworks', 'process'],
  },
  'planning-under-uncertainty': {
    category: 'decision-making',
    tags: ['uncertainty', 'risk', 'planning'],
  },
  'evaluating-trade-offs': {
    category: 'decision-making',
    tags: ['trade-offs', 'analysis', 'decisions'],
  },
  'post-mortems-retrospectives': {
    category: 'decision-making',
    tags: ['retrospectives', 'learning', 'post-mortems'],
  },
  'systems-thinking': { category: 'decision-making', tags: ['systems', 'complexity', 'thinking'] },

  // Cross-functional & Org Design
  'cross-functional-collaboration': {
    category: 'org-effectiveness',
    tags: ['cross-functional', 'collaboration', 'alignment'],
  },
  'organizational-design': {
    category: 'org-effectiveness',
    tags: ['org-design', 'structure', 'scaling'],
  },
  'organizational-transformation': {
    category: 'org-effectiveness',
    tags: ['transformation', 'change-management', 'culture'],
  },

  // Communication & Influence
  'giving-presentations': {
    category: 'communication',
    tags: ['presentations', 'public-speaking', 'storytelling'],
  },
  'written-communication': {
    category: 'communication',
    tags: ['writing', 'documentation', 'async'],
  },
  'stakeholder-alignment': {
    category: 'communication',
    tags: ['stakeholders', 'alignment', 'influence'],
  },
  'running-offsites': { category: 'communication', tags: ['offsites', 'team-events', 'planning'] },
  'running-effective-meetings': {
    category: 'communication',
    tags: ['meetings', 'facilitation', 'efficiency'],
  },

  // Growth & Metrics
  'measuring-product-market-fit': {
    category: 'growth-metrics',
    tags: ['pmf', 'product-market-fit', 'validation'],
  },
  'designing-growth-loops': {
    category: 'growth-metrics',
    tags: ['growth-loops', 'virality', 'acquisition'],
  },
  'pricing-strategy': { category: 'growth-metrics', tags: ['pricing', 'monetization', 'strategy'] },
  'retention-engagement': {
    category: 'growth-metrics',
    tags: ['retention', 'engagement', 'churn'],
  },
  'marketplace-liquidity': {
    category: 'growth-metrics',
    tags: ['marketplace', 'liquidity', 'supply-demand'],
  },
  'user-onboarding': {
    category: 'growth-metrics',
    tags: ['onboarding', 'activation', 'first-run'],
  },

  // Go-to-Market & Sales
  'positioning-messaging': {
    category: 'go-to-market',
    tags: ['positioning', 'messaging', 'branding'],
  },
  'brand-storytelling': { category: 'go-to-market', tags: ['storytelling', 'brand', 'narrative'] },
  'launch-marketing': { category: 'go-to-market', tags: ['launches', 'marketing', 'gtm'] },
  'content-marketing': { category: 'go-to-market', tags: ['content', 'marketing', 'distribution'] },
  'community-building': { category: 'go-to-market', tags: ['community', 'engagement', 'advocacy'] },
  'media-relations': { category: 'go-to-market', tags: ['pr', 'media', 'press'] },
  'founder-sales': { category: 'go-to-market', tags: ['sales', 'founder-led', 'b2b'] },
  'building-sales-team': { category: 'go-to-market', tags: ['sales-team', 'hiring', 'scaling'] },
  'enterprise-sales': { category: 'go-to-market', tags: ['enterprise', 'sales', 'b2b'] },
  'partnership-bd': { category: 'go-to-market', tags: ['partnerships', 'bd', 'alliances'] },
  'product-led-sales': { category: 'go-to-market', tags: ['pls', 'product-led', 'sales'] },
  'sales-compensation': { category: 'go-to-market', tags: ['compensation', 'incentives', 'sales'] },
  'sales-qualification': {
    category: 'go-to-market',
    tags: ['qualification', 'discovery', 'sales'],
  },

  // Career Development
  'building-a-promotion-case': {
    category: 'career-development',
    tags: ['promotions', 'career', 'growth'],
  },
  'negotiating-offers': {
    category: 'career-development',
    tags: ['negotiation', 'offers', 'compensation'],
  },
  'finding-mentors-sponsors': {
    category: 'career-development',
    tags: ['mentorship', 'sponsorship', 'networking'],
  },
  'career-transitions': {
    category: 'career-development',
    tags: ['transitions', 'career-change', 'job-search'],
  },
  'managing-imposter-syndrome': {
    category: 'career-development',
    tags: ['imposter-syndrome', 'confidence', 'mindset'],
  },
  'personal-productivity': {
    category: 'career-development',
    tags: ['productivity', 'time-management', 'efficiency'],
  },
  fundraising: { category: 'career-development', tags: ['fundraising', 'vc', 'startup'] },

  // LLM & AI Products (specific, not generic "AI")
  'ai-product-strategy': {
    category: 'llm-products',
    tags: ['ai-strategy', 'ml-products', 'ai-roadmap'],
  },
  'building-with-llms': { category: 'llm-products', tags: ['llm', 'gpt', 'ai-development'] },
  'evaluating-new-technology': {
    category: 'llm-products',
    tags: ['tech-evaluation', 'adoption', 'innovation'],
  },
  'platform-strategy': { category: 'llm-products', tags: ['platform', 'ecosystem', 'api'] },
  'vibe-coding': { category: 'llm-products', tags: ['vibe-coding', 'ai-assisted', 'no-code'] },
  'ai-evals': { category: 'llm-products', tags: ['evals', 'ai-testing', 'benchmarks'] },

  // Technical Leadership (specific, not generic "engineering")
  'technical-roadmaps': {
    category: 'technical-leadership',
    tags: ['tech-roadmap', 'architecture', 'planning'],
  },
  'managing-tech-debt': {
    category: 'technical-leadership',
    tags: ['tech-debt', 'refactoring', 'maintenance'],
  },
  'platform-infrastructure': {
    category: 'technical-leadership',
    tags: ['infrastructure', 'platform', 'scalability'],
  },
  'engineering-culture': {
    category: 'technical-leadership',
    tags: ['eng-culture', 'practices', 'excellence'],
  },
  'design-engineering': {
    category: 'technical-leadership',
    tags: ['design-engineering', 'craft', 'frontend'],
  },

  // Design Excellence (specific, not generic "design")
  'design-systems': {
    category: 'design-excellence',
    tags: ['design-systems', 'components', 'consistency'],
  },
  'running-design-reviews': {
    category: 'design-excellence',
    tags: ['design-reviews', 'critique', 'quality'],
  },
}

/**
 * Author attribution
 */
const AUTHOR_INFO = {
  author: 'sidbharath',
  authorName: 'Sid Bharath',
  organization: 'Refound AI',
  githubUrl: 'https://github.com/sidbharath',
  blogUrl: 'https://sidbharath.com/blog/building-lenny-skills-database/',
  sourceUrl: 'https://refoundai.com/lenny-skills/',
  license: 'CC BY 4.0', // Assuming - Lenny's transcripts are public
}

/**
 * Approval criteria
 */
const APPROVAL_CRITERIA = {
  minGuestCount: 10, // Auto-approve skills with 10+ expert guests
  minInsightCount: 15, // Or 15+ insights
  minQualityScore: 0.85, // Or high quality score
}

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
 * Get refined category and tags for a skill
 */
function getRefinedCategoryAndTags(slug: string): { category: string; tags: string[] } {
  const refined = REFINED_CATEGORIES[slug]
  if (refined) {
    return refined
  }
  // Fallback
  return { category: 'product-management', tags: ['product', 'strategy'] }
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
    refined: { category: string; tags: string[] }
  }> = []
  const toReview: Array<{
    skill: Skill
    reason: string
    refined: { category: string; tags: string[] }
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
    console.log(`  ✓ ${slug} (${reason}) → ${refined.category}`)
  }
  if (toApprove.length > 10) {
    console.log(`  ... and ${toApprove.length - 10} more`)
  }
  console.log('')

  // Show manual review candidates
  console.log('=== Manual Review Required ===')
  for (const { skill, reason, refined } of toReview) {
    const slug = skill.id.split('/').pop()
    console.log(`  ? ${slug} (${reason}) → ${refined.category}`)
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
