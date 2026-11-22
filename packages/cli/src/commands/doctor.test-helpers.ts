/**
 * @fileoverview Test seam for the `doctor` command tests (SMI-6531 step 6a-i):
 * root discovery pointed at temporary directories, so no test reads the real
 * home, and a crashed update to list. Used only by `doctor*.test.ts`.
 * @module @skillsmith/cli/commands/doctor.test-helpers
 */

import { createHash } from 'node:crypto'
import { lstatSync, mkdirSync, realpathSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  claimPublish,
  computeRecordSha256,
  sealInstallRecord,
  treeHashOf,
  type DiscoverOptions,
} from '@skillsmith/core'

/** The nine client ids, as `CLIENT_NATIVE_PATHS` keys them. */
export const CLIENT_IDS = [
  'claude-code',
  'cursor',
  'copilot',
  'windsurf',
  'agents',
  'opencode',
  'hermes',
  'grok',
  'antigravity',
] as const

/**
 * Discovery overrides that read only `base`: the nine client roots under
 * `base/clients/<id>` (created when `create` is true), `base` as home and as
 * the working directory.
 */
export function hermeticDiscovery(base: string, create = false): Partial<DiscoverOptions> {
  const nativePaths = Object.fromEntries(
    CLIENT_IDS.map((id) => [id, join(base, 'clients', id)])
  ) as unknown as NonNullable<DiscoverOptions['nativePaths']>
  if (create) {
    for (const id of CLIENT_IDS) mkdirSync(join(base, 'clients', id), { recursive: true })
  }
  return { homeDir: base, cwd: base, nativePaths }
}

const FMT = 0o170000n

/** A directory's identity as `record.json` stores it (decimal strings). */
function identityOf(p: string): { dev: string; ino: string; birthtimeNs: string; fmt: string } {
  const s = lstatSync(p, { bigint: true })
  return {
    dev: s.dev.toString(),
    ino: s.ino.toString(),
    birthtimeNs: s.birthtimeNs.toString(),
    fmt: (s.mode & FMT).toString(),
  }
}

export interface PlantedUpdate {
  root: string
  opId: string
  opDir: string
  skillDir: string
  stateRoot: string
  backupDest: string
}

/**
 * A skills root holding an update that crashed after the swap (the plan's S2):
 * the new folder at the skill path, the old one in the op dir, a record that
 * verifies, and the manifest entry still as planned. Built by hand with the
 * same fields `swapInPlace` writes, so `doctor recovery` reads a real record.
 */
export function plantCrashedUpdate(
  base: string,
  opId = 'a'.repeat(32),
  /** The state root (default `<base>/.skillsmith`); another device makes the backup cross-device. */
  stateRoot = join(base, '.skillsmith')
): PlantedUpdate {
  const root = realpathSync(join(base, 'clients', 'claude-code'))
  mkdirSync(stateRoot, { recursive: true })
  const staging = join(root, '.skillsmith-staging')
  mkdirSync(staging, { mode: 0o700 })
  const opDir = join(staging, opId)
  mkdirSync(opDir, { mode: 0o700 })
  const skillDir = join(root, 'my-skill')
  const oldDir = join(opDir, 'old')
  for (const [dir, text] of [
    [oldDir, '# old\n'],
    [skillDir, '# new\n'],
  ] as const) {
    mkdirSync(dir)
    writeFileSync(join(dir, 'SKILL.md'), text)
  }
  const hashOf = (p: string): string => {
    const h = treeHashOf(p)
    if (!h.ok) throw new Error(`cannot hash ${p}`)
    return h.hash
  }
  const rootKey = createHash('sha256').update(root).digest('hex').slice(0, 16)
  const backupDest = join(
    realpathSync(stateRoot),
    'backups',
    'update',
    'claude-code',
    rootKey,
    'my-skill',
    opId
  )
  const body = {
    schema: 1 as const,
    op: 'update' as const,
    opId,
    pid: process.pid,
    host: 'test-host',
    uid: process.geteuid?.() ?? -1,
    target: {
      comparedPath: skillDir,
      realDir: skillDir,
      skillsDir: root,
      manifestPath: join(realpathSync(stateRoot), 'manifest.json'),
      manifestKey: 'my-skill',
      client: 'claude-code',
      scope: 'global',
      dirName: 'my-skill',
    },
    rootIdentity: identityOf(root),
    opDirIdentity: identityOf(opDir),
    oldIdentity: identityOf(oldDir),
    newIdentity: identityOf(skillDir),
    preTree: hashOf(oldDir),
    postTree: hashOf(skillDir),
    preEntry: { version: '1.0.0' },
    postEntry: { version: '2.0.0' },
    backupDest,
  }
  writeFileSync(
    join(opDir, 'record.json'),
    JSON.stringify({ ...body, recordSha256: computeRecordSha256(body) })
  )
  writeFileSync(
    join(stateRoot, 'manifest.json'),
    JSON.stringify({ version: '1.0.0', installedSkills: { 'my-skill': { version: '1.0.0' } } })
  )
  return { root, opId, opDir, skillDir, stateRoot, backupDest }
}

export interface PlantedInstall {
  root: string
  opId: string
  opDir: string
  skillDir: string
  stateRoot: string
  /** Where FI4's set-aside copy is (FI4 only). */
  parked: string | null
}

/**
 * SMI-6531 (A1 step 8-i-a-2): a skills root holding a fresh install that
 * stopped at `stage` (the design's FI0, FI2 or FI4): the staged folder in the
 * op dir, its record sealed by `sealInstallRecord` (the staged install's own
 * sealer), the manifest with no entry. FI2 publishes it with `claimPublish`;
 * FI4 then moves it to the install's parked area with its identity kept (a
 * rename, as the park makes one; no sidecar, as a park killed before its
 * sidecar write leaves it).
 */
export async function plantInstall(
  base: string,
  stage: 'FI0' | 'FI2' | 'FI4',
  opId = 'c'.repeat(32)
): Promise<PlantedInstall> {
  const root = realpathSync(join(base, 'clients', 'claude-code'))
  const stateRoot = join(base, '.skillsmith')
  mkdirSync(stateRoot, { recursive: true })
  writeFileSync(
    join(stateRoot, 'manifest.json'),
    JSON.stringify({ version: '1.0.0', installedSkills: {} })
  )
  const opDir = join(root, '.skillsmith-staging', opId)
  mkdirSync(opDir, { recursive: true, mode: 0o700 })
  const newDir = join(opDir, 'new')
  mkdirSync(newDir)
  writeFileSync(join(newDir, 'SKILL.md'), '# installed\n')
  const skillDir = join(root, 'my-skill')
  const h = treeHashOf(newDir)
  if (!h.ok) throw new Error('cannot hash the staged folder')
  const sealed = sealInstallRecord(
    {
      schema: 1,
      op: 'install',
      opId,
      pid: process.pid,
      host: 'test-host',
      uid: process.geteuid?.() ?? -1,
      target: {
        comparedPath: skillDir,
        realDir: skillDir,
        skillsDir: root,
        manifestPath: join(realpathSync(stateRoot), 'manifest.json'),
        manifestKey: 'my-skill',
        client: 'claude-code',
        scope: 'global',
        dirName: 'my-skill',
      },
      rootIdentity: identityOf(root),
      opDirIdentity: identityOf(opDir),
      newIdentity: identityOf(newDir),
      postTree: h.hash,
      preEntry: null,
      postEntry: { version: '1.0.0', source: 'github:o/r' },
    },
    root,
    opId
  )
  if (!sealed.ok) throw new Error(`seal failed: ${sealed.why}`)
  writeFileSync(join(opDir, 'record.json'), sealed.bytes)
  let parked: string | null = null
  if (stage !== 'FI0') {
    const r = await claimPublish(newDir, skillDir)
    if (!r.ok) throw new Error(`publish failed: ${r.reason}`)
  }
  if (stage === 'FI4') {
    const area = join(root, '.skillsmith-parked', opId)
    mkdirSync(area, { recursive: true })
    parked = join(area, 'my-skill-0123abcd')
    renameSync(skillDir, parked)
  }
  return { root, opId, opDir, skillDir, stateRoot, parked }
}
