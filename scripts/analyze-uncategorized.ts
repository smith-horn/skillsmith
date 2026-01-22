/**
 * Analyze uncategorized skills to determine if new categories are needed
 */

import { createClient } from '@supabase/supabase-js'

const supabaseUrl = process.env.SUPABASE_URL || 'https://vrcnzpmndtroqxxoqkzy.supabase.co'
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY

if (!supabaseKey) {
  console.error('SUPABASE_SERVICE_ROLE_KEY or SUPABASE_ANON_KEY required')
  process.exit(1)
}

const supabase = createClient(supabaseUrl, supabaseKey)

async function analyzeUncategorized() {
  // Get total skill count
  const { count: totalSkills } = await supabase
    .from('skills')
    .select('*', { count: 'exact', head: true })

  console.log(`\n=== Skill Categorization Analysis ===\n`)
  console.log(`Total skills in database: ${totalSkills}`)

  // Get categorized skill IDs
  const { data: categorizedIds } = await supabase.from('skill_categories').select('skill_id')

  const categorizedSet = new Set(categorizedIds?.map((r) => r.skill_id) || [])
  console.log(`Skills with categories: ${categorizedSet.size}`)
  console.log(`Skills without categories: ${(totalSkills || 0) - categorizedSet.size}`)

  // Get uncategorized skills
  const { data: allSkills } = await supabase
    .from('skills')
    .select('id, name, description, tags, stars')
    .order('stars', { ascending: false, nullsFirst: false })

  const uncategorized = allSkills?.filter((s) => !categorizedSet.has(s.id)) || []

  console.log(`\n=== Top 50 Uncategorized Skills (by stars) ===\n`)

  // Analyze tags from uncategorized skills
  const tagCounts: Record<string, number> = {}

  for (const skill of uncategorized.slice(0, 50)) {
    const tags = (skill.tags as string[]) || []
    console.log(`- ${skill.name} (${skill.stars || 0}★)`)
    console.log(`  Tags: ${tags.slice(0, 10).join(', ') || 'none'}`)
    console.log(`  Desc: ${(skill.description || '').slice(0, 100)}...`)
    console.log('')

    for (const tag of tags) {
      tagCounts[tag] = (tagCounts[tag] || 0) + 1
    }
  }

  // Sort tags by frequency
  const sortedTags = Object.entries(tagCounts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 30)

  console.log(`\n=== Most Common Tags in Uncategorized Skills ===\n`)
  for (const [tag, count] of sortedTags) {
    console.log(`  ${tag}: ${count}`)
  }

  // Analyze ALL uncategorized skills for tag patterns
  const allTagCounts: Record<string, number> = {}
  for (const skill of uncategorized) {
    const tags = (skill.tags as string[]) || []
    for (const tag of tags) {
      allTagCounts[tag] = (allTagCounts[tag] || 0) + 1
    }
  }

  const allSortedTags = Object.entries(allTagCounts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 50)

  console.log(`\n=== Top 50 Tags Across ALL Uncategorized Skills ===\n`)
  for (const [tag, count] of allSortedTags) {
    console.log(`  ${tag}: ${count}`)
  }
}

analyzeUncategorized().catch(console.error)
