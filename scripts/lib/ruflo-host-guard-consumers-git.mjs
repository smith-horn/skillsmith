#!/usr/bin/env node
/**
 * git exec-relevant config key extraction — split out of
 * `ruflo-host-guard-consumers.mjs` (SMI-6869 consumer-string round 2)
 * purely to stay under the 500-line-per-file convention this repo keeps by
 * hand for .mjs files under scripts/ (M3 correction: `scripts/check-file-
 * length.mjs`, the machine-enforced pre-commit gate, does NOT observe this
 * path — it's wired through `lint-staged.config.js` for `*.ts`/`*.sh` only;
 * SMI-5994) once round 2's expanded key/pattern tables and the ssh/env-var
 * extensions grew that file past the limit.
 * `git -c key=value` (anywhere before the subcommand) and `git config
 * [--global|...] key value` both write (or, for `-c`, transiently set) a
 * git config key that a later git operation execs as a shell command, or,
 * for an `alias.*` key, as a git alias (a `!`-prefixed value execs via
 * shell; a bare value is just a git subcommand name — extracting it either
 * way is harmless, since recursing a non-ruflo-shaped alias target denies
 * nothing). Exported as `extractGitTexts` and wired into
 * `ruflo-host-guard-consumers.mjs`'s own `EXTRACTORS` list.
 */

import { RUNNER_TOKEN_RE } from './ruflo-host-guard-h1to7.mjs'
import { tokenize } from './shell-command-normalize.mjs'

/**
 * Exact exec-relevant keys (round 2 expansion). `core.hooksPath` is
 * DELIBERATELY not here — its value is a directory PATH git reads hook
 * SCRIPTS from, not text git execs directly, so `git -c
 * core.hooksPath=/tmp/hooks status` stays allow (measured, not a key this
 * guard should ever gate on).
 */
const GIT_EXEC_KEYS = new Set([
  'core.pager',
  'core.editor',
  'core.sshcommand',
  'core.askpass',
  'core.fsmonitor',
  'core.gitproxy',
  'credential.helper',
  'diff.external',
  'gpg.program',
  'sequence.editor',
  'ssh.program',
  // Round-3 governance fix: documented git config keys whose value git runs
  // as a shell command line, missing from the first cut -- each measured
  // reaching ALLOW through `decide()` before this addition.
  'core.alternaterefscommand',
  'interactive.difffilter',
  'web.browser',
  'instaweb.httpd',
  'sendemail.smtpserver',
])
/**
 * Keys whose SUBSECTION varies per-remote/per-driver/per-tool — matched by
 * pattern rather than enumeration. The `.*` freely matches slashes/colons
 * in the middle segment (`credential.https://x.helper`), since `.` in a
 * key name is otherwise the only structural separator git itself parses.
 */
const GIT_EXEC_KEY_PATTERNS = [
  /^pager\./,
  /^credential\..*\.helper$/,
  /^diff\..*\.command$/,
  /^difftool\..*\.cmd$/,
  /^mergetool\..*\.cmd$/,
  /^merge\..*\.driver$/,
  /^filter\..*\.clean$/,
  /^filter\..*\.smudge$/,
  /^filter\..*\.process$/,
  /^gpg\..*\.program$/,
  /^uploadpack\./,
  /^receive\./,
  // Round-3 governance fix: same class, same measurement (each reached
  // ALLOW before this addition). `trailer.<token>.command` is git's own
  // deprecated spelling of `trailer.<token>.cmd`; both exec.
  /^trailer\..*\.command$/,
  /^trailer\..*\.cmd$/,
  /^diff\..*\.textconv$/,
  /^browser\..*\.cmd$/,
  /^man\..*\.cmd$/,
  /^remote\..*\.uploadpack$/,
  /^remote\..*\.receivepack$/,
]
/** `alias.*` only execs its value when that value is itself `!`-prefixed — a bare value is just a git subcommand name. */
const GIT_ALIAS_KEY_RE = /^alias\./
/**
 * Round-3 governance fix: `submodule.<name>.update` has the SAME `!`-prefixed
 * shell-escape shape `alias.*` does (`!command`), and nothing else — a bare
 * value is one of git's own `checkout`/`rebase`/`merge`/`none` keywords.
 */
const GIT_BANG_ONLY_KEY_RE = /^submodule\..*\.update$/

function isGitExecKey(key, value) {
  const lower = key.toLowerCase()
  if (GIT_EXEC_KEYS.has(lower)) return true
  if (GIT_ALIAS_KEY_RE.test(lower) || GIT_BANG_ONLY_KEY_RE.test(lower)) {
    return value.startsWith('!')
  }
  return GIT_EXEC_KEY_PATTERNS.some((re) => re.test(lower))
}

/**
 * A ruflo/claude-flow name spelled as the whole head word or as the final
 * path element of one. Checked even when the head also carries a `$`:
 * `$HOME/bin/ruflo` is unresolvable AS A PATH but still spells the name, so
 * the "cannot spell the name" premise of the skip below does not hold for it.
 */
const RUFLO_NAME_IN_VALUE_HEAD_RE =
  /(?:^|[/\\])(?:ruflo|claude-flow-mcp|claude-flow)(?![a-z0-9._-])/i

/**
 * Governance follow-up (PR #2963 cross-family gate, class-1): a leading
 * `NAME=value` word in the config VALUE is a shell ASSIGNMENT, not the
 * command -- git's own shell runs whatever word comes after it, exactly the
 * same "skip a leading VAR=val before reading the command name" shape
 * H8(i)'s own docblock describes for a real argv (`checkAssignmentValuePredicate`,
 * `ruflo-host-guard-predicates.mjs`). Matches that same regex's key shape
 * (`[A-Za-z_][A-Za-z0-9_]*=`) so the two stay in lockstep.
 */
const ASSIGNMENT_WORD_RE = /^[A-Za-z_][A-Za-z0-9_]*=/

/**
 * Only these op values END a command IN THIS CONSUMER -- a git config
 * VALUE, not a full command line, so a literal `(`/`)` cannot occur here in
 * a position this segmentation would ever need to split on; excluding them
 * costs nothing in this domain. `{`/`}` are GROUPING, not separators, and
 * the tokenizer emits them unconditionally -- so `${VAR}` arrives here as
 * the three tokens `$`, op `{`, `VAR`, op `}`, and treating the braces as
 * boundaries put `VAR` in its own segment where it read as a RESOLVABLE
 * head. That made `${PAGER}` extract-and-deny while `$PAGER` skipped: two
 * spellings of one construct, two verdicts. This is NOT a repo-wide rule
 * about `(`/`)`: `ruflo-host-guard-segments.mjs`'s own `SPLIT_OPS` DOES
 * split on `(`/`)` for its own consumer (a full command line, where a real
 * subshell grouping can appear) -- each consumer's boundary set matches
 * what can actually occur in the text it segments.
 */
const SEGMENT_BOUNDARY_OPS = new Set([';', '&&', '||', '|', '&', '\n'])

/**
 * The value's own tokens, split into COMMAND SEGMENTS on
 * `SEGMENT_BOUNDARY_OPS`, plus a flag for a heredoc or here-string seen
 * anywhere in the value. A config value is shell TEXT and can hold more
 * than one command (`$X; ruflo memory store`); testing only the whole
 * value's first word read segment 1's head and discarded every later
 * segment, the shape that let an unresolvable head hide a resolvable
 * invocation behind a `;`/`&&`/`||`/`|`/newline.
 */
function valueSegments(body) {
  const segments = []
  let current = []
  let sawHeredoc = false
  for (const t of tokenize(body)) {
    if (t.type === 'heredoc') {
      sawHeredoc = true
      continue
    }
    // A here-STRING (`<<< text`) is the same class as a heredoc: readable
    // text handed to whatever the unresolvable head turns out to be. A
    // plain `<`/`>` file redirect is NOT -- its target is a filename.
    if (t.redirect === true && typeof t.value === 'string' && t.value.startsWith('<<')) {
      sawHeredoc = true
    }
    if (t.type === 'op') {
      if (!SEGMENT_BOUNDARY_OPS.has(t.value)) continue
      if (current.length > 0) segments.push(current)
      current = []
      continue
    }
    if (t.type === 'word') current.push(t)
  }
  if (current.length > 0) segments.push(current)
  return { segments, sawHeredoc }
}

/**
 * The head test for ONE command segment: an assignment prefix is skipped,
 * a head that spells the name forces extraction, a head carrying `$` is
 * unresolvable. A backtick substitution never reaches here as a backtick:
 * the shared tokenizer spells it `$(...)` (see shell-command-tokenize.mjs);
 * a literal backtick (single-quoted or escaped) can, and reads as an
 * ordinary character.
 */
function segmentHeadIsUnresolvable(tokens) {
  const words = tokens.map((t) => t.value)
  let i = 0
  while (i < words.length && ASSIGNMENT_WORD_RE.test(words[i])) {
    const eq = words[i].indexOf('=')
    const assignedValue = words[i].slice(eq + 1)
    if (
      RUFLO_NAME_IN_VALUE_HEAD_RE.test(assignedValue) ||
      RUNNER_TOKEN_RE.test(assignedValue.toLowerCase())
    ) {
      return false
    }
    i++
  }
  if (i >= words.length) return true
  // The skip has TWO premises: the guard can neither resolve the head NOR
  // read the name. The second premise quantifies over the whole segment,
  // not just its head -- with `$X` unset, `sh -c '$X ruflo memory store'`
  // runs `ruflo memory store`, so a name in an ARGUMENT slot behind an
  // unresolvable head is text the guard can read, exactly like a name in a
  // later SEGMENT behind one.
  const nameCandidates = tokens
    .slice(i)
    .filter((t) => t.redirect !== true)
    .map((t) => t.value)
  if (nameCandidates.some((w) => RUFLO_NAME_IN_VALUE_HEAD_RE.test(w))) return false
  const head = words[i] ?? ''
  if (head.includes('$')) return true
  return false
}

/**
 * A command SUBSTITUTION written literally in the value (`$(...)` or a
 * backtick pair) is text this guard CAN read -- the shared tokenizer hands
 * its body back in `.subs`. The skip's premise is "cannot be resolved and
 * cannot spell the name"; that premise fails for a substitution, so a value
 * carrying one is extracted and the recursion resolves it, exactly as it
 * did before the skip existed.
 */
function carriesResolvableSubstitution(segments) {
  return segments.some((tokens) => tokens.some((t) => (t.subs?.length ?? 0) > 0))
}

/**
 * THE RULE, in one sentence: skip a git config value only when EVERY
 * command in it has a head this guard can neither resolve nor read as the
 * name, and the value carries no command substitution whose body it could
 * read instead.
 *
 * A value that is read is shell text and gets shell text's posture: an
 * unresolvable head in a segment the guard evaluates denies as
 * unresolved-command, exactly as the same text under bash -c does. The
 * skip exists for a value the guard cannot read at all, not for one it
 * can partly read.
 *
 * Why skip rather than deny: a value whose commands the guard cannot read is
 * out of reach, the posture an unreadable -f file already has elsewhere in
 * this guard; denying it refused the repo's own git-crypt filter registration
 * (round 7).
 * @param {string} value the config value (already split from its key)
 */
function hasUnresolvableValueHead(value) {
  const body = value.startsWith('!') ? value.slice(1) : value
  const { segments, sawHeredoc } = valueSegments(body)
  // A heredoc body is text this guard CAN read, and whatever the
  // unresolvable head turns out to be may execute it (`$SHELL <<EOF …`).
  // Same premise failure as a substitution: don't skip.
  if (sawHeredoc) return false
  if (carriesResolvableSubstitution(segments)) return false
  return segments.every((tokens) => segmentHeadIsUnresolvable(tokens))
}

/**
 * A double-quoted value's substitutions are evaluated twice, by the outer
 * .subs recursion and by this extraction, so MAX_DEPTH is reached one level
 * earlier on this path; the cap fails closed (internal error), by design.
 */
function pushGitConfigValue(results, key, value) {
  if (!isGitExecKey(key, value)) return
  if (hasUnresolvableValueHead(value)) return
  results.push({ text: value.startsWith('!') ? value.slice(1) : value, kind: 'shell' })
}

/**
 * @param {string} base lowercased basename of argv[0]
 * @param {string[]} argv post wrapper/launcher-peel argv (original case)
 * @param {Array<{value: string}>} alignedTokens original tokens aligned to `argv`
 */
export function extractGitTexts(base, argv, alignedTokens) {
  if (base !== 'git') return null
  const results = []
  let i = 1
  while (i < argv.length) {
    const a = argv[i]
    if (a === '-c') {
      if (alignedTokens[i + 1]) {
        const tok = alignedTokens[i + 1]
        const raw = tok.value
        const eq = raw.indexOf('=')
        if (eq !== -1) pushGitConfigValue(results, raw.slice(0, eq), raw.slice(eq + 1))
      }
      i += 2
      continue
    }
    if (a.startsWith('-c') && a !== '-c') {
      const raw = a.slice(2)
      const eq = raw.indexOf('=')
      if (eq !== -1) pushGitConfigValue(results, raw.slice(0, eq), raw.slice(eq + 1))
      i++
      continue
    }
    if (a === '-C' || a === '--git-dir' || a === '--work-tree' || a === '--namespace') {
      i += 2
      continue
    }
    if (a.startsWith('-') && a !== '-') {
      i++
      continue
    }
    break
  }
  if (argv[i] === 'config') {
    let j = i + 1
    while (j < argv.length) {
      const a = argv[j]
      if (a === '--') {
        j++
        break
      }
      if (a === '-f' || a === '--file' || a === '--blob') {
        j += 2
        continue
      }
      if (a.startsWith('-') && a !== '-') {
        j++
        continue
      }
      break
    }
    const key = argv[j]
    const valueTok = alignedTokens[j + 1]
    if (key && valueTok) pushGitConfigValue(results, key, valueTok.value)
  }
  return results.length > 0 ? results : null
}
