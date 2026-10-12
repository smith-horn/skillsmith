#!/usr/bin/env node
// Named field extractor for the driver. Not a general JSON query tool on
// purpose: every name below is a predicate input the driver prints, so the
// mapping from a name to what it counts is reviewable in one place instead of
// being spread across shell one-liners.
//
// Usage: node jqlite.mjs <file.json> <name> [arg]
// The file may contain leading non-JSON lines (a probe's own stdout); the first
// line that parses as a JSON object wins.

import { readFileSync } from 'node:fs'

const [file, name, arg] = process.argv.slice(2)
const raw = readFileSync(file, 'utf8')

function parseLoose(text) {
  try {
    return JSON.parse(text)
  } catch {
    /* fall through to line scan */
  }
  const lines = text.split('\n')
  for (let i = 0; i < lines.length; i += 1) {
    const t = lines[i].trim()
    if (!t.startsWith('{')) continue
    try {
      return JSON.parse(lines.slice(i).join('\n'))
    } catch {
      try {
        return JSON.parse(t)
      } catch {
        /* keep scanning */
      }
    }
  }
  throw new Error(`no JSON object found in ${file}`)
}

const d = parseLoose(raw)
const ifaces = Array.isArray(d.interfaces) ? d.interfaces : []
// A missing value must not print the string "undefined" with rc 0: every
// caller in lib/*.sh guards with `|| echo ERR` (or `|| echo ''`) specifically
// so a genuine extraction failure is distinguishable from a real value, and
// that guard is unreachable if this function itself turns "absent" into a
// truthy-looking string. A field that can be LEGITIMATELY absent (not an
// error, just nothing there) must be handled by its own case below before it
// ever reaches this function -- see dnsCode/dnsErrno/dnsSyscall/rawIpCode/
// rawIpErrno (successful connect/lookup carries no error code) and walSize
// (an absent -wal is a real state store-reader.mjs reports as null).
const out = (v) => {
  if (v === undefined || v === null) {
    process.stderr.write(`jqlite: ${name} is absent in ${file}\n`)
    process.exit(3)
  }
  process.stdout.write(`${v}\n`)
  process.exit(0)
}

switch (name) {
  case 'upNonLoopback':
    out(ifaces.filter((i) => i.up && !i.loopback).length)
    break
  case 'ifaceSummary':
    out(
      ifaces
        .map(
          (i) => `${i.name}(flags=${i.flags}${i.up ? ',UP' : ''}${i.loopback ? ',LOOPBACK' : ''})`
        )
        .join(' ')
    )
    break
  case 'nonLoopbackV4':
    out((Array.isArray(d.ipv4Local) ? d.ipv4Local : []).filter((a) => !a.startsWith('127.')).length)
    break
  case 'nonLoopbackV6':
    out(
      (Array.isArray(d.ipv6Local) ? d.ipv6Local : []).filter(
        (a) => a.addr !== '00000000000000000000000000000001'
      ).length
    )
    break
  case 'routeCount':
    out(typeof d.routeCount === 'number' ? d.routeCount : `ERR:${JSON.stringify(d.routeCount)}`)
    break
  case 'dnsFailed':
    out(String(Boolean(d.dns && d.dns.failed)))
    break
  // net-probe.mjs only sets code/errno/syscall on the FAILURE shape
  // ({failed:true, ...}); a successful lookup ({failed:false, address}) never
  // has a .code at all, and that is a legitimate outcome, not a missing
  // measurement -- so it is coalesced to 'none' here rather than left
  // undefined for out() to reject.
  case 'dnsCode':
    out(d.dns ? (d.dns.code ?? 'none') : 'none')
    break
  case 'dnsErrno':
    out(d.dns ? (d.dns.errno ?? 'none') : 'none')
    break
  case 'dnsSyscall':
    out(d.dns ? (d.dns.syscall ?? 'none') : 'none')
    break
  // Same shape as dns above: net-probe.mjs's successful-connect result is
  // {failed:false, remote} with no .code -- a legitimate "it connected", not
  // an absent measurement.
  case 'rawIpCode':
    out(d.rawIp ? (d.rawIp.code ?? 'none') : 'none')
    break
  case 'rawIpErrno':
    out(d.rawIp ? (d.rawIp.errno ?? 'none') : 'none')
    break
  case 'netNames':
    out(
      Object.keys(d.Networks ?? {})
        .sort()
        .join(',')
    )
    break
  case 'netWithAddress':
    // Networks whose IPAddress is a non-empty string: the daemon always lists
    // the null-driver `none` network for an unattached container, so the count
    // that separates attached from unattached is the ADDRESSED one.
    out(
      Object.values(d.Networks ?? {}).filter(
        (n) => typeof n.IPAddress === 'string' && n.IPAddress.length > 0
      ).length
    )
    break
  case 'netDetail':
    out(
      Object.entries(d.Networks ?? {})
        .map(
          ([k, v]) =>
            `${k}(ip='${v.IPAddress ?? ''}' mac='${v.MacAddress ?? ''}' gw='${v.Gateway ?? ''}')`
        )
        .join(' ') || 'none-listed'
    )
    break
  case 'probeOutcome':
    out(d.outcome ?? 'none')
    break
  case 'canaryList':
    out((d.canaries ?? []).map((c) => c.c).join(' '))
    break
  case 'canaryAndMutantList':
    out((d.canaries ?? []).flatMap((c) => [c.c, c.f]).join(' '))
    break
  case 'bridgeBackend': {
    const r = (d.responses ?? []).find((x) => x.label === 'bridge_status')
    out(r && r.parsed ? (r.parsed.agentdb?.embeddingBackend ?? 'absent') : 'none')
    break
  }
  case 'bridgeStatusJson': {
    const r = (d.responses ?? []).find((x) => x.label === 'bridge_status')
    out(r && r.parsed ? JSON.stringify(r.parsed) : 'none')
    break
  }
  // store-reader.mjs (L-17) reports an absent -wal as null, a real and
  // expected state (the file was checkpointed away) rather than a missing
  // measurement -- printed as 'absent' rather than routed through out()'s
  // undefined/null rejection.
  case 'walSize':
    out(d.walSizeBytes === null ? 'absent' : d.walSizeBytes)
    break
  case 'rowCount':
    out(d.rows && d.rows[arg] ? d.rows[arg].rowCount : 'none')
    break
  case 'mainOnlyRowCount':
    out(d.mainFileOnly && d.mainFileOnly[arg] ? d.mainFileOnly[arg].rowCount : 'none')
    break
  case 'distillSkipped':
    out(d.report ? (d.report.skipped ?? 'none') : 'none')
    break
  case 'distillCounters':
    out(
      d.report
        ? JSON.stringify({
            patterns: d.report.patterns,
            processed: d.report.processed,
            episodes: d.report.episodes,
            causalEdges: d.report.causalEdges,
          })
        : 'none'
    )
    break
  case 'hits':
    out(d.hits ? String(d.hits[arg]) : 'none')
    break
  case 'counts':
    out(d.counts ? JSON.stringify(d.counts) : 'none')
    break
  case 'matchedTargetInode':
    out(d.matchedTargetInode)
    break
  case 'fdObservations':
    out(
      (d.observations ?? [])
        .map((o) => `pid=${o.pid} fd=${o.fd} ino=${o.ino} ${o.path}`)
        .join(' | ') || 'none'
    )
    break
  case 'field':
    out(arg.split('.').reduce((acc, k) => (acc == null ? acc : acc[k]), d))
    break
  default:
    process.stderr.write(`jqlite: unknown name ${name}\n`)
    process.exit(2)
}
