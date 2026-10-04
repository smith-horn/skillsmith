/**
 * Shell-command tokenizer and package-manager / Vercel-CLI command scanners for
 * Check 4 of `check-supply-chain-pins.mjs` (SMI-6944). Split out of the helpers
 * module to keep every file under the 500-line ceiling.
 *
 * A run block is split into commands (`;` `&&` `||` `|` newline `(` `)` backtick),
 * quote-aware, with leading `VAR=value` assignments and wrapper words (`env`,
 * `sudo`, `nohup`, `time`, `command`, `exec`, ...) skipped, so a rule sees the
 * real command word. Quoted `$(...)`, `sh -c '...'` and `eval '...'` are scanned
 * recursively (depth-limited).
 *
 * A package-runner wrapper that runs the CLI (`npx vercel`, `bunx`, `pnpx`,
 * `npm exec|x`, `pnpm|yarn dlx|exec|run`, `bun x|run`, the implicit `yarn vercel`
 * / `pnpm vercel` / `bun vercel`, and any of these behind `corepack`) is reported
 * as a Vercel call whose command word is the wrapper, so it can never equal the
 * absolute lockfile path.
 *
 * NOT covered (documented limits): a command word held in a variable (`$V
 * deploy`) whose value is not assigned in a form the indirect-dispatch rule
 * reads (check-supply-chain-pins.vercel-dispatch.mjs names those forms), a
 * name assembled from pieces (`ver"cel"`, `${A}${B}`), a heredoc body, a script
 * file the run block executes, and a third-party action that deploys without
 * `vercel` in its owner/repo.
 *
 * Pure functions. ASCII only.
 *
 * @see scripts/ci/check-supply-chain-pins.helpers.mjs (consumer)
 * @see docs/internal/implementation/smi-6944-vercel-cli-from-lockfile.md
 */

/** The only accepted spelling of a credentialed Vercel CLI command word. */
export const ABS_VERCEL = '"$GITHUB_WORKSPACE/node_modules/.bin/vercel"'

const KEYWORDS = new Set(['then', 'do', 'else', 'elif', 'if', 'while', 'until', '!', '{', '}'])
const PREFIX_WRAPPERS = new Set([
  'env',
  'sudo',
  'nohup',
  'time',
  'xargs',
  'timeout',
  'nice',
  'corepack',
])
const SHELLS = new Set(['bash', 'sh', 'zsh', 'dash'])
const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*(\[[^\]]*\])?\+?=/

/** Strip surrounding quote characters. */
export function bare(token) {
  return String(token).replace(/^["']+|["']+$/g, '')
}

function baseName(token) {
  return bare(token).split('/').pop()
}

/**
 * Split text into commands, each an array of tokens (quotes retained).
 * @returns {string[][]}
 */
export function splitCommands(text) {
  const src = text.replace(/\\\r?\n/g, ' ')
  const commands = []
  let cur = []
  let tok = ''
  let quote = ''
  const endTok = () => {
    if (tok !== '') {
      cur.push(tok)
      tok = ''
    }
  }
  const endCmd = () => {
    endTok()
    if (cur.length) commands.push(cur)
    cur = []
  }
  for (let i = 0; i < src.length; i++) {
    const c = src[i]
    if (quote) {
      tok += c
      if (c === '\\' && quote === '"' && i + 1 < src.length) {
        tok += src[++i]
      } else if (c === quote) {
        quote = ''
      }
      continue
    }
    if (c === '\\' && i + 1 < src.length) {
      tok += c + src[++i]
    } else if (c === '"' || c === "'") {
      quote = c
      tok += c
    } else if (c === '#' && tok === '') {
      while (i + 1 < src.length && src[i + 1] !== '\n') i++
    } else if (c === ' ' || c === '\t') {
      endTok()
    } else if (c === '&' && (src[i - 1] === '>' || src[i - 1] === '<' || src[i + 1] === '>')) {
      tok += c
    } else if ('\n;|&()`'.includes(c)) {
      endCmd()
    } else {
      tok += c
    }
  }
  endCmd()
  return commands
}

/** Tokens from the real command word onward, or null when there is none. */
export function commandWords(tokens) {
  let i = 0
  while (i < tokens.length) {
    const t = tokens[i]
    const b = bare(t)
    if (ASSIGNMENT.test(t) || KEYWORDS.has(b)) {
      i++
    } else if (PREFIX_WRAPPERS.has(b)) {
      i++
      while (
        i < tokens.length &&
        (tokens[i].startsWith('-') || ASSIGNMENT.test(tokens[i]) || /^\d+[smhd]?$/.test(tokens[i]))
      ) {
        i++
      }
    } else if (b === 'command' || b === 'exec' || b === 'builtin') {
      i++
      if (/^-[vV]/.test(tokens[i] || '')) return null
      while (i < tokens.length && tokens[i].startsWith('-')) i++
    } else {
      break
    }
  }
  return i < tokens.length ? tokens.slice(i) : null
}

function substitutions(token) {
  const out = []
  let from = 0
  for (;;) {
    const at = token.indexOf('$(', from)
    if (at < 0) return out
    let depth = 1
    let j = at + 2
    while (j < token.length && depth > 0) {
      if (token[j] === '(') depth++
      else if (token[j] === ')') depth--
      j++
    }
    out.push(token.slice(at + 2, depth === 0 ? j - 1 : j))
    from = j
  }
}

function unquote(token) {
  const m = token.match(/^(["'])([\s\S]*)\1$/)
  return m ? m[2] : token
}

/**
 * Every raw token list in `text` (assignments and keywords retained), including
 * those inside a quoted `$(...)`, a shell `-c` string and `eval`.
 */
export function allTokenLists(text, depth = 0) {
  const out = []
  for (const toks of splitCommands(text)) {
    out.push(toks)
    if (depth >= 3) continue
    for (const t of toks) {
      for (const inner of substitutions(t)) out.push(...allTokenLists(inner, depth + 1))
    }
    const cmd = commandWords(toks)
    if (!cmd) continue
    if (SHELLS.has(baseName(cmd[0]))) {
      const k = cmd.findIndex((t, j) => j > 0 && /^-[a-zA-Z]*c$/.test(t))
      if (k > 0 && cmd[k + 1]) out.push(...allTokenLists(unquote(cmd[k + 1]), depth + 1))
    } else if (bare(cmd[0]) === 'eval') {
      out.push(...allTokenLists(unquote(cmd.slice(1).join(' ')), depth + 1))
    }
  }
  return out
}

/**
 * Every command in `text`, including those inside a quoted `$(...)`, a shell
 * `-c` string and `eval`. Each entry is the token list from the command word on.
 */
export function allCommands(text) {
  return allTokenLists(text)
    .map(commandWords)
    .filter((cmd) => cmd !== null)
}

// ---------------------------------------------------------------------------
// Vercel CLI command words
// ---------------------------------------------------------------------------
const VERCEL_VERBS = new Set([
  'alias',
  'bisect',
  'blob',
  'build',
  'cache',
  'certs',
  'curl',
  'deploy',
  'dev',
  'dns',
  'domains',
  'env',
  'git',
  'guidance',
  'help',
  'httpstat',
  'init',
  'inspect',
  'install',
  'integration',
  'link',
  'list',
  'ls',
  'login',
  'logout',
  'logs',
  'mcp',
  'microfrontends',
  'open',
  'project',
  'promote',
  'pull',
  'redeploy',
  'remove',
  'rm',
  'rolling-release',
  'rollback',
  'target',
  'teams',
  'telemetry',
  'upgrade',
  'whoami',
])
const VERCEL_VALUE_FLAGS = new Set([
  '--token',
  '-t',
  '--scope',
  '-S',
  '--cwd',
  '-A',
  '--local-config',
  '--global-config',
  '-Q',
  '--team',
  '--project',
  '--environment',
  '--target',
  '--archive',
])
const VERCEL_META_FLAGS = new Set(['--version', '-v', '--help', '-h'])

/** True when the command word is `vercel` or `vc`, any path, optional `@ver`. */
export function isVercelWord(word) {
  return /^(vercel|vc)(@.*)?$/.test(baseName(word))
}

const DIRECT_RUNNERS = new Set(['npx', 'bunx', 'pnpx'])
const RUNNER_VERBS = {
  npm: new Set(['exec', 'x']),
  pnpm: new Set(['dlx', 'exec', 'run']),
  yarn: new Set(['dlx', 'exec', 'run']),
  bun: new Set(['x', 'run']),
}
const RUNNER_VALUE_FLAGS = new Set(['--prefix', '--workspace', '-w', '--cwd', '-C', '--call', '-c'])

/**
 * Index of the token naming the Vercel package or bin when `cmd` is a package
 * runner that runs it (`npx vercel`, `npx -p vercel x`, `npm exec -- vercel`,
 * `yarn dlx vc`, `pnpm vercel`, ...), else -1. `corepack` is already peeled.
 */
function wrappedVercelIndex(cmd) {
  const pm = baseName(cmd[0])
  if (!DIRECT_RUNNERS.has(pm) && !RUNNER_VERBS[pm]) return -1
  let i = 1
  // Skips flags; returns the index of a `-p/--package vercel` spec, else -1.
  const skipFlags = () => {
    while (i < cmd.length) {
      const t = bare(cmd[i])
      if (t === '--') {
        i++
        return -1
      }
      if (!t.startsWith('-')) return -1
      if (t === '-p' || t === '--package') {
        if (isVercelWord(cmd[i + 1] || '')) return i + 1
        i += 2
      } else if (t.startsWith('--package=')) {
        if (isVercelWord(t.slice('--package='.length))) return i
        i++
      } else {
        i += RUNNER_VALUE_FLAGS.has(t) ? 2 : 1
      }
    }
    return -1
  }
  let hit = skipFlags()
  if (hit >= 0) return hit
  if (i >= cmd.length) return -1
  if (!DIRECT_RUNNERS.has(pm)) {
    const sub = bare(cmd[i])
    if (pm !== 'npm' && isVercelWord(sub)) return i // implicit bin: `yarn vercel`
    if (!RUNNER_VERBS[pm].has(sub)) return -1
    i++
    hit = skipFlags()
    if (hit >= 0) return hit
    if (i >= cmd.length) return -1
  }
  return isVercelWord(cmd[i]) ? i : -1
}

/**
 * Every Vercel CLI invocation: `[{ word, verb }]`. `word` is the raw command word
 * (quotes retained). `verb` is the subcommand; a call with no known subcommand is
 * the CLI's implicit deploy, reported as `deploy`. `--version`/`--help` alone
 * report `meta`.
 */
export function vercelCalls(body) {
  const out = []
  for (const cmd of allCommands(body)) {
    // `node <path>/vc.js ...` runs the CLI entrypoint directly, bypassing the bin link.
    const isNode = /^node(js)?$/.test(baseName(cmd[0]))
    const viaNode = isNode ? cmd.findIndex((t) => baseName(t) === 'vc.js') : -1
    // A package runner (`npx vercel`, `yarn dlx vc`, ...) reports the runner and its
    // arguments up to the package as the command word.
    const viaRunner = viaNode < 0 && !isVercelWord(cmd[0]) ? wrappedVercelIndex(cmd) : -1
    if (viaNode < 0 && viaRunner < 0 && !isVercelWord(cmd[0])) continue
    const at = Math.max(viaNode, viaRunner, 0)
    const word = viaRunner >= 0 ? cmd.slice(0, viaRunner + 1).join(' ') : cmd[at]
    let verb = ''
    let meta = false
    for (let i = at + 1; i < cmd.length; i++) {
      const t = bare(cmd[i])
      if (VERCEL_META_FLAGS.has(t)) meta = true
      if (VERCEL_VALUE_FLAGS.has(t)) {
        i++
        continue
      }
      if (t.startsWith('-')) continue
      verb = VERCEL_VERBS.has(t) ? t : 'deploy'
      break
    }
    out.push({ word, verb: verb || (meta ? 'meta' : 'deploy') })
  }
  return out
}

/** Vercel CLI invocations whose command word is not exactly {@link ABS_VERCEL}. */
export function nonLockfileVercelCalls(body) {
  return vercelCalls(body).filter((c) => c.word !== ABS_VERCEL)
}

// ---------------------------------------------------------------------------
// Package-manager commands
// ---------------------------------------------------------------------------
const VALUE_FLAGS = new Set([
  '--prefix',
  '--registry',
  '--userconfig',
  '--cache',
  '--workspace',
  '-w',
  '--loglevel',
  '--omit',
  '--include',
  '--tag',
  '--otp',
  '--before',
  '--scope',
  '--call',
  '-c',
  '--script-shell',
])
const NPM_INSTALL_VERBS = new Set(['i', 'in', 'ins', 'inst', 'insta', 'instal', 'install', 'add'])

function parseArgs(tokens) {
  let global = false
  const packageSpecs = []
  const positionals = []
  const afterDashDash = []
  let seenDashDash = false
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i]
    if (t === '--') {
      seenDashDash = true
    } else if (seenDashDash) {
      const b = bare(t)
      if (b && !/^[/.~]/.test(b) && !b.includes('://')) afterDashDash.push(b)
    } else if (t === '--global' || t === '--location=global' || /^-[a-zA-Z]*g[a-zA-Z]*$/.test(t)) {
      global = true
    } else if (t === '--location') {
      if (tokens[i + 1] === 'global') global = true
      i++
    } else if (t === '-p' || t === '--package') {
      if (tokens[i + 1]) packageSpecs.push(bare(tokens[i + 1]))
      i++
    } else if (t.startsWith('--package=')) {
      packageSpecs.push(bare(t.slice('--package='.length)))
    } else if (VALUE_FLAGS.has(t)) {
      i++
    } else if (!t.startsWith('-')) {
      const b = bare(t)
      if (b && !/^[/.~]/.test(b) && !b.includes('://')) positionals.push(b)
    }
  }
  return { global, packageSpecs, positionals, afterDashDash }
}

/**
 * Every package-manager command that installs or fetches-and-runs a package.
 * `kind` is `install` (npm/pnpm/yarn/bun install|add|i, `yarn global add`) or
 * `run` (npx, npm exec|x, pnpm dlx, yarn dlx, bunx, bun x). `fetchAlways` marks
 * the dlx family, which never resolves from the workspace tree.
 *
 * @returns {Array<{ pm: string, kind: 'install'|'run', global: boolean,
 *   specs: string[], fetchAlways: boolean }>}
 */
export function packageCommands(body) {
  const out = []
  for (const cmd of allCommands(body)) {
    const pm = baseName(cmd[0])
    const rest = cmd.slice(1)
    if (pm === 'npx' || pm === 'bunx' || pm === 'pnpx') {
      const a = parseArgs(rest)
      out.push({
        pm,
        kind: 'run',
        global: false,
        specs: [...a.packageSpecs, ...a.positionals.slice(0, 1)],
        fetchAlways: pm !== 'npx',
      })
    } else if (['npm', 'pnpm', 'yarn', 'bun'].includes(pm)) {
      const a = parseArgs(rest)
      const [sub, ...args] = a.positionals
      if (!sub) continue
      if (pm === 'yarn' && sub === 'global' && args[0] === 'add') {
        out.push({ pm, kind: 'install', global: true, specs: args.slice(1), fetchAlways: false })
      } else if (NPM_INSTALL_VERBS.has(sub) || (pm === 'pnpm' && sub === 'add')) {
        const specs = [...args, ...a.afterDashDash]
        out.push({ pm, kind: 'install', global: a.global, specs, fetchAlways: false })
      } else if ((pm === 'npm' && (sub === 'exec' || sub === 'x')) || sub === 'dlx') {
        const specs = [...a.packageSpecs, ...args.slice(0, 1)]
        out.push({ pm, kind: 'run', global: false, specs, fetchAlways: sub === 'dlx' })
      } else if (pm === 'bun' && sub === 'x') {
        const specs = [...a.packageSpecs, ...args.slice(0, 1)]
        out.push({ pm, kind: 'run', global: false, specs, fetchAlways: true })
      }
    }
  }
  return out
}
