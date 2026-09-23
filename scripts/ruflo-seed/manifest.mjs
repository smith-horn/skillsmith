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
 *   MANIFEST := LP(VERSION_BYTES) RECORD*      -- records sorted ascending
 *                                                  by unsigned byte comparison
 *                                                  of their relative-path bytes
 *   RECORD   := LP(PATH_BYTES) TYPE MODE PAYLOAD
 *   TYPE     := 1 byte: 'd' (0x64) directory | 'f' (0x66) regular file
 *                       | 'l' (0x6c) symlink
 *   MODE     := 4 ASCII bytes: (st_mode & 0o7777) as fixed-width, zero-
 *               padded lowercase octal (e.g. "0644", "4755") — includes
 *               setuid/setgid/sticky, per § 7's "full st_mode & 07777"
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
 * Refusals (§ 7, retro F5; § 7, round-5 finding 4) — non-zero exit, no
 * manifest is printed, and the offending path is named on stderr:
 *   - any covered-root entry that is not a directory, regular file or
 *     symlink (FIFO, socket, block/character device, ...) — path and type
 *   - any regular file whose st_nlink is not exactly 1 (two same-content
 *     files hard-linked to one inode would otherwise compare equal, since
 *     this serialization has no inode-identity field) — path, link count
 *     and type
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
          modeField,
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

function serialize(records) {
  const parts = [lp(VERSION_BYTES)]
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
  try {
    records = walk(rootBuf)
  } catch (err) {
    if (err instanceof ManifestRefusal) {
      process.stderr.write(`[ruflo-seed manifest] ${err.message}\n`)
      process.exit(1)
    }
    throw err
  }

  const manifest = serialize(records)
  const digestHex = createHash('sha256').update(manifest).digest('hex')

  if (digestOnly) {
    process.stdout.write(`${digestHex}\n`)
  } else {
    process.stdout.write(manifest)
    process.stderr.write(`${digestHex}\n`)
  }
}

main()
