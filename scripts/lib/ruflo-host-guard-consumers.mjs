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
 * ex-commands, tmux's `send-keys`/`new-window`, screen's `-X stuff`,
 * expect's `-c '...spawn ...'`, sqlite3's `.shell`/`.system`/piped-
 * `.once`/`.output` dot-commands, psql's `\!` and `COPY`/`\copy ... PROGRAM`
 * clauses, and osascript's `-e` AppleScript source (round-4 cross-family
 * gate follow-up).
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
import { extractTmuxTexts } from './ruflo-host-guard-consumers-tmux.mjs'
import { extractAwkTexts, extractSedTexts } from './ruflo-host-guard-consumers-awksed.mjs'
import {
  extractSqliteTexts,
  extractPsqlTexts,
  extractOsascriptTexts,
} from './ruflo-host-guard-consumers-dbshell.mjs'

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

/**
 * Round-3 governance fix: `view`, `vimdiff`, `vimdiff`'s `-d` twin and `ex`
 * are the SAME binary under a different argv[0] (vim's own personality
 * switch) and honor `-c`/`+`/`--cmd` identically — the commit body already
 * claimed them, the set did not contain them (measured: `vimdiff -c
 * '!ruflo …'` reached ALLOW). `rvim`/`rview`/`rgvim`/`rgview` are the
 * restricted personalities: they REFUSE `:!`, but they still run `-c`
 * Vimscript, so the source arm still needs to see them. `evim`/`eview` are
 * the easy personalities and have no such restriction at all.
 */
const VIM_BASENAMES = new Set([
  'vim',
  'nvim',
  'gvim',
  'mvim',
  'vi',
  'view',
  'vimdiff',
  'gvimdiff',
  'nvimdiff',
  'ex',
  'evim',
  'eview',
  'rvim',
  'rview',
  'rgvim',
  'rgview',
])

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

/**
 * screen `-X stuff '<text>'` types literal text into a session, same as tmux
 * send-keys.
 *
 * Round-3 governance fix: real screen accepts its OWN options in any order,
 * including BETWEEN `-X` and the command word — `screen -X -S sess stuff
 * '<text>'` is the documented form for targeting a named session, and the
 * previous cut required `stuff` to sit at exactly `-X`+1, so that form
 * reached ALLOW (measured). Locate `stuff` anywhere after `-X` instead, and
 * take the first following token that is not itself a flag.
 */
function extractScreenTexts(base, argv, alignedTokens) {
  if (base !== 'screen') return null
  const xIdx = argv.indexOf('-X')
  if (xIdx === -1) return null
  const stuffIdx = argv.indexOf('stuff', xIdx + 1)
  if (stuffIdx === -1) return null
  let i = stuffIdx + 1
  while (i < argv.length && argv[i].startsWith('-') && argv[i] !== '-') i++
  const tok = alignedTokens[i]
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
    // Round-3 governance fix: the whole `-c` body is ALSO Tcl SOURCE, and gets
    // the same `INLINE_SCRIPT_BARE_NAME_RE`-then-embedded-recursion treatment
    // H-8 gives node/python source (which is what the commit body already
    // claimed: "Tcl as source"). Without it, every Tcl process-launching form
    // that is not a bare leading `spawn`/`exec` reached ALLOW -- measured:
    // `expect -c 'open "|ruflo memory store" r'`, Tcl's own pipe-open.
    results.push({ text: s, kind: 'source' })
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
  extractSqliteTexts,
  extractPsqlTexts,
  extractOsascriptTexts,
]

/**
 * SMI-6869 consumer-string family dispatcher. Tries every family extractor
 * in turn (argv[0]'s basename decides which, if any, applies) and returns
 * the first one that finds something — `null` when this segment isn't any
 * of the eleven recognized consumer shapes, or found nothing extractable
 * (e.g. an awk `-f file` program naming a real file, or an ssh call with
 * zero trailing remote-command tokens). `segmentTokens` is forwarded to
 * every extractor (M5 follow-up, post round-3 governance) so awk/sed can
 * see a heredoc feeding a readable-stdin `-f`/`--file` value; every other
 * extractor ignores the extra argument. `segments`/`segmentIndex` remain
 * unused — accepted only for interface parity with `findShellFedLiteralText`,
 * should a future family need cross-segment pipe context.
 * @param {string[]} normalizedArgv post wrapper/launcher-peel argv (original case)
 * @param {Array<{value: string, subs?: string[]}>} alignedTokens original
 *   tokens aligned to `normalizedArgv` (see `tokensForArgv`)
 * @param {Array<object>} segmentTokens the RAW segment (word/op/heredoc
 *   tokens interleaved) — used by the awk/sed extractors' M5 heredoc lookup
 * @param {Array<object>} _segments unused (interface parity, see above)
 * @param {number} _segmentIndex unused (interface parity, see above)
 * @returns {Array<{text: string, kind: 'shell'|'source'}> | null}
 */
export function extractConsumerTexts(
  normalizedArgv,
  alignedTokens,
  segmentTokens,
  _segments,
  _segmentIndex
) {
  if (normalizedArgv.length === 0) return null
  const base = basenameOf(normalizedArgv[0]).toLowerCase()
  for (const extractor of EXTRACTORS) {
    const result = extractor(base, normalizedArgv, alignedTokens, segmentTokens)
    if (result) return result
  }
  return null
}
