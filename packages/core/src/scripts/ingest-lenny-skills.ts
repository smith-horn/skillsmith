/**
 * SMI-1757: Ingest Lenny Skills from Refound AI
 *
 * This script reads downloaded Lenny Skills from Refound AI and prepares them
 * for ingestion into the Skillsmith database with quarantine status.
 *
 * Usage:
 *   npx tsx packages/core/src/scripts/ingest-lenny-skills.ts [input-dir] [--output path]
 *
 * Arguments:
 *   input-dir     Directory containing downloaded skills (default: ~/.claude/skills/dev-browser/tmp/lenny-skills)
 *   --output      Path to output JSON file (default: ./data/lenny-skills.json)
 */

import { existsSync, readdirSync, readFileSync, writeFileSync, mkdirSync } from 'fs'
import { dirname, join, resolve } from 'path'
import { homedir } from 'os'

/**
 * Skill metadata extracted from SKILL.md files
 */
interface LennySkillInput {
  id: string
  name: string
  description: string
  author: string
  repoUrl: string
  qualityScore: number
  trustTier: 'experimental'
  tags: string[]
  source: string
  category: string
  guestCount?: number
  insightCount?: number
}

/**
 * Category mapping from Lenny categories to Skillsmith categories
 */
const CATEGORY_MAP: Record<string, string[]> = {
  'Product Management': ['product-management', 'product', 'pm'],
  'Hiring & Teams': ['hiring', 'teams', 'management'],
  Leadership: ['leadership', 'management'],
  'AI & Technology': ['ai', 'technology', 'llm'],
  Communication: ['communication', 'collaboration'],
  Growth: ['growth', 'product-growth', 'metrics'],
  Marketing: ['marketing', 'gtm'],
  Career: ['career', 'professional-development'],
  'Sales & GTM': ['sales', 'gtm', 'business'],
  Engineering: ['engineering', 'development'],
  Design: ['design', 'ux'],
}

/**
 * Category assignments for each skill slug
 */
const SKILL_CATEGORIES: Record<string, string> = {
  // Product Management (22)
  'writing-north-star-metrics': 'Product Management',
  'defining-product-vision': 'Product Management',
  'prioritizing-roadmap': 'Product Management',
  'setting-okrs-goals': 'Product Management',
  'competitive-analysis': 'Product Management',
  'writing-prds': 'Product Management',
  'problem-definition': 'Product Management',
  'writing-specs-designs': 'Product Management',
  'scoping-cutting': 'Product Management',
  'working-backwards': 'Product Management',
  'conducting-user-interviews': 'Product Management',
  'designing-surveys': 'Product Management',
  'analyzing-user-feedback': 'Product Management',
  'usability-testing': 'Product Management',
  'shipping-products': 'Product Management',
  'managing-timelines': 'Product Management',
  'product-taste-intuition': 'Product Management',
  'product-operations': 'Product Management',
  'behavioral-product-design': 'Product Management',
  'startup-ideation': 'Product Management',
  dogfooding: 'Product Management',
  'startup-pivoting': 'Product Management',
  // Hiring & Teams (6)
  'writing-job-descriptions': 'Hiring & Teams',
  'conducting-interviews': 'Hiring & Teams',
  'evaluating-candidates': 'Hiring & Teams',
  'onboarding-new-hires': 'Hiring & Teams',
  'building-team-culture': 'Hiring & Teams',
  'team-rituals': 'Hiring & Teams',
  // Leadership (14)
  'running-effective-1-1s': 'Leadership',
  'having-difficult-conversations': 'Leadership',
  'delegating-work': 'Leadership',
  'managing-up': 'Leadership',
  'running-decision-processes': 'Leadership',
  'planning-under-uncertainty': 'Leadership',
  'evaluating-trade-offs': 'Leadership',
  'post-mortems-retrospectives': 'Leadership',
  'cross-functional-collaboration': 'Leadership',
  'systems-thinking': 'Leadership',
  'energy-management': 'Leadership',
  'coaching-pms': 'Leadership',
  'organizational-design': 'Leadership',
  'organizational-transformation': 'Leadership',
  // AI & Technology (6)
  'ai-product-strategy': 'AI & Technology',
  'building-with-llms': 'AI & Technology',
  'evaluating-new-technology': 'AI & Technology',
  'platform-strategy': 'AI & Technology',
  'vibe-coding': 'AI & Technology',
  'ai-evals': 'AI & Technology',
  // Communication (5)
  'giving-presentations': 'Communication',
  'written-communication': 'Communication',
  'stakeholder-alignment': 'Communication',
  'running-offsites': 'Communication',
  'running-effective-meetings': 'Communication',
  // Growth (6)
  'measuring-product-market-fit': 'Growth',
  'designing-growth-loops': 'Growth',
  'pricing-strategy': 'Growth',
  'retention-engagement': 'Growth',
  'marketplace-liquidity': 'Growth',
  'user-onboarding': 'Growth',
  // Marketing (6)
  'positioning-messaging': 'Marketing',
  'brand-storytelling': 'Marketing',
  'launch-marketing': 'Marketing',
  'content-marketing': 'Marketing',
  'community-building': 'Marketing',
  'media-relations': 'Marketing',
  // Career (7)
  'building-a-promotion-case': 'Career',
  'negotiating-offers': 'Career',
  'finding-mentors-sponsors': 'Career',
  'career-transitions': 'Career',
  'managing-imposter-syndrome': 'Career',
  'personal-productivity': 'Career',
  fundraising: 'Career',
  // Sales & GTM (7)
  'founder-sales': 'Sales & GTM',
  'building-sales-team': 'Sales & GTM',
  'enterprise-sales': 'Sales & GTM',
  'partnership-bd': 'Sales & GTM',
  'product-led-sales': 'Sales & GTM',
  'sales-compensation': 'Sales & GTM',
  'sales-qualification': 'Sales & GTM',
  // Engineering (5)
  'technical-roadmaps': 'Engineering',
  'managing-tech-debt': 'Engineering',
  'platform-infrastructure': 'Engineering',
  'engineering-culture': 'Engineering',
  'design-engineering': 'Engineering',
  // Design (2)
  'design-systems': 'Design',
  'running-design-reviews': 'Design',
}

/**
 * Parse YAML frontmatter from SKILL.md content
 */
function parseFrontmatter(content: string): { name: string; description: string } {
  const match = content.match(/^---\n([\s\S]*?)\n---/)
  if (!match) {
    return { name: '', description: '' }
  }

  const yaml = match[1]
  const nameMatch = yaml.match(/name:\s*(.+)/)
  const descMatch = yaml.match(/description:\s*(.+)/)

  return {
    name: nameMatch?.[1]?.trim() || '',
    description: descMatch?.[1]?.trim() || '',
  }
}

/**
 * Extract guest count and insight count from description
 */
function extractCounts(description: string): { guestCount: number; insightCount: number } {
  const guestMatch = description.match(/(\d+)\s*product leaders/i)
  const insightMatch = description.match(/\((\d+)\s*insights?\)/i)

  return {
    guestCount: guestMatch ? parseInt(guestMatch[1], 10) : 0,
    insightCount: insightMatch ? parseInt(insightMatch[1], 10) : 0,
  }
}

/**
 * Calculate quality score based on skill content
 */
function calculateQualityScore(content: string, guestCount: number, insightCount: number): number {
  let score = 0.5 // Base score for external content

  // Has multiple guests (+0.15)
  if (guestCount >= 10) {
    score += 0.15
  } else if (guestCount >= 5) {
    score += 0.1
  } else if (guestCount >= 2) {
    score += 0.05
  }

  // Has many insights (+0.1)
  if (insightCount >= 20) {
    score += 0.1
  } else if (insightCount >= 10) {
    score += 0.05
  }

  // Has structured content (+0.1)
  if (content.includes('## Top Insights') || content.includes('## What This Covers')) {
    score += 0.1
  }

  // Has apply this by sections (+0.05)
  if (content.includes('**Apply this by:**')) {
    score += 0.05
  }

  // From reputable source (+0.1)
  score += 0.1 // Lenny's Podcast is a high-quality source

  return Math.min(score, 1.0)
}

/**
 * Convert slug to title case name
 */
function slugToTitle(slug: string): string {
  return slug
    .split('-')
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ')
}

/**
 * Process a single SKILL.md file
 */
function processSkillFile(skillDir: string, slug: string): LennySkillInput | null {
  const skillPath = join(skillDir, slug, 'SKILL.md')

  if (!existsSync(skillPath)) {
    console.warn(`[WARN] Missing SKILL.md: ${slug}`)
    return null
  }

  const content = readFileSync(skillPath, 'utf-8')
  const frontmatter = parseFrontmatter(content)
  const counts = extractCounts(frontmatter.description)
  const category = SKILL_CATEGORIES[slug] || 'Product Management'
  const categoryTags = CATEGORY_MAP[category] || []

  const qualityScore = calculateQualityScore(content, counts.guestCount, counts.insightCount)

  return {
    id: `refoundai/lenny-skills/${slug}`,
    name: frontmatter.name || slugToTitle(slug),
    description: frontmatter.description || `Insights on ${slugToTitle(slug)} from Lenny's Podcast`,
    author: 'refoundai',
    repoUrl: `https://refoundai.com/lenny-skills/s/${slug}/`,
    qualityScore,
    trustTier: 'experimental', // Quarantine status
    tags: ['lenny-podcast', 'product-management', ...categoryTags],
    source: 'refoundai',
    category,
    guestCount: counts.guestCount,
    insightCount: counts.insightCount,
  }
}

/**
 * Main ingestion function
 */
export async function ingestLennySkills(
  inputDir: string,
  outputPath: string
): Promise<{ success: boolean; count: number; skills: LennySkillInput[] }> {
  console.log('[SMI-1757] Starting Lenny Skills ingestion')
  console.log(`[SMI-1757] Input directory: ${inputDir}`)
  console.log(`[SMI-1757] Output file: ${outputPath}`)

  if (!existsSync(inputDir)) {
    throw new Error(`Input directory not found: ${inputDir}`)
  }

  // Read all skill directories
  const skillDirs = readdirSync(inputDir, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)

  console.log(`[SMI-1757] Found ${skillDirs.length} skill directories`)

  const skills: LennySkillInput[] = []
  const errors: string[] = []

  for (const slug of skillDirs) {
    try {
      const skill = processSkillFile(inputDir, slug)
      if (skill) {
        skills.push(skill)
      }
    } catch (error) {
      errors.push(`${slug}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  console.log(`[SMI-1757] Processed ${skills.length} skills, ${errors.length} errors`)

  // Ensure output directory exists
  const outputDir = dirname(outputPath)
  if (!existsSync(outputDir)) {
    mkdirSync(outputDir, { recursive: true })
  }

  // Write output file
  const output = {
    description: "Lenny Skills from Refound AI - Extracted from Lenny's Podcast",
    version: '1.0.0',
    source: 'https://refoundai.com/lenny-skills/',
    extractedAt: new Date().toISOString(),
    metadata: {
      totalCount: skills.length,
      byCategory: skills.reduce(
        (acc, s) => {
          acc[s.category] = (acc[s.category] || 0) + 1
          return acc
        },
        {} as Record<string, number>
      ),
      averageQualityScore: skills.reduce((sum, s) => sum + s.qualityScore, 0) / skills.length,
    },
    skills,
  }

  writeFileSync(outputPath, JSON.stringify(output, null, 2))
  console.log(`[SMI-1757] Output written to: ${outputPath}`)

  if (errors.length > 0) {
    console.log('\n[SMI-1757] Errors:')
    errors.forEach((e) => console.log(`  - ${e}`))
  }

  // Print summary by category
  console.log('\n=== Summary by Category ===')
  Object.entries(output.metadata.byCategory)
    .sort((a, b) => b[1] - a[1])
    .forEach(([cat, count]) => {
      console.log(`  ${cat}: ${count}`)
    })

  console.log(
    `\n[SMI-1757] Average quality score: ${output.metadata.averageQualityScore.toFixed(2)}`
  )

  return {
    success: errors.length === 0,
    count: skills.length,
    skills,
  }
}

/**
 * Parse command line arguments
 */
function parseArgs(args: string[]): { inputDir: string; outputPath: string } {
  let inputDir = join(homedir(), '.claude/skills/dev-browser/tmp/lenny-skills')
  let outputPath = './data/lenny-skills.json'

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--output' && args[i + 1]) {
      outputPath = args[i + 1]
      i++
    } else if (!args[i].startsWith('--')) {
      inputDir = args[i]
    }
  }

  return { inputDir, outputPath }
}

/**
 * Main entry point
 */
async function main(): Promise<void> {
  const args = process.argv.slice(2)
  const { inputDir, outputPath } = parseArgs(args)

  try {
    const result = await ingestLennySkills(resolve(inputDir), resolve(outputPath))

    console.log(
      `\n[SMI-1757] Ingestion ${result.success ? 'completed successfully' : 'completed with errors'}`
    )
    console.log(`[SMI-1757] Total skills: ${result.count}`)

    process.exit(result.success ? 0 : 1)
  } catch (error) {
    console.error('[SMI-1757] Fatal error:', error)
    process.exit(1)
  }
}

// Run if executed directly
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error('Fatal error:', error)
    process.exit(1)
  })
}
