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

import { isMainModule } from './lib/is-main-module.mjs'
import { bridgeVerdict, DERIVED_FROM } from './lib/ruflo-bridge-verdict.mjs'
import { checkIndependentIdentity } from './ruflo-bridge-probe.identity.mjs'
import {
  acquireBridgeLock,
  BRIDGE_PROBE_DISABLE_VAR,
  foldLiveness,
  isValidCount,
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

/**
 * SMI-6967 H-1: a producer EXISTING is strictly weaker than learning having
 * happened — `bridge.status === 'connected'` and/or a non-trivial
 * `agentdb.totalEntries` both count, independent of the embeddingBackend
 * verdict (a `degraded` mock-backend bridge can still be a real producer).
 *
 * SMI-6967 PR-gate (H-A) correction: `totalEntries` is validated through
 * {@link isValidCount}, the SAME validator the liveness fold uses for
 * `patternsLearned`/`trajectoriesRecorded` (`ruflo-bridge-state.liveness.ts`)
 * — one shared predicate, not a second copy. The prior inline check here
 * (`Number.isFinite(total) && total > 0`) wrongly accepted a fractional
 * `totalEntries` like `0.5`: finite and positive, but not a count any real
 * probe would ever produce, and `foldLiveness` LATCHES `everProducerPresent`
 * permanently on a single `true` reading — so one invalid fractional payload
 * could never be un-armed. `isValidCount` requires a non-negative INTEGER,
 * closing that gap.
 */
export function isProducerPresent(payload) {
  const total = payload?.agentdb?.totalEntries
  if (isValidCount(total) && total > 0) return true
  return payload?.bridge?.status === 'connected'
}

/**
 * SMI-6985 Medium: extraction seam for `intelligence.patternsLearned`/
 * `.trajectoriesRecorded`, exported so a test can drive it directly against
 * a payload shape (e.g. one with no `intelligence` block at all) without
 * spinning up the launcher — the same seam `isProducerPresent` already is
 * for `bridge`/`agentdb`. Raw values only (not yet validated as counts):
 * `foldLiveness` is the one place that calls `isValidCount` on them. Before
 * this was split out, nothing drove this exact expression from any test
 * (confirmed: `grep -n intelligence scripts/tests/*.ts
 * packages/doc-retrieval-mcp/src/retrieval-log/*.test.ts` returned a single
 * hit, a type declaration). An `intelligence` block that silently vanishes
 * upstream would still matter once a trajectory writer exists and the
 * liveness arm can arm — see `ruflo-bridge-state.liveness.ts`'s own SMI-6985
 * doc comment for why that follow-on is filed, not built, today.
 */
export function extractLearningCounters(payload) {
  return {
    patternsLearned: payload?.intelligence?.patternsLearned ?? null,
    trajectoriesRecorded: payload?.intelligence?.trajectoriesRecorded ?? null,
  }
}

// ---- Deadlines, and why these numbers ------------------------------------
// The invariant is that this writer never terminates without having written
// something. The hook SIGTERMs at 60 s and SIGKILLs at 65 s, and SIGKILL
// cannot write — so every internal deadline plus classification plus the
// write must finish inside 60 s with margin. An earlier revision spent
// 55 s + 10 s on the two status calls alone, which exceeded the SIGTERM
// before classification began: the code gate found it as its second blocker.
//
// Budget: 30 s first call + 8 s second call + ~10 s for D4's own docker
// probes (several 5 s ceilings, not all on the same path) = ~48 s, leaving
// ~12 s for classification and the atomic write. The relationship that must
// hold is FIRST + SECOND + D4 + write < SIGTERM < SIGKILL < stale-lock
// threshold; changing any one of them requires re-checking the chain.
const FIRST_CALL_MS = 30_000
const SECOND_CALL_MS = 8_000

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
// D4's identity check lives in ./ruflo-bridge-probe.identity.mjs — split out
// when the three-way outcome crossed the 500-line gate. Its constants are
// passed in so there is exactly one definition of each.

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
    const first = await callMemoryBridgeStatus(FIRST_CALL_MS)
    let entry
    let exitCode = 0

    if (!first.ok) {
      log(`unreadable: ${first.reason}`)
      // SMI-6967 H-1: the server could not even be reached, so there is no
      // payload to read a producer signal from either — `null`, the same
      // "could not ask" treatment the counters themselves get.
      const fold = foldLiveness(prior, null, null, null)
      entry = {
        evaluatedAt: new Date().toISOString(),
        verdict: 'unreadable',
        reason: first.reason,
        observedBackend: null,
        derivedFromVersion: DERIVED_FROM.version,
        patternsLearned: null,
        trajectoriesRecorded: null,
        consecutiveNoLearning: fold.consecutiveNoLearning,
        everProducerPresent: fold.everProducerPresent,
        everLearned: fold.everLearned,
        countersRegressed: fold.countersRegressed,
        lastObservedPatternsLearned: fold.lastObservedPatternsLearned,
        lastObservedTrajectoriesRecorded: fold.lastObservedTrajectoriesRecorded,
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
      const { patternsLearned, trajectoriesRecorded } = extractLearningCounters(first.payload)

      let finalVerdict = verdict.verdict
      let finalReason = verdict.reason
      if (finalVerdict === 'healthy' || finalVerdict === 'degraded') {
        const second = await callMemoryBridgeStatus(SECOND_CALL_MS)
        const secondTotal = second.ok ? second.payload?.agentdb?.totalEntries : undefined
        const d4 = checkIndependentIdentity(first.payload, secondTotal, log, {
          execFileSync,
          readFileSync,
          CONTAINER_NAME,
          AGENTDB_DB_PATH,
          AUTHORITY_FILE,
        })
        // Three outcomes, never two. 'contradicted' is an active problem and
        // reads as degraded; 'inconclusive' is the could-not-ask case and gets
        // its OWN verdict rather than passing as healthy — collapsing it into
        // either neighbour is what let a cached answer render nothing.
        // It is deliberately NOT the detector's 'malformed', which means the
        // payload contradicted itself and carries a different remedy.
        if (d4.status === 'contradicted') {
          log(`D4 contradicted: ${d4.detail}`)
          finalVerdict = 'degraded'
          finalReason = `the served store contradicts the authority: ${d4.detail}`
        } else if (d4.status === 'inconclusive') {
          log(`D4 inconclusive: ${d4.detail}`)
          finalVerdict = 'unverified'
          finalReason = `backend read clean (${verdict.reason}) but could not be corroborated: ${d4.detail}`
        }
      }

      // SMI-6967 H-1: producer presence is read from the FIRST call's own
      // payload, independent of `finalVerdict` — a degraded (mock-backend)
      // bridge, or one D4 could not corroborate, is still a real producer.
      const producerPresentThisProbe = isProducerPresent(first.payload)
      const fold = foldLiveness(
        prior,
        patternsLearned,
        trajectoriesRecorded,
        producerPresentThisProbe
      )
      entry = {
        evaluatedAt: new Date().toISOString(),
        verdict: finalVerdict,
        reason: finalReason,
        observedBackend: verdict.observed?.['agentdb.embeddingBackend'] ?? null,
        derivedFromVersion: DERIVED_FROM.version,
        patternsLearned,
        trajectoriesRecorded,
        consecutiveNoLearning: fold.consecutiveNoLearning,
        everProducerPresent: fold.everProducerPresent,
        everLearned: fold.everLearned,
        countersRegressed: fold.countersRegressed,
        lastObservedPatternsLearned: fold.lastObservedPatternsLearned,
        lastObservedTrajectoriesRecorded: fold.lastObservedTrajectoriesRecorded,
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

// SMI-6967 PR-gate (H-A) test-gap fix: entry-point guard (scripts/lib/
// is-main-module.mjs, the same pattern ruflo-bridge-verdict.mjs uses) so
// importing this module FOR ITS EXPORTS (isProducerPresent, in
// scripts/tests/ruflo-bridge-probe.test.ts) never also spawns the launcher,
// takes the bridge lock, or writes state as a side effect of the import.
// `.husky/post-merge`'s `tsx scripts/ruflo-bridge-probe.mjs` invocation sets
// argv[1] to this file, so main() still runs exactly as before there.
if (isMainModule(import.meta.url)) {
  main()
    .then((code) => process.exit(code))
    .catch((e) => {
      process.stderr.write(`ruflo-bridge-probe fatal: ${e?.stack ?? e}\n`)
      process.exit(UNREADABLE_EXIT)
    })
}
