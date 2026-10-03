#!/usr/bin/env node
/**
 * Canonical tree manifest generator for the ruflo seed (SMI-6744, ADR-170 § 7).
 *
 * ADR-170 § 7 requires acceptance to authenticate the INSTALLED TREE at
 * `/opt/ruflo-seed`, not the committed lockfile bytes (a tree built from an
 * accepted lockfile and then modified passes lockfile-digest equality). This
 * script is the "canonical tree manifest" § 7 specifies: it walks a covered
 * root, includes every directory, regular file and symlink by relative path,
 * and serializes them into one deterministic, versioned, byte-defined
 * output whose sha256 digest CI compares against an externally published
 * expected digest (never a digest read back from inside the image — § 7,
 * round-4 finding 2). This script has no npm dependencies: it is Node
 * builtins only, so it needs no `npm install` step of its own to run.
 *
 * Wire format (this script's own canonical choice — § 7 requires the
 * serialization be versioned and byte-defined, not any one particular byte
 * layout; this is "RUFLO_SEED_MANIFEST_V1"):
 *
 *   MANIFEST := LP(VERSION_BYTES) ROOT_MODE RECORD*   -- records sorted
 *                                                  ascending by unsigned byte
 *                                                  comparison of their
 *                                                  relative-path bytes
 *   ROOT_MODE := 4 ASCII bytes: the COVERED ROOT DIRECTORY's own
 *               (st_mode & 0o7777), same fixed-width zero-padded lowercase
 *               octal encoding as a RECORD's MODE field below. The root
 *               itself is never a RECORD (a RECORD always carries a
 *               relative path, and the root's own relative path is empty),
 *               so without this field a `chmod` of the covered root itself
 *               was invisible to the digest (governance review L-20a,
 *               2026-09-23) — this field is what makes it visible. Emitted
 *               once, immediately after VERSION_BYTES, before any RECORD.
 *   RECORD   := LP(PATH_BYTES) TYPE MODE PAYLOAD
 *   TYPE     := 1 byte: 'd' (0x64) directory | 'f' (0x66) regular file
 *                       | 'l' (0x6c) symlink
 *   MODE     := 4 ASCII bytes: (st_mode & 0o7777) as fixed-width, zero-
 *               padded lowercase octal (e.g. "0644", "4755") — includes
 *               setuid/setgid/sticky, per § 7's "full st_mode & 07777".
 *               EXCEPTION: for a symlink record (TYPE='l') this field is
 *               NEVER the filesystem's own reported mode — symlink
 *               permission bits are platform-dependent (measured: Linux
 *               always reports 0777 for every symlink, unconditionally;
 *               macOS reports whatever mode the symlink was created with,
 *               e.g. 0755 by default, and macOS-only `fs.lchmodSync` can
 *               change it further) — so a manifest generated from a
 *               `docker cp`-extracted tree on macOS would otherwise digest
 *               differently from the same tree read natively on Linux, for
 *               no content difference at all (governance review L-20c,
 *               2026-09-23). This field is instead always the fixed
 *               constant SYMLINK_MODE_MASK = "0777" below, matching what
 *               every acceptance run already observes in practice (the
 *               generator only ever runs against a Linux-mounted tree, via
 *               `docker cp`/`docker exec`), so masking is a no-op against
 *               the real served tree and only removes the macOS-vs-Linux
 *               divergence for a host-side dry run.
 *   PAYLOAD  := directory: (empty)
 *               regular file: SIZE(8-byte big-endian unsigned) SHA256HEX
 *                              (64 ASCII bytes, lowercase hex)
 *               symlink: LP(TARGET_BYTES)  -- raw target bytes, no referent
 *                              check; a dangling symlink is accepted (§ 7)
 *   LP(x)    := UInt32BE(byte length of x) followed by the raw bytes of x
 *
 * Relative paths and symlink targets are filesystem BYTE STRINGS, read via
 * Node's `encoding: 'buffer'` APIs throughout and never locale-decoded, per
 * § 7's "filesystem byte strings, not locale-decoded text". Path segments
 * are joined with a single 0x2F ('/') byte. No newline, locale, JSON-object
 * ordering or platform-default collation participates anywhere in this
 * format, per § 7.
 *
 * Refusals (§ 7, retro F5; § 7, round-5 finding 4) — exit 3 (see "Exit
 * codes" below), no manifest is printed, and the offending path is named on
 * stderr:
 *   - any covered-root entry that is not a directory, regular file or
 *     symlink (FIFO, socket, block/character device, ...) — path and type
 *   - any regular file whose st_nlink is not exactly 1 (two same-content
 *     files hard-linked to one inode would otherwise compare equal, since
 *     this serialization has no inode-identity field) — path, link count
 *     and type
 *
 * Exit codes:
 *   0   success
 *   2   usage error (wrong argument count) — no filesystem access attempted
 *   3   ManifestRefusal (see "Refusals" above) — a deliberate, named
 *       decision to produce no manifest, distinct from a crash so the two
 *       are never conflated by status code alone (governance review L-20b,
 *       2026-09-23; previously refusal and an uncaught exception both
 *       exited 1 and were indistinguishable by status)
 *   1   anything else: an uncaught exception (a genuine bug, an unreadable
 *       root, etc.) — Node's own default exit code, never assigned here
 *
 * Usage: node manifest.mjs <covered-root> [--digest]
 *   (no flag)  writes the serialized manifest bytes to stdout, and its
 *              lowercase-hex sha256 digest, newline-terminated, to stderr.
 *   --digest   writes ONLY the lowercase-hex sha256 digest, newline-
 *              terminated, to stdout; the manifest bytes are not printed.
 */

import { readdirSync, lstatSync, readlinkSync, readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { resolve } from 'node:path'

const VERSION_BYTES = Buffer.from('RUFLO_SEED_MANIFEST_V1', 'ascii')
const SLASH = Buffer.from('/', 'ascii')
// L-20c: every symlink record's MODE field is masked to this fixed constant
// instead of its own lstat-reported mode — see the header's MODE definition
// for why (Linux always reports 0777 for a symlink; macOS does not).
const SYMLINK_MODE_MASK = Buffer.from('0777', 'ascii')

/** Length-prefix a byte buffer: 4-byte big-endian length, then the bytes. */
function lp(buf) {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(buf.length, 0)
  return Buffer.concat([len, buf])
}

/**
 * Walk `root` (a Buffer, absolute path) and return one record per
 * directory, regular file and symlink found under it (root itself is not a
 * record — only its contents). Refuses (throws ManifestRefusal) on any
 * other entry type, or any regular file whose nlink !== 1.
 */
class ManifestRefusal extends Error {}

function walk(rootBuf) {
  const records = []

  function recurse(absBuf, relBuf) {
    const entries = readdirSync(absBuf, { withFileTypes: true, encoding: 'buffer' })
    for (const entry of entries) {
      const entryAbsBuf = Buffer.concat([absBuf, SLASH, entry.name])
      const entryRelBuf =
        relBuf.length === 0 ? entry.name : Buffer.concat([relBuf, SLASH, entry.name])
      const st = lstatSync(entryAbsBuf)
      const modeField = Buffer.from((st.mode & 0o7777).toString(8).padStart(4, '0'), 'ascii')
      const displayPath = entryRelBuf.toString('utf8')

      if (st.isDirectory()) {
        records.push({ pathBuf: entryRelBuf, type: 'd', modeField, payload: Buffer.alloc(0) })
        recurse(entryAbsBuf, entryRelBuf)
      } else if (st.isSymbolicLink()) {
        const targetBuf = readlinkSync(entryAbsBuf, 'buffer')
        records.push({
          pathBuf: entryRelBuf,
          type: 'l',
          modeField: SYMLINK_MODE_MASK,
          payload: lp(targetBuf),
        })
      } else if (st.isFile()) {
        if (st.nlink !== 1) {
          throw new ManifestRefusal(
            `refused: regular file has st_nlink=${st.nlink} (expected 1), type=regular file, path=${displayPath}`
          )
        }
        const contents = readFileSync(entryAbsBuf)
        const size = Buffer.alloc(8)
        size.writeBigUInt64BE(BigInt(contents.length), 0)
        const sha256hex = Buffer.from(createHash('sha256').update(contents).digest('hex'), 'ascii')
        records.push({
          pathBuf: entryRelBuf,
          type: 'f',
          modeField,
          payload: Buffer.concat([size, sha256hex]),
        })
      } else {
        const kind = st.isFIFO()
          ? 'FIFO'
          : st.isSocket()
            ? 'socket'
            : st.isBlockDevice()
              ? 'block device'
              : st.isCharacterDevice()
                ? 'character device'
                : 'unknown special file'
        throw new ManifestRefusal(`refused: unsupported entry type=${kind}, path=${displayPath}`)
      }
    }
  }

  recurse(rootBuf, Buffer.alloc(0))
  return records
}

/** Unsigned lexicographic comparison of relative-path bytes (§ 7). */
function sortRecords(records) {
  return records.slice().sort((a, b) => Buffer.compare(a.pathBuf, b.pathBuf))
}

/**
 * L-20a: `rootModeField` is the covered root DIRECTORY's own mode (see the
 * header's ROOT_MODE definition) — never a RECORD, since the root has no
 * relative path of its own; emitted once, right after VERSION_BYTES.
 */
function serialize(records, rootModeField) {
  const parts = [lp(VERSION_BYTES), rootModeField]
  for (const r of sortRecords(records)) {
    parts.push(lp(r.pathBuf))
    parts.push(Buffer.from(r.type, 'ascii'))
    parts.push(r.modeField)
    parts.push(r.payload)
  }
  return Buffer.concat(parts)
}

function main() {
  const args = process.argv.slice(2)
  const digestOnly = args.includes('--digest')
  const positional = args.filter((a) => a !== '--digest')
  if (positional.length !== 1) {
    process.stderr.write('usage: node manifest.mjs <covered-root> [--digest]\n')
    process.exit(2)
  }
  const rootBuf = Buffer.from(resolve(positional[0]))

  let records
  let rootModeField
  try {
    // L-20a: the covered root's OWN mode, read before walking its contents —
    // an lstat failure here (e.g. the root itself doesn't exist) is a normal
    // uncaught exception, exit 1, exactly as it always was (readdirSync
    // inside walk() would have thrown the same class of error previously).
    const rootStat = lstatSync(rootBuf)
    rootModeField = Buffer.from((rootStat.mode & 0o7777).toString(8).padStart(4, '0'), 'ascii')
    records = walk(rootBuf)
  } catch (err) {
    if (err instanceof ManifestRefusal) {
      process.stderr.write(`[ruflo-seed manifest] ${err.message}\n`)
      process.exit(3) // L-20b: distinguish a deliberate refusal from a crash (exit 1)
    }
    throw err
  }

  const manifest = serialize(records, rootModeField)
  const digestHex = createHash('sha256').update(manifest).digest('hex')

  if (digestOnly) {
    process.stdout.write(`${digestHex}\n`)
  } else {
    process.stdout.write(manifest)
    process.stderr.write(`${digestHex}\n`)
  }
}

main()
