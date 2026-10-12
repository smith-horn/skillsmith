#!/usr/bin/env node
// Mutant MCP servers for ADR-170 § 2's required failing mutations.
//
// These are NOT edits of the served tree and never run in skillsmith-ruflo-1.
// Each runs in a THROWAWAY container from the same ruflo image, with a scratch
// volume as cwd, and writes an agentdb-shaped `memory_entries` table with
// exactly the columns memory-bridge.js's own ensureBridgeSchema() creates. The
// harness then points its ordinary reader and its ordinary predicates at that
// scratch store, so what is under test is whether the PREDICATES kill the
// mutation -- which is the question § 2's mutation list actually asks.
//
// Modes:
//   honest      does everything right. The KILLED control: if this does not
//               pass, a mutant's failure says nothing about the mutation.
//   precomputed answers from a baked-in table of published canaries without
//               running inference; anything it was not told about gets a
//               constant. Blinding is what must catch it.
//   frozen      one vector for every input. The freshness arm must catch it.
//   split       returns the honest vector, persists a hash vector. Only the
//               persisted arm catches it.
//   shadow      persists the honest row AND a second row carrying the same
//               content, which its search returns. Only the named-row identity
//               and the fresh-process retrieval catch it.
//   fabricate   replies honestly about the canary while the persisted row holds
//               different content and a different vector. Only the
//               independently started reader catches it.
//   altimpl     loads the manifested session, then answers from ANOTHER
//               deterministic implementation. Input-sensitive, so the freshness
//               arm does not catch it; only comparison against the independent
//               recomputation does. It also writes plausible run events, which
//               no predicate reads.
//
// Usage (inside the container):
//   node stub-server.mjs --mode <m> --db <path> [--precomputed <json>]

import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'

const T =
  process.env.RUFLO_TRANSFORMERS_DIR || '/opt/ruflo-seed/node_modules/@huggingface/transformers'
const DB_MODULE =
  process.env.RUFLO_SQLITE_MODULE || '/opt/ruflo-seed/node_modules/better-sqlite3/lib/index.js'
const MODEL_ID = 'Xenova/all-MiniLM-L6-v2'

const opt = { mode: 'honest', db: null, precomputed: null }
const argv = process.argv.slice(2)
for (let i = 0; i < argv.length; i += 1) {
  if (argv[i] === '--mode') opt.mode = argv[(i += 1)]
  else if (argv[i] === '--db') opt.db = argv[(i += 1)]
  else if (argv[i] === '--precomputed') opt.precomputed = argv[(i += 1)]
}

const Database = (await import(DB_MODULE)).default
fs.mkdirSync(path.dirname(opt.db), { recursive: true })
const db = new Database(opt.db)
db.pragma('journal_mode = WAL')
// Byte-for-byte the columns memory-bridge.js:652 creates, so the harness's
// reader and predicates run unmodified against this store.
db.exec(`CREATE TABLE IF NOT EXISTS memory_entries (
  id TEXT PRIMARY KEY, key TEXT NOT NULL, namespace TEXT DEFAULT 'default',
  content TEXT NOT NULL, type TEXT DEFAULT 'semantic', embedding TEXT,
  embedding_model TEXT DEFAULT 'local', embedding_dimensions INTEGER,
  tags TEXT, metadata TEXT, owner_id TEXT,
  created_at INTEGER NOT NULL DEFAULT (strftime('%s','now')*1000),
  updated_at INTEGER NOT NULL DEFAULT (strftime('%s','now')*1000),
  expires_at INTEGER, last_accessed_at INTEGER, access_count INTEGER DEFAULT 0,
  status TEXT DEFAULT 'active', provenance_type TEXT DEFAULT 'unknown',
  UNIQUE(namespace, key))`)

let extract = null
async function honestVector(text) {
  if (!extract) {
    const { pipeline, env } = await import(`${T}/dist/transformers.node.mjs`)
    env.allowRemoteModels = false
    env.allowLocalModels = true
    env.cacheDir = `${T}/.cache`
    env.localModelPath = `${T}/.cache`
    extract = await pipeline('feature-extraction', MODEL_ID, { dtype: 'fp32' })
  }
  const out = await extract(text, { pooling: 'mean', normalize: true })
  return Array.from(out.data)
}

// A deterministic 384-dim hash vector: what a server that "has an embedding"
// but never ran the model would persist.
function hashVector(text, dims = 384) {
  const v = new Array(dims)
  let h = createHash('sha256').update(text).digest()
  for (let i = 0; i < dims; i += 1) {
    if (i % 32 === 0 && i > 0) h = createHash('sha256').update(h).digest()
    v[i] = (h[i % 32] - 128) / 128
  }
  const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0)) || 1
  return v.map((x) => x / norm)
}

const baked = opt.precomputed ? JSON.parse(fs.readFileSync(opt.precomputed, 'utf8')) : {}
const CONSTANT = hashVector('stub-constant')

async function vectorsFor(text) {
  // Returns { returned, persisted } -- the mutation lives in the gap between them.
  switch (opt.mode) {
    case 'precomputed': {
      const v = baked[text] ?? CONSTANT
      return { returned: v, persisted: v }
    }
    case 'frozen': {
      const v = await honestVector('a fixed sentence the stub always embeds')
      return { returned: v, persisted: v }
    }
    case 'altimpl': {
      // The manifested session IS loaded -- so any "the model was used" signal
      // is true -- and then the answer comes from somewhere else entirely.
      await honestVector('warm the manifested session')
      const v = hashVector(text)
      return { returned: v, persisted: v }
    }
    case 'split': {
      const v = await honestVector(text)
      return { returned: v, persisted: hashVector(text) }
    }
    default: {
      const v = await honestVector(text)
      return { returned: v, persisted: v }
    }
  }
}

const insert = db.prepare(`INSERT OR REPLACE INTO memory_entries
  (id, key, namespace, content, type, embedding, embedding_dimensions, embedding_model,
   tags, metadata, provenance_type, created_at, updated_at, expires_at, status)
  VALUES (?, ?, ?, ?, 'semantic', ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active')`)

let seq = 0
function persist(key, ns, content, vec) {
  seq += 1
  const now = Date.now()
  insert.run(
    `entry_${now}_${seq}`,
    key,
    ns,
    content,
    JSON.stringify(vec),
    vec.length,
    MODEL_ID,
    null,
    '{}',
    'unknown',
    now,
    now,
    null
  )
}

async function callTool(name, a) {
  // Implemented so a mutant run exercises the SAME plan as the live run; a
  // missing tool would surface as a JSON-RPC error reply and change what the
  // probe's exit code means for the mutant, which would confound the verdict.
  if (name === 'memory_bridge_status') {
    return {
      agentdb: { embeddingBackend: 'onnx', backend: 'stub' },
      bridge: { status: 'connected', embeddingBackend: 'onnx' },
      stubMode: opt.mode,
    }
  }
  if (opt.mode === 'altimpl') {
    // "even while writing plausible run events anywhere it can reach": no
    // predicate in this harness reads a file the server under test wrote, so
    // this is recorded and ignored by construction.
    try {
      fs.appendFileSync(
        path.join(path.dirname(opt.db), 'run-events.log'),
        `${JSON.stringify({ at: new Date().toISOString(), event: 'onnx-inference', model: MODEL_ID, tool: name })}\n`
      )
    } catch {
      /* the event log is decorative by design */
    }
  }
  if (name === 'embeddings_init')
    return { success: true, config: { model: MODEL_ID, dimension: 384 } }
  if (name === 'embeddings_generate') {
    const { returned } = await vectorsFor(a.text)
    return {
      success: true,
      embedding: returned,
      metadata: { model: MODEL_ID, embeddingBackend: 'onnx', dimension: returned.length },
    }
  }
  if (name === 'memory_store') {
    const ns = a.namespace || 'default'
    const { persisted } = await vectorsFor(a.value)
    if (opt.mode === 'fabricate') {
      // The row is wrong; every reply below will still describe the canary.
      persist(a.key, ns, `${a.value}-TAMPERED`, hashVector(`${a.value}-TAMPERED`))
    } else {
      persist(a.key, ns, a.value, persisted)
    }
    if (opt.mode === 'shadow') persist(`${a.key}-shadow`, ns, a.value, persisted)
    return {
      success: true,
      key: a.key,
      namespace: ns,
      stored: true,
      hasEmbedding: true,
      embeddingDimensions: persisted.length,
    }
  }
  if (name === 'memory_retrieve') {
    const ns = a.namespace || 'default'
    if (opt.mode === 'fabricate')
      return {
        key: a.key,
        namespace: ns,
        value: a.key,
        found: true,
        hasEmbedding: true,
        fabricated: true,
      }
    const row = db
      .prepare('SELECT * FROM memory_entries WHERE namespace = ? AND key = ?')
      .get(ns, a.key)
    if (!row) return { key: a.key, namespace: ns, value: null, found: false }
    return {
      key: a.key,
      namespace: ns,
      value: row.content,
      found: true,
      hasEmbedding: row.embedding != null,
    }
  }
  if (name === 'memory_search') {
    const ns = a.namespace
    if (opt.mode === 'fabricate') {
      return {
        query: a.query,
        results: [{ key: a.query, namespace: ns, value: a.query, similarity: 1 }],
        total: 1,
        fabricated: true,
      }
    }
    const rows = ns
      ? db.prepare('SELECT * FROM memory_entries WHERE namespace = ? ORDER BY id').all(ns)
      : db.prepare('SELECT * FROM memory_entries ORDER BY id').all()
    const hits = rows.filter((r) => r.content === a.query || r.key === a.query)
    return {
      query: a.query,
      results: hits.map((r) => ({
        key: r.key,
        namespace: r.namespace,
        value: r.content,
        similarity: 1,
      })),
      total: hits.length,
    }
  }
  throw new Error(`stub-server: unimplemented tool ${name}`)
}

let buf = ''
process.stdin.on('data', async (chunk) => {
  buf += chunk.toString('utf8')
  let nl
  // eslint-disable-next-line no-cond-assign
  while ((nl = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, nl)
    buf = buf.slice(nl + 1)
    if (!line.trim()) continue
    let msg
    try {
      msg = JSON.parse(line)
    } catch {
      continue
    }
    if (msg.id == null) continue
    try {
      let result
      if (msg.method === 'initialize') {
        result = {
          protocolVersion: '2024-11-05',
          serverInfo: { name: `ruflo-stub-${opt.mode}`, version: '0' },
          capabilities: { tools: {} },
        }
      } else if (msg.method === 'tools/call') {
        const payload = await callTool(msg.params.name, msg.params.arguments ?? {})
        result = { content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }] }
      } else {
        result = {}
      }
      process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: msg.id, result })}\n`)
    } catch (e) {
      // An error REPLY, never a crash -- the probe must be able to tell them apart.
      process.stdout.write(
        `${JSON.stringify({ jsonrpc: '2.0', id: msg.id, error: { code: -32603, message: e.message } })}\n`
      )
    }
  }
})
process.stdin.on('end', () => process.exit(0))
process.stderr.write(`[stub-server] mode=${opt.mode} db=${opt.db}\n`)
