#!/usr/bin/env node
/**
 * tmux consumer-string extraction -- split out of
 * `ruflo-host-guard-consumers.mjs` (round-3 governance fix) purely to stay
 * under the 500-line file-length gate once the per-subcommand value-flag map
 * grew that file past the limit, same precedent as
 * `ruflo-host-guard-consumers-git.mjs`. Exported as `extractTmuxTexts` and
 * wired into `ruflo-host-guard-consumers.mjs`'s own `EXTRACTORS` list.
 */

const TMUX_TEXT_SUBCOMMANDS = new Set(['send-keys', 'send'])
const TMUX_SHELL_SUBCOMMANDS = new Set([
  'new-window',
  'neww',
  'split-window',
  'splitw',
  'run-shell',
  'run',
  // Round-3 governance fix: the commit body already claimed these five; the
  // set did not contain them (measured: `tmux new-session -d 'ruflo …'`,
  // `respawn-pane -k 'ruflo …'`, `if-shell true 'ruflo …'`,
  // `pipe-pane 'ruflo …'` and `display-popup -E 'ruflo …'` all reached
  // ALLOW). Every one of them takes a SHELL COMMAND argument.
  'new-session',
  'new',
  'respawn-window',
  'respawnw',
  'respawn-pane',
  'respawnp',
  'if-shell',
  'if',
  'pipe-pane',
  'pipep',
  'display-popup',
  'popup',
])
const TMUX_KEY_NAMES = new Set(['enter', 'escape', 'tab', 'space', 'c-m', 'c-c', 'c-j'])

/**
 * Round-3 governance fix: tmux option letters that take their OWN VALUE as
 * the NEXT argv element. The previous cut filtered out flag TOKENS but kept
 * their VALUES, so `-t 0`'s `0` landed at the head of the extracted text and
 * `checkUnresolvedCommand`'s all-digit arm denied three entirely ordinary
 * commands (`tmux send-keys -t 0 'ls -la' Enter`, `tmux send-keys -t 1 'git
 * status' C-m`, `tmux new-window -t 0 'htop'` — all measured). Modelled
 * per-tmux rather than as a generic set for the same reason
 * `H4B_LABEL_VALUE_FLAGS` is (`ruflo-host-guard-predicates.mjs`): the same
 * letter means different things in different programs.
 */
const TMUX_SEND_VALUE_FLAGS = new Set(['-N', '-t'])
const TMUX_WINDOW_VALUE_FLAGS = new Set(['-c', '-e', '-F', '-n', '-t'])
const TMUX_SPLIT_VALUE_FLAGS = new Set(['-c', '-e', '-F', '-l', '-t'])
const TMUX_SESSION_VALUE_FLAGS = new Set(['-c', '-e', '-F', '-f', '-n', '-s', '-t', '-x', '-y'])
const TMUX_RESPAWN_VALUE_FLAGS = new Set(['-c', '-e', '-t'])
const TMUX_POPUP_VALUE_FLAGS = new Set([
  '-b',
  '-c',
  '-d',
  '-e',
  '-h',
  '-s',
  '-S',
  '-t',
  '-T',
  '-w',
  '-x',
  '-y',
])

/**
 * Round-3 governance fix: tmux's VALUE-TAKING option letters, keyed by
 * SUBCOMMAND (tmux(1)). Keyed per-subcommand rather than as one shared set
 * for the same reason `H4B_LABEL_VALUE_FLAGS`
 * (`ruflo-host-guard-predicates.mjs`) is keyed per-launcher: the same letter
 * means different things — `-l` takes a size for `split-window` but is the
 * boolean "literal" for `send-keys`; `-d` is boolean for `new-window` but
 * takes a delay for `run-shell`; `-h` is boolean for `split-window` but
 * takes a height for `display-popup`. A shared set has to pick one meaning
 * and get the other wrong in BOTH directions: mis-reading a boolean as a
 * value flag SWALLOWS the command (a hole), and mis-reading a value flag as
 * boolean leaves its value at the head of the extracted text (the measured
 * false positive this fix exists to remove — `tmux send-keys -t 0 'ls -la'
 * Enter` denied on `0` via `checkUnresolvedCommand`'s all-digit arm).
 */
const TMUX_VALUE_FLAGS_BY_SUB = new Map([
  ['send-keys', TMUX_SEND_VALUE_FLAGS],
  ['send', TMUX_SEND_VALUE_FLAGS],
  ['new-window', TMUX_WINDOW_VALUE_FLAGS],
  ['neww', TMUX_WINDOW_VALUE_FLAGS],
  ['split-window', TMUX_SPLIT_VALUE_FLAGS],
  ['splitw', TMUX_SPLIT_VALUE_FLAGS],
  ['new-session', TMUX_SESSION_VALUE_FLAGS],
  ['new', TMUX_SESSION_VALUE_FLAGS],
  ['run-shell', new Set(['-d', '-t'])],
  ['run', new Set(['-d', '-t'])],
  ['respawn-window', TMUX_RESPAWN_VALUE_FLAGS],
  ['respawnw', TMUX_RESPAWN_VALUE_FLAGS],
  ['respawn-pane', TMUX_RESPAWN_VALUE_FLAGS],
  ['respawnp', TMUX_RESPAWN_VALUE_FLAGS],
  ['if-shell', new Set(['-t'])],
  ['if', new Set(['-t'])],
  ['pipe-pane', new Set(['-t'])],
  ['pipep', new Set(['-t'])],
  ['display-popup', TMUX_POPUP_VALUE_FLAGS],
  ['popup', TMUX_POPUP_VALUE_FLAGS],
])

/** Real positional arguments after `argv[startIndex]`, flags AND their values dropped. */
function tmuxPositionalTokens(argv, alignedTokens, startIndex, valueFlags) {
  const out = []
  let i = startIndex
  while (i < argv.length) {
    const a = argv[i]
    if (a === '--') {
      i++
      continue
    }
    if (valueFlags.has(a)) {
      i += 2
      continue
    }
    if (a.startsWith('-') && a !== '-') {
      i++
      continue
    }
    if (alignedTokens[i]) out.push(alignedTokens[i])
    i++
  }
  return out
}

/**
 * tmux `send-keys`/`send` types literal text into a pane (a trailing
 * `Enter`/`C-m` submits it to whatever shell is running there); the
 * `TMUX_SHELL_SUBCOMMANDS` set starts a NEW pane/window/session, respawns
 * one, or runs a hook/popup, each with the given shell command directly.
 *
 * Round-3 governance fix, second half: a SHELL subcommand's positionals are
 * SEPARATE shell commands (`if-shell <condition> <then> [<else>]`), not one
 * joined command line, so each is emitted as its OWN entry. Joining them put
 * `if-shell`'s own condition word at the head — and when that word is on
 * `NON_EXECUTING_VERBS` (`true`), the bare-name inversion that would have
 * closed the SECOND positional was skipped entirely. `send-keys` keeps the
 * join: its arguments really are one typed string.
 */
export function extractTmuxTexts(base, argv, alignedTokens) {
  if (base !== 'tmux' || argv.length < 2) return null
  const sub = argv[1]
  const isText = TMUX_TEXT_SUBCOMMANDS.has(sub)
  if (!isText && !TMUX_SHELL_SUBCOMMANDS.has(sub)) return null
  const valueFlags = TMUX_VALUE_FLAGS_BY_SUB.get(sub) ?? new Set(['-t'])
  let rest = tmuxPositionalTokens(argv, alignedTokens, 2, valueFlags)
  if (isText) {
    rest = rest.filter((t) => !TMUX_KEY_NAMES.has(t.value.toLowerCase()))
    if (rest.length === 0) return null
    return [{ text: rest.map((t) => t.value).join(' '), kind: 'shell' }]
  }
  if (rest.length === 0) return null
  return rest.map((t) => ({ text: t.value, kind: 'shell' }))
}
