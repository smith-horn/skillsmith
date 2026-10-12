// SMI-6715: every full C4 trace is kept as a content-addressed Brotli side file,
// so any verdict -- including a matched one, which compactTrace summarises
// without the full trace -- can be re-audited from the exact bytes.
//
//   <dir>/<sha256>.json.br   where sha256 = sha256(JSON.stringify(trace))
//
// The address is the same sha256 compactTrace reports (same JSON.stringify
// bytes), so a record's traceCompact.sha256 names its artifact directly.
//
// Fail-closed throughout: a write is not reported until the file has been READ
// BACK, decompressed and re-hashed; an existing file is reused only after the
// same verification; a corrupt existing file is refused, never silently
// replaced (that would hide the corruption); a read throws on absence, on a
// decompression error and on a hash mismatch.

import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import zlib from 'node:zlib'

// Owner decision: measured on a 1630-dir C4 trace (3.33 MB JSON), q5 = ~141 KB in ~11 ms vs q11 = ~87 KB in ~4.5 s.
export const TRACE_BROTLI_QUALITY = 5
const SHA_RE = /^[0-9a-f]{64}$/
const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex')

function requireDir(dir, who) {
  if (typeof dir !== 'string' || !path.isAbsolute(dir)) {
    throw new TypeError(`${who}: dir must be an absolute path string, got ${String(dir)}`)
  }
  return path.resolve(dir)
}

const artifactPath = (dir, sha) => path.join(dir, `${sha}.json.br`)

/**
 * Decompresses and verifies one artifact file against its address.
 * @returns {{json: string, bytes: number}}
 */
function verifyFile(file, sha) {
  const br = fs.readFileSync(file) // ENOENT propagates with its code
  let raw
  try {
    raw = zlib.brotliDecompressSync(br)
  } catch (err) {
    throw new Error(`trace artifact ${file} does not decompress (${err.message}); refusing it`, {
      cause: err,
    })
  }
  const got = sha256(raw)
  if (got !== sha) {
    throw new Error(`trace artifact ${file} hashes to ${got}, not its address ${sha}; refusing it`)
  }
  return { json: raw.toString('utf8'), bytes: br.length }
}

/**
 * Writes `trace` as <dir>/<sha256>.json.br, atomically (temp name in the same
 * dir, fsync, rename), then reads it back and verifies it before returning.
 *
 * @param {unknown[]} trace
 * @param {{dir: string, _faultAfterRename?: (finalPath: string) => void}} options
 *   `_faultAfterRename` is a TEST SEAM only: called after the rename and before
 *   the read-back, so a test can corrupt the file and prove the read-back runs.
 * @returns {{sha256: string, path: string, bytes: number}} path is relative to
 *   the parent of `dir` (e.g. "traces/<sha>.json.br" when dir ends in /traces).
 */
export function writeTraceArtifact(trace, options = {}) {
  const dir = requireDir(options?.dir, 'writeTraceArtifact')
  const fault = options?._faultAfterRename
  // No guard of our own: JSON.stringify throws a TypeError for a cyclic or
  // BigInt-bearing trace, and for a trace with no JSON form (undefined) it
  // returns undefined, which Buffer.from rejects with a TypeError -- both before
  // anything touches the disk.
  const json = JSON.stringify(trace)
  const raw = Buffer.from(json, 'utf8')
  const sha = sha256(raw)
  const final = artifactPath(dir, sha)
  const ref = (bytes) => ({ sha256: sha, path: path.relative(path.dirname(dir), final), bytes })

  fs.mkdirSync(dir, { recursive: true })
  if (fs.existsSync(final)) {
    // Content-addressed: same address, same content -- but only after proving it.
    return ref(verifyFile(final, sha).bytes)
  }

  const br = zlib.brotliCompressSync(raw, {
    params: { [zlib.constants.BROTLI_PARAM_QUALITY]: TRACE_BROTLI_QUALITY },
  })
  const tmp = path.join(dir, `.${sha}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`)
  let fd = null
  try {
    fd = fs.openSync(tmp, 'wx', 0o644)
    let off = 0
    while (off < br.length) off += fs.writeSync(fd, br, off, br.length - off)
    fs.fsyncSync(fd)
    fs.closeSync(fd)
    fd = null
    fs.renameSync(tmp, final)
  } catch (err) {
    if (fd !== null) {
      try {
        fs.closeSync(fd)
      } catch {
        // the original error is the one worth reporting
      }
    }
    try {
      fs.rmSync(tmp, { force: true })
    } catch {
      // best effort; the original error is the one worth reporting
    }
    throw err
  }
  // Best-effort directory fsync so the rename itself is durable. Not every
  // filesystem supports fsync on a directory fd; the read-back below is the
  // correctness check, this is only durability.
  try {
    const dfd = fs.openSync(dir, 'r')
    try {
      fs.fsyncSync(dfd)
    } finally {
      fs.closeSync(dfd)
    }
  } catch {
    // not a correctness failure; see above
  }

  if (typeof fault === 'function') fault(final)
  const back = verifyFile(final, sha)
  if (back.json !== json) {
    throw new Error(`trace artifact ${final} read back different bytes than were written`)
  }
  return ref(back.bytes)
}

/**
 * For auditors: decompresses <dir>/<sha256>.json.br, re-hashes it, and throws
 * on absence (code ENOENT), on a decompression error, or on a hash mismatch.
 * @returns {{sha256: string, json: string, trace: unknown, bytes: number}}
 */
export function readTraceArtifact(sha, options = {}) {
  if (typeof sha !== 'string' || !SHA_RE.test(sha)) {
    throw new TypeError(
      `readTraceArtifact: address must be 64 lowercase hex characters, got ${String(sha)}`
    )
  }
  const dir = requireDir(options?.dir, 'readTraceArtifact')
  const { json, bytes } = verifyFile(artifactPath(dir, sha), sha)
  return { sha256: sha, json, trace: JSON.parse(json), bytes }
}

/**
 * Throws unless a compactTrace() result and a writeTraceArtifact() ref name the
 * same trace bytes. A malformed compact (no sha256) never matches.
 */
export function assertCompactMatchesArtifact(compact, artifactRef) {
  const c = compact?.sha256
  const a = artifactRef?.sha256
  if (typeof c !== 'string' || !SHA_RE.test(c)) {
    throw new Error(`compact trace has no valid sha256 (malformed: ${compact?.malformed === true})`)
  }
  // No separate check of the ref's own sha256: if the compact's is valid, any
  // ref value that is not the same string already fails the comparison below.
  if (c !== a) throw new Error(`compact trace sha256 ${c} does not match trace artifact ${a}`)
}
