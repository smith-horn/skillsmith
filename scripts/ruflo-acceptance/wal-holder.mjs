#!/usr/bin/env node
// Known-positive control for store-reader.mjs (ADR-170 § 2, v5.3 round-5
// finding 1): a writer that commits a row and then HOLDS its connection open,
// so the committed frame stays in the -wal and is never checkpointed.
//
// This exists because the served write path on this service checkpoints
// promptly: every canary the acceptance run wrote was already in the main file
// by the time any independent reader could look, so the honest run never
// exercised the WAL-resident case. An instrument whose WAL-inclusive claim has
// never been shown to distinguish WAL-resident from checkpointed state is not
// evidence about either -- this control supplies the positive half, on a
// scratch database, with a known-negative (a key never written) beside it.
//
// Usage: node wal-holder.mjs --db <scratch.db> --ns <ns> --key <k> \
//          --ready <file> --go <file> [--hold-ms N]

import fs from 'node:fs'
import path from 'node:path'

const DB_MODULE =
  process.env.RUFLO_SQLITE_MODULE || '/opt/ruflo-seed/node_modules/better-sqlite3/lib/index.js'
const opt = { db: null, ns: 'wal-control', key: null, ready: null, go: null, holdMs: 120000 }
const argv = process.argv.slice(2)
for (let i = 0; i < argv.length; i += 1) {
  if (argv[i] === '--db') opt.db = argv[(i += 1)]
  else if (argv[i] === '--ns') opt.ns = argv[(i += 1)]
  else if (argv[i] === '--key') opt.key = argv[(i += 1)]
  else if (argv[i] === '--ready') opt.ready = argv[(i += 1)]
  else if (argv[i] === '--go') opt.go = argv[(i += 1)]
  else if (argv[i] === '--hold-ms') opt.holdMs = Number(argv[(i += 1)])
  else throw new Error(`unknown argument: ${argv[i]}`)
}

const Database = (await import(DB_MODULE)).default
fs.mkdirSync(path.dirname(opt.db), { recursive: true })
for (const s of ['', '-wal', '-shm']) {
  if (fs.existsSync(opt.db + s)) fs.unlinkSync(opt.db + s)
}

// Phase 1: build the baseline and checkpoint it into the main file, then close,
// so anything still in the -wal afterwards was written by phase 2 alone.
{
  const seed = new Database(opt.db)
  seed.pragma('journal_mode = WAL')
  seed.exec(`CREATE TABLE memory_entries (
    id TEXT PRIMARY KEY, key TEXT NOT NULL, namespace TEXT, content TEXT NOT NULL,
    embedding TEXT, embedding_model TEXT, embedding_dimensions INTEGER,
    status TEXT DEFAULT 'active', UNIQUE(namespace, key))`)
  seed
    .prepare(
      'INSERT INTO memory_entries (id,key,namespace,content,embedding,embedding_model,embedding_dimensions) VALUES (?,?,?,?,?,?,?)'
    )
    .run('baseline', 'baseline-key', opt.ns, 'baseline row', JSON.stringify([0, 1]), 'control', 2)
  seed.pragma('wal_checkpoint(TRUNCATE)')
  seed.close()
}

// Phase 2: commit the canary and hold the connection. No checkpoint runs while
// this process lives, so the frame stays in the -wal.
const db = new Database(opt.db)
db.pragma('journal_mode = WAL')
db.prepare(
  'INSERT INTO memory_entries (id,key,namespace,content,embedding,embedding_model,embedding_dimensions) VALUES (?,?,?,?,?,?,?)'
).run(`wal_${Date.now()}`, opt.key, opt.ns, opt.key, JSON.stringify([0.5, -0.5]), 'control', 2)
fs.writeFileSync(
  opt.ready,
  `${JSON.stringify({ walBytes: fs.statSync(`${opt.db}-wal`).size, pid: process.pid })}\n`
)

const t0 = Date.now()
const iv = setInterval(() => {
  if (fs.existsSync(opt.go) || Date.now() - t0 > opt.holdMs) {
    clearInterval(iv)
    db.close()
    process.stdout.write(`wal-holder released after ${Date.now() - t0}ms\n`)
    process.exit(0)
  }
}, 50)
