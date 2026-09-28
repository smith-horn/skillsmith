#!/usr/bin/env node
/**
 * Guard-local wrapper-normalization helpers for scripts/ruflo-host-guard.mjs
 * (SMI-6744 Wave 4 governance round: H-A launcher prefixes, H-B `env -S`,
 * H-F shell-fed literal text, L-A `docker container exec`).
 *
 * Split out of the guard's own orchestration file purely to stay under the
 * 500-line file-length gate (scripts/check-file-length.mjs) -- these are
 * guard-SPECIFIC wrapper/launcher-peeling helpers, not general-purpose
 * primitives every consumer of shell-command-normalize.mjs would want, so
 * they stay out of that shared module (env-read-guard.mjs needs none of
 * this).
 */

import { basenameOf, normalizeWrappers, stripFlags, tokenize } from './shell-command-normalize.mjs'

/**
 * Transparent wrappers this guard sees through for its own argv[0]-relative
 * predicates (H4/H5/H8(ii)) and for H9's own eval-detection --
 * `exec`/`command`/`noglob` (round 1 finding 2; docs fact 3) plus `builtin`
 * (H-C fix, SMI-6744 Wave 4 governance round: `builtin eval '...'` needs
 * `builtin` peeled the same way `command eval '...'` needs `command`
 * peeled).
 */
export const TRANSPARENT_WRAPPERS = new Set(['exec', 'command', 'noglob', 'builtin'])

/**
 * Process-wrapping launcher table (H-A fix, SMI-6744 Wave 4 governance
 * round): each of these prefixes a command without itself BEING the
 * command, defeating H4's argv[0]-exact check and H5's "scan forward from
 * a runner" when placed in front of a runner or a bare `ruflo`. One table
 * with an arity column, so the next launcher is a row, not a new branch:
 * `positionals` is the number of bare (non-flag) arguments the launcher
 * itself consumes before the wrapped command starts (0 for most;
 * `timeout <duration>` and `script <file>` take exactly 1); `valueFlags`
 * is the launcher's own flags that consume a following value, so
 * flag-skipping does not mistake that value for the wrapped command. A
 * combined short-flag+value token (`-o0`) is not in `valueFlags` — it is
 * self-contained, and the generic single-token skip below already handles
 * it correctly.
 */
const LAUNCHER_TABLE = new Map(
  [
    { name: 'nohup', positionals: 0, valueFlags: [] },
    { name: 'setsid', positionals: 0, valueFlags: [] },
    { name: 'time', positionals: 0, valueFlags: [] },
    { name: 'unbuffer', positionals: 0, valueFlags: [] },
    { name: 'doas', positionals: 0, valueFlags: [] },
    { name: 'caffeinate', positionals: 0, valueFlags: [] },
    { name: 'timeout', positionals: 1, valueFlags: [] },
    { name: 'nice', positionals: 0, valueFlags: ['-n'] },
    { name: 'stdbuf', positionals: 0, valueFlags: ['-o', '-e', '-i'] },
    { name: 'script', positionals: 1, valueFlags: [] },
    { name: 'chrt', positionals: 0, valueFlags: ['-p'] },
    { name: 'ionice', positionals: 0, valueFlags: ['-c', '-n', '-p'] },
    { name: 'xargs', positionals: 0, valueFlags: ['-I', '-n', '-P', '-d', '-L', '-s'] },
  ].map((entry) => [
    entry.name,
    { positionals: entry.positionals, valueFlags: new Set(entry.valueFlags) },
  ])
)

/** Strips one launcher's own flags (value-flags aware), then its `positionals` bare arguments. */
function stripLauncher(argv, entry) {
  let i = 0
  while (i < argv.length) {
    const a = argv[i]
    if (a === '--') {
      i++
      break
    }
    if (!a.startsWith('-') || a === '-') break
    i += entry.valueFlags.has(a) ? 2 : 1
  }
  return argv.slice(i + entry.positionals)
}

/** Peels ONE leading transparent wrapper or launcher-table entry; null if argv[0] is neither. */
function peelOneLauncher(argv) {
  if (argv.length === 0) return null
  const base = basenameOf(argv[0])
  if (TRANSPARENT_WRAPPERS.has(base)) return stripFlags(argv.slice(1))
  const entry = LAUNCHER_TABLE.get(base)
  if (entry) return stripLauncher(argv.slice(1), entry)
  return null
}

/**
 * `docker container exec [flags] <container> <inner...>` → `<inner...>`
 * (L-A fix, SMI-6744 Wave 4 governance round) — the long-form Docker CLI
 * alias for `docker exec`. Guard-local since the shared `normalizeWrappers`
 * only recognizes the short form and `env-read-guard.mjs` has no
 * equivalent need for the long one.
 */
function stripDockerContainerExec(argv) {
  if (basenameOf(argv[0] ?? '') !== 'docker') return null
  if (argv[1] !== 'container' || argv[2] !== 'exec') return null
  return stripFlags(argv.slice(3)).slice(1)
}

/**
 * `exec`/`command`/`noglob`/`builtin`-aware, launcher-aware,
 * `docker container exec`-aware wrapper normalization (round 1 finding 2;
 * docs fact 3; H-A/L-A fixes). Alternates peeling ONE leading
 * transparent-wrapper/launcher/`docker container exec` prefix and calling
 * the shared unwrap until neither changes anything or a nested shell body
 * is found.
 * @param {string[]} argvIn
 * @returns {{argv: string[], nested: string|null}}
 */
export function normalizeWrappersWithExec(argvIn) {
  let current = argvIn
  for (let pass = 0; pass < 8; pass++) {
    let changed = false
    while (true) {
      const peeled = peelOneLauncher(current)
      if (peeled === null) break
      current = peeled
      changed = true
    }
    const dockerInner = stripDockerContainerExec(current)
    if (dockerInner !== null) {
      current = dockerInner
      changed = true
    }
    const { argv: after, nested } = normalizeWrappers(current)
    if (nested !== null) return { argv: after, nested }
    if (!changed && after.length === current.length) {
      return { argv: after, nested: null }
    }
    current = after
  }
  return { argv: current, nested: null }
}

/**
 * `env -S '<command text>'` / `env --split-string='<command text>'` (H-B
 * fix, SMI-6744 Wave 4 governance round): env's own `-S`/`--split-string`
 * flag re-tokenizes its argument as a SINGLE shell command line (GNU
 * coreutils `env(1)`), collapsing "ruflo memory store ..." into one argv
 * token that the shared `stripEnvPrefix`'s per-token flag/assignment scan
 * never expands back out. Detected on the raw (pre-strip) word values,
 * immediately after `env` — guard-local since no other consumer of
 * `shell-command-normalize.mjs` needs this env-specific flag.
 * @param {string[]} rawValues
 * @returns {string | null} the nested command text, or null if this
 *   segment isn't that shape
 */
export function detectEnvSplitString(rawValues) {
  if (basenameOf(rawValues[0] ?? '') !== 'env') return null
  const a = rawValues[1]
  if (a === undefined) return null
  if (a === '-S' || a === '--split-string') return rawValues[2] ?? null
  if (a.startsWith('--split-string=')) return a.slice('--split-string='.length)
  return null
}

/**
 * Recover the ORIGINAL token objects (with `.subs`) aligned to a
 * normalized argv string array. Every wrapper-stripping step here and in
 * `shell-command-normalize.mjs` only ever drops elements from the FRONT of
 * the array it is given — never reorders, filters from the middle, or
 * appends — so the final normalized argv is always a contiguous SUFFIX of
 * the segment's original word-token list.
 * @param {Array<{value: string}>} originalTokens
 * @param {string[]} normalizedArgv
 */
export function tokensForArgv(originalTokens, normalizedArgv) {
  const start = Math.max(0, originalTokens.length - normalizedArgv.length)
  return originalTokens.slice(start)
}

/** Recognized shell wrappers — mirrors `shell-command-normalize.mjs`'s own `SHELL_COMMANDS`. */
const SHELL_COMMANDS = new Set(['bash', 'sh', 'zsh', 'dash', 'ksh'])

/**
 * H-F fix (SMI-6744 Wave 4 governance round): literal text piped, here-
 * string-fed, or process-substitution-fed into a bare shell invocation
 * (`echo '...' | bash`, `printf '...' | sh`, `bash <<< '...'`,
 * `bash <(echo '...')`) is READABLE TEXT this guard's tokenizer already
 * captures — it just never treated it as a command to evaluate. Runs only
 * when this segment's post-normalize argv[0] resolves to a bare shell (a
 * `-c` body, if any, is handled separately via `normalizeWrappersWithExec`'s
 * own `nested` return, checked by the caller before this is ever reached).
 * Three independent sources, checked in order:
 *   1. a PRECEDING pipeline segment's own `echo`/`printf` literal
 *      arguments (piped in via `|`);
 *   2. a `<<<` here-string operator's following token — the tokenizer
 *      does not model `<<<` as its own operator, so both the `<<<` marker
 *      and the string after it surface as plain WORD tokens, detected
 *      here by value;
 *   3. a `<(...)` sub appearing as this shell's own argument whose inner
 *      command is itself `echo`/`printf` — the sub's own literal
 *      arguments are the fed text (NOT the whole "echo '...'" text, which
 *      the caller's top-level subs-recursion already evaluates separately
 *      and harmlessly).
 * Text sourced from a FILE (`source f`, `sh <file>`, `bash -c "$(cat
 * f)"`) stays out of reach by design (design § 8 item 15) — none of these
 * three sources touches the filesystem.
 * @param {string[]} argvLower this segment's post-normalize, lowercased argv
 * @param {Array<{type:string, value?:string, subs?:string[]}>} segmentTokens
 *   the RAW segment (word + op tokens interleaved)
 * @param {Array<{type:string, value?:string, subs?:string[]}> | null} precedingSegmentTokens
 * @returns {string | null} literal text fed to the shell, or null
 */
export function findShellFedLiteralText(argvLower, segmentTokens, precedingSegmentTokens) {
  if (!SHELL_COMMANDS.has(basenameOf(argvLower[0] ?? ''))) return null

  if (precedingSegmentTokens) {
    const precedingWords = precedingSegmentTokens.filter((t) => t.type === 'word')
    const head = precedingWords[0] ? basenameOf(precedingWords[0].value) : ''
    if (head === 'echo' || head === 'printf') {
      const args = precedingWords.slice(1).map((t) => t.value)
      if (args.length > 0) return args.join(' ')
    }
  }

  const words = segmentTokens.filter((t) => t.type === 'word')
  for (let i = 0; i < words.length; i++) {
    if (words[i].value === '<<<' && i + 1 < words.length) return words[i + 1].value
  }

  for (const t of words) {
    for (const sub of t.subs ?? []) {
      const innerWords = tokenize(sub).filter((tk) => tk.type === 'word')
      if (innerWords.length === 0) continue
      const innerHead = basenameOf(innerWords[0].value)
      if (innerHead === 'echo' || innerHead === 'printf') {
        const args = innerWords.slice(1).map((tk) => tk.value)
        if (args.length > 0) return args.join(' ')
      }
    }
  }

  return null
}
