#!/usr/bin/env npx tsx
/**
 * Verify skill registry quality after indexing
 */

import { createClient } from '@supabase/supabase-js'

async function verify() {
  const projectRef = process.env.SUPABASE_PROJECT_REF
  const anonKey = process.env.SUPABASE_ANON_KEY

  if (!projectRef || !anonKey) {
    console.error('Missing SUPABASE_PROJECT_REF or SUPABASE_ANON_KEY')
    process.exit(1)
  }

  const supabase = createClient(`https://${projectRef}.supabase.co`, anonKey)

  // Get total count
  const { count: totalCount } = await supabase
    .from('skills')
    .select('*', { count: 'exact', head: true })

  // Get installable count
  const { count: installableCount } = await supabase
    .from('skills')
    .select('*', { count: 'exact', head: true })
    .eq('installable', true)

  // Get counts by trust tier
  const tierCounts: Record<string, number> = {}
  for (const tier of ['verified', 'community', 'experimental', 'unknown']) {
    const { count } = await supabase
      .from('skills')
      .select('*', { count: 'exact', head: true })
      .eq('trust_tier', tier)
    tierCounts[tier] = count || 0
  }

  console.log('='.repeat(50))
  console.log('Skill Registry Quality Report')
  console.log('='.repeat(50))
  console.log('Total skills:', totalCount)
  console.log('Installable:', installableCount)
  console.log('')
  console.log('By Trust Tier:')
  for (const [tier, count] of Object.entries(tierCounts)) {
    console.log(`  ${tier}: ${count}`)
  }

  // Get verified skills from high-trust authors
  const { data: verified } = await supabase
    .from('skills')
    .select('name, author, quality_score, repo_url, installable')
    .eq('trust_tier', 'verified')
    .order('author')
    .order('name')
    .limit(50)

  if (verified && verified.length > 0) {
    console.log('')
    console.log(`Verified Skills (${verified.length}):`)
    let currentAuthor = ''
    for (const s of verified) {
      if (s.author !== currentAuthor) {
        console.log('')
        console.log(`  ${s.author}:`)
        currentAuthor = s.author
      }
      const status = s.installable ? '✓' : '○'
      const score = ((s.quality_score || 0) * 100).toFixed(0)
      console.log(`    ${status} ${s.name} (score: ${score}%)`)
    }
  }
}

verify().catch((err) => {
  console.error('Error:', err)
  process.exit(1)
})
