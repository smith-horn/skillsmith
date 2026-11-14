/**
 * SMI-6531 (A1 step 6c-ii-a): fixtures for the `listBackups` suites: discovery
 * pointed at a temporary base, copies parked by the REAL `parkTree`, and
 * parked-index lines written with the real appender.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { CLIENT_NATIVE_PATHS } from '../../../src/install/paths.js'
import { parkTree, computePathTreeHash } from '../../../src/install/park-tree.js'
import { appendParkedIndex } from '../../../src/install/parked-index.js'
import type { DiscoverOptions } from '../../../src/services/skill-recovery.discover.js'
import type { ClientId } from '../../../src/install/paths.js'

/** A throwaway real-path base, removed by the caller. */
export function mkBase(prefix = 'sbk-'): string {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)))
}

/** The nine client roots under `base/clients/<id>` (created), `base` as home and cwd. */
export function hermetic(base: string): Partial<DiscoverOptions> {
  const nativePaths = Object.fromEntries(
    (Object.keys(CLIENT_NATIVE_PATHS) as ClientId[]).map((id) => {
      const dir = path.join(base, 'clients', id)
      fs.mkdirSync(dir, { recursive: true })
      return [id, dir]
    })
  ) as Record<ClientId, string>
  return { homeDir: base, cwd: base, nativePaths }
}

export interface Parked {
  copyPath: string
  sidecarPath: string
  opDir: string
}

/** Builds `parent/name` (two files) and parks it guarded, as `uninstall`. */
export function parkAt(
  parent: string,
  name: string,
  o: { opId?: string; caller?: 'uninstall' | 'doctor-park'; kind?: string } = {}
): Parked {
  const origin = path.join(parent, name)
  fs.mkdirSync(origin, { recursive: true })
  fs.writeFileSync(path.join(origin, 'SKILL.md'), `skill ${name}\n`)
  fs.writeFileSync(path.join(origin, 'notes.txt'), 'x'.repeat(5000))
  const h = computePathTreeHash(origin)
  if (!h.ok) throw new Error(`parkAt: hash failed (${h.reason})`)
  const caller = o.caller ?? 'uninstall'
  const r = parkTree(parent, name, {
    client: 'claude-code',
    caller,
    kind: o.kind ?? (caller === 'doctor-park' ? 'unreadable-record' : 'uninstall'),
    guardHash: h.treeHash,
    opId: o.opId ?? `op-${name}`,
  })
  if (r.status !== 'parked' || r.path === null || r.sidecarPath === null) {
    throw new Error(`parkAt: park returned ${r.status}/${r.reason}`)
  }
  return { copyPath: r.path, sidecarPath: r.sidecarPath, opDir: path.dirname(r.path) }
}

/** Appends one parked-index line for `copyPath` (the path as the caller spells it). */
export function indexLine(stateRoot: string, copyPath: string, opId: string): string {
  fs.mkdirSync(stateRoot, { recursive: true })
  const indexPath = path.join(stateRoot, 'parked-index.jsonl')
  appendParkedIndex(indexPath, {
    path: copyPath,
    opId,
    client: 'claude-code',
    kind: 'uninstall',
    createdAt: new Date().toISOString(),
  })
  return indexPath
}
