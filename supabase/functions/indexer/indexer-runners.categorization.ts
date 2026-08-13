/**
 * Phase 5 categorization — extracted to keep `indexer-runners.ts` ≤ 500 lines.
 * @module indexer/indexer-runners.categorization
 *
 * SMI-6020's write-path truncation-ratchet addition pushed indexer-runners.ts
 * past the audit:standards line cap; broken out here (mirrors the existing
 * indexer-runners.codesearch.ts extraction pattern, SMI-4854). Re-exported by
 * indexer-runners.ts for existing import sites.
 */

import type { SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2.47.0'
import { batchedIn } from './batch-utils.ts'
import { CATEGORY_IDS, categorizeSkill } from './categorization.ts'

/**
 * Phase 5: Run categorization for all indexed skills.
 * Clears stale category assignments, re-categorizes, and updates counts.
 *
 * @param supabase - Supabase admin client
 * @param repoUrls - URLs of repositories that were indexed this run
 * @returns categorizedCount, categoryAssignments, and any non-fatal errors
 */
export async function runCategorization(
  supabase: SupabaseClient,
  repoUrls: string[]
): Promise<{ categorizedCount: number; categoryAssignments: number; errors: string[] }> {
  console.log(`[Categorization] Starting categorization for indexed skills...`)
  let categorizedCount = 0
  let categoryAssignments = 0
  const errors: string[] = []

  const skillsToCheck = await batchedIn<{ id: string; tags: string[]; description: string }>(
    () => supabase.from('skills').select('id, tags, description'),
    'repo_url',
    repoUrls
  )

  if (skillsToCheck.length > 0) {
    const skillIds = skillsToCheck.map((s) => s.id)
    const { error: deleteError } = await supabase
      .from('skill_categories')
      .delete()
      .in('skill_id', skillIds)
    if (deleteError) {
      console.log(
        `[Categorization] Warning: failed to clear stale categories: ${deleteError.message}`
      )
    }

    // SMI-5209 Wave 2: collect all category rows across every skill, then issue
    // ONE upsert instead of N per-skill inserts. ignoreDuplicates gives
    // ON CONFLICT DO NOTHING semantics so concurrent runs don't error.
    const allCategoryRows: Array<{ skill_id: string; category_id: string }> = []
    for (const skill of skillsToCheck) {
      const tags = Array.isArray(skill.tags) ? skill.tags : []
      const categories = categorizeSkill(tags as string[], skill.description)
      if (categories.length > 0) {
        for (const categoryId of categories) {
          allCategoryRows.push({ skill_id: skill.id, category_id: categoryId })
        }
        categorizedCount++
        categoryAssignments += categories.length
      }
    }

    if (allCategoryRows.length > 0) {
      const { error: catError } = await supabase
        .from('skill_categories')
        .upsert(allCategoryRows, { ignoreDuplicates: true })
      if (catError) {
        const failedSkillIds = [...new Set(allCategoryRows.map((r) => r.skill_id))]
        console.log(`[Categorization] Batch insert error: ${catError.message}`)
        errors.push(
          `Category batch insert failed for ${failedSkillIds.length} skills: ${catError.message}`
        )
        categorizedCount = 0
        categoryAssignments = 0
      }
    }

    const { error: updateError } = await supabase.rpc('update_category_counts')
    if (updateError) {
      const isRpcNotFound =
        updateError.message?.includes('not found') ||
        updateError.code === '42883' ||
        updateError.code === 'PGRST202'
      if (isRpcNotFound) {
        console.log(`[Categorization] RPC not found, updating manually...`)
        for (const categoryId of Object.values(CATEGORY_IDS)) {
          const { count } = await supabase
            .from('skill_categories')
            .select('*', { count: 'exact', head: true })
            .eq('category_id', categoryId)
          await supabase
            .from('categories')
            .update({ skill_count: count || 0 })
            .eq('id', categoryId)
            .neq('id', '') // pg_safeupdate: WHERE clause required
        }
      } else {
        console.error(
          `[Categorization] RPC failed: ${updateError.message} (${updateError.code})`
        )
        errors.push(`Category count update failed: ${updateError.message}`)
      }
    }
    console.log(`[Categorization] ${categorizedCount} skills, ${categoryAssignments} assignments`)
  }

  return { categorizedCount, categoryAssignments, errors }
}
