/**
 * SMI-6531 (A1 step 6c-ii-a): the text of one `.prune-*` leftover in the
 * `doctor backups` listing (UD70, UD71). It lives beside the listing so a test
 * can render a leftover it listed from a real fixture. Pure: no fs.
 *
 * An interrupted prune says what it left, whether a resume is offered, and
 * every empty directory a resume left behind, which only the user may remove.
 *
 * @module @skillsmith/core/services/skill-backups.render
 */
import type { LeftoverView } from './skill-backups.listing.types.js'

const plural = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`

/** The lines for one leftover, each indented two spaces. */
export function leftoverLines(v: LeftoverView): string[] {
  const l = v.leftover
  const lines = [
    `  unfinished prune (${l.state}): ${l.S}${l.detail === undefined ? '' : ` - ${l.detail}`}`,
  ]
  if (l.unapproved.length > 0) {
    lines.push(
      `    ${plural(l.unapproved.length, 'entry', 'entries')} not approved for deletion, kept`
    )
  }
  const remaining = l.remaining?.length ?? 0
  if (remaining > 0) {
    lines.push(`    ${plural(remaining, 'approved entry', 'approved entries')} remaining`)
  }
  lines.push(`    resume: ${v.resumeOffered ? 'offered' : 'not offered'}`)
  for (const s of l.skeletons ?? []) {
    lines.push(`    empty folder a resume left, remove by hand: ${s}`)
  }
  return lines
}
