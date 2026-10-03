#!/usr/bin/env node
// The § 6 consolidation control: prepare paired scratch copies, seed one of
// them with a scratch-only row carrying a random value, run the SERVED
// consolidation pass on each, and inspect what each produced.
//
// The served pass is `runDistillation` from
// @claude-flow/cli/dist/src/services/memory-distillation.js -- the same
// function the `consolidate` daemon worker calls (worker-daemon.js:1547). It is
// invoked here with an explicit dbPath so it runs on a scratch copy and never
// on the live volume, which § 6 requires.
//
// `--stub` is the required failing mutation: a command that OPENS the correct
// database (so any inode check passes) and returns counters read from a
// fixture, without reading the seeded row. The paired control must fail it.
//
// Subcommands:
//   --prepare --src <db> --dst <db> [--pad N]
//   --seed-row --db <db> --ns <ns> --key <k> --value <v>
//   --run --db <db> --out <json> [--stub --fixture <json>] [--pid-file <f>]
//   --inspect --db <db> --token <t> --out <json>

import fs from 'node:fs'
import path from 'node:path'
import { randomBytes } from 'node:crypto'

const CLI = '/opt/ruflo-seed/node_modules/@claude-flow/cli/dist/src'
const T =
  process.env.RUFLO_TRANSFORMERS_DIR || '/opt/ruflo-seed/node_modules/@huggingface/transformers'
const DB_MODULE =
  process.env.RUFLO_SQLITE_MODULE || '/opt/ruflo-seed/node_modules/better-sqlite3/lib/index.js'
const DERIVED_TABLES = ['episodes', 'reasoning_patterns', 'pattern_embeddings', 'causal_edges']

const opt = {
  cmd: null,
  src: null,
  dst: null,
  db: null,
  ns: null,
  key: null,
  value: null,
  out: null,
  token: null,
  fixture: null,
  pad: 0,
  stub: false,
  pidFile: null,
}
const argv = process.argv.slice(2)
for (let i = 0; i < argv.length; i += 1) {
  const a = argv[i]
  if (a === '--prepare' || a === '--seed-row' || a === '--run' || a === '--inspect')
    opt.cmd = a.slice(2)
  else if (a === '--stub') opt.stub = true
  else if (a === '--src') opt.src = argv[(i += 1)]
  else if (a === '--dst') opt.dst = argv[(i += 1)]
  else if (a === '--db') opt.db = argv[(i += 1)]
  else if (a === '--ns') opt.ns = argv[(i += 1)]
  else if (a === '--key') opt.key = argv[(i += 1)]
  else if (a === '--value') opt.value = argv[(i += 1)]
  else if (a === '--out') opt.out = argv[(i += 1)]
  else if (a === '--token') opt.token = argv[(i += 1)]
  else if (a === '--fixture') opt.fixture = argv[(i += 1)]
  else if (a === '--pad') opt.pad = Number(argv[(i += 1)])
  else if (a === '--pid-file') opt.pidFile = argv[(i += 1)]
  else throw new Error(`unknown argument: ${a}`)
}

const Database = (await import(DB_MODULE)).default
const write = (o) => fs.writeFileSync(opt.out, `${JSON.stringify(o, null, 2)}\n`)
const inoOf = (p) => {
  const s = fs.statSync(p)
  return { dev: String(s.dev), ino: String(s.ino), size: s.size, mtimeMs: s.mtimeMs }
}

let extract = null
async function embed(text) {
  if (!extract) {
    const { pipeline, env } = await import(`${T}/dist/transformers.node.mjs`)
    env.allowRemoteModels = false
    env.allowLocalModels = true
    env.cacheDir = `${T}/.cache`
    env.localModelPath = `${T}/.cache`
    extract = await pipeline('feature-extraction', 'Xenova/all-MiniLM-L6-v2', { dtype: 'fp32' })
  }
  const out = await extract(text, { pooling: 'mean', normalize: true })
  return Array.from(out.data)
}

// ---- prepare ---------------------------------------------------------------
// Both members of the pair come from ONE baseline, taken through SQLite's own
// online-backup API so the copy is consistent with the WAL rather than a
// sequential file copy. Padding rows exist so the served pass takes long enough
// to be observable by an external /proc/*/fd poller; they carry synthetic unit
// vectors, which is sound on a scratch copy and is recorded as synthetic.
if (opt.cmd === 'prepare') {
  fs.mkdirSync(path.dirname(opt.dst), { recursive: true })
  for (const s of ['', '-wal', '-shm']) if (fs.existsSync(opt.dst + s)) fs.unlinkSync(opt.dst + s)
  const src = new Database(opt.src, { timeout: 10000 })
  // query_only, not a :ro mount: the backup must join the normal WAL locking
  // protocol, which creates the -shm when it is absent.
  src.pragma('query_only = ON')
  await src.backup(opt.dst)
  src.close()
  const dst = new Database(opt.dst)
  const ins = dst.prepare(`INSERT OR REPLACE INTO memory_entries
    (id,key,namespace,content,type,embedding,embedding_dimensions,embedding_model,tags,metadata,provenance_type,created_at,updated_at,expires_at,status)
    VALUES (?,?,?,'semantic',?,?,?,?,?,?,?,?,?,?,'active')`)
  const txn = dst.transaction(() => {
    for (let i = 0; i < opt.pad; i += 1) {
      const v = new Array(384)
      let n = 0
      for (let j = 0; j < 384; j += 1) {
        v[j] = Math.sin((i + 1) * (j + 1) * 0.0137)
        n += v[j] * v[j]
      }
      const norm = Math.sqrt(n) || 1
      const now = Date.now()
      ins.run(
        `pad_${i}`,
        `pad-${i}`,
        'a14-pad',
        `padding row ${i} ${randomBytes(4).toString('hex')}`,
        JSON.stringify(v.map((x) => x / norm)),
        384,
        'synthetic-pad',
        null,
        '{}',
        'unknown',
        now,
        now,
        null
      )
    }
  })
  if (opt.pad > 0) txn()
  const counts = {}
  for (const t of DERIVED_TABLES) {
    try {
      counts[t] = dst.prepare(`SELECT COUNT(*) AS c FROM ${t}`).get().c
    } catch (e) {
      counts[t] = `ERR:${e.message}`
    }
  }
  counts.memory_entries = dst.prepare('SELECT COUNT(*) AS c FROM memory_entries').get().c
  dst.close()
  process.stdout.write(
    `prepared ${opt.dst} pad=${opt.pad} baseline=${JSON.stringify(counts)} inode=${JSON.stringify(inoOf(opt.dst))}\n`
  )
}

// ---- seed-row --------------------------------------------------------------
if (opt.cmd === 'seed-row') {
  const v = await embed(opt.value)
  const db = new Database(opt.db)
  const now = Date.now()
  db.prepare(
    `INSERT OR REPLACE INTO memory_entries
    (id,key,namespace,content,type,embedding,embedding_dimensions,embedding_model,tags,metadata,provenance_type,created_at,updated_at,expires_at,status)
    VALUES (?,?,?,?,'semantic',?,?,?,?,?,?,?,?,?,'active')`
  ).run(
    `seed_${now}`,
    opt.key,
    opt.ns,
    opt.value,
    JSON.stringify(v),
    384,
    'Xenova/all-MiniLM-L6-v2',
    null,
    '{}',
    'unknown',
    now,
    now,
    null
  )
  db.close()
  process.stdout.write(`seeded ns=${opt.ns} key=${opt.key} into ${opt.db}\n`)
}

// ---- run -------------------------------------------------------------------
if (opt.cmd === 'run') {
  if (opt.pidFile) fs.writeFileSync(opt.pidFile, String(process.pid))
  const before = inoOf(opt.db)
  let report
  let mode
  if (opt.stub) {
    mode = 'stub (fixture-derived counters, opens the DB and reads nothing)'
    // Opens the correct database, so an inode check passes, then answers from
    // the fixture. This is the mutation § 6 names.
    const db = new Database(opt.db, { timeout: 3000 })
    db.prepare('SELECT COUNT(*) AS c FROM sqlite_master').get()
    await new Promise((r) => setTimeout(r, 120))
    db.close()
    report = JSON.parse(fs.readFileSync(opt.fixture, 'utf8'))
  } else {
    mode = 'served runDistillation (memory-distillation.js)'
    const { runDistillation } = await import(`${CLI}/services/memory-distillation.js`)
    report = await runDistillation({ dbPath: opt.db, batchSize: 200, dedupDistance: 0.2 })
  }
  const after = inoOf(opt.db)
  write({
    mode,
    db: opt.db,
    selfReportedInodeBefore: before,
    selfReportedInodeAfter: after,
    report,
  })
  process.stdout.write(
    `run mode=${mode} skipped=${report.skipped ?? 'none'} patterns=${report.patterns ?? 'n/a'} processed=${report.processed ?? 'n/a'}\n`
  )
}

// ---- inspect ---------------------------------------------------------------
if (opt.cmd === 'inspect') {
  const db = new Database(opt.db, { readonly: true, fileMustExist: true })
  const res = { db: opt.db, token: opt.token, counts: {}, hits: {}, inode: inoOf(opt.db) }
  for (const t of DERIVED_TABLES) {
    try {
      res.counts[t] = db.prepare(`SELECT COUNT(*) AS c FROM ${t}`).get().c
    } catch (e) {
      res.counts[t] = `ERR:${e.message}`
    }
  }
  // "derived output containing the row's random value" is the binding between
  // operation and input: a fixture cannot contain a token minted after it.
  for (const t of ['episodes', 'reasoning_patterns']) {
    try {
      const cols = db
        .prepare(`PRAGMA table_info(${t})`)
        .all()
        .map((c) => c.name)
      const textCols = cols.filter((c) => !/^id$|_at$|count|rate|reward|embedding/i.test(c))
      const clause = textCols.map((c) => `CAST(${c} AS TEXT) LIKE ?`).join(' OR ')
      const params = textCols.map(() => `%${opt.token}%`)
      res.hits[t] = clause
        ? db.prepare(`SELECT COUNT(*) AS c FROM ${t} WHERE ${clause}`).get(...params).c
        : 0
      res.hits[`${t}:columns`] = textCols
    } catch (e) {
      res.hits[t] = `ERR:${e.message}`
    }
  }
  db.close()
  write(res)
  process.stdout.write(
    `inspect ${opt.db} token=${opt.token} counts=${JSON.stringify(res.counts)} hits=${JSON.stringify(res.hits.episodes)}/${JSON.stringify(res.hits.reasoning_patterns)}\n`
  )
}
