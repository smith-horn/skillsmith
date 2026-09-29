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
 * Governance-round M1 fix (post-PR-#2959 retro): a config VALUE this guard
 * cannot statically resolve -- a literal `$` anywhere in the aligned
 * token's own text (a bare `$VAR`/`${VAR}` reference, or a `$(...)`
 * substitution, which also always contains a literal `$`) or a non-empty
 * `.subs` (catches a backtick substitution too, which contains NO literal
 * `$` at all) -- cannot be proven to spell a ruflo/claude-flow invocation
 * OR proven not to. Skip it (don't extract anything for this config-key
 * write) rather than deny: this is the SAME "out of reach by design"
 * posture the awk/sed `-f realfile` and psql `-f realfile.sql` limits
 * already carry, not the different "unresolved COMMAND head" posture
 * `checkUnresolvedCommand`'s `$`-in-head arm uses (that arm denies because
 * an unresolved *command name* is inherently suspicious in a way a
 * git-crypt filter registration writing an unresolved *config value* for
 * LATER indirect use is not — measured: `git config --local
 * filter.git-crypt.smudge "$SMUDGE_CMD"`, the exact shape
 * `ensure_git_crypt_filter_registered()` and `.husky/pre-commit` both run,
 * reached DENY before this fix because the extracted value recursed into
 * `checkUnresolvedCommand`'s own `$`-in-head arm one level down).
 */
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
 * True when the config value's own COMMAND HEAD -- the first shell word of
 * the text git would exec (after the `!` alias marker and after skipping
 * any leading `NAME=value` assignment words) -- can neither be resolved
 * statically NOR be read as spelling the name. Only the HEAD matters: a `$`
 * in a LATER word leaves the head a readable literal that still spells the
 * name (`ruflo $X`), so testing the whole token would skip a value this
 * guard can in fact read. A leading assignment word (`X=$Y ruflo status`)
 * is skipped before this test, not read AS the head -- an assignment's own
 * word never carries the command name git's shell will exec, and treating
 * it as the head wrongly reads its `$` (or absence of one) as if it
 * described the command that follows. If every word is an assignment,
 * there is no command in this value at all; skipping is correct (nothing
 * to extract), matching the caller's existing skip = no-op posture. The
 * assignment words themselves are NOT stripped from the extracted text when
 * this returns false -- `pushGitConfigValue` still pushes the WHOLE value,
 * and the recursion H8(i) already scans handles them (verdict-redundant
 * with round 3's own note on that function, not new coverage here).
 *
 * Governance follow-up (same PR #2963 thread, regression the skip loop
 * above introduced): skipping PAST an assignment word is only safe when
 * that word's own VALUE is not itself runner-shaped -- `X=ruflo $PAGER`
 * denied H8 before the skip loop existed (the recursion's own H8(i) saw
 * the `X=ruflo` token directly), and silently started allowing once the
 * skip loop began walking past it to test `$PAGER` instead. The guard's
 * own posture at the top level is that an assignment whose value is
 * runner-shaped denies (`X=ruflo; $X memory store` denies H8 on
 * `X=ruflo`), so the config-value path must not swallow one either.
 *
 * Round-3 correction (same PR #2963 thread): `RUNNER_TOKEN_RE` alone only
 * catches the EXACT bare name (`X=ruflo`), not a path whose tail spells it
 * (`X=node_modules/.bin/ruflo`, `X=/usr/local/bin/ruflo`, `X=./ruflo`) --
 * the coordinator's own decision is ONE rule for the head test and the
 * assignment-value test, not two: an assignment word's value half is
 * tested with the SAME TWO checks the post-skip head already uses two
 * lines below (`RUFLO_NAME_IN_VALUE_HEAD_RE` for "a bare name or a path
 * whose tail is the name", `RUNNER_TOKEN_RE` for H8(i)'s own exact-name
 * shape, kept alongside it rather than replaced -- `RUNNER_TOKEN_RE` still
 * matches `@claude-flow/cli`, a form `RUFLO_NAME_IN_VALUE_HEAD_RE` does not
 * cover, its `@` not being a path separator). Either match stops the skip
 * immediately and returns false, so the whole value is extracted and
 * recursed, where a predicate downstream catches it (H8(i) for the exact-
 * name case; a path-shaped case reaches whatever the recursion's own
 * pipeline resolves it to once the assignment word itself is stripped --
 * measured per-case, not asserted here).
 *
 * Class-2 correction (PR #2963 confirmation round, one last fix): the value
 * is itself SHELL TEXT, quoted or not, and this guard's own outer tokenizer
 * has already stripped the OUTER quoting around the whole `-c key=value`
 * argument by the time this function sees `value` -- a naive
 * `.split(/\s+/)` on that already-unquoted text does not know about
 * quoting that survives INSIDE the value itself (`X="a b" $PAGER`, where
 * the inner double quotes are literal characters the outer `-c`
 * single-quoting protected). Splitting on whitespace alone breaks `"a b"`
 * into two words (`"a` and `b"`), so the assignment-skip loop stops one
 * word early on a bogus "resolvable" head and the recursion denies
 * unresolved-command on the REAL trailing `$PAGER`, where the unquoted
 * shape (`X=1 $PAGER`) correctly allows. Fix: parse `body` with the SAME
 * shared `tokenize()` (`shell-command-normalize.mjs`) the outer pipeline
 * already uses, and iterate its WORD tokens' own `.value` -- `X="a b"`
 * becomes one word (`X=a b`), matching how a real shell would see it --
 * for BOTH the assignment-skip loop and the head test below.
 *
 * A config value is shell TEXT and may hold several commands;
 * hasUnresolvableValueHead below composes the per-segment head test with the
 * substitution rule and states the whole rule in one sentence.
 */
/**
 * The value's own tokens, split into COMMAND SEGMENTS on the tokenizer's
 * `op` tokens. A config value is shell TEXT, and shell text can hold more
 * than one command (`$X; ruflo memory store`). Testing only the first
 * word of the whole value reads segment 1's head and then discards every
 * later segment -- the shape that let an unresolvable head hide a
 * perfectly resolvable invocation behind a `;`/`&&`/`||`/`|`/newline.
 */
function valueSegments(body) {
  const segments = []
  let current = []
  for (const t of tokenize(body)) {
    if (t.type === 'op') {
      if (current.length > 0) segments.push(current)
      current = []
      continue
    }
    if (t.type === 'word') current.push(t)
  }
  if (current.length > 0) segments.push(current)
  return segments
}

/**
 * The head test for ONE command segment: an assignment prefix is skipped,
 * a head that spells the name forces extraction, a head carrying `$` is
 * unresolvable. A backtick substitution never reaches here as a backtick:
 * the shared tokenizer spells it `$(...)` (see shell-command-tokenize.mjs).
 */
function segmentHeadIsUnresolvable(tokens, token) {
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
  const head = words[i] ?? ''
  if (RUFLO_NAME_IN_VALUE_HEAD_RE.test(head)) return false
  if (head.includes('$')) return true
  return head === '' && (token?.subs?.length ?? 0) > 0
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
 * @param {string} value the config value (already split from its key)
 * @param {{value: string, subs?: string[]}} [token] the aligned token
 */
function hasUnresolvableValueHead(value, token) {
  const body = value.startsWith('!') ? value.slice(1) : value
  const segments = valueSegments(body)
  if (segments.length === 0) return true
  if (carriesResolvableSubstitution(segments)) return false
  return segments.every((tokens) => segmentHeadIsUnresolvable(tokens, token))
}

function pushGitConfigValue(results, key, value, token) {
  if (!isGitExecKey(key, value)) return
  if (hasUnresolvableValueHead(value, token)) return
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
        if (eq !== -1) pushGitConfigValue(results, raw.slice(0, eq), raw.slice(eq + 1), tok)
      }
      i += 2
      continue
    }
    if (a.startsWith('-c') && a !== '-c') {
      const tok = alignedTokens[i]
      const raw = a.slice(2)
      const eq = raw.indexOf('=')
      if (eq !== -1) pushGitConfigValue(results, raw.slice(0, eq), raw.slice(eq + 1), tok)
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
    if (key && valueTok) pushGitConfigValue(results, key, valueTok.value, valueTok)
  }
  return results.length > 0 ? results : null
}
