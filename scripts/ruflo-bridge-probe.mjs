#!/usr/bin/env tsx
// ruflo-bridge-probe.mjs (SMI-6744 A5.5.2 delta) — the bridge-verdict writer.
//
// Spawns the served ruflo MCP server over stdio through
// scripts/mcp-ruflo-launcher.sh (never any other path, so the launcher's own
// acceptance checks run first and its stderr is available as a `reason`),
// calls `memory_bridge_status`, pipes the payload through `bridgeVerdict()`
// (scripts/lib/ruflo-bridge-verdict.mjs), and persists the returned verdict
// and reason atomically to `~/.skillsmith/ruflo-bridge.state`.
//
// Invoked from `.husky/post-merge`, OUTSIDE its lockfile conditional (D1.1),
// bounded to SIGKILL at 65s — strictly inside this module's own 120s
// lock-stale window; LOCK_STALE_MS and the kill deadline are related by
// construction, see ruflo-bridge-state.ts. The hook wraps this with GNU
// `timeout -k 5 60` (or `gtimeout`) when available, falling back to a
// job-control SIGTERM/SIGKILL watchdog with the same 60s/65s timing when
// neither is on PATH — measured: stock macOS has NEITHER by default, so a
// bare `timeout` call would silently no-op the probe on every run there
// (`scripts/session-start-priming.sh`'s own capability-probe pattern is what
// this mirrors). Shebang is `tsx` (not plain `node`) because this file
// imports the TypeScript state module directly — `.husky/post-merge` invokes
// it via the repo's own `tsx` binary (falling back to `npx --no-install
// tsx`), matching `scripts/retrieval-autoheal-state.ts`'s established
// pattern.
//
// Exit codes: 0 on any outcome that isn't "could not reach the server at
// all" (including `degraded`/`not-evaluated`/`malformed`/`unrecognized` —
// those are recorded verdicts, not probe failures); 2 when the verdict ends
// up `unreadable` (server down, launcher refused, JSON-RPC timeout, or this
// process's own `timeout` wrapper SIGKILLs it at 65s). `.husky/post-merge`
// has no `set -e` and this is the last statement before its own `exit 0`, so
// this exit code is inert there by design (D1.1) — it exists for a human or
// CI running this script directly to observe.
//
// Spec: docs/internal/implementation/smi-6744-bridge-verdict-consumer.md.

import { execFileSync, spawn } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { bridgeVerdict, DERIVED_FROM } from './lib/ruflo-bridge-verdict.mjs'
import {
  acquireBridgeLock,
  BRIDGE_PROBE_DISABLE_VAR,
  foldLiveness,
  readState,
  releaseBridgeLock,
  resolveBridgeLogPath,
  resolveBridgePayloadPath,
  resolveMainRepoKey,
  shouldProbe,
  writeEntryIfOwned,
} from '../packages/doc-retrieval-mcp/src/retrieval-log/ruflo-bridge-state.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const LAUNCHER = join(HERE, 'mcp-ruflo-launcher.sh')
const UNREADABLE_EXIT = 2

// Mirrors scripts/mcp-ruflo-launcher.sh's own committed literals — duplicated
// rather than imported because the launcher is a bash script with no JS
// surface, same as ruflo-launch-guard.mjs duplicates them against it.
const CONTAINER_NAME = 'skillsmith-ruflo-1'
const SERVICE_CWD = '/srv/ruflo'
const AGENTDB_DB_PATH = `${SERVICE_CWD}/.swarm/agentdb-memory.db`
const AUTHORITY_FILE = join(process.env.HOME ?? '', '.skillsmith', 'ruflo-store.json')

// ---- Host-resolved key (D3) -----------------------------------------------
// Identical derivation to retrieval-autoheal.sh's MAIN_REPO resolution: the
// first `worktree` line of `git worktree list --porcelain`, run against THIS
// SCRIPT's own directory (never process.cwd(), and never a container-side
// computation) — the main checkout regardless of which worktree invoked it.
function resolveHostKey() {
  const override = process.argv.includes('--key')
    ? process.argv[process.argv.indexOf('--key') + 1]
    : null
  if (override) return override
  const key = resolveMainRepoKey(HERE)
  if (key) return key
  try {
    return execFileSync('git', ['-C', HERE, 'rev-parse', '--show-toplevel'], {
      encoding: 'utf8',
    }).trim()
  } catch {
    return join(HERE, '..')
  }
}

// ---- Minimal stdio JSON-RPC client (modeled on scripts/ruflo-acceptance/mcp-probe.mjs) ----
function callMemoryBridgeStatus(timeoutMs) {
  return new Promise((resolve) => {
    const child = spawn(LAUNCHER, [], { stdio: ['pipe', 'pipe', 'pipe'] })
    let buf = ''
    let stderr = ''
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
          // a non-JSON stdout line is not a reply
        }
      }
    })
    child.stderr.on('data', (d) => {
      stderr += d.toString('utf8')
    })
    let closed = null
    child.on('close', (code, signal) => {
      closed = { code, signal }
    })
    child.on('error', (e) => {
      closed = { code: null, signal: null, spawnError: e.message }
    })

    const send = (o) => {
      try {
        child.stdin.write(`${JSON.stringify(o)}\n`)
      } catch {
        // the child may already be gone
      }
    }
    const firstLauncherLine = () => {
      const line = stderr.split('\n').find((l) => l.startsWith('[ruflo]'))
      return line ?? (stderr.trim().split('\n')[0] || 'no stderr from the launcher')
    }

    const waitFor = (id, onDone) => {
      const t0 = Date.now()
      const iv = setInterval(() => {
        if (replies.has(id)) {
          clearInterval(iv)
          onDone({ ok: true, message: replies.get(id) })
        } else if (closed) {
          clearInterval(iv)
          onDone({ ok: false, reason: firstLauncherLine() })
        } else if (Date.now() - t0 > timeoutMs) {
          clearInterval(iv)
          try {
            child.kill('SIGTERM')
          } catch {
            // best-effort
          }
          onDone({ ok: false, reason: `timeout waiting for the server after ${timeoutMs}ms` })
        }
      }, 25)
    }

    send({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'ruflo-bridge-probe', version: '1' },
      },
    })
    waitFor(1, (initResult) => {
      if (!initResult.ok) return resolve(initResult)
      send({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} })
      send({
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/call',
        params: { name: 'memory_bridge_status', arguments: {} },
      })
      waitFor(2, (statusResult) => {
        try {
          child.stdin.end()
        } catch {
          // already gone
        }
        setTimeout(() => {
          try {
            child.kill('SIGTERM')
          } catch {
            // already gone
          }
        }, 500)
        if (!statusResult.ok) return resolve(statusResult)
        const msg = statusResult.message
        if (msg.error) {
          return resolve({ ok: false, reason: `JSON-RPC error: ${JSON.stringify(msg.error)}` })
        }
        try {
          const parsed = JSON.parse(msg.result.content[0].text)
          resolve({ ok: true, payload: parsed })
        } catch (e) {
          resolve({ ok: false, reason: `unparseable tool result: ${e.message}` })
        }
      })
    })
  })
}

// ---- D4: independent identity + write-free freshness fallback -------------
//
// `memory_bridge_status` is a self-report from the layer that was lying
// (ADR-170), so a cached or latched `healthy` is a plausible answer no enum
// value alone can express. This check adds identity evidence the serving
// layer cannot fabricate (the fd-resolved store's own generation, read
// independently of the server's self-report) plus a write-free freshness
// signal (a monotonic counter checked across two calls in one probe).
//
// The nonce-challenge design the spec names as primary (write a random value
// into the store and require it echoed back) needs a write to the served
// store, which is gated on the owner's ingestion consent (Checkpoint 7, not
// taken here) — this implements ONLY the write-free fallback the spec names
// for that case, and states its weakness rather than papering over it: a
// counter that merely stays the same across two close-together calls is not
// proof of freshness, only an absence of the one failure mode (a visible
// decrease) this check can actually rule out.
//
// Fails OPEN: any error in this check (docker unavailable, no authority
// file, parsing failure) is logged and otherwise ignored — a check that
// cannot run is not the same as a check that found a problem, and promoting
// "inconclusive" to "wrong" would make this a second point of failure for
// the thing it exists to make more trustworthy.
function checkIndependentIdentity(firstPayload, secondTotalEntries, log) {
  try {
    const authorityRaw = readFileSync(AUTHORITY_FILE, 'utf8')
    const authority = JSON.parse(authorityRaw)
    const expectedGeneration = authority.generationUuid
    if (!expectedGeneration) {
      log('D4: authority file has no generationUuid — identity check skipped')
      return null
    }
    // Select the serving process by the descriptor it HOLDS, not by the order
    // its command line happens to appear in.
    //
    // Measured 2026-10-03, and the reason this check previously protected
    // nothing: six pids in this container satisfy a naive
    // cli.js+mcp+start cmdline predicate, and pid 1 is one of them, because
    // docker-init's own command line embeds the server's. /proc/[0-9]* globs
    // lexicographically, so pid 1 sorts first and a .find() selected the
    // wrapper — which holds no database descriptor at all. The check then
    // reported "no fd to inspect" and failed open on every single run.
    //
    // That artifact also invited a wrong explanation: that sql.js loads the
    // database into memory and keeps no descriptor. It does keep one. Of
    // those six pids, exactly one held agentdb-memory.db together with its
    // -wal and -shm. Scanning for the descriptor first is what makes this
    // check able to find its subject at all.
    //
    // Ambiguity is reported rather than guessed past: the container
    // accumulates orphaned server processes, so "more than one holder" is a
    // state that really occurs, and picking one arbitrarily is how a wrong
    // instrument returns a plausible answer instead of failing.
    const holderScan = execFileSync(
      'docker',
      [
        'exec',
        CONTAINER_NAME,
        'sh',
        '-c',
        'for p in /proc/[0-9]*; do pid=${p#/proc/}; ' +
          'c=$(tr "\\0" " " < "$p/cmdline" 2>/dev/null); ' +
          'case "$c" in *cli.js*mcp*start*) ' +
          'for f in "$p"/fd/*; do tgt=$(readlink "$f" 2>/dev/null); ' +
          'case "$tgt" in *agentdb-memory.db) echo "$pid $tgt";; esac; done;; esac; done',
      ],
      { encoding: 'utf8', timeout: 5000 }
    )
    const holders = holderScan
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean)
    if (holders.length === 0) {
      log(
        'D4: no server process holds an open fd to agentdb-memory.db — identity check skipped (genuinely no evidence, not a wrong subject)'
      )
      return null
    }
    // Several holders is the NORMAL state, not an anomaly, and an earlier
    // revision of this check treated it as a finding — which rendered a loud
    // false alarm on a healthy machine, measured 2026-10-03 (pids 2809 and
    // 502). Two reasons it is normal: this probe spawns its own server, which
    // opens the store, and the container accumulates orphaned servers that
    // keep their descriptors. A check that fires every session is one the
    // reader learns to ignore, which costs more than the check is worth.
    //
    // So the question is not WHICH process is the serving one — that is
    // unanswerable from a descriptor scan and, more importantly, not the
    // question D4 asks. D4 asks whether the store being served is the
    // authoritative one. That is answerable without identifying a unique
    // holder: require every holder to resolve to the same device:inode as
    // the authoritative path, and every holder's store generation to match
    // the authority file. Agreement across all holders confirms identity;
    // disagreement names the divergent process and is a real finding.
    const holderPids = holders.map((h) => h.split(' ')[0])
    const openAgentDb = holders[0].split(' ')[1]
    log(
      `D4: ${holders.length} process(es) hold the store open (pid(s) ${holderPids.join(', ')}); requiring all to agree with the authority`
    )
    const statOpen = execFileSync(
      'docker',
      ['exec', CONTAINER_NAME, 'stat', '-c', '%d:%i', openAgentDb],
      { encoding: 'utf8', timeout: 5000 }
    ).trim()
    const statExpected = execFileSync(
      'docker',
      ['exec', CONTAINER_NAME, 'stat', '-c', '%d:%i', AGENTDB_DB_PATH],
      { encoding: 'utf8', timeout: 5000 }
    ).trim()
    if (statOpen !== statExpected) {
      return `the server's open agentdb-memory.db fd resolves to device:inode ${statOpen}, which differs from ${AGENTDB_DB_PATH}'s own ${statExpected} — a copied or substituted store`
    }
    // Every holder must resolve to that same inode. One holder agreeing is
    // not evidence about the others, and a divergent holder is exactly the
    // substituted-store case this check exists to catch.
    for (const hp of holderPids) {
      const hTargets = execFileSync(
        'docker',
        [
          'exec',
          CONTAINER_NAME,
          'sh',
          '-c',
          `for f in /proc/${hp}/fd/*; do tgt=$(readlink "$f" 2>/dev/null); case "$tgt" in *agentdb-memory.db) echo "$tgt";; esac; done`,
        ],
        { encoding: 'utf8', timeout: 5000 }
      )
      for (const tgt of hTargets
        .split('\n')
        .map((x) => x.trim())
        .filter(Boolean)) {
        const s = execFileSync('docker', ['exec', CONTAINER_NAME, 'stat', '-c', '%d:%i', tgt], {
          encoding: 'utf8',
          timeout: 5000,
        }).trim()
        if (s !== statExpected) {
          return `pid ${hp} holds a store at device:inode ${s}, which differs from ${AGENTDB_DB_PATH}'s own ${statExpected} — two processes are serving different stores, so a healthy verdict is not attributable`
        }
      }
    }
    const genRaw = execFileSync(
      'docker',
      [
        'exec',
        CONTAINER_NAME,
        'node',
        '-e',
        `const D=require('/opt/ruflo-seed/node_modules/better-sqlite3/lib/index.js');const db=new D(${JSON.stringify(openAgentDb)},{readonly:true});const r=db.prepare('SELECT id FROM store_generation').get();process.stdout.write(r?r.id:'')`,
      ],
      { encoding: 'utf8', timeout: 5000 }
    ).trim()
    if (genRaw && genRaw !== expectedGeneration) {
      return `the fd-resolved store's generation (${genRaw.slice(0, 12)}...) does not match the authority file's (${expectedGeneration.slice(0, 12)}...) — a copied generation marker pointing at the wrong store`
    }
    // Write-free freshness fallback: a counter that visibly DECREASED between
    // the two calls this probe made is impossible for a legitimate append-
    // mostly store and is the one thing this weaker check can rule out.
    const firstTotal = firstPayload?.agentdb?.totalEntries
    if (
      typeof firstTotal === 'number' &&
      typeof secondTotalEntries === 'number' &&
      secondTotalEntries < firstTotal
    ) {
      return `agentdb.totalEntries decreased from ${firstTotal} to ${secondTotalEntries} across two calls in one probe — a cached or inconsistent answer`
    }
    return null
  } catch (e) {
    log(`D4: identity check inconclusive (${e.message}) — trusting the detector's own verdict`)
    return null
  }
}

// ---- main -------------------------------------------------------------

async function main() {
  if (process.env[BRIDGE_PROBE_DISABLE_VAR] === '1') {
    return 0
  }

  const key = resolveHostKey()
  const logLines = []
  const log = (line) => logLines.push(`${new Date().toISOString()} ${line}`)

  const handle = await acquireBridgeLock()
  if (!handle) {
    log('lock not acquired within budget — another probe is live; exiting without probing')
    flushLog(logLines)
    return 0
  }

  try {
    const prior = readState()[key] ?? null
    if (!shouldProbe(prior, Date.now())) {
      log(`debounced — prior entry at ${prior?.evaluatedAt} is within the 24h window`)
      return 0
    }

    log('probing memory_bridge_status via the launcher')
    const first = await callMemoryBridgeStatus(55_000)
    let entry
    let exitCode = 0

    if (!first.ok) {
      log(`unreadable: ${first.reason}`)
      entry = {
        evaluatedAt: new Date().toISOString(),
        verdict: 'unreadable',
        reason: first.reason,
        observedBackend: null,
        derivedFromVersion: DERIVED_FROM.version,
        patternsLearned: null,
        trajectoriesRecorded: null,
        consecutiveNoLearning: foldLiveness(prior, null, null),
      }
      exitCode = UNREADABLE_EXIT
    } else {
      try {
        mkdirSync(dirname(resolveBridgePayloadPath()), { recursive: true })
        writeFileSync(resolveBridgePayloadPath(), `${JSON.stringify(first.payload, null, 2)}\n`)
      } catch {
        // side-file write is diagnostic only — never block on it
      }
      const verdict = bridgeVerdict(first.payload)
      const patternsLearned = first.payload?.intelligence?.patternsLearned ?? null
      const trajectoriesRecorded = first.payload?.intelligence?.trajectoriesRecorded ?? null

      let finalVerdict = verdict.verdict
      let finalReason = verdict.reason
      if (finalVerdict === 'healthy' || finalVerdict === 'degraded') {
        const second = await callMemoryBridgeStatus(10_000)
        const secondTotal = second.ok ? second.payload?.agentdb?.totalEntries : undefined
        const d4Finding = checkIndependentIdentity(first.payload, secondTotal, log)
        if (d4Finding) {
          log(`D4 finding: ${d4Finding}`)
          finalVerdict = 'malformed'
          finalReason = `independent identity/freshness check failed: ${d4Finding}`
        }
      }

      entry = {
        evaluatedAt: new Date().toISOString(),
        verdict: finalVerdict,
        reason: finalReason,
        observedBackend: verdict.observed?.['agentdb.embeddingBackend'] ?? null,
        derivedFromVersion: DERIVED_FROM.version,
        patternsLearned,
        trajectoriesRecorded,
        consecutiveNoLearning: foldLiveness(prior, patternsLearned, trajectoriesRecorded),
      }
      log(`verdict: ${finalVerdict} -- ${finalReason}`)
    }

    const wrote = writeEntryIfOwned(key, entry, handle)
    if (!wrote) {
      log('write refused — this probe no longer owns the lock (a replacement took over)')
    }
    return exitCode
  } finally {
    releaseBridgeLock(handle)
    flushLog(logLines)
  }
}

function flushLog(lines) {
  if (lines.length === 0) return
  try {
    const path = resolveBridgeLogPath(new Date())
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, `${lines.join('\n')}\n`, { flag: 'a' })
  } catch {
    // logging must never fail the probe
  }
}

main()
  .then((code) => process.exit(code))
  .catch((e) => {
    process.stderr.write(`ruflo-bridge-probe fatal: ${e?.stack ?? e}\n`)
    process.exit(UNREADABLE_EXIT)
  })
