#!/usr/bin/env node
/**
 * Guard-local wrapper/launcher-peeling helpers for scripts/ruflo-host-
 * guard.mjs (SMI-6744 Wave 4 governance round: H-A launcher prefixes, H-B
 * `env -S`, L-A `docker container exec`; delta round: H-1 launcher-table
 * arity fixes + `script -c`, H-2 exec/command/noglob/builtin per-wrapper
 * value-flags, H-3 `env -S` skip-past-own-flags + glued form).
 *
 * Split out of the guard's own orchestration file purely to stay under the
 * 500-line-per-file convention this repo keeps by hand for .mjs files
 * under scripts/ (M3 correction: not enforced by tooling here --
 * scripts/check-file-length.mjs only runs via lint-staged for *.ts/*.sh;
 * SMI-5994) -- these are guard-SPECIFIC wrapper-peeling helpers, not
 * general-purpose primitives every consumer of shell-command-normalize.mjs
 * would want, so they stay out of that shared module. The LAUNCHER TABLE
 * was the exception: env-read-guard.mjs turned out to need it too
 * (SMI-6903 round 22, `timeout 5 cat .env`), so it now lives in the shared
 * `shell-command-launchers.mjs` and is imported here. Shell-fed-text and inline-
 * interpreter-script helpers (H-4/H-8/M-1/M-2, plus the pre-existing H-F)
 * split further into their own sibling file, `ruflo-host-guard-shell-
 * fed.mjs` (same hand-kept convention, once the delta round's fixes grew
 * this file past the limit).
 */

import { launcherDashCCommand, peelOneLauncher } from './shell-command-launchers.mjs'
import { basenameOf, normalizeWrappers, stripFlags } from './shell-command-normalize.mjs'

// The process-launcher table (H-A/H-1/H-2 fixes) and `peelOneLauncher` live
// in `shell-command-launchers.mjs` since SMI-6903 round 22, shared with the
// env guard's transparent-head reading; the table's docblock carries the
// per-launcher shell measurements and the arity model.

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
 * positional in either order. The set and the extractor are the shared
 * `DASH_C_LAUNCHERS` / `launcherDashCCommand` since SMI-6903 rounds 23 and
 * 24: round 23 added `flock FILE -c COMMAND` (measured running its body in
 * bash 5.2) and round 24 found this guard's own extractor still matched a
 * bare `-c` only, so `script --command 'ruflo …'`, `--command=…`, `-c…`
 * glued and `-qc …` clustered reached the fail-closed arity fallback or
 * allowed where the env guard read them.
 */

/**
 * `exec`/`command`/`noglob`/`builtin`-aware, launcher-aware,
 * `docker container exec`-aware, `script`/`su`/`dtrace`/`flock` `-c`-aware
 * wrapper normalization (round 1 finding 2; docs fact 3; H-A/H-1/L-A/M-6
 * fixes). Alternates peeling ONE leading launcher/`docker container exec`
 * prefix and calling the shared unwrap until neither changes anything or a
 * nested shell body is found. The shared `launcherDashCCommand` runs FIRST,
 * on `current` before any peeling touches `script` itself, since the
 * launcher table's own `script` entry would otherwise mis-model `-c`'s
 * value (`su`/`dtrace` are not launcher-table entries at all, so this is
 * their only unwrap path). The guard-local alias it once went through was
 * removed in SMI-6908 (F-10).
 * @param {string[]} argvIn
 * @returns {{argv: string[], nested: string|null}}
 */
export function normalizeWrappersWithExec(argvIn) {
  let current = argvIn
  for (let pass = 0; pass < 8; pass++) {
    const dashCNested = launcherDashCCommand(current)
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
