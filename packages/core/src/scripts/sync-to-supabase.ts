/**
 * SMI-1757: Sync Lenny Skills to Supabase
 *
 * Uploads reviewed skills from local JSON to production Supabase.
 *
 * Usage:
 *   varlock run -- npx tsx packages/core/src/scripts/sync-to-supabase.ts [--dry-run]
 */

import { createClient } from '@supabase/supabase-js'
import { readFileSync, existsSync } from 'fs'

const INPUT_PATH = './data/lenny-skills-reviewed.json'

interface SkillInput {
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
  metadata?: Record<string, unknown>
}

async function syncToSupabase(dryRun = false): Promise<void> {
  const supabaseUrl = process.env.SUPABASE_URL
  const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY

  if (!supabaseUrl || !supabaseKey) {
    console.error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY')
    console.error('Run with: varlock run -- npx tsx <script>')
    process.exit(1)
  }

  console.log('[SMI-1757] Syncing Lenny Skills to Supabase')
  console.log(`[SMI-1757] Mode: ${dryRun ? 'DRY RUN' : 'LIVE'}`)
  console.log(`[SMI-1757] Supabase URL: ${supabaseUrl.substring(0, 30)}...`)
  console.log('')

  // Read skills
  if (!existsSync(INPUT_PATH)) {
    console.error(`Input file not found: ${INPUT_PATH}`)
    process.exit(1)
  }

  const data = JSON.parse(readFileSync(INPUT_PATH, 'utf-8'))
  const skills: SkillInput[] = data.skills

  console.log(`[SMI-1757] Found ${skills.length} skills to sync`)

  if (dryRun) {
    console.log('\n[DRY RUN] Would insert:')
    skills.slice(0, 5).forEach((s) => {
      console.log(`  - ${s.id} (${s.category})`)
    })
    console.log(`  ... and ${skills.length - 5} more`)
    return
  }

  // Connect to Supabase
  const supabase = createClient(supabaseUrl, supabaseKey)

  // Transform skills to database format (matching Supabase schema)
  // Schema: id, name, description, author, repo_url, quality_score, trust_tier, tags, source, stars, installable
  const records = skills.map((skill) => ({
    id: skill.id,
    name: skill.name,
    description: skill.description,
    author: skill.author,
    repo_url: skill.repoUrl,
    quality_score: skill.qualityScore,
    trust_tier: skill.trustTier === 'community' ? 'community' : 'experimental',
    // Include category in tags for searchability
    tags: [...new Set([...skill.tags, skill.category])],
    source: skill.source,
    stars: null, // No stars for non-GitHub skills
    installable: true, // These are installable skills
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  }))

  // Upsert in batches
  const batchSize = 50
  let inserted = 0
  let errors = 0

  for (let i = 0; i < records.length; i += batchSize) {
    const batch = records.slice(i, i + batchSize)

    const { data: result, error } = await supabase
      .from('skills')
      .upsert(batch, { onConflict: 'id' })
      .select('id')

    if (error) {
      console.error(`[ERROR] Batch ${Math.floor(i / batchSize) + 1}:`, error.message)
      errors += batch.length
    } else {
      inserted += result?.length || batch.length
      console.log(
        `[SMI-1757] Batch ${Math.floor(i / batchSize) + 1}: ${result?.length || batch.length} skills`
      )
    }
  }

  console.log('')
  console.log('=== Sync Complete ===')
  console.log(`Inserted/Updated: ${inserted}`)
  console.log(`Errors: ${errors}`)

  // Verify
  const { count } = await supabase.from('skills').select('*', { count: 'exact', head: true })

  console.log(`Total skills in database: ${count}`)
}

// CLI
const dryRun = process.argv.includes('--dry-run')
syncToSupabase(dryRun).catch((err) => {
  console.error('Fatal error:', err)
  process.exit(1)
})
