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
function pushGitConfigValue(results, key, value, token) {
  if (!isGitExecKey(key, value)) return
  if (token && (token.value.includes('$') || (token.subs?.length ?? 0) > 0)) return
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
