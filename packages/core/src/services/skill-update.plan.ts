/**
 * SMI-6531 (A1 step 7b): `planSkillUpdate`, the write-set planner for an
 * existing folder (A1 plan §3.7 items 2-5, §3.6).
 *
 * 1. The optimizer is off by construction: this module never imports it, so
 *    there is no generated sub-skill and no companion write (§3.7 item 1).
 * 2. SKILL.md and the optional files are fetched and scanned through
 *    `install()`'s own pipeline (`skill-installation.fetch-scan.ts`), before
 *    any lock.
 * 3. The write set is SKILL.md plus the fetched optional files, minus those
 *    whose current bytes already equal the fetched bytes. Nothing is ever
 *    removed: a file upstream no longer serves stays, with its baseline (Q12).
 * 4. Each file is `modify` (a regular file with one link) or `create` (absent,
 *    or under an absent directory). A symlink, a directory, a FIFO, another
 *    type or a hard link at the path, or a non-directory on its way, is
 *    `unsupported-entry`; nothing at the path is opened before its `lstat`.
 * 5. `postEntry` is `buildPostEntry(preEntry, writable)`, computed once here
 *    (Q7): `version` when the caller names a non-empty one, `lastUpdated` now,
 *    `originalContentHash` and `upstreamContentHash` the sha256 of the fetched
 *    SKILL.md bytes (equal with the optimizer off), and `fileHashes` the
 *    sha256 of every fetched optional file, those already equal included,
 *    merged over the existing map. SKILL.md is not in `fileHashes`: A2 reads
 *    its baseline from `originalContentHash`.
 *
 * Step 4 of the swap re-verifies the whole folder against `preTree` under
 * lock 1, so a change between this read and the lock aborts the update.
 *
 * @module @skillsmith/core/services/skill-update.plan
 */
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { LockOrderError } from '../config/lock-tracker.js'
import { O_NOFOLLOW } from '../utils/safe-fs.js'
import {
  fetchAndScanOptional,
  fetchAndScanSkillMd,
  resolveInstallSource,
  type InstallSource,
} from './skill-installation.fetch-scan.js'
import type {
  AiDefenceFeedback,
  InstallResult,
  ProgressCallback,
  RegistryLookup,
} from './skill-installation.types.js'
import { buildPostEntry } from './skill-manifest.entry.js'
import type { EntryWritable } from './skill-manifest.entry.js'
import type {
  PlannedFile,
  UpdatePlan,
  UpdateRefusal,
  UpdateRefusalReason,
  UpdateTarget,
} from './skill-update.types.js'

export interface PlanSkillUpdateInput {
  target: UpdateTarget
  /** The skill ID the entry records (a registry ID or a GitHub URL). */
  skillId: string
  /** The registry version the plan diffed; written to the entry only when non-empty. */
  version?: string
  registryLookup?: RegistryLookup
  skipScan?: boolean
  confirmed?: boolean
  onProgress?: ProgressCallback
  aiDefenceFeedback?: AiDefenceFeedback
  /** @internal The clock `lastUpdated` reads (default `new Date()`). */
  now?: () => Date
}

const sha256 = (bytes: Buffer): string => createHash('sha256').update(bytes).digest('hex')

const codeOf = (err: unknown): string => {
  const code = (err as NodeJS.ErrnoException)?.code
  return typeof code === 'string' && code !== '' ? code : 'UNKNOWN'
}

/** The fetch-and-scan failure codes that are a scan's verdict, not a fetch's. */
const SCAN_CODES: ReadonlySet<string> = new Set(['SCAN_REJECTED', 'SKIP_SCAN_FORBIDDEN'])

function refusalOf(result: InstallResult): UpdateRefusal {
  const reason: UpdateRefusalReason =
    result.errorCode === 'CONFIRMATION_REQUIRED'
      ? 'confirmation-required'
      : result.errorCode !== undefined && SCAN_CODES.has(result.errorCode)
        ? 'scan-rejected'
        : 'fetch-failed'
  return {
    ok: false,
    reason,
    detail: result.error ?? result.confirmationReason ?? '',
    install: result,
  }
}

type Current =
  | { kind: 'modify'; bytes: Buffer }
  | { kind: 'create' }
  | { refuse: 'unsupported-entry' | 'unreadable'; detail: string; path: string }

/** `lstat` without following, `null` for `ENOENT`. */
async function lstatOrNull(p: string): Promise<fs.Stats | null> {
  try {
    return await fs.promises.lstat(p)
  } catch (err) {
    if (codeOf(err) === 'ENOENT') return null
    throw err
  }
}

/** What is at `rel` under `realDir` now (§3.7 item 4). */
async function currentAt(realDir: string, rel: string): Promise<Current> {
  const segs = rel.split('/')
  let abs = realDir
  try {
    for (const seg of segs.slice(0, -1)) {
      abs = path.join(abs, seg)
      const st = await lstatOrNull(abs)
      if (st === null) return { kind: 'create' }
      if (st.isSymbolicLink() || !st.isDirectory()) {
        return { refuse: 'unsupported-entry', detail: `${abs} is not a directory`, path: abs }
      }
    }
    abs = path.join(realDir, rel)
    const st = await lstatOrNull(abs)
    if (st === null) return { kind: 'create' }
    if (!st.isFile()) {
      return { refuse: 'unsupported-entry', detail: `${abs} is not a regular file`, path: abs }
    }
    if (st.nlink !== 1) {
      return { refuse: 'unsupported-entry', detail: `${abs} has ${st.nlink} links`, path: abs }
    }
    // O_NONBLOCK: a FIFO swapped in after the lstat fails instead of blocking the open.
    const fh = await fs.promises.open(
      abs,
      fs.constants.O_RDONLY | O_NOFOLLOW | fs.constants.O_NONBLOCK
    )
    try {
      const now = await fh.stat()
      if (!now.isFile() || now.nlink !== 1 || now.ino !== st.ino || now.dev !== st.dev) {
        return { refuse: 'unsupported-entry', detail: `${abs} changed while read`, path: abs }
      }
      return { kind: 'modify', bytes: await fh.readFile() }
    } finally {
      await fh.close().catch(() => undefined)
    }
  } catch (err) {
    return { refuse: 'unreadable', detail: `${abs} could not be read (${codeOf(err)})`, path: abs }
  }
}

/** Plans the in-place update of `input.target` (§3.7), or refuses with nothing written. */
export async function planSkillUpdate(
  input: PlanSkillUpdateInput
): Promise<UpdatePlan | UpdateRefusal> {
  const { target, skillId } = input
  const onProgress = input.onProgress ?? (() => {})
  let source: InstallSource
  try {
    const resolved = await resolveInstallSource(skillId, input.registryLookup, onProgress)
    if (!resolved.ok) return refusalOf(resolved.result)
    source = resolved.value
  } catch (err) {
    if (err instanceof LockOrderError) throw err
    return { ok: false, reason: 'fetch-failed', detail: (err as Error)?.message ?? String(err) }
  }
  const installPath = target.comparedPath
  const skillMd = await fetchAndScanSkillMd(source, {
    skillId,
    installPath,
    ...(input.skipScan !== undefined && { skipScan: input.skipScan }),
    ...(input.confirmed !== undefined && { confirmed: input.confirmed }),
    onProgress,
    ...(input.aiDefenceFeedback !== undefined && { aiDefenceFeedback: input.aiDefenceFeedback }),
  })
  if (!skillMd.ok) return refusalOf(skillMd.result)
  const optional = await fetchAndScanOptional(source, skillId, installPath, input.skipScan)
  if (!optional.ok) return refusalOf(optional.result)

  const skillMdBytes = Buffer.from(skillMd.value.skillMdContent, 'utf8')
  const fetched = [
    { rel: 'SKILL.md', bytes: skillMdBytes },
    ...optional.value.filesToWrite.map((f) => ({
      rel: f.filename,
      bytes: Buffer.from(f.content, 'utf8'),
    })),
  ]
  const files: PlannedFile[] = []
  for (const f of fetched) {
    const now = await currentAt(target.realDir, f.rel)
    if ('refuse' in now)
      return { ok: false, reason: now.refuse, detail: now.detail, path: now.path }
    if (now.kind === 'create') {
      files.push({ rel: f.rel, kind: 'create', bytes: f.bytes, preSha256: null })
    } else if (!now.bytes.equals(f.bytes)) {
      files.push({ rel: f.rel, kind: 'modify', bytes: f.bytes, preSha256: sha256(now.bytes) })
    }
  }

  const skillMdHash = sha256(skillMdBytes)
  const optionalHashes = fetched.slice(1).map((f) => [f.rel, sha256(f.bytes)] as const)
  const writable: EntryWritable = {
    ...(typeof input.version === 'string' && input.version !== '' && { version: input.version }),
    lastUpdated: (input.now ?? (() => new Date()))().toISOString(),
    originalContentHash: skillMdHash,
    upstreamContentHash: skillMdHash,
    ...(optionalHashes.length > 0 && { fileHashes: Object.fromEntries(optionalHashes) }),
  }
  return {
    ok: true,
    target,
    skillId,
    trustTier: source.trustTier,
    files,
    writes: files.map((f) => ({ rel: f.rel, mode: f.kind === 'create' ? 'add' : 'modify' })),
    postEntry: buildPostEntry(target.preEntry, writable),
    ...(skillMd.value.securityReport !== undefined && {
      securityReport: skillMd.value.securityReport,
    }),
    contentHashMismatch: skillMd.value.contentHashMismatch,
    configWarnings: optional.value.configWarnings,
  }
}
