/**
 * Notification helpers (Node port)
 * @module scripts/indexer/_shared/notification
 *
 * SMI-4852: Node-flavored sibling of `supabase/functions/_shared/notification.ts`.
 * The only fetch in this file targets the Supabase `alert-notify` edge function
 * (NOT api.github.com) so it is intentionally NOT wrapped in
 * `withRateLimitTracking` — that helper is GitHub-API-specific.
 *
 * SMI-3347: Bulk-quarantine author notification — fires alert-notify when
 * any single author has >= BULK_QUARANTINE_THRESHOLD skills quarantined in
 * one indexer run.
 */

import type { SupabaseClient } from '@supabase/supabase-js'

// Threshold: minimum quarantined skills per author to trigger notification
const BULK_QUARANTINE_THRESHOLD = 3

interface QuarantinedSkillInfo {
  id: string
  author: string | null
}

// Check for bulk quarantine by author and send notification if threshold met.
// Queries recently quarantined skills (from this run), groups by author,
// and fires alert-notify for any author with >= BULK_QUARANTINE_THRESHOLD.
//
// Non-fatal: all errors are caught and logged. Never throws.
export async function notifyBulkQuarantine(
  supabase: SupabaseClient,
  quarantinedIds: string[]
): Promise<void> {
  if (quarantinedIds.length < BULK_QUARANTINE_THRESHOLD) {
    return
  }

  try {
    // Fetch author info for quarantined skills
    const { data: skills } = await supabase
      .from('skills')
      .select('id, author')
      .in('id', quarantinedIds)

    if (!skills || skills.length === 0) {
      return
    }

    // Group by author
    const authorGroups = new Map<string, string[]>()
    for (const skill of skills as QuarantinedSkillInfo[]) {
      const author = skill.author || 'unknown'
      const group = authorGroups.get(author) || []
      group.push(skill.id)
      authorGroups.set(author, group)
    }

    // Check each author against threshold
    for (const [author, skillIds] of authorGroups) {
      if (skillIds.length < BULK_QUARANTINE_THRESHOLD) {
        continue
      }

      console.log(
        `[BulkQuarantine] Author "${author}" has ${skillIds.length} skills quarantined — sending notification`
      )

      // Fire alert via alert-notify edge function.
      // Targets the Supabase project URL — not api.github.com — so no
      // withRateLimitTracking wrapping (GitHub-specific).
      const supabaseUrl = process.env.SUPABASE_URL
      const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY
      if (!supabaseUrl || !serviceKey) {
        console.warn('[BulkQuarantine] Missing SUPABASE_URL or SERVICE_ROLE_KEY — skipping alert')
        return
      }

      const resp = await fetch(`${supabaseUrl}/functions/v1/alert-notify`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${serviceKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          type: 'bulk_quarantine',
          message:
            `Author "${author}" had ${skillIds.length} skills quarantined in a single indexer run. ` +
            `Skill IDs: ${skillIds.slice(0, 10).join(', ')}` +
            (skillIds.length > 10 ? ` (+${skillIds.length - 10} more)` : '') +
            `. Review for potential author-wide issues.`,
        }),
      })

      console.log(`[BulkQuarantine] Alert sent for author "${author}"`, {
        status: resp.status,
        skillCount: skillIds.length,
      })
    }
  } catch (err) {
    // Non-fatal: don't fail the indexer if notification fails
    console.warn('[BulkQuarantine] Notification failed (non-fatal):', err)
  }
}
