/**
 * @fileoverview Test seam for the `doctor` command tests (SMI-6531 step 6a-i):
 * root discovery pointed at temporary directories, so no test reads the real
 * home, and a crashed update to list. Used only by `doctor*.test.ts`.
 * @module @skillsmith/cli/commands/doctor.test-helpers
 */

import { createHash } from 'node:crypto'
import { lstatSync, mkdirSync, realpathSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { computeRecordSha256, treeHashOf, type DiscoverOptions } from '@skillsmith/core'

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
export function plantCrashedUpdate(base: string, opId = 'a'.repeat(32)): PlantedUpdate {
  const root = realpathSync(join(base, 'clients', 'claude-code'))
  const stateRoot = join(base, '.skillsmith')
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
    uid: process.getuid?.() ?? -1,
    target: {
      comparedPath: skillDir,
      realDir: skillDir,
      skillsDir: root,
      manifestPath: join(realpathSync(stateRoot), 'manifest.json'),
      manifestKey: 'my-skill',
      client: 'claude-code',
      scope: 'user',
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
