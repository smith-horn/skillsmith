#!/usr/bin/env node
/**
 * Consumer-string family extraction for scripts/ruflo-host-guard.mjs
 * (SMI-6869 consumer-string round). H1-H9/H8(ii)/H-8 model a FIXED set of
 * launchers/interpreters whose own argv or stdin text is worth re-scanning.
 * This module extends that idea to a second, broader class: programs whose
 * OWN arguments (or a config value they write) embed a string THAT PROGRAM
 * will itself hand to a shell or spawn as a new process — awk's
 * `system()`/pipe-to-command, sed's `s///e` flag and `Ne` command, ssh's
 * single-argument remote command, git's exec-relevant config keys (`-c
 * key=value` / `git config key value`), vim/nvim's `-c`/`+`/`--cmd`
 * ex-commands, tmux's `send-keys`/`new-window`, screen's `-X stuff`, and
 * expect's `-c '...spawn ...'`.
 *
 * Each family's extractor returns `{text, kind}` pairs: `kind: 'shell'` for
 * text the family hands directly to a real shell/exec (recursed
 * non-embedded — the same treatment an `env -S` body or a nested `-c` body
 * gets); `kind: 'source'` for text that is itself DSL/script source worth
 * the same `INLINE_SCRIPT_BARE_NAME_RE`-then-embedded-recursion treatment
 * H-8 already gives node/python/perl/ruby/php source text (see
 * `ruflo-host-guard-shell-fed.mjs`'s `extractInlineScriptText`/
 * `INLINE_SCRIPT_BARE_NAME_RE`). Wired into `evaluateGuardSegment`
 * immediately after the H-8 inline-script step and before the M-6
 * bare-name inversion — see that function's own pipeline-order docblock in
 * `scripts/ruflo-host-guard.mjs`.
 *
 * `EXEC_ENV_VARS` also lives here (not consumer-string extraction itself,
 * but the same "text this guard must treat as a real shell command" theme)
 * so `ruflo-host-guard-predicates.mjs`'s H8(i) can recognize a
 * process-launching env var's assigned value without duplicating the set.
 */

import { basenameOf } from './shell-command-normalize.mjs'
import { extractGitTexts } from './ruflo-host-guard-consumers-git.mjs'

/**
 * Env vars whose VALUE a downstream program execs as a shell command line —
 * git's own pager/editor/ssh/askpass/diff/sequence-editor/proxy hooks, the
 * generic $PAGER/$EDITOR/$VISUAL/$BROWSER/$MANPAGER/$FCEDIT every
 * pager/editor/browser-invoking tool honors, less(1)'s $LESSOPEN/$LESSCLOSE
 * preprocessor hooks, and npm's script-shell override (both the historical
 * uppercase spelling and the lowercase `npm_config_*` form npm itself
 * injects into child-process environments — env var names are
 * case-sensitive, so both are listed).
 */
export const EXEC_ENV_VARS = new Set([
  'PAGER',
  'GIT_PAGER',
  'EDITOR',
  'VISUAL',
  'GIT_EDITOR',
  'GIT_SSH',
  'GIT_SSH_COMMAND',
  'GIT_ASKPASS',
  'SSH_ASKPASS',
  'GIT_EXTERNAL_DIFF',
  'GIT_PROXY_COMMAND',
  'GIT_SEQUENCE_EDITOR',
  'BROWSER',
  'MANPAGER',
  'LESSOPEN',
  'LESSCLOSE',
  'FCEDIT',
  'NPM_CONFIG_SCRIPT_SHELL',
  'npm_config_script_shell',
])

/**
 * H8(i) extension (SMI-6869 round 2): the VALUE of an `EXEC_ENV_VARS`
 * assignment is real shell text a downstream program will exec — not just
 * a bare tool name, so `PAGER='npx ruflo memory store' git log` and
 * `GIT_SSH_COMMAND='sh -c "ruflo memory store"' git fetch` need the SAME
 * full-pipeline recursion an `env -S` body or a nested `-c` body gets, not
 * only the cheap first-word exact-match `checkAssignmentValuePredicate`
 * already does. Runs on the SAME pre-strip word tokens H8(i) reads (before
 * wrapper normalization can discard a bare leading assignment), so it
 * catches both the bare-prefix form (`PAGER=... cmd`) and the `env`-
 * argument form (`env PAGER=... cmd`) identically — this scans every token
 * in the segment regardless of position, exactly like H8(i) itself.
 * @param {Array<{value: string}>} wordTokens pre-strip word tokens (this segment)
 * @returns {Array<{text: string, kind: 'shell'}> | null}
 */
export function extractExecEnvVarTexts(wordTokens) {
  const results = []
  for (const tok of wordTokens) {
    const m = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(tok.value)
    if (!m) continue
    const [, key, value] = m
    if (EXEC_ENV_VARS.has(key)) results.push({ text: value, kind: 'shell' })
  }
  return results.length > 0 ? results : null
}

const AWK_BASENAMES = new Set(['awk', 'gawk', 'mawk', 'nawk'])

/** awk/gawk/mawk/nawk: `system("...")`/pipe-to-command live inside the PROGRAM text. */
function extractAwkTexts(base, argv, alignedTokens) {
  if (!AWK_BASENAMES.has(base)) return null
  let i = 1
  let sawDashF = false
  while (i < argv.length) {
    const a = argv[i]
    if (a === '--') {
      i++
      break
    }
    if (a === '-f' || a === '--file') {
      sawDashF = true
      i += 2
      continue
    }
    if (a === '-v' || a === '-F' || a === '--assign') {
      i += 2
      continue
    }
    if (a.startsWith('--file=')) {
      sawDashF = true
      i++
      continue
    }
    if (a.startsWith('-f') && a !== '-f') {
      sawDashF = true
      i++
      continue
    }
    if (a.startsWith('-') && a !== '-') {
      i++
      continue
    }
    break
  }
  // `-f progfile` reads the program from a FILE -- unreadable, out of reach
  // by design (same posture as a shell's own `source f`/`sh <file>`).
  if (sawDashF || i >= argv.length || !alignedTokens[i]) return null
  return [{ text: alignedTokens[i].value, kind: 'source' }]
}

const SED_BASENAMES = new Set(['sed', 'gsed'])
// `s<delim>pattern<delim>replacement<delim>flags` -- delimiter-agnostic via
// a backreference to whatever character follows `s`, the same technique
// `INLINE_SCRIPT_BARE_NAME_RE` uses for quote-agnostic matching.
const SED_S_COMMAND_RE = /s(.)((?:\\.|(?!\1)[\s\S])*)\1((?:\\.|(?!\1)[\s\S])*)\1([a-zA-Z0-9]*)/g
// sed's `[addr]e command` -- executes `command` and inserts its output;
// distinct from the `s///e` FLAG above (a single trailing character on an
// s-command) -- this `e` is its own command letter, optionally preceded by
// a numeric or `$` address.
const SED_E_COMMAND_RE = /(?:^|;)\s*(?:[0-9]+|\$)?\s*e\s+([^\n;]+)/

function extractSedScriptTexts(script) {
  const results = []
  for (const m of script.matchAll(SED_S_COMMAND_RE)) {
    if (/e/.test(m[4])) results.push({ text: m[3], kind: 'shell' })
  }
  const eCmd = SED_E_COMMAND_RE.exec(script)
  if (eCmd) results.push({ text: eCmd[1], kind: 'shell' })
  return results
}

/** sed/gsed: the `s///e` flag and the `Ne command` form both hand a shell command to /bin/sh. */
function extractSedTexts(base, argv, alignedTokens) {
  if (!SED_BASENAMES.has(base)) return null
  const scripts = []
  let sawDashF = false
  let i = 1
  while (i < argv.length) {
    const a = argv[i]
    if (a === '--') {
      i++
      break
    }
    if (a === '-e' || a === '--expression') {
      if (alignedTokens[i + 1]) scripts.push(alignedTokens[i + 1].value)
      i += 2
      continue
    }
    if (a.startsWith('--expression=')) {
      scripts.push(a.slice('--expression='.length))
      i++
      continue
    }
    if (a.startsWith('-e') && a !== '-e') {
      scripts.push(a.slice(2))
      i++
      continue
    }
    if (a === '-f' || a === '--file') {
      sawDashF = true
      i += 2
      continue
    }
    if (a.startsWith('-f') && a !== '-f') {
      sawDashF = true
      i++
      continue
    }
    if (a.startsWith('-') && a !== '-') {
      i++
      continue
    }
    break
  }
  if (scripts.length === 0 && !sawDashF && alignedTokens[i]) {
    scripts.push(alignedTokens[i].value)
  }
  if (scripts.length === 0) return null
  const results = scripts.flatMap(extractSedScriptTexts)
  return results.length > 0 ? results : null
}

const SSH_VALUE_FLAGS = new Set([
  '-p',
  '-i',
  '-l',
  '-F',
  '-c',
  '-D',
  '-L',
  '-R',
  '-W',
  '-b',
  '-e',
  '-J',
  '-B',
  '-I',
])

/** `-o` option names whose value ssh itself execs as a shell command. */
const SSH_SHELL_OPTION_NAMES = new Set([
  'proxycommand',
  'localcommand',
  'remotecommand',
  'permitlocalcommand',
])

/** @param {string} raw the `OptionName=value` text past `-o`/glued `-oOptionName=value`'s prefix */
function extractSshDashOValue(raw) {
  const eq = raw.indexOf('=')
  if (eq === -1) return null
  const name = raw.slice(0, eq).toLowerCase()
  return SSH_SHELL_OPTION_NAMES.has(name) ? raw.slice(eq + 1) : null
}

/**
 * ssh/slogin: (round 2) EVERY non-flag argument after the destination is
 * part of the remote command — real ssh joins them all with spaces before
 * handing the result to the remote shell — not just a single trailing
 * token, so `ssh host 'ruflo memory store' -v` (a stray flag-shaped token
 * AFTER the remote command text) still denies. Also extracts `-o
 * ProxyCommand=...`/`LocalCommand=`/`RemoteCommand=`/`PermitLocalCommand=`
 * (case-insensitive option name, separate `-o value` or glued `-ovalue`) —
 * ssh execs THAT value as a shell command directly, independent of
 * whether a remote command follows at all.
 */
function extractSshTexts(base, argv, alignedTokens) {
  if (base !== 'ssh' && base !== 'slogin') return null
  const results = []
  const remoteParts = []
  let sawDestination = false
  let i = 1
  while (i < argv.length) {
    const a = argv[i]
    if (a === '-o') {
      const valTok = alignedTokens[i + 1]
      const shellText = valTok ? extractSshDashOValue(valTok.value) : null
      if (shellText !== null) results.push({ text: shellText, kind: 'shell' })
      i += 2
      continue
    }
    if (a.startsWith('-o') && a !== '-o') {
      const shellText = extractSshDashOValue(a.slice(2))
      if (shellText !== null) results.push({ text: shellText, kind: 'shell' })
      i++
      continue
    }
    if (SSH_VALUE_FLAGS.has(a)) {
      i += 2
      continue
    }
    if (a.startsWith('-') && a !== '-') {
      i++
      continue
    }
    if (!sawDestination) {
      sawDestination = true
    } else {
      const tok = alignedTokens[i]
      if (tok) remoteParts.push(tok.value)
    }
    i++
  }
  if (remoteParts.length > 0) {
    results.push({ text: remoteParts.join(' '), kind: 'shell' })
  }
  return results.length > 0 ? results : null
}

const VIM_BASENAMES = new Set(['vim', 'nvim', 'gvim', 'mvim', 'vi'])

function classifyVimExCommand(raw) {
  const cmd = raw.startsWith(':') ? raw.slice(1) : raw
  if (cmd.startsWith('!')) return { text: cmd.slice(1), kind: 'shell' }
  const term = /^terminal\s+(.+)$/i.exec(cmd)
  if (term) return { text: term[1], kind: 'shell' }
  return { text: cmd, kind: 'source' }
}

/**
 * vim/nvim family: `-c`/`--cmd`/a leading-`+` positional all run an EX
 * COMMAND before editing starts. `:!cmd`/a bare `!cmd` shells out directly
 * (real shell text); `terminal cmd` opens a terminal running `cmd` (also
 * real shell text); anything else is Vimscript SOURCE, given the same
 * `INLINE_SCRIPT_BARE_NAME_RE`-then-embedded treatment H-8 gives node/
 * python/etc source text (catches `call system("ruflo …")` via that shared
 * quoted-text regex, with no Vimscript-specific parsing needed).
 */
function extractVimTexts(base, argv, alignedTokens) {
  if (!VIM_BASENAMES.has(base)) return null
  const raws = []
  let i = 1
  while (i < argv.length) {
    const a = argv[i]
    if (a === '-c' || a === '--cmd') {
      if (alignedTokens[i + 1]) raws.push(alignedTokens[i + 1].value)
      i += 2
      continue
    }
    if (a.startsWith('-c') && a !== '-c') {
      raws.push(a.slice(2))
      i++
      continue
    }
    if (a.startsWith('--cmd=')) {
      raws.push(a.slice('--cmd='.length))
      i++
      continue
    }
    if (a.startsWith('+') && a !== '+' && alignedTokens[i]) {
      raws.push(alignedTokens[i].value.slice(1))
      i++
      continue
    }
    i++
  }
  if (raws.length === 0) return null
  return raws.map(classifyVimExCommand)
}

const TMUX_TEXT_SUBCOMMANDS = new Set(['send-keys', 'send'])
const TMUX_SHELL_SUBCOMMANDS = new Set([
  'new-window',
  'neww',
  'split-window',
  'splitw',
  'run-shell',
  'run',
])
const TMUX_KEY_NAMES = new Set(['enter', 'escape', 'tab', 'space', 'c-m', 'c-c', 'c-j'])

/**
 * tmux `send-keys`/`send` types literal text into a pane (a trailing
 * `Enter`/`C-m` submits it to whatever shell is running there); `new-window`/
 * `split-window`/`run-shell`/`run` (and their short aliases) start a NEW
 * pane/window running the given shell command directly.
 */
function extractTmuxTexts(base, argv, alignedTokens) {
  if (base !== 'tmux' || argv.length < 2) return null
  const sub = argv[1]
  const rest = alignedTokens.slice(2).filter((t) => !t.value.startsWith('-'))
  if (TMUX_TEXT_SUBCOMMANDS.has(sub)) {
    const parts = rest.filter((t) => !TMUX_KEY_NAMES.has(t.value.toLowerCase()))
    if (parts.length === 0) return null
    return [{ text: parts.map((t) => t.value).join(' '), kind: 'shell' }]
  }
  if (TMUX_SHELL_SUBCOMMANDS.has(sub)) {
    if (rest.length === 0) return null
    return [{ text: rest.map((t) => t.value).join(' '), kind: 'shell' }]
  }
  return null
}

/** screen `-X stuff '<text>'` types literal text into a session, same as tmux send-keys. */
function extractScreenTexts(base, argv, alignedTokens) {
  if (base !== 'screen') return null
  const xIdx = argv.indexOf('-X')
  if (xIdx === -1 || argv[xIdx + 1] !== 'stuff') return null
  const tok = alignedTokens[xIdx + 2]
  if (!tok) return null
  const text = tok.value.endsWith('\\n') ? tok.value.slice(0, -2) : tok.value
  return [{ text, kind: 'shell' }]
}

/**
 * expect `-c '...'`: a Tcl command string, most dangerously its own
 * `spawn <cmd...>`/`exec <cmd...>` builtins, both of which launch a REAL
 * process from the text following them.
 */
function extractExpectTexts(base, argv, alignedTokens) {
  if (base !== 'expect') return null
  const scripts = []
  let i = 1
  while (i < argv.length) {
    const a = argv[i]
    if (a === '-c') {
      if (alignedTokens[i + 1]) scripts.push(alignedTokens[i + 1].value)
      i += 2
      continue
    }
    if (a.startsWith('-c') && a !== '-c') {
      scripts.push(a.slice(2))
      i++
      continue
    }
    i++
  }
  const results = []
  for (const s of scripts) {
    const m = /\b(?:spawn|exec)\s+(.+)/.exec(s)
    if (m) results.push({ text: m[1], kind: 'shell' })
  }
  return results.length > 0 ? results : null
}

const EXTRACTORS = [
  extractAwkTexts,
  extractSedTexts,
  extractSshTexts,
  extractGitTexts,
  extractVimTexts,
  extractTmuxTexts,
  extractScreenTexts,
  extractExpectTexts,
]

/**
 * SMI-6869 consumer-string family dispatcher. Tries every family extractor
 * in turn (argv[0]'s basename decides which, if any, applies) and returns
 * the first one that finds something — `null` when this segment isn't any
 * of the eight recognized consumer shapes, or found nothing extractable
 * (e.g. an awk `-f file` program, or an ssh call with zero or more than one
 * trailing remote-command token). `segmentTokens`/`segments`/`segmentIndex`
 * are accepted for interface parity with `findShellFedLiteralText` (a
 * future family may need pipe/heredoc context the way heredoc-consumers
 * do) but none of the eight current extractors uses them — every red arm
 * this round closes is a single-segment argv shape.
 * @param {string[]} normalizedArgv post wrapper/launcher-peel argv (original case)
 * @param {Array<{value: string, subs?: string[]}>} alignedTokens original
 *   tokens aligned to `normalizedArgv` (see `tokensForArgv`)
 * @param {Array<object>} _segmentTokens unused (interface parity, see above)
 * @param {Array<object>} _segments unused (interface parity, see above)
 * @param {number} _segmentIndex unused (interface parity, see above)
 * @returns {Array<{text: string, kind: 'shell'|'source'}> | null}
 */
export function extractConsumerTexts(
  normalizedArgv,
  alignedTokens,
  _segmentTokens,
  _segments,
  _segmentIndex
) {
  if (normalizedArgv.length === 0) return null
  const base = basenameOf(normalizedArgv[0]).toLowerCase()
  for (const extractor of EXTRACTORS) {
    const result = extractor(base, normalizedArgv, alignedTokens)
    if (result) return result
  }
  return null
}
