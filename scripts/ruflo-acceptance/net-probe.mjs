#!/usr/bin/env node
// In-container network probe for ADR-170 § 6 egress arms 2 and 4.
// Prints one JSON object on stdout; asserts nothing itself, so the same probe
// runs unchanged against the service under test and against the known-positive
// networked control that validates the instrument.
//
// Arm 2 as ADR-170 § 6 words it is "no non-loopback interface inside the
// container". Measured on this LinuxKit kernel, that literal wording is not the
// predicate: a fresh network namespace is born holding tunl0, gre0, gretap0,
// erspan0, ip_vti0, ip6_vti0, sit0, ip6tnl0 and ip6gre0 -- kernel tunnel
// devices the loaded modules create in every netns. None is UP and none carries
// an address. So this probe reports, per interface, the IFF_UP bit
// (flags & 0x1) and the IFF_LOOPBACK bit (flags & 0x8) from sysfs, every
// address from /proc/net/fib_trie and /proc/net/if_inet6, and the route count,
// and the driver asserts on those rather than on interface names.
//
// Usage: node net-probe.mjs [--host <dns-name>] [--ip <a.b.c.d>] [--port N]

import { readFileSync, readdirSync, existsSync } from 'node:fs'
import dns from 'node:dns'
import net from 'node:net'

const args = process.argv.slice(2)
const opt = { host: 'registry.npmjs.org', ip: '93.184.216.34', port: 443, timeoutMs: 8000 }
for (let i = 0; i < args.length; i += 1) {
  if (args[i] === '--host') opt.host = args[(i += 1)]
  else if (args[i] === '--ip') opt.ip = args[(i += 1)]
  else if (args[i] === '--port') opt.port = Number(args[(i += 1)])
  else if (args[i] === '--timeout-ms') opt.timeoutMs = Number(args[(i += 1)])
}

function readMaybe(p) {
  try {
    return readFileSync(p, 'utf8')
  } catch {
    return null
  }
}

function interfaces() {
  const base = '/sys/class/net'
  if (!existsSync(base)) return { error: 'no /sys/class/net' }
  const out = []
  for (const name of readdirSync(base)) {
    const flagsRaw = (readMaybe(`${base}/${name}/flags`) || '').trim()
    if (!flagsRaw) continue
    const flags = Number.parseInt(flagsRaw, 16)
    out.push({
      name,
      flags: flagsRaw,
      up: (flags & 0x1) !== 0,
      loopback: (flags & 0x8) !== 0,
      operstate: (readMaybe(`${base}/${name}/operstate`) || '').trim(),
    })
  }
  return out
}

// /proc/net/fib_trie names every locally-configured IPv4 address under a
// "LOCAL" line; parsing it avoids needing `ip`, which the node:22-slim base
// image does not carry.
function ipv4Local() {
  const t = readMaybe('/proc/net/fib_trie')
  if (t == null) return { error: 'no /proc/net/fib_trie' }
  const lines = t.split('\n')
  const addrs = new Set()
  for (let i = 0; i < lines.length; i += 1) {
    const m = lines[i].match(/^\s*\|--\s+(\d+\.\d+\.\d+\.\d+)\s*$/)
    if (m && /host LOCAL|link LOCAL/.test(lines[i + 1] || '')) addrs.add(m[1])
  }
  return [...addrs]
}

function ipv6Local() {
  const t = readMaybe('/proc/net/if_inet6')
  if (t == null) return []
  return t
    .split('\n')
    .filter((l) => l.trim())
    .map((l) => {
      const f = l.trim().split(/\s+/)
      return { addr: f[0], iface: f[5] }
    })
}

function routeCount() {
  const t = readMaybe('/proc/net/route')
  if (t == null) return { error: 'no /proc/net/route' }
  return t.split('\n').filter((l) => l.trim()).length - 1 // minus the header row
}

function errShape(e) {
  if (!e) return null
  return { code: e.code, errno: e.errno, syscall: e.syscall, hostname: e.hostname }
}

const result = {
  interfaces: interfaces(),
  ipv4Local: ipv4Local(),
  ipv6Local: ipv6Local(),
  routeCount: routeCount(),
  dns: null,
  rawIp: null,
}

dns.lookup(opt.host, (dnsErr, address) => {
  result.dns = dnsErr ? { failed: true, ...errShape(dnsErr) } : { failed: false, address }
  const sock = net.connect({ host: opt.ip, port: opt.port })
  let done = false
  const finish = () => {
    if (done) return
    done = true
    try {
      sock.destroy()
    } catch {
      /* already destroyed */
    }
    process.stdout.write(`${JSON.stringify(result)}\n`)
    process.exit(0)
  }
  sock.on('error', (e) => {
    result.rawIp = { failed: true, ...errShape(e) }
    finish()
  })
  sock.on('connect', () => {
    result.rawIp = { failed: false, remote: `${opt.ip}:${opt.port}` }
    finish()
  })
  setTimeout(() => {
    result.rawIp = result.rawIp ?? {
      failed: true,
      code: 'PROBE_TIMEOUT',
      errno: null,
      syscall: 'connect',
    }
    finish()
  }, opt.timeoutMs)
})
