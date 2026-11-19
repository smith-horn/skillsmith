/**
 * SMI-6531 (A1 step 6d-ii, design note §4.2): which set-aside copy `<id>` names.
 *
 * @module @skillsmith/core/services/skill-restore.resolve
 */
import fs from 'node:fs'
import path from 'node:path'
import type { ParkedAreaView, ParkedRow } from './skill-backups.listing.js'

export interface Match {
  row: ParkedRow
  view: ParkedAreaView
}

export type IdForm =
  | { form: 'path'; value: string }
  | { form: 'opId'; opId: string }
  | { form: 'opId-name'; opId: string; name: string }
  | { form: 'bad' }

const SEGMENT = /^[^/\\]+$/

const okSegment = (s: string): boolean => SEGMENT.test(s) && s !== '.' && s !== '..'

export function parseId(id: string): IdForm {
  if (id === '' || id.includes('\0')) return { form: 'bad' }
  if (path.isAbsolute(id)) return { form: 'path', value: id }
  const parts = id.split('/')
  if (parts.length === 1) return okSegment(id) ? { form: 'opId', opId: id } : { form: 'bad' }
  if (parts.length === 2 && okSegment(parts[0]!) && okSegment(parts[1]!)) {
    return { form: 'opId-name', opId: parts[0]!, name: parts[1]! }
  }
  return { form: 'bad' }
}

/** Every parked row across the listing, de-duplicated by `copyPath`. */
export function allRows(parked: readonly ParkedAreaView[]): Match[] {
  const seen = new Set<string>()
  const out: Match[] = []
  for (const view of parked) {
    for (const row of view.rows) {
      if (seen.has(row.copy.copyPath)) continue
      seen.add(row.copy.copyPath)
      out.push({ row, view })
    }
  }
  return out
}

export function matchRows(form: IdForm, all: readonly Match[]): Match[] {
  switch (form.form) {
    case 'bad':
      return []
    case 'path': {
      let real = form.value
      try {
        // The parent is resolved, never the entry: a symlink copy must not resolve to its target.
        real = path.join(
          fs.realpathSync.native(path.dirname(form.value)),
          path.basename(form.value)
        )
      } catch {
        // an unresolvable parent: its own spelling is compared
      }
      return all.filter((m) => m.row.copy.copyPath === real || m.row.copy.copyPath === form.value)
    }
    case 'opId':
      return all.filter((m) => m.row.copy.opId === form.opId)
    case 'opId-name':
      return all.filter((m) => m.row.copy.opId === form.opId && m.row.copy.name === form.name)
  }
}
