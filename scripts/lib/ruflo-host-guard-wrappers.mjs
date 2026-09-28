#!/usr/bin/env node
/**
 * Guard-local wrapper/launcher-peeling helpers for scripts/ruflo-host-
 * guard.mjs (SMI-6744 Wave 4 governance round: H-A launcher prefixes, H-B
 * `env -S`, L-A `docker container exec`; delta round: H-1 launcher-table
 * arity fixes + `script -c`, H-2 exec/command/noglob/builtin per-wrapper
 * value-flags, H-3 `env -S` skip-past-own-flags + glued form).
 *
 * Split out of the guard's own orchestration file purely to stay under the
 * 500-line file-length gate (scripts/check-file-length.mjs) -- these are
 * guard-SPECIFIC wrapper/launcher-peeling helpers, not general-purpose
 * primitives every consumer of shell-command-normalize.mjs would want, so
 * they stay out of that shared module (env-read-guard.mjs needs none of
 * this). Shell-fed-text and inline-interpreter-script helpers (H-4/H-8/M-1/
 * M-2, plus the pre-existing H-F) split further into their own sibling
 * file, `ruflo-host-guard-shell-fed.mjs` (same 500-line pressure, once the
 * delta round's fixes grew this file past the limit).
 */

import { basenameOf, normalizeWrappers, stripFlags } from './shell-command-normalize.mjs'

/**
 * Process-wrapping launcher table (H-A fix, SMI-6744 Wave 4 governance
 * round; extended by the delta round's H-1/H-2 fixes below): each of these
 * prefixes a command without itself BEING the command, defeating H4's
 * argv[0]-exact check and H5's "scan forward from a runner" when placed in
 * front of a runner or a bare `ruflo`. One table with an arity column, so
 * the next launcher is a row, not a new branch: `positionals` is the
 * number of bare (non-flag) arguments the launcher itself consumes before
 * the wrapped command starts (0 for most; `timeout <duration>`, `script
 * <file>`, and `chrt <priority>` take exactly 1); `valueFlags` is the
 * launcher's own flags that consume a following value, so flag-skipping
 * does not mistake that value for the wrapped command. A combined
 * short-flag+value token (`-o0`) is not in `valueFlags` — it is
 * self-contained, and the generic single-token skip below already handles
 * it correctly.
 *
 * `exec`/`command`/`noglob`/`builtin` moved INTO this table (H-2 fix,
 * SMI-6744 Wave 4 governance round) with their OWN per-wrapper
 * `valueFlags`, instead of being routed through the shared
 * `stripFlags`/`WRAPPER_VALUE_FLAGS` in `shell-command-normalize.mjs` (the
 * former `TRANSPARENT_WRAPPERS` special-case, now removed) — that shared
 * set's `-p`/`--prompt` (sudo's own password-prompt flag) collided with
 * `command -p`'s unrelated, value-LESS POSIX "use the default PATH" flag,
 * so `command -p ruflo memory store` was wrongly parsed as `-p` consuming
 * `ruflo` as its value, leaving no ruflo-shaped text in the residual argv
 * at all (a live bypass, not a cosmetic mis-parse — see
 * `shell-command-normalize.mjs`'s own corrected `WRAPPER_VALUE_FLAGS`
 * docblock). `noglob`/`builtin` take no flags of their own in real Bash;
 * `exec -a <name>` sets argv[0] of the replaced process and is the one
 * `exec` flag that takes a value.
 */
const LAUNCHER_TABLE = new Map(
  [
    { name: 'nohup', positionals: 0, valueFlags: [] },
    { name: 'setsid', positionals: 0, valueFlags: [] },
    { name: 'time', positionals: 0, valueFlags: [] },
    { name: 'unbuffer', positionals: 0, valueFlags: [] },
    { name: 'doas', positionals: 0, valueFlags: [] },
    { name: 'caffeinate', positionals: 0, valueFlags: [] },
    // H-1 fix (SMI-6744 Wave 4 governance round): `timeout -k <duration>
    // 5 ruflo …` / `timeout -s KILL 5 ruflo …` both left `timeout`'s own
    // `-k`/`-s` VALUE sitting where the wrapped command's own duration
    // positional was expected, since neither flag was in this table's
    // valueFlags before.
    { name: 'timeout', positionals: 1, valueFlags: ['-k', '--kill-after', '-s', '--signal'] },
    { name: 'nice', positionals: 0, valueFlags: ['-n'] },
    { name: 'stdbuf', positionals: 0, valueFlags: ['-o', '-e', '-i'] },
    // `script`'s own `-c COMMAND` shape is a NESTED command, not a
    // flag/positional this table's generic stripping models correctly —
    // handled separately by `extractScriptDashC` below, checked BEFORE
    // this table ever peels `script`, so this entry only ever governs the
    // plain `script [flags] [file]` (no `-c`) shape.
    { name: 'script', positionals: 1, valueFlags: [] },
    // H-1 fix: `chrt -f 1 ruflo …`'s priority (`1`) is a REQUIRED bare
    // positional between chrt's own flags and the wrapped command --
    // `positionals: 0` left it sitting as argv[0] of the "residual"
    // command (a bare number), which is exactly the H-7 mis-modelled-
    // arity shape the new fail-closed fallback exists to catch, but a
    // correctly-modelled arity here means H4 catches `ruflo` directly
    // instead.
    { name: 'chrt', positionals: 1, valueFlags: ['-p'] },
    { name: 'ionice', positionals: 0, valueFlags: ['-c', '-n', '-p'] },
    // H-1 fix: `-I`/`-i` added to xargs's own valueFlags -- correct ONLY
    // once `restoreXargsReplacementWordTokens` (below) has first restored
    // the `{}` replacement-string token an UNQUOTED `-I{}`/`-I {}` loses
    // entirely to this guard's own tokenizer (which treats bare `{`/`}`
    // as command-grouping operators, not word characters) -- without that
    // restoration, treating `-I`/`-i` as value-flags here would instead
    // make them wrongly consume the NEXT REAL WORD (the wrapped command's
    // own name) as if it were the vanished replacement string.
    { name: 'xargs', positionals: 0, valueFlags: ['-I', '-i', '-n', '-P', '-d', '-L', '-s'] },
    { name: 'exec', positionals: 0, valueFlags: ['-a'] },
    { name: 'command', positionals: 0, valueFlags: [] },
    { name: 'noglob', positionals: 0, valueFlags: [] },
    { name: 'builtin', positionals: 0, valueFlags: [] },
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

/**
 * Peels ONE leading launcher-table entry (H-2 fix folded `exec`/`command`/
 * `noglob`/`builtin` into the same table, so there is no longer a separate
 * "transparent wrapper" branch using the shared, differently-shaped
 * `stripFlags`); null if argv[0] matches none.
 */
function peelOneLauncher(argv) {
  if (argv.length === 0) return null
  const base = basenameOf(argv[0])
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
 * Commands whose OWN `-c '<command>'` flag takes a full nested command
 * string to recurse into — the same shape as `bash -c`, just spelled with
 * a different flag on a different program (H-1 fix for `script`, M-6 fix
 * for `su`/`dtrace`, SMI-6744 Wave 4 governance round): `script`'s
 * `-c COMMAND` runs COMMAND instead of an interactive session; `su`'s
 * `-c COMMAND` runs COMMAND as the target user; `dtrace`'s `-c COMMAND`
 * runs COMMAND under its probe. Checked BEFORE any of these three is ever
 * peeled by the launcher table (whose generic positional/valueFlags model
 * has no notion of "this flag's value is itself a nested command" and
 * would otherwise mis-model `-c`'s own value as just another flag
 * argument, discarding it). `-c`'s position is order-independent
 * (`script -q -c '...' /dev/null` and `script /dev/null -c '...'` both
 * work) since real `script(1)` accepts its own flags and the output-file
 * positional in either order.
 */
const DASH_C_NESTED_COMMAND_NAMES = new Set(['script', 'su', 'dtrace'])

/**
 * @param {string[]} argv
 * @returns {string | null} the nested command text, or null if this isn't
 *   one of the `DASH_C_NESTED_COMMAND_NAMES`' own `-c` invocation.
 */
function extractDashCNestedCommand(argv) {
  if (!DASH_C_NESTED_COMMAND_NAMES.has(basenameOf(argv[0] ?? ''))) return null
  const idx = argv.indexOf('-c')
  if (idx === -1) return null
  return idx + 1 < argv.length ? argv[idx + 1] : null
}

/**
 * `exec`/`command`/`noglob`/`builtin`-aware, launcher-aware,
 * `docker container exec`-aware, `script`/`su`/`dtrace` `-c`-aware wrapper
 * normalization (round 1 finding 2; docs fact 3; H-A/H-1/L-A/M-6 fixes).
 * Alternates peeling ONE leading launcher/`docker container exec` prefix
 * and calling the shared unwrap until neither changes anything or a
 * nested shell body is found. `extractDashCNestedCommand` runs FIRST, on
 * `current` before any peeling touches `script` itself, since the
 * launcher table's own `script` entry would otherwise mis-model `-c`'s
 * value (`su`/`dtrace` are not launcher-table entries at all, so this is
 * their only unwrap path).
 * @param {string[]} argvIn
 * @returns {{argv: string[], nested: string|null}}
 */
export function normalizeWrappersWithExec(argvIn) {
  let current = argvIn
  for (let pass = 0; pass < 8; pass++) {
    const dashCNested = extractDashCNestedCommand(current)
    if (dashCNested !== null) return { argv: current, nested: dashCNested }

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
 * `env -S '<command text>'` / `env --split-string='<command text>'` / a
 * glued `-S<text>` (H-3 fix, SMI-6744 Wave 4 governance round, extending
 * the original H-B fix): env's own `-S`/`--split-string` flag re-tokenizes
 * its argument as a SINGLE shell command line (GNU coreutils `env(1)`),
 * collapsing "ruflo memory store ..." into one argv token that the shared
 * `stripEnvPrefix`'s per-token flag/assignment scan never expands back
 * out. The original fix only checked `rawValues[1]` directly, missing
 * `-S` preceded by env's OWN other flags/assignments (`env -uX -S '...'`,
 * `env X=1 -S '...'`) and the glued short-option form (`-S'...'`, which
 * this guard's own tokenizer concatenates into one word since there is no
 * space to split on) — this now skips past env's own leading
 * flags/assignments first, then scans every remaining token. Detected on
 * the raw (pre-strip) word values, before this segment's OWN wrapper
 * normalization would otherwise treat `-S` as an ordinary flag — guard-
 * local since no other consumer of `shell-command-normalize.mjs` needs
 * this env-specific flag.
 * @param {string[]} rawValues
 * @returns {string | null} the nested command text, or null if this
 *   segment isn't that shape
 */
export function detectEnvSplitString(rawValues) {
  if (basenameOf(rawValues[0] ?? '') !== 'env') return null
  let i = 1
  while (i < rawValues.length) {
    const a = rawValues[i]
    if (a === '-S' || a === '--split-string') return rawValues[i + 1] ?? null
    if (a.startsWith('--split-string=')) return a.slice('--split-string='.length)
    if (a.startsWith('-S') && a !== '-S') return a.slice(2)
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(a)) {
      i++
      continue
    }
    if (a === '-u' || a === '--unset' || a === '-C' || a === '--chdir') {
      i += 2
      continue
    }
    if (a === '--') break
    if (a.startsWith('-')) {
      i++
      continue
    }
    break // the actual wrapped command name -- no -S here
  }
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
