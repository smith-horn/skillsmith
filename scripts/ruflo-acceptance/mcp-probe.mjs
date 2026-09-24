#!/usr/bin/env node
// Host-side JSON-RPC probe for the ruflo MCP service (SMI-6744 A1.4 part iv,
// ADR-170 § 2).
//
// Takes A0.9's shape, which ADR-170 § 2 makes mandatory: "Every probe used in
// any arm must distinguish a JSON-RPC error reply from a crash." A0.8's probe
// treated an `error` reply as `result === undefined`, died inside
// JSON.stringify, and produced exit 1 with no recorded verdict -- two outcomes
// collapsed into one. Here the three are separate exit codes:
//
//   0  every request in the plan got a JSON-RPC `result`
//   5  at least one request got a JSON-RPC `error` reply (recorded, not a crash)
//   1  the server crashed, never replied, or the probe timed out
//
// Blinding (ADR-170 § 2 arm 3): canaries are generated AFTER `initialize`
// returns, from crypto.randomBytes, so the serving process cannot have known
// them when it started. The plan file refers to them as {{C0}}, {{C1}}, ... and
// to the freshness mutants as {{F0}}, {{F1}}, ... -- an F input differs from
// its C input in its last 8 hex characters only.
//
// Usage:
//   node mcp-probe.mjs --out <evidence.json> --plan <plan.json> \
//        [--canaries N] [--timeout-ms N] [--] <server-cmd> [server args...]
//
// The server command defaults to scripts/mcp-ruflo-launcher.sh in this
// checkout. A mutant run passes `docker run ...` instead; nothing else changes.

import { spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const DEFAULT_SERVER = path.resolve(HERE, '..', 'mcp-ruflo-launcher.sh')

function parseArgs(argv) {
  const o = {
    out: null,
    plan: null,
    canaries: 0,
    timeoutMs: 180000,
    server: [],
    published: null,
    publishedMutant: null,
    holdFile: null,
    holdMs: 120000,
  }
  let i = 0
  for (; i < argv.length; i += 1) {
    const a = argv[i]
    if (a === '--') {
      o.server = argv.slice(i + 1)
      break
    } else if (a === '--out') o.out = argv[(i += 1)]
    else if (a === '--plan') o.plan = argv[(i += 1)]
    else if (a === '--canaries') o.canaries = Number(argv[(i += 1)])
    else if (a === '--timeout-ms') o.timeoutMs = Number(argv[(i += 1)])
    // The blinding OPT-OUT, used only by the precomputed-server mutation's own
    // control arm: it publishes the canary in advance so a server that answers
    // from a lookup table passes. That control passing is what makes the
    // blinded run's failure attributable to blinding rather than to the stub.
    else if (a === '--published-canary') o.published = argv[(i += 1)]
    else if (a === '--published-mutant') o.publishedMutant = argv[(i += 1)]
    // Holds the SESSION open after the plan completes, so a reader can observe
    // the store while the serving process still owns its connection. ADR-170
    // § 2's positive arm needs an acknowledged canary that is still WAL-resident,
    // and SQLite checkpoints on last-connection close -- so a reader that starts
    // after the session ends can only ever see a checkpointed main file.
    else if (a === '--hold-file') o.holdFile = argv[(i += 1)]
    else if (a === '--hold-ms') o.holdMs = Number(argv[(i += 1)])
    else throw new Error(`unknown argument: ${a}`)
  }
  if (o.server.length === 0) o.server = [DEFAULT_SERVER]
  return o
}

// A canary is the stored key AND the stored value: one blinded string per
// input, so the row identity and the embedded text cannot drift apart.
function makeCanaries(n) {
  const out = []
  for (let i = 0; i < n; i += 1) {
    const head = randomBytes(8).toString('hex')
    const tail = randomBytes(4).toString('hex')
    let mutTail = randomBytes(4).toString('hex')
    while (mutTail === tail) mutTail = randomBytes(4).toString('hex')
    out.push({ c: `a14c-${head}-${tail}`, f: `a14c-${head}-${mutTail}` })
  }
  return out
}

function substitute(node, canaries) {
  if (typeof node === 'string') {
    return node.replace(/\{\{([CF])(\d+)\}\}/g, (m, kind, idx) => {
      const c = canaries[Number(idx)]
      if (!c)
        throw new Error(`plan references ${m} but only ${canaries.length} canaries were generated`)
      return kind === 'C' ? c.c : c.f
    })
  }
  if (Array.isArray(node)) return node.map((x) => substitute(x, canaries))
  if (node && typeof node === 'object') {
    const o = {}
    for (const [k, v] of Object.entries(node)) o[k] = substitute(v, canaries)
    return o
  }
  return node
}

async function main() {
  const opt = parseArgs(process.argv.slice(2))
  const plan = JSON.parse(readFileSync(opt.plan, 'utf8'))
  const ev = {
    server: opt.server,
    startedAt: new Date().toISOString(),
    canaries: [],
    responses: [],
    stderr: '',
    exit: { code: null, signal: null },
    outcome: null,
  }

  const child = spawn(opt.server[0], opt.server.slice(1), { stdio: ['pipe', 'pipe', 'pipe'] })
  let buf = ''
  const replies = new Map()
  child.stdout.on('data', (d) => {
    buf += d.toString('utf8')
    let nl
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl)
      buf = buf.slice(nl + 1)
      if (!line.trim()) continue
      try {
        const msg = JSON.parse(line)
        if (msg.id != null) replies.set(msg.id, msg)
      } catch {
        /* a non-JSON stdout line is not a reply; kept out of the reply map on purpose */
      }
    }
  })
  child.stderr.on('data', (d) => {
    ev.stderr += d.toString('utf8')
  })

  let closed = null
  child.on('close', (code, signal) => {
    closed = { code, signal }
  })
  child.on('error', (e) => {
    closed = { code: null, signal: null, spawnError: e.message }
  })

  const send = (o) => child.stdin.write(`${JSON.stringify(o)}\n`)
  const waitFor = (id) =>
    new Promise((resolve, reject) => {
      const t0 = Date.now()
      const iv = setInterval(() => {
        if (replies.has(id)) {
          clearInterval(iv)
          resolve(replies.get(id))
        } else if (closed) {
          clearInterval(iv)
          reject(
            new Error(
              `server exited before replying to id=${id} (code=${closed.code} signal=${closed.signal})`
            )
          )
        } else if (Date.now() - t0 > opt.timeoutMs) {
          clearInterval(iv)
          reject(new Error(`timeout waiting for id=${id} after ${opt.timeoutMs}ms`))
        }
      }, 25)
    })

  let sawJsonRpcError = false
  try {
    send({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'ruflo-acceptance', version: '1' },
      },
    })
    const init = await waitFor(1)
    ev.responses.push({ id: 1, method: 'initialize', message: init })
    if (init.error) sawJsonRpcError = true
    send({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} })

    // Blinding boundary: nothing below this line existed before the server ran.
    if (opt.published) {
      ev.canaries = [{ c: opt.published, f: opt.publishedMutant }]
      ev.blinded = false
    } else {
      ev.canaries = makeCanaries(opt.canaries)
      ev.blinded = true
    }
    ev.canaryGeneratedAt = new Date().toISOString()

    let id = 1
    for (const step of plan) {
      id += 1
      const params = substitute(step.params ?? {}, ev.canaries)
      send({ jsonrpc: '2.0', id, method: step.method ?? 'tools/call', params })
      const reply = await waitFor(id)
      if (reply.error) sawJsonRpcError = true
      let parsed = null
      try {
        parsed = JSON.parse(reply.result.content[0].text)
      } catch {
        parsed = null
      }
      // The label carries {{Cn}}/{{Fn}} too: compare.mjs keys the returned
      // vectors off it, and an unsubstituted label silently produces "no
      // returned vector for this canary" rather than a wrong one.
      ev.responses.push({
        id,
        label: step.label ? substitute(step.label, ev.canaries) : null,
        params,
        message: reply,
        parsed,
      })
    }
    ev.outcome = sawJsonRpcError ? 'jsonrpc-error' : 'ok'
    if (opt.holdFile) {
      writeFileSync(opt.holdFile, `${JSON.stringify(ev.canaries)}\n`)
      const t0 = Date.now()
      // Wait for the driver's go signal, keeping the server process alive.
      // eslint-disable-next-line no-await-in-loop
      while (!existsSync(`${opt.holdFile}.go`) && Date.now() - t0 < opt.holdMs) {
        // eslint-disable-next-line no-await-in-loop
        await new Promise((r) => setTimeout(r, 50))
      }
      ev.heldForMs = Date.now() - t0
      ev.holdReleasedBy = existsSync(`${opt.holdFile}.go`) ? 'go-file' : 'hold-ms-timeout'
    }
  } catch (e) {
    ev.outcome = 'crash-or-timeout'
    ev.failure = e.message
  }

  try {
    child.stdin.end()
  } catch {
    /* already gone */
  }
  await new Promise((r) => setTimeout(r, 750))
  if (closed) ev.exit = closed
  else {
    child.kill('SIGTERM')
    ev.exit = { code: null, signal: 'SIGTERM-by-probe' }
  }

  writeFileSync(opt.out, `${JSON.stringify(ev, null, 2)}\n`)
  process.stdout.write(
    `probe outcome=${ev.outcome} responses=${ev.responses.length} canaries=${ev.canaries.length}\n`
  )
  if (ev.outcome === 'ok') process.exit(0)
  if (ev.outcome === 'jsonrpc-error') process.exit(5)
  process.exit(1)
}

main().catch((e) => {
  process.stderr.write(`mcp-probe fatal: ${e.stack}\n`)
  process.exit(1)
})
