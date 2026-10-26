/**
 * SMI-6531 (A1 step 6a-i): the classifier's reader, the only filesystem access
 * doctor's classifier has (design `step6a-design.md` § 2 "One reader, one
 * digest").
 *
 * Every method records what it was asked and what it found into a transcript.
 * The re-plan check under lock 1 is a digest of that transcript plus the
 * serialized plan (`skill-recovery.digest.ts`), so it covers exactly what the
 * classifier read, with no curated list of fields to keep in step with the
 * classifier. Two properties make that true by construction:
 *
 *  - a file the classifier parses is read through `readFile`, which records the
 *    file's identity, type and byte hash, so a parsed file is in the digest;
 *  - the classifier modules import neither `node:fs` nor any module that does
 *    except this one (a core test walks their imports), so a read added later
 *    cannot bypass the transcript.
 *
 * Listings are filtered by a named rule and record only the names the rule
 * keeps, so an unrelated entry (another op's backup) never enters the
 * transcript and cannot cause a spurious `plan-changed`. The manifest entry's
 * state and the journal's presence fact are the declared shared reads
 * (`SHARED_METHODS`): those files change with unrelated work, so the
 * transcript holds the derived fact, not the bytes.
 *
 * Read-only: this module opens files with `O_RDONLY|O_NOFOLLOW|O_NONBLOCK`,
 * lists directories and `lstat`s. It creates, writes, renames and removes
 * nothing.
 *
 * @module @skillsmith/core/services/skill-recovery.reader
 */
import crypto from 'node:crypto'
import fs from 'node:fs'
import { S_IFDIR, S_IFLNK, S_IFMT, S_IFREG } from '../install/park-tree.perms.js'
import { readEntryState } from './skill-manifest.entry.js'
import { createManifestPort } from './skill-manifest.port.js'
import type { ManifestPortTarget } from './skill-manifest.port.js'
import { isAreaEntryOf, KEPT_KINDS } from './skill-swap.fullmark.js'
import { treeHashOf } from './skill-tree.js'
import { SHARED_METHODS } from './skill-recovery.types.js'
import type {
  EntryFact,
  FileType,
  JournalFact,
  ListFact,
  ListRule,
  PortFact,
  ReadFact,
  ReaderMethod,
  ReadFactOf,
  ReadTranscript,
  RealpathFact,
  StatFact,
  TranscriptEntry,
  TreeHashFact,
} from './skill-recovery.types.js'
import type { RecordIdentity } from './skill-swap.types.js'

/** `.skillsmith-probe-<opId>-<n>`: the clock gate's probe (UD25), made and removed under lock 1. */
export const PROBE_NAME = /^\.skillsmith-probe-[A-Za-z0-9_-]+-[0-9]+$/

/** The most of the audit journal the reader will read: past it the fact is unknown, not "absent". */
export const JOURNAL_READ_CAP = 64 * 1024 * 1024

export interface ReaderOptions {
  /** @internal Test seam: replaces `JOURNAL_READ_CAP`. */
  journalCap?: number
  /**
   * @internal Test seam: replaces what `stat` reports for a path (for instance
   * a stat that matches dev, ino and birthtime but not the file type).
   */
  statOverride?: (p: string, real: StatFact) => StatFact
}

const errnoOf = (err: unknown): string => {
  const code = (err as NodeJS.ErrnoException | null)?.code
  return typeof code === 'string' && code !== '' ? code : 'UNKNOWN'
}

function typeOf(mode: bigint): FileType {
  const fmt = mode & S_IFMT
  if (fmt === S_IFDIR) return 'dir'
  if (fmt === S_IFREG) return 'file'
  if (fmt === S_IFLNK) return 'symlink'
  return 'other'
}

function identityOf(st: fs.BigIntStats): RecordIdentity {
  return {
    dev: st.dev.toString(),
    ino: st.ino.toString(),
    birthtimeNs: st.birthtimeNs.toString(),
    fmt: (st.mode & S_IFMT).toString(),
  }
}

/**
 * The kinds doctor recognizes in a backup area: the producers' (`KEPT_KINDS`,
 * which the compiler keeps in step with `PublishKind`) and the ones doctor
 * itself makes, `unused-new` (a staged tree no one installed, 6a-ii) and the
 * `abandoned-*` kinds (`--abandon`, 6b). A set union, so a producer that later
 * adds one of them changes nothing here.
 */
const RECOGNIZED_KINDS: ReadonlySet<string> = new Set([
  ...KEPT_KINDS,
  'unused-new',
  'abandoned-old',
  'abandoned-new',
  'abandoned-undone',
])

/** The entries a rule keeps, sorted. */
function keep(rule: ListRule, names: string[]): string[] {
  const kept = names.filter((n) => {
    if (rule.name === 'all') return true
    if (rule.name === 'stagingEntries') return !n.startsWith('.') || PROBE_NAME.test(n)
    return isAreaEntryOf(n, rule.opId, RECOGNIZED_KINDS)
  })
  return kept.sort()
}

const ruleKey = (rule: ListRule): string =>
  rule.name === 'areaForOp' ? `areaForOp:${rule.opId}` : rule.name

export class ClassifierReader {
  private readonly entries: TranscriptEntry[] = []
  constructor(private readonly options: ReaderOptions = {}) {}

  private record<M extends ReaderMethod>(
    method: M,
    key: string,
    fact: ReadFactOf[M]
  ): ReadFactOf[M] {
    this.entries.push({ method, key, derived: SHARED_METHODS.has(method), fact })
    return fact
  }

  /** Everything read so far, in call order (the digest sorts it). */
  transcript(): ReadTranscript {
    return this.entries.slice()
  }

  /** A no-follow bigint `lstat`: type, identity, owner and link count, or the errno. */
  stat(p: string): StatFact {
    let fact: StatFact
    try {
      const st = fs.lstatSync(p, { bigint: true })
      fact = {
        ok: true,
        type: typeOf(st.mode),
        identity: identityOf(st),
        uid: Number(st.uid),
        nlink: Number(st.nlink),
      }
    } catch (err) {
      fact = { ok: false, errno: errnoOf(err) }
    }
    if (this.options.statOverride !== undefined) fact = this.options.statOverride(p, fact)
    return this.record('stat', p, fact)
  }

  /**
   * A bounded read of at most `cap` bytes, `O_NOFOLLOW|O_NONBLOCK`, of a
   * regular file. `bytes` is for the caller to parse; the transcript keeps the
   * file's identity, size and the sha256 of the bytes read. A directory, FIFO
   * or device is `NOT_A_FILE` and is never read.
   */
  readFile(p: string, cap: number): { fact: ReadFact; bytes: Buffer | null } {
    const failed = (errno: string, type?: FileType): { fact: ReadFact; bytes: null } => ({
      fact: this.record(
        'readFile',
        p,
        type === undefined ? { ok: false, errno } : { ok: false, errno, type }
      ),
      bytes: null,
    })
    let fd: number
    try {
      fd = fs.openSync(
        p,
        fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0) | (fs.constants.O_NONBLOCK ?? 0)
      )
    } catch (err) {
      return failed(errnoOf(err))
    }
    try {
      const st = fs.fstatSync(fd, { bigint: true })
      if (typeOf(st.mode) !== 'file') return failed('NOT_A_FILE', typeOf(st.mode))
      const buf = Buffer.alloc(cap)
      let got = 0
      while (got < cap) {
        const n = fs.readSync(fd, buf, got, cap - got, got)
        if (n === 0) break
        got += n
      }
      const bytes = buf.subarray(0, got)
      const fact = this.record('readFile', p, {
        ok: true,
        identity: identityOf(st),
        size: got,
        sha256: crypto.createHash('sha256').update(bytes).digest('hex'),
        truncated: got === cap,
      })
      return { fact, bytes }
    } catch (err) {
      return failed(errnoOf(err))
    } finally {
      fs.closeSync(fd)
    }
  }

  /** The entries of a directory that `rule` keeps, with the directory's own identity. */
  list(dir: string, rule: ListRule): ListFact {
    let fact: ListFact
    try {
      const st = fs.lstatSync(dir, { bigint: true })
      if (typeOf(st.mode) !== 'dir') {
        fact = { ok: false, errno: 'ENOTDIR' }
      } else {
        fact = {
          ok: true,
          dirIdentity: identityOf(st),
          rule: ruleKey(rule),
          names: keep(rule, fs.readdirSync(dir)),
        }
      }
    } catch (err) {
      fact = { ok: false, errno: errnoOf(err) }
    }
    return this.record('list', `${dir}\0${ruleKey(rule)}`, fact)
  }

  /** The §3.4 tree hash of `p`, with the identity of its root. */
  treeHash(p: string): TreeHashFact {
    let fact: TreeHashFact
    try {
      const st = fs.lstatSync(p, { bigint: true })
      const h = treeHashOf(p)
      fact = h.ok
        ? { ok: true, hash: h.hash, identity: identityOf(st) }
        : { ok: false, reason: h.reason, path: h.path, errno: h.errno }
    } catch (err) {
      fact = { ok: false, reason: 'unreadable', path: p, errno: errnoOf(err) }
    }
    return this.record('treeHash', p, fact)
  }

  realpath(p: string): RealpathFact {
    let fact: RealpathFact
    try {
      fact = { ok: true, path: fs.realpathSync.native(p) }
    } catch (err) {
      fact = { ok: false, errno: errnoOf(err) }
    }
    return this.record('realpath', p, fact)
  }

  /** The entry at `key` in the manifest, as `pre`, `post` or `other`, or why the manifest refuses. */
  async manifestEntry(
    manifestPath: string,
    key: string,
    pre: unknown,
    post: unknown
  ): Promise<EntryFact> {
    const read = await readEntryState(manifestPath, key, pre, post)
    const fact: EntryFact = read.ok
      ? { ok: true, state: read.state }
      : { ok: false, refusal: read.refusal.state }
    return this.record('manifestEntry', `${manifestPath}\0${key}`, fact)
  }

  /**
   * Whether any parseable line of the journal at `file` is an `update` record
   * naming `opId` (not only the verified chain, which stops at a break), and
   * whether the last line is torn. A missing journal holds no record.
   */
  journalHasUpdate(opId: string, file: string): JournalFact {
    let fact: JournalFact
    try {
      const text = this.readJournalText(file)
      const lines = text.split('\n')
      const last = lines.length - 1
      let present = false
      let torn = false
      lines.forEach((line, i) => {
        if (line === '') return
        try {
          const rec: unknown = JSON.parse(line)
          // A line that is valid JSON but not an object (`null`, a number) is not a record.
          if (typeof rec === 'object' && rec !== null) {
            const r = rec as { tool?: unknown; suggestion_id?: unknown }
            if (r.tool === 'update' && r.suggestion_id === opId) present = true
          }
        } catch {
          if (i === last) torn = true
        }
      })
      fact = { ok: true, present, torn, file }
    } catch (err) {
      fact =
        errnoOf(err) === 'ENOENT'
          ? { ok: true, present: false, torn: false, file }
          : { ok: false, errno: errnoOf(err), file }
    }
    return this.record('journalHasUpdate', `${file}\0${opId}`, fact)
  }

  /**
   * The journal's text, read as the reader's other files are: `O_NOFOLLOW` and
   * `O_NONBLOCK`, a regular file only, and at most the cap. Throws an error with
   * a `code` (`NOT_A_FILE`, `TOO_LARGE`, or the errno) for `journalHasUpdate` to report.
   */
  private readJournalText(file: string): string {
    const cap = this.options.journalCap ?? JOURNAL_READ_CAP
    const fd = fs.openSync(
      file,
      fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0) | (fs.constants.O_NONBLOCK ?? 0)
    )
    try {
      const st = fs.fstatSync(fd, { bigint: true })
      if (typeOf(st.mode) !== 'file')
        throw Object.assign(new Error('not a file'), { code: 'NOT_A_FILE' })
      if (st.size > BigInt(cap)) throw Object.assign(new Error('too large'), { code: 'TOO_LARGE' })
      const buf = Buffer.alloc(Number(st.size))
      let got = 0
      while (got < buf.length) {
        const n = fs.readSync(fd, buf, got, buf.length - got, got)
        if (n === 0) break
        got += n
      }
      return buf.subarray(0, got).toString('utf8')
    } finally {
      fs.closeSync(fd)
    }
  }

  /** `createManifestPort` accepts these entries (it refuses a pair that is not a plain object or not different). */
  portAccepts(target: ManifestPortTarget): PortFact {
    let fact: PortFact
    try {
      createManifestPort(target)
      fact = { ok: true }
    } catch {
      fact = { ok: false }
    }
    return this.record(
      'portAccepts',
      `${target.manifestPath}\0${target.manifestKey}\0${JSON.stringify([target.preEntry, target.postEntry])}`,
      fact
    )
  }
}
