#!/usr/bin/env node
// Independently started SQLite reader for ADR-170 § 2 arm 3 (v5.2 F2 / v5.3
// round-5 finding 1). Runs inside a THROWAWAY container from the ruflo image
// with the store volume mounted -- a different container and a different
// process from the server under test, on the same kernel, so it joins the
// normal WAL locking protocol rather than reading around it.
//
// Sequence, in this order and for the reasons § 2 gives:
//   1. record the source -wal size (a WAL-inclusive claim needs its denominator)
//   2. copy the MAIN FILE ALONE to a scratch path and open it read-only --
//      a canary absent here and present in step 4 is WAL-resident, which is what
//      the positive arm has to exercise. Taken BEFORE the backup so it cannot be
//      a post-checkpoint view.
//   3. open the source read-write (query_only=ON), BEGIN a read transaction,
//      read the canary inside it -- the transaction is what pins the snapshot
//   4. sqlite3_backup that transaction's snapshot to a new database
//      (better-sqlite3 db.backup()), COMMIT, close the source
//   5. open ONLY the backup read-only and evaluate the persisted predicate
//
// Raw sequential copies of memory.db/-wal/-shm are NOT used: § 2 rejects them.
//
// Usage:
//   node store-reader.mjs --db <path> --table memory_entries \
//     --ns <namespace> --key <key> [--key <key>...] --out <json>

import fs from 'node:fs'
import path from 'node:path'

const DB_MODULE =
  process.env.RUFLO_SQLITE_MODULE || '/opt/ruflo-seed/node_modules/better-sqlite3/lib/index.js'

const opt = {
  db: null,
  table: 'memory_entries',
  ns: null,
  keys: [],
  out: null,
  scratch: '/tmp/ruflo-reader',
}
const argv = process.argv.slice(2)
for (let i = 0; i < argv.length; i += 1) {
  if (argv[i] === '--db') opt.db = argv[(i += 1)]
  else if (argv[i] === '--table') opt.table = argv[(i += 1)]
  else if (argv[i] === '--ns') opt.ns = argv[(i += 1)]
  else if (argv[i] === '--key') opt.keys.push(argv[(i += 1)])
  else if (argv[i] === '--out') opt.out = argv[(i += 1)]
  else if (argv[i] === '--scratch') opt.scratch = argv[(i += 1)]
  else throw new Error(`unknown argument: ${argv[i]}`)
}

// The table name is interpolated into SQL, so it is constrained to a plain
// identifier here rather than trusted: the caller is the harness, but a
// harness that grew a configurable table name would otherwise grow an
// injection surface with it.
if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(opt.table)) throw new Error(`unsafe table name: ${opt.table}`)

const Database = (await import(DB_MODULE)).default
fs.mkdirSync(opt.scratch, { recursive: true })

const ev = {
  db: opt.db,
  table: opt.table,
  namespace: opt.ns,
  readerPid: process.pid,
  walSizeBytes: null,
  shmSizeBytes: null,
  mainFileOnly: {},
  snapshot: {},
  rows: {},
  errors: [],
}

// null, not -1: an absent -wal/-shm is a real state (checkpointed away), not
// an error, and a sentinel like -1 is indistinguishable from a genuine size
// once printed (L-17). Callers print 'absent' for null.
function sizeOf(p) {
  try {
    return fs.statSync(p).size
  } catch {
    return null
  }
}

// ---- step 1: the WAL denominator ------------------------------------------
ev.walSizeBytes = sizeOf(`${opt.db}-wal`)
ev.shmSizeBytes = sizeOf(`${opt.db}-shm`)
const srcStat = fs.statSync(opt.db)
ev.sourceDev = String(srcStat.dev)
ev.sourceIno = String(srcStat.ino)

// ---- step 2: the main-file-only control ------------------------------------
const mainOnly = path.join(opt.scratch, 'main-only.db')
for (const suffix of ['', '-wal', '-shm']) {
  const p = mainOnly + suffix
  if (fs.existsSync(p)) fs.unlinkSync(p)
}
fs.copyFileSync(opt.db, mainOnly)
try {
  const mo = new Database(mainOnly, { readonly: true, fileMustExist: true })
  for (const key of opt.keys) {
    const rows = mo
      .prepare(`SELECT id FROM ${opt.table} WHERE namespace = ? AND key = ?`)
      .all(opt.ns, key)
    ev.mainFileOnly[key] = { rowCount: rows.length, ids: rows.map((r) => r.id) }
  }
  ev.mainFileOnly._total = mo.prepare(`SELECT COUNT(*) AS c FROM ${opt.table}`).get().c
  mo.close()
} catch (e) {
  ev.errors.push(`main-file-only open failed: ${e.message}`)
}

// ---- steps 3 and 4: read transaction + online backup ------------------------
const backup = path.join(opt.scratch, 'snapshot.db')
for (const suffix of ['', '-wal', '-shm']) {
  const p = backup + suffix
  if (fs.existsSync(p)) fs.unlinkSync(p)
}
const src = new Database(opt.db, { timeout: 10000 })
src.pragma('query_only = ON')
ev.snapshot.journalMode = src.pragma('journal_mode', { simple: true })
src.prepare('BEGIN').run()
ev.snapshot.inTransaction = {}
for (const key of opt.keys) {
  const r = src
    .prepare(`SELECT id FROM ${opt.table} WHERE namespace = ? AND key = ?`)
    .all(opt.ns, key)
  ev.snapshot.inTransaction[key] = { rowCount: r.length, ids: r.map((x) => x.id) }
}
try {
  await src.backup(backup)
  ev.snapshot.backupOk = true
} catch (e) {
  ev.snapshot.backupOk = false
  ev.errors.push(`backup failed: ${e.message}`)
}
src.prepare('COMMIT').run()
src.close()

// ---- step 5: the persisted predicate, over the backup alone -----------------
if (ev.snapshot.backupOk) {
  const bk = new Database(backup, { readonly: true, fileMustExist: true })
  for (const key of opt.keys) {
    const rows = bk
      .prepare(
        `SELECT id, key, namespace, content, embedding, embedding_model, embedding_dimensions
         FROM ${opt.table} WHERE namespace = ? AND key = ?`
      )
      .all(opt.ns, key)
    let embedding = null
    let embeddingParseError = null
    if (rows.length === 1) {
      try {
        embedding = JSON.parse(rows[0].embedding)
      } catch (e) {
        embeddingParseError = e.message
      }
    }
    // Identity is NAMED, not merely keyed (round-4 finding 1): zero or several
    // rows fail, and the counts below expose a second row or a shadow carrier
    // that a (namespace,key) lookup alone would never see.
    const anyNs = bk.prepare(`SELECT id, namespace FROM ${opt.table} WHERE key = ?`).all(key)
    const sameContent =
      rows.length === 1
        ? bk
            .prepare(`SELECT id, key, namespace FROM ${opt.table} WHERE content = ?`)
            .all(rows[0].content)
        : []
    ev.rows[key] = {
      rowCount: rows.length,
      id: rows.length === 1 ? rows[0].id : null,
      content: rows.length === 1 ? rows[0].content : null,
      embeddingModel: rows.length === 1 ? rows[0].embedding_model : null,
      embeddingDimensions: rows.length === 1 ? rows[0].embedding_dimensions : null,
      embedding,
      embeddingParseError,
      rowsWithThisKeyAnyNamespace: anyNs.length,
      rowsWithThisContentAnyNamespace: sameContent.length,
      rowsWithThisContent: sameContent,
    }
  }
  ev.snapshot.tables = bk
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
    .all()
    .map((r) => r.name)
  ev.snapshot.totalRows = bk.prepare(`SELECT COUNT(*) AS c FROM ${opt.table}`).get().c
  bk.close()
}

fs.writeFileSync(opt.out, `${JSON.stringify(ev, null, 2)}\n`)
process.stdout.write(
  `store-reader ok db=${opt.db} wal=${ev.walSizeBytes === null ? 'absent' : ev.walSizeBytes} keys=${opt.keys.length}\n`
)
