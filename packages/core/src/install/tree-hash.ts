/**
 * SMI-6531 (A1 step 3a): the one tree-hash function (A1 plan §3.4), ported
 * from the SMI-6676 spike's `hash.mjs` `computeTreeHash`.
 *
 * sha256 over the entries of `pathTreeRecord`'s `lstat` walk, sorted by path
 * relative to the walk root. That walk types every entry without following a
 * link, but it reads by path, so a link raced in between an entry's `lstat`
 * and its read is read through (its docblock: TOCTOU-prone, closing only the
 * pre-aged-substitute class, ADR-166 D-0). Each entry contributes `rel`, type,
 * mode, size, and the content sha256 for a file or the link text for a
 * symlink, in that order. Directories are included,
 * without their size: a directory's `lstat` size is filesystem bookkeeping, and
 * on Linux one that once held many entries stays larger than a fresh copy with
 * the same contents, so a faithful copy would hash differently from its source
 * (owner decision 2026-10-21, SMI-6531 step 3). Symlinks are included without
 * their mode, for the same reason: on macOS a link's mode comes from the
 * creating process's umask (755 under 022, 700 under 077) and on Linux it is
 * always 777, and no OS uses it for access (owner decision 2026-10-21).
 * `preTree`, `postTree`, every sidecar `treeHash` and every park `guardHash`
 * must come from this function, or every guarded park returns
 * `kept/identity-changed`.
 *
 * Keys are relative to the walk root and no absolute path enters the hash, so
 * a tree hashes the same before and after a move (ADR-166 D-10), and the hash
 * of OP never equals the hash of OP/new (UD28).
 *
 * @module @skillsmith/core/install/tree-hash
 */
import crypto from 'node:crypto'

/** One entry of a tree record. `size` is the bigint `lstat` size. */
export type TreeRecordEntry =
  | { type: 'dir'; mode: number; size: bigint }
  | { type: 'file'; mode: number; size: bigint; contentHash: string }
  | { type: 'symlink'; mode: number; size: bigint; linkText: string }

/** Entries keyed by path relative to the walk root; the root itself is `''`. */
export type TreeRecord = Map<string, TreeRecordEntry>

/** The §3.4 tree hash of a record built by `pathTreeRecord`. */
export function computeTreeHash(record: ReadonlyMap<string, TreeRecordEntry>): string {
  const rels = [...record.keys()].sort()
  const hash = crypto.createHash('sha256')
  for (const rel of rels) {
    const e = record.get(rel) as TreeRecordEntry
    const contentPart = e.type === 'file' ? e.contentHash : e.type === 'symlink' ? e.linkText : ''
    const modePart = e.type === 'symlink' ? '' : String(e.mode)
    const sizePart = e.type === 'dir' ? '' : String(e.size)
    hash.update(`${rel}\u0000${e.type}\u0000${modePart}\u0000${sizePart}\u0000${contentPart}\n`)
  }
  return hash.digest('hex')
}
