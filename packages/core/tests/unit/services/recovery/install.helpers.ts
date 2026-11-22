/**
 * SMI-6531 (A1 step 8-i-a-2): fixtures for a fresh install's recovery rows
 * (FI0-FI4). Nothing writes an install record in production yet (8-i-a-3), so
 * each state is built the way the staged install will leave it: the record's
 * bytes from `sealInstallRecord`, the claim and the publish from
 * `claimPublish`, the post-claim park from `parkTree` (caller
 * `install-rollback`), and every keep from `publishTree` under lock 1. No
 * record, sidecar or keep is written by hand. Two steps are modelled with a
 * plain rename: the staged folder written into `OP/new` (8-i-a-3's build), and
 * FI2u's set-aside of the published folder to `OP/undone` (the rename doctor's
 * undo makes with `undoAside`).
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { expect } from 'vitest'
import { parkTree } from '../../../../src/install/park-tree.js'
import type { InstallRecord } from '../../../../src/services/skill-install.record-schema.js'
import { sealInstallRecord } from '../../../../src/services/skill-install.record-seal.js'
import { recoveryState } from '../../../../src/services/skill-recovery.state.js'
import { publishTree } from '../../../../src/services/skill-swap.publish.js'
import type { PublishKind } from '../../../../src/services/skill-swap.sidecar.js'
import type { RecordIdentity } from '../../../../src/services/skill-swap.types.js'
import { claimPublish } from '../../../../src/services/skill-tree.js'
import {
  bindSkillsRootReadOnly,
  withSkillWriteLock,
} from '../../../../src/services/skill-write-lock.js'
import { hashOf, OP_ID, tmp } from '../skill-swap.helpers.js'
import type { Fixture } from '../skill-swap.helpers.js'
import { setEntry } from './recovery.helpers.js'

export const POST_ENTRY = { version: '1.0.0', source: 'github:o/r', installedAt: 'fixed' }
export const OTHER_ENTRY = { version: '9.9.9', source: 'someone-else' }

/** A fresh install's op dir: the fixture, its opId and op dir, N, and the record as sealed. */
export interface IState {
  fx: Fixture
  opId: string
  opDir: string
  newDir: string
  record: InstallRecord
}

/**
 * A skills root with no skill folder yet, and a state root whose manifest has
 * no entry for it: under the same temp, or `stateRoot` (an existing directory,
 * another device for the cross-device keeps).
 */
export function installFixture(at: { stateRoot?: string } = {}): Fixture {
  const base = tmp('install-rec-')
  const skillsDir = path.join(base, 'skills')
  const stateRoot = at.stateRoot ?? path.join(base, 'state')
  const outside = path.join(base, 'outside')
  fs.mkdirSync(skillsDir)
  if (at.stateRoot === undefined) fs.mkdirSync(stateRoot)
  fs.mkdirSync(outside)
  fs.writeFileSync(
    path.join(stateRoot, 'manifest.json'),
    JSON.stringify({ version: '1.0.0', installedSkills: {} })
  )
  const dirName = 'my-skill'
  const staging = path.join(skillsDir, '.skillsmith-staging')
  return {
    base,
    skillsDir,
    stateRoot,
    dirName,
    realDir: path.join(skillsDir, dirName),
    staging,
    opDir: path.join(staging, OP_ID),
    outside,
  }
}

/** A record identity of `p` (no-follow), as `record.json` writes one. */
export function idOf(p: string): RecordIdentity {
  const s = fs.lstatSync(p, { bigint: true })
  return {
    dev: s.dev.toString(),
    ino: s.ino.toString(),
    birthtimeNs: s.birthtimeNs.toString(),
    fmt: (s.mode & 0o170000n).toString(),
  }
}

export interface BuildOptions {
  opId?: string
  /** The entry the target guard accepted (default: none). */
  preEntry?: unknown
  /** Another uid in the record (T-FIO). */
  uid?: number
}

/**
 * FI0: the staged install built in `OP/new`, its record sealed and published
 * in OP, the manifest with no entry (or `preEntry`), the skill path absent.
 */
export function fi0(fx: Fixture, o: BuildOptions = {}): IState {
  const opId = o.opId ?? OP_ID
  const opDir = path.join(fx.staging, opId)
  const newDir = path.join(opDir, 'new')
  fs.mkdirSync(path.join(newDir, 'docs'), { recursive: true })
  fs.writeFileSync(path.join(newDir, 'SKILL.md'), '# installed\n')
  fs.writeFileSync(path.join(newDir, 'docs', 'a.md'), 'a\n')
  const preEntry = o.preEntry ?? null
  if (preEntry !== null) setEntry(fx, fx.dirName, preEntry)
  const body: Omit<InstallRecord, 'recordSha256'> = {
    schema: 1,
    op: 'install',
    opId,
    pid: process.pid,
    host: os.hostname(),
    uid: o.uid ?? process.geteuid?.() ?? 0,
    target: {
      comparedPath: fx.realDir,
      realDir: fx.realDir,
      skillsDir: fx.skillsDir,
      manifestPath: path.join(fx.stateRoot, 'manifest.json'),
      manifestKey: fx.dirName,
      client: 'claude-code',
      scope: 'global',
      dirName: fx.dirName,
    },
    rootIdentity: idOf(fx.skillsDir),
    opDirIdentity: idOf(opDir),
    newIdentity: idOf(newDir),
    postTree: hashOf(newDir),
    preEntry,
    postEntry: POST_ENTRY,
  }
  const sealed = sealInstallRecord(body, fx.skillsDir, opId)
  if (!sealed.ok) throw new Error(`seal failed: ${sealed.why} ${sealed.detail}`)
  fs.writeFileSync(path.join(opDir, 'record.json'), sealed.bytes, { mode: 0o600 })
  return { fx, opId, opDir, newDir, record: sealed.record }
}

/** FI1: FI0 with the claim made and the publish stopped before its rename (claim-publish's own kill). */
export async function fi1(fx: Fixture, o: BuildOptions = {}): Promise<IState> {
  const st = fi0(fx, o)
  await expect(
    claimPublish(st.newDir, fx.realDir, {
      afterClaim: () => {
        throw new Error('killed between the claim and the rename')
      },
    })
  ).rejects.toThrow('killed')
  return st
}

/** FI2: FI0 with N published at the skill path; the manifest not committed. */
export async function fi2(fx: Fixture, o: BuildOptions = {}): Promise<IState> {
  const st = fi0(fx, o)
  const r = await claimPublish(st.newDir, fx.realDir)
  expect(r.ok).toBe(true)
  return st
}

/** FI3: FI2 with the manifest entry committed. */
export async function fi3(fx: Fixture, o: BuildOptions = {}): Promise<IState> {
  const st = await fi2(fx, o)
  setEntry(fx, fx.dirName, POST_ENTRY)
  return st
}

/** FI2′: FI2 with the manifest entry neither the planned nor the installed one. */
export async function fi2prime(fx: Fixture, o: BuildOptions = {}): Promise<IState> {
  const st = await fi2(fx, o)
  setEntry(fx, fx.dirName, OTHER_ENTRY)
  return st
}

/** FI2u: FI2 with the published folder set aside to `OP/undone`, modelled by the rename `undoAside` makes. */
export async function fi2u(fx: Fixture, o: BuildOptions = {}): Promise<IState> {
  const st = await fi2(fx, o)
  fs.renameSync(fx.realDir, path.join(st.opDir, 'undone'))
  return st
}

/**
 * FI4: FI2 with the published folder set aside by the install's post-claim
 * park (`parkTree`, caller `install-rollback`, the record's opId). Returns the
 * parked copy's path too.
 */
export async function fi4(fx: Fixture, o: BuildOptions = {}): Promise<IState & { parked: string }> {
  const st = await fi2(fx, o)
  const r = parkTree(fx.skillsDir, fx.dirName, {
    client: 'claude-code',
    caller: 'install-rollback',
    kind: 'install-rollback',
    opId: st.opId,
    guardHash: st.record.postTree,
  })
  expect(r.status).toBe('parked')
  return { ...st, parked: r.path! }
}

/**
 * Keeps the tree at `src` as `kind` with the production `publishTree`, under
 * lock 1, from a state built from the record: what a doctor keep (or the
 * staged install's abort keep) leaves, sidecar included. Returns where.
 */
export async function keepWith(st: IState, src: string, kind: PublishKind): Promise<string> {
  const binding = await bindSkillsRootReadOnly(st.fx.skillsDir)
  if (binding === null) throw new Error('no binding')
  const r = await withSkillWriteLock(binding, 'test keep', async (ctx) => {
    const s = recoveryState({ record: st.record, binding: ctx, ctx, options: {} })
    return publishTree(s, src, kind)
  })
  if (!r.ok) throw new Error(`keep failed: ${JSON.stringify(r)}`)
  return r.value
}

/** The parked area of the install's opId under the skills root. */
export const parkedDirOf = (st: Pick<IState, 'fx' | 'opId'>): string =>
  path.join(st.fx.skillsDir, '.skillsmith-parked', st.opId)
