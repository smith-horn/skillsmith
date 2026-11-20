/**
 * SMI-6531 (A1 step 6d-ii): fixtures for the `skillsmith restore` suites.
 * Copies are made by the REAL `parkTree` (a held one by the production writer,
 * as `park-call.test.ts` does), never written by hand.
 */
import fs from 'node:fs'
import path from 'node:path'
import { CLIENT_NATIVE_PATHS } from '../../../src/install/paths.js'
import { callerKind, type ParkCaller } from '../../../src/install/park-callers.js'
import { appendParkedIndex } from '../../../src/install/parked-index.js'
import { parkTree } from '../../../src/install/park-tree.js'
import { guardOf, withFsStub, writeAfterRename } from '../install/park-tree.helpers.js'
import { hermetic, mkBase } from './skill-backups.helpers.js'
import type { RestorePlan, RestorePlanOptions } from '../../../src/services/skill-restore.types.js'
import { planRestore } from '../../../src/services/skill-restore.js'

export { mkBase }

export interface Env {
  base: string
  /** A discovered client skills root. */
  root: string
  /** A second discovered client skills root. */
  root2: string
  stateRoot: string
  opts: RestorePlanOptions
}

export function mkEnv(): Env {
  const base = mkBase('rst-')
  const discovery = hermetic(base)
  const ids = Object.keys(CLIENT_NATIVE_PATHS)
  const root = path.join(base, 'clients', 'claude-code')
  const second = ids.find((k) => k !== 'claude-code')!
  const root2 = path.join(base, 'clients', second)
  const stateRoot = path.join(base, 'state')
  fs.mkdirSync(stateRoot, { recursive: true })
  return { base, root, root2, stateRoot, opts: { stateRoot, discovery } }
}

export interface Made {
  copyPath: string
  sidecarPath: string
  origin: string
  opId: string
}

export interface MakeOpts {
  opId?: string
  caller?: ParkCaller
  type?: 'dir' | 'file' | 'symlink'
  held?: boolean
  /** symlink text (default dangling) */
  linkText?: string
}

/** Builds `parent/name` of the given type and parks it with the real park. */
export function parkEntry(parent: string, name: string, o: MakeOpts = {}): Made {
  const origin = path.join(parent, name)
  fs.mkdirSync(parent, { recursive: true })
  const type = o.type ?? 'dir'
  if (type === 'dir') {
    fs.mkdirSync(origin)
    fs.writeFileSync(path.join(origin, 'SKILL.md'), `skill ${name}\n`)
    fs.writeFileSync(path.join(origin, 'notes.txt'), 'x'.repeat(2000))
  } else if (type === 'file') {
    fs.writeFileSync(origin, `file ${name}\n`)
  } else {
    fs.symlinkSync(o.linkText ?? `missing-target-${name}`, origin)
  }
  const caller = o.caller ?? 'uninstall'
  const opId = o.opId ?? `op-${name}`
  const park = (): ReturnType<typeof parkTree> =>
    parkTree(parent, name, {
      client: 'claude-code',
      caller,
      kind: callerKind(caller),
      opId,
      ...(type === 'dir' ? { guardHash: guardOf(origin) } : {}),
    })
  const r = o.held === true ? withFsStub('renameSync', writeAfterRename(origin), park) : park()
  const copyPath = o.held === true ? r.heldPath : r.path
  if (copyPath == null || r.sidecarPath == null) {
    throw new Error(`parkEntry: ${r.status}/${r.reason}`)
  }
  return { copyPath, sidecarPath: r.sidecarPath, origin, opId }
}

/** A parked-index line with the given kind (the helper in skill-backups.helpers fixes it to `uninstall`). */
export function indexKind(stateRoot: string, copyPath: string, opId: string, kind: string): void {
  fs.mkdirSync(stateRoot, { recursive: true })
  appendParkedIndex(path.join(stateRoot, 'parked-index.jsonl'), {
    path: copyPath,
    opId,
    client: 'claude-code',
    kind,
    createdAt: new Date().toISOString(),
  })
}

export async function planOk(id: string, opts: RestorePlanOptions): Promise<RestorePlan> {
  const r = await planRestore(id, opts)
  if (r.status !== 'planned') throw new Error(`plan refused: ${r.reason}: ${r.message}`)
  return r.plan
}

/** Every path under `dir` (lstat-based), with its type and, for files, bytes: a mutation snapshot. */
export function snapshot(dir: string): string[] {
  const out: string[] = []
  const walk = (d: string): void => {
    for (const n of fs.readdirSync(d).sort()) {
      const p = path.join(d, n)
      const st = fs.lstatSync(p)
      if (st.isSymbolicLink()) out.push(`${p} -> ${fs.readlinkSync(p)}`)
      else if (st.isDirectory()) {
        out.push(`${p}/ ino=${st.ino}`)
        walk(p)
      } else out.push(`${p} ino=${st.ino} ${fs.readFileSync(p, 'utf8')}`)
    }
  }
  walk(dir)
  return out
}
