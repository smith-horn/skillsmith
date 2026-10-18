/**
 * SMI-6531 (A1 step 3a): the one tree-hash function (A1 plan §3.4), ported
 * from the SMI-6676 spike's `hash.mjs` `computeTreeHash`.
 *
 * sha256 over the entries of an `lstat` walk that never follows links, sorted
 * by path relative to the walk root: `rel`, type, mode, size, and the content
 * sha256 for a file or the link text for a symlink. Directories are included.
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
    hash.update(`${rel}\u0000${e.type}\u0000${e.mode}\u0000${e.size}\u0000${contentPart}\n`)
  }
  return hash.digest('hex')
}
