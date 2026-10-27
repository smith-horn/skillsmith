/**
 * SMI-6531 (A1 step 7b): `planSkillUpdate`, the write-set planner for an
 * existing folder (A1 plan §3.7 items 2-5, §3.6).
 *
 * 1. The optimizer is off by construction: this module never imports it, so
 *    there is no generated sub-skill and no companion write (§3.7 item 1).
 * 2. SKILL.md and the optional files are fetched and scanned through
 *    `install()`'s own pipeline (`skill-installation.fetch-scan.ts`), before
 *    any lock. The security gate's refusals (a scan or quarantine verdict, and
 *    `skipScan` on a tier that requires a scan, whose detail says to run
 *    without it) are `scan-rejected`, install's confirmation gate
 *    `confirmation-required`,
 *    anything else (a throw included, with install's sanitized message)
 *    `fetch-failed`; a skill ID that does not parse is `manifest-key-conflict`.
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
  type FetchScanStage,
} from './skill-installation.fetch-scan.js'
import { sanitizeInstallError } from './skill-installation.helpers.js'
import { parseSkillIdInternal } from './skill-installation.validate.js'
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

/**
 * The fetch-and-scan failure codes that are the security gate's, not a
 * fetch's, so `fetch-failed`'s retry is wrong for them. `SCAN_REJECTED` and
 * `QUARANTINED` (A2 has no quarantine reason) are verdicts on the content.
 * `SKIP_SCAN_FORBIDDEN` is not: the same update succeeds without `skipScan`,
 * so its detail carries install's tip that the tier requires a scan, since
 * `scan-rejected`'s A2 remedy (audit the source) does not say so.
 */
const SCAN_CODES: ReadonlySet<string> = new Set([
  'SCAN_REJECTED',
  'SKIP_SCAN_FORBIDDEN',
  'QUARANTINED',
])

function refusalOf(result: InstallResult): UpdateRefusal {
  const reason: UpdateRefusalReason =
    result.errorCode === 'CONFIRMATION_REQUIRED'
      ? 'confirmation-required'
      : result.errorCode !== undefined && SCAN_CODES.has(result.errorCode)
        ? 'scan-rejected'
        : 'fetch-failed'
  const base = result.error ?? result.confirmationReason ?? ''
  const scanTip = result.errorCode === 'SKIP_SCAN_FORBIDDEN' ? result.tips?.[0] : undefined
  return {
    ok: false,
    reason,
    detail: scanTip === undefined ? base : `${base} ${scanTip}; run the update without skipScan.`,
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
      const fst = await fh.stat()
      if (!fst.isFile() || fst.nlink !== 1 || fst.ino !== st.ino || fst.dev !== st.dev) {
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

/**
 * Runs one fetch-and-scan stage. Its failure result maps through `refusalOf`;
 * a throw becomes `fetch-failed` with `install()`'s own sanitized message
 * (`install()` reports it as `UNKNOWN`), except a `LockOrderError`, which is a
 * bug and propagates.
 */
async function runStage<T>(
  stage: () => Promise<FetchScanStage<T>>
): Promise<{ ok: true; value: T } | UpdateRefusal> {
  try {
    const r = await stage()
    return r.ok ? r : refusalOf(r.result)
  } catch (err) {
    if (err instanceof LockOrderError) throw err
    return { ok: false, reason: 'fetch-failed', detail: sanitizeInstallError(err) }
  }
}

/** Plans the in-place update of `input.target` (§3.7), or refuses with nothing written. */
export async function planSkillUpdate(
  input: PlanSkillUpdateInput
): Promise<UpdatePlan | UpdateRefusal> {
  const { target, skillId } = input
  const onProgress = input.onProgress ?? (() => {})
  // An unparseable recorded skill ID is not transient, so it must not get
  // `fetch-failed`'s retry. A2 has no reason for it; `manifest-key-conflict`
  // (the entry's identity is wrong; its remedy re-verifies or relinks it) is
  // the nearest.
  try {
    parseSkillIdInternal(skillId)
  } catch {
    return {
      ok: false,
      reason: 'manifest-key-conflict',
      detail: `the skill ID ${JSON.stringify(skillId)} recorded for ${target.comparedPath} is neither a registry ID nor a GitHub URL`,
    }
  }
  const resolved = await runStage(() =>
    resolveInstallSource(skillId, input.registryLookup, onProgress)
  )
  if (!resolved.ok) return resolved
  const source = resolved.value
  const installPath = target.comparedPath
  const skillMd = await runStage(() =>
    fetchAndScanSkillMd(source, {
      skillId,
      installPath,
      ...(input.skipScan !== undefined && { skipScan: input.skipScan }),
      ...(input.confirmed !== undefined && { confirmed: input.confirmed }),
      onProgress,
      ...(input.aiDefenceFeedback !== undefined && { aiDefenceFeedback: input.aiDefenceFeedback }),
    })
  )
  if (!skillMd.ok) return skillMd
  const optional = await runStage(() =>
    fetchAndScanOptional(source, skillId, installPath, input.skipScan)
  )
  if (!optional.ok) return optional

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
    const current = await currentAt(target.realDir, f.rel)
    if ('refuse' in current)
      return { ok: false, reason: current.refuse, detail: current.detail, path: current.path }
    if (current.kind === 'create') {
      files.push({ rel: f.rel, kind: 'create', bytes: f.bytes, preSha256: null })
    } else if (!current.bytes.equals(f.bytes)) {
      files.push({ rel: f.rel, kind: 'modify', bytes: f.bytes, preSha256: sha256(current.bytes) })
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
