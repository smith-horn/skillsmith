/**
 * Shared quarantine helpers (Node port)
 * @module scripts/indexer/_shared/quarantine
 *
 * SMI-4852: Node-flavored sibling of `supabase/functions/_shared/quarantine.ts`.
 * Pure Supabase client usage — no fetches, no env reads. Byte-identical to the
 * Deno parent apart from the npm import for `@supabase/supabase-js`.
 *
 * SMI-2560: Provides both single-skill and batch quarantine with RPC + fallback
 * pattern (used by indexer stale reconciliation + skills-refresh-metadata).
 */

import type { SupabaseClient } from '@supabase/supabase-js'

/**
 * A security finding to append to the skill's security_findings JSONB array
 */
export interface QuarantineFinding {
  type: string
  severity: string
  description: string
  lineNumber: number
}

/**
 * Quarantine a single skill by setting quarantined=true and appending a finding.
 * Used by skills-refresh-metadata for immediate quarantine on 404/archived repos.
 *
 * @param supabase - Admin Supabase client
 * @param skillId - Skill ID to quarantine
 * @param finding - Finding to append to security_findings
 * @param reason - Human-readable quarantine reason (optional)
 * @returns Empty object on success, or `{ error: string }` on failure
 */
export async function quarantineSkill(
  supabase: SupabaseClient,
  skillId: string,
  finding: QuarantineFinding,
  reason?: string
): Promise<{ error?: string }> {
  // Read existing findings first to avoid clobbering
  const { data: existing, error: readError } = await supabase
    .from('skills')
    .select('security_findings, quarantined')
    .eq('id', skillId)
    .single()

  if (readError) {
    return { error: readError.message }
  }

  // Skip if already quarantined
  if (existing?.quarantined) {
    return {}
  }

  const existingFindings = Array.isArray(existing?.security_findings)
    ? existing.security_findings
    : []

  const updateData: Record<string, unknown> = {
    quarantined: true,
    security_findings: [...existingFindings, finding],
    indexed_at: new Date().toISOString(),
  }

  if (reason) {
    updateData.quarantine_reason = reason
  }

  const { error: updateError } = await supabase.from('skills').update(updateData).eq('id', skillId)

  if (updateError) {
    return { error: updateError.message }
  }

  return {}
}

/**
 * Quarantine multiple skills in batches using RPC with fallback.
 * Used by the indexer for stale skill reconciliation.
 *
 * @param supabase - Admin Supabase client
 * @param skillIds - Array of skill IDs to quarantine
 * @param finding - Finding to append to each skill's security_findings
 * @param batchSize - Batch size for PostgREST URL limits (default: 100)
 * @returns Count of quarantined and errors
 */
export async function quarantineSkillsBatch(
  supabase: SupabaseClient,
  skillIds: string[],
  finding: QuarantineFinding,
  batchSize = 100
): Promise<{ quarantined: number; errors: number }> {
  let quarantined = 0
  let errors = 0

  for (let i = 0; i < skillIds.length; i += batchSize) {
    const batch = skillIds.slice(i, i + batchSize)
    const { data: rpcResult, error: updateError } = await supabase.rpc('quarantine_stale_skills', {
      skill_ids: batch,
      stale_finding: finding,
    })

    if (updateError) {
      // Fallback: direct update if RPC doesn't exist yet
      if (
        updateError.code === '42883' || // undefined_function
        updateError.code === 'PGRST202' // function not found
      ) {
        // Read existing findings for this batch before updating
        // Filter out already-quarantined to match RPC behavior (WHERE quarantined = FALSE)
        const { data: existingSkills } = await supabase
          .from('skills')
          .select('id, security_findings')
          .in('id', batch)
          .eq('quarantined', false)

        for (const skill of existingSkills || []) {
          const existingFindings = Array.isArray(skill.security_findings)
            ? skill.security_findings
            : []
          const { error: directError } = await supabase
            .from('skills')
            .update({
              quarantined: true,
              security_findings: [...existingFindings, finding],
            })
            .eq('id', skill.id)
          if (directError) {
            errors++
          } else {
            quarantined++
          }
        }
      } else {
        // Count all skills in the batch as failed, not just 1
        errors += batch.length
        console.error(
          `[Quarantine] Failed to quarantine batch of ${batch.length}: ${updateError.message}`
        )
      }
    } else {
      quarantined += typeof rpcResult === 'number' ? rpcResult : batch.length
    }
  }

  return { quarantined, errors }
}

// Pre-built finding objects for common quarantine reasons

/** Finding for skills whose GitHub repo returns 404 */
export const FINDING_REPO_DELETED: QuarantineFinding = {
  type: 'repo_deleted',
  severity: 'info',
  description: 'GitHub repository not found (404) during metadata refresh',
  lineNumber: 0,
}

/** Finding for skills whose GitHub repo is archived or disabled */
export const FINDING_REPO_ARCHIVED: QuarantineFinding = {
  type: 'repo_archived',
  severity: 'info',
  description: 'GitHub repository archived or disabled during metadata refresh',
  lineNumber: 0,
}

/** Finding for skills not seen by the indexer for N+ consecutive days */
export const FINDING_STALE: QuarantineFinding = {
  type: 'stale',
  severity: 'info',
  description: 'Skill repository not found during recent indexer runs',
  lineNumber: 0,
}
