/**
 * SMI-6531 (A1 step 6c-ii-a): fixtures for the read-only listing and
 * classification tests: backup-area trees with sidecars that pass the strict
 * schema, and a way to inject `/proc/self/mountinfo`.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { vi } from 'vitest'
import { computePathTreeHash } from '../../../src/install/park-tree.js'
import { rootKeyFor } from '../../../src/install/prune.classify.js'

/** A throwaway real-path root. */
export function tmpRoot(prefix = 'prune-list-'): string {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)))
}

export interface MadeBackup {
  /** `<state>/backups/update`. */
  updateDir: string
  areaPath: string
  copyPath: string
  sidecarPath: string
  sidecar: Record<string, unknown> | null
}

export interface BackupSpec {
  state: string
  skillsDir: string
  /** The sidecar's `client`. */
  client?: string
  /** The `<client>` path segment, when it is not the sidecar's (a copied sidecar). */
  areaClient?: string
  /** The `<rootKey>` path segment, when it is not the key of `skillsDir`. */
  areaRootKey?: string
  dirName?: string
  opId?: string
  kind?: string
  files?: Record<string, string>
  /** Keys merged over the sidecar. */
  sidecar?: Record<string, unknown>
  /** No sidecar at all. */
  noSidecar?: boolean
}

/** A kept tree in the update backup area, with a sidecar that passes the strict schema. */
export function makeBackup(s: BackupSpec): MadeBackup {
  const client = s.client ?? 'claude-code'
  const dirName = s.dirName ?? 'foo'
  const opId = s.opId ?? 'op-1'
  const kind = s.kind ?? 'backup'
  const updateDir = path.join(s.state, 'backups', 'update')
  const areaPath = path.join(
    updateDir,
    s.areaClient ?? client,
    s.areaRootKey ?? rootKeyFor(s.skillsDir),
    dirName
  )
  const name = kind === 'backup' ? opId : `${opId}.${kind}`
  const copyPath = path.join(areaPath, name)
  fs.mkdirSync(copyPath, { recursive: true })
  for (const [rel, body] of Object.entries(s.files ?? { 'SKILL.md': `skill ${dirName}\n` })) {
    fs.mkdirSync(path.dirname(path.join(copyPath, rel)), { recursive: true })
    fs.writeFileSync(path.join(copyPath, rel), body)
  }
  const st = fs.lstatSync(copyPath, { bigint: true })
  const h = computePathTreeHash(copyPath)
  if (!h.ok) throw new Error(`makeBackup: hash failed (${h.reason})`)
  const sidecarPath = `${copyPath}.json`
  const sidecar: Record<string, unknown> = {
    opId,
    kind,
    dirName,
    createdAt: new Date().toISOString(),
    treeHash: h.treeHash,
    identity: {
      dev: String(st.dev),
      ino: String(st.ino),
      birthtimeNs: String(st.birthtimeNs),
      fmt: String(st.mode & 0o170000n),
    },
    client,
    skillsDir: s.skillsDir,
    scope: 'user',
    manifestKey: `${client}:${dirName}`,
    ...s.sidecar,
  }
  if (s.noSidecar !== true) fs.writeFileSync(sidecarPath, JSON.stringify(sidecar, null, 2) + '\n')
  return {
    updateDir,
    areaPath,
    copyPath,
    sidecarPath,
    sidecar: s.noSidecar === true ? null : sidecar,
  }
}

/** One mountinfo line whose mount point (field 5) is `mountPoint`. */
export const mountinfoLine = (mountPoint: string): string =>
  `99 1 0:99 / ${mountPoint} rw,relatime - tmpfs tmpfs rw\n`

/**
 * Makes `/proc/self/mountinfo` read as `text`, or throw `code` when `text` is
 * an errno name. Every other read passes through. Restore with `vi.restoreAllMocks()`.
 */
export function injectMountinfo(text: string | { throws: string }): void {
  const real = fs.readFileSync.bind(fs) as (...a: unknown[]) => unknown
  vi.spyOn(fs, 'readFileSync').mockImplementation(((p: unknown, ...rest: unknown[]) => {
    if (p === '/proc/self/mountinfo') {
      if (typeof text === 'string') return text
      throw Object.assign(new Error(text.throws), { code: text.throws })
    }
    return real(p, ...rest)
  }) as typeof fs.readFileSync)
}
