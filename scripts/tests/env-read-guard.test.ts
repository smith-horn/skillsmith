/**
 * Tests for the SMI-6361 env-read-guard PreToolUse hook.
 *
 * Two things are covered, per the plan's Wave 1 Step 3
 * (docs/internal/implementation/varlock-secret-exposure-defense-in-depth.md):
 *
 *   1. Registration regression pin — `.claude/settings.json` on disk must
 *      still register this hook on the `Bash` `PreToolUse` matcher. This
 *      is a REAL-FILE assertion, not a fixture copy, so a future PR that
 *      quietly removes the registration fails this test.
 *   2. Behavior — table-driven `decide()` cases covering the plan's
 *      required minimum plus additional cases pulled from the guard's own
 *      documented rules (safe-file allowlist, the output-free-grep
 *      exception, the `varlock load --format` flag guard, the
 *      `docker exec` / `varlock run` / `bash -c` wrapper-normalization
 *      paths, and the hard-disable env var).
 *
 * No shadow mode exists for this guard (Owner Decision A — deny from day
 * one), so unlike the sibling `linear-issue-creation-guard`, there is no
 * `warn` action to test.
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

import { decide } from '../env-read-guard.mjs'

const SETTINGS_PATH = fileURLToPath(new URL('../../.claude/settings.json', import.meta.url))

function bashCall(command: string) {
  return { tool_name: 'Bash', tool_input: { command } }
}

/**
 * The guard's allow verdict, whole. Round 2 of SMI-6920 (M-2) started
 * asserting this instead of `.action` alone, because the only
 * allow-with-stderr this guard produces is the catch-all fail-open: with the
 * shell-text module's import removed, 13 of 13 rows still passed a bare
 * `.action` check on a mechanism that was entirely dead. Round 3 (F-2) found
 * the conversion had reached 27 of 76 rows while the record claimed all of
 * them. Round 4 restated the figures and got them wrong too, and round 5
 * (M3) measured the file a third time. Both spellings assert the whole
 * verdict, so assertion strength is uniform across them and the exact split
 * carries no behavioural weight — which is precisely why it kept going
 * unchecked. The count is therefore left to the one command that produces
 * it rather than restated here as prose that rots: `grep -o 'expectAllow(' …
 * | wc -l` counts occurrences INCLUDING the helper definition, and
 * `grep -o 'toEqual(ALLOW_RESULT)' … | wc -l` the other spelling; a line
 * count differs from an occurrence count, and an `it.each` row differs from
 * a call site, which is where all three wrong figures came from.
 *
 * What matters and is checkable: no allow assertion reads `.action` alone.
 * `grep -c "\\.action).toBe('allow')" …` must be 0.
 */
const ALLOW_RESULT = { action: 'allow', json: null, stderr: null }

/** Assert that `command` is allowed, asserting the whole verdict. */
function expectAllow(command: string): void {
  expect(decide(bashCall(command), {})).toEqual(ALLOW_RESULT)
}

describe('.claude/settings.json registration (regression pin)', () => {
  it('registers env-read-guard.mjs on the Bash PreToolUse matcher', () => {
    const settings = JSON.parse(readFileSync(SETTINGS_PATH, 'utf8'))
    const preToolUse = settings.hooks?.PreToolUse
    expect(Array.isArray(preToolUse)).toBe(true)

    const bashMatchers = preToolUse.filter(
      (entry: { matcher?: string }) => entry.matcher === 'Bash'
    )
    expect(bashMatchers.length).toBeGreaterThan(0)

    // Checks type + the exact invocation shape, not just a substring match
    // on the command string — a pre-merge review flagged that a
    // substring-only check would still pass if the hook were silently
    // replaced with a non-functional command that merely retained the text
    // "env-read-guard" somewhere (e.g. in a comment or an unrelated arg).
    const hasGuardHook = bashMatchers.some((entry: { hooks?: Array<Record<string, unknown>> }) =>
      (entry.hooks ?? []).some(
        (hook) =>
          hook.type === 'command' &&
          typeof hook.command === 'string' &&
          hook.command.includes('node') &&
          hook.command.includes('scripts/env-read-guard.mjs')
      )
    )
    expect(hasGuardHook).toBe(true)
  })

  it('no longer registers the dead Bash(echo $.env:*) deny entry', () => {
    const settings = JSON.parse(readFileSync(SETTINGS_PATH, 'utf8'))
    expect(settings.permissions?.deny ?? []).not.toContain('Bash(echo $.env:*)')
  })
})

describe('decide() — required minimum cases (plan Wave 1 Step 3)', () => {
  it('1. grep PAT .env -> deny (the incident shape)', () => {
    const result = decide(bashCall('grep PAT .env'), {})
    expect(result.action).toBe('deny')
    expect(result.json?.hookSpecificOutput.permissionDecision).toBe('deny')
    expect(result.json?.hookSpecificOutput.permissionDecisionReason).toEqual(expect.any(String))
    expect(result.json?.hookSpecificOutput.permissionDecisionReason.length).toBeGreaterThan(0)
  })

  it('2. docker exec skillsmith-dev-1 cat /app/.env -> deny', () => {
    const result = decide(bashCall('docker exec skillsmith-dev-1 cat /app/.env'), {})
    expect(result.action).toBe('deny')
    expect(result.json?.hookSpecificOutput.permissionDecision).toBe('deny')
    expect(result.json?.hookSpecificOutput.permissionDecisionReason.length).toBeGreaterThan(0)
  })

  it('3. varlock load --format json -> deny (unmasked plaintext)', () => {
    const result = decide(bashCall('varlock load --format json'), {})
    expect(result.action).toBe('deny')
    expect(result.json?.hookSpecificOutput.permissionDecision).toBe('deny')
    expect(result.json?.hookSpecificOutput.permissionDecisionReason.length).toBeGreaterThan(0)
  })

  it("4. grep -qE '^LINEAR_API_KEY=' .env -> allow (output-free presence check)", () => {
    const result = decide(bashCall("grep -qE '^LINEAR_API_KEY=' .env"), {})
    expect(result).toEqual(ALLOW_RESULT)
  })

  it('5. cat .env.schema -> allow (safe file)', () => {
    const result = decide(bashCall('cat .env.schema'), {})
    expect(result).toEqual(ALLOW_RESULT)
  })

  it('6. cat .env.example -> allow (safe file)', () => {
    const result = decide(bashCall('cat .env.example'), {})
    expect(result).toEqual(ALLOW_RESULT)
  })

  it('7. head -5 .worktrees/foo/.env -> deny (nested worktree path)', () => {
    const result = decide(bashCall('head -5 .worktrees/foo/.env'), {})
    expect(result.action).toBe('deny')
    expect(result.json?.hookSpecificOutput.permissionDecision).toBe('deny')
    expect(result.json?.hookSpecificOutput.permissionDecisionReason.length).toBeGreaterThan(0)
  })

  it('8. python3 -c "print(open(\'.env\').read())" -> deny (inline interpreter)', () => {
    const result = decide(bashCall('python3 -c "print(open(\'.env\').read())"'), {})
    expect(result.action).toBe('deny')
    expect(result.json?.hookSpecificOutput.permissionDecision).toBe('deny')
    expect(result.json?.hookSpecificOutput.permissionDecisionReason.length).toBeGreaterThan(0)
  })
})

describe('decide() — additional cases from the guard’s own documented behavior', () => {
  it('bare cat .env -> deny', () => {
    const result = decide(bashCall('cat .env'), {})
    expect(result.action).toBe('deny')
  })

  it('cat .env.registry -> deny (second secret-bearing file, root-cause finding 10)', () => {
    const result = decide(bashCall('cat .env.registry'), {})
    expect(result.action).toBe('deny')
  })

  it('cat .env.local -> deny (protected .env.<anything> except the two safe files)', () => {
    const result = decide(bashCall('cat .env.local'), {})
    expect(result.action).toBe('deny')
  })

  it('grep PAT .env with a count flag (-c) is treated as output, not the quiet exception -> deny', () => {
    const result = decide(bashCall('grep -qc PAT .env'), {})
    expect(result.action).toBe('deny')
  })

  it('grep -q PAT .env (quiet, no output flag) -> allow', () => {
    const result = decide(bashCall('grep -q PAT .env'), {})
    expect(result).toEqual(ALLOW_RESULT)
  })

  it('grep -o PAT .env (quiet-less, output-producing) -> deny', () => {
    const result = decide(bashCall('grep -o PAT .env'), {})
    expect(result.action).toBe('deny')
  })

  it('[ -f .env ] presence/metadata check -> allow', () => {
    const result = decide(bashCall('[ -f .env ]'), {})
    expect(result).toEqual(ALLOW_RESULT)
  })

  it('test -f .env presence/metadata check -> allow', () => {
    const result = decide(bashCall('test -f .env'), {})
    expect(result).toEqual(ALLOW_RESULT)
  })

  it('wc -c .env metadata check -> allow', () => {
    const result = decide(bashCall('wc -c .env'), {})
    expect(result).toEqual(ALLOW_RESULT)
  })

  it('varlock load (default pretty format, no --format flag) -> allow', () => {
    const result = decide(bashCall('varlock load'), {})
    expect(result).toEqual(ALLOW_RESULT)
  })

  it('varlock load --format pretty -> allow (explicit default format)', () => {
    const result = decide(bashCall('varlock load --format pretty'), {})
    expect(result).toEqual(ALLOW_RESULT)
  })

  it('varlock load --quiet -> allow (validation only)', () => {
    const result = decide(bashCall('varlock load --quiet'), {})
    expect(result).toEqual(ALLOW_RESULT)
  })

  it('varlock load --format=json (equals-spelling) -> deny', () => {
    const result = decide(bashCall('varlock load --format=json'), {})
    expect(result.action).toBe('deny')
  })

  it('varlock load --format env -> deny', () => {
    const result = decide(bashCall('varlock load --format env'), {})
    expect(result.action).toBe('deny')
  })

  it('sudo cat .env -> deny (sudo wrapper stripped before matching)', () => {
    const result = decide(bashCall('sudo cat .env'), {})
    expect(result.action).toBe('deny')
  })

  it('bash -c "cat .env" -> deny (nested shell body is inspected)', () => {
    const result = decide(bashCall('bash -c "cat .env"'), {})
    expect(result.action).toBe('deny')
  })

  it('varlock run -- cat .env -> deny (varlock run wrapper stripped before matching)', () => {
    const result = decide(bashCall('varlock run -- cat .env'), {})
    expect(result.action).toBe('deny')
  })

  // L-2 fix (SMI-6744 Wave 4 delta governance round, ruflo-host-guard.mjs's
  // own review): confirms `stripVarlockRun`'s H-E fix (SMI-6744 Wave 4
  // governance round) — a trailing `--` that belongs to the WRAPPED
  // command's own argv, not varlock's own separator — also holds for THIS
  // guard, not just ruflo-host-guard.mjs, since both guards share the same
  // `normalizeWrappers`/`stripVarlockRun` implementation. The ONE append to
  // this file for that fix.
  it("varlock run cat .env -- x -> deny (a trailing -- is the wrapped command's own, not varlock's separator)", () => {
    const result = decide(bashCall('varlock run cat .env -- x'), {})
    expect(result.action).toBe('deny')
  })

  it('docker compose exec dev cat /app/.env -> deny (compose exec wrapper stripped)', () => {
    const result = decide(bashCall('docker compose exec dev cat /app/.env'), {})
    expect(result.action).toBe('deny')
  })

  it('cp .env /tmp/x (not a reader command) -> allow (named residual gap, not covered)', () => {
    const result = decide(bashCall('cp .env /tmp/x'), {})
    expect(result).toEqual(ALLOW_RESULT)
  })

  it('cat some-other-file.txt -> allow (no protected file referenced)', () => {
    const result = decide(bashCall('cat some-other-file.txt'), {})
    expect(result).toEqual(ALLOW_RESULT)
  })
})

describe('decide() — interpreter short-flag bypass regression (pre-merge review finding)', () => {
  // GPT-5.6-Sol's cross-model pre-merge review (SMI-6361) found that a
  // generic "-[ce]" short-flag regex missed node's `-p` (print, same
  // inline-code hazard as `-e`) — confirmed live: `node -p
  // "require('fs').readFileSync('.env','utf8')"` returned allow before this
  // fix. The same root cause (per-interpreter flags pooled into one
  // generic check) was independently found to also miss php's `-r` (run
  // code). Both are fixed via INLINE_SCRIPT_SHORT_FLAG_CHARS.

  it('node -p "<code touching .env>" -> deny (was a confirmed bypass)', () => {
    const result = decide(bashCall(`node -p "require('fs').readFileSync('.env','utf8')"`), {})
    expect(result.action).toBe('deny')
  })

  it('node --print "<code touching .env>" -> deny (long-flag form, already covered)', () => {
    const result = decide(bashCall(`node --print "require('fs').readFileSync('.env','utf8')"`), {})
    expect(result.action).toBe('deny')
  })

  it('php -r "<code touching .env>" -> deny (was a confirmed bypass)', () => {
    const result = decide(bashCall(`php -r "readfile('.env');"`), {})
    expect(result.action).toBe('deny')
  })

  it('node -p "<code with no .env reference>" -> allow (no false positive)', () => {
    const result = decide(bashCall('node -p "1+1"'), {})
    expect(result).toEqual(ALLOW_RESULT)
  })

  it('node -pe "<code with no .env reference>" -> allow (combined short flags, no false positive)', () => {
    const result = decide(bashCall('node -pe "1+1"'), {})
    expect(result).toEqual(ALLOW_RESULT)
  })

  it('ruby -r json -e "puts 1" -> allow (ruby\'s -r means require-a-library, not run-code — must not be pooled with php\'s -r)', () => {
    const result = decide(bashCall('ruby -r json -e "puts 1"'), {})
    expect(result).toEqual(ALLOW_RESULT)
  })

  it('php -v -> allow (a real php flag that happens to start with a different letter than -r)', () => {
    const result = decide(bashCall('php -v'), {})
    expect(result).toEqual(ALLOW_RESULT)
  })

  // Discriminating regression for the per-interpreter design itself
  // (adversarial confirmation-pass finding F5): the three "no false
  // positive" tests above pass identically under a BROKEN pooled variant
  // (one shared short-flag-char set for every interpreter) because none of
  // them combine a coincidentally-shared flag letter with an actual `.env`
  // reference. This one does — it denies under pooling (ruby's `-r` would
  // wrongly gate a text scan) and allows under the correct per-interpreter
  // design (ruby's own chars are `e` only, so `-r`'s argument is never
  // scanned as inline script — matching real ruby semantics, where `-r`
  // takes a library name to require, not code to run).
  it('ruby -r "<text containing .env>" -> allow (proves per-interpreter chars, not a pooled set, are in effect)', () => {
    const result = decide(bashCall(`ruby -r "readfile('.env')"`), {})
    expect(result).toEqual(ALLOW_RESULT)
  })
})

describe('decide() — second-round adversarial confirmation findings (SMI-6361)', () => {
  // A follow-up confirmation pass on the fix above found perl's -E and
  // php's -B/-R/-E were the same class of gap node's -p was: a real
  // inline-code short flag missing from INLINE_SCRIPT_SHORT_FLAG_CHARS.

  it('perl -E "<code touching .env>" -> deny (perl -h: "-E ... like -e, but enables all optional features")', () => {
    const result = decide(bashCall(`perl -E "open my $f,'<','.env'; print <$f>;"`), {})
    expect(result.action).toBe('deny')
  })

  it('php -B "<code touching .env>" -> deny (process-begin hook, same hazard as -r)', () => {
    const result = decide(bashCall(`php -B "readfile('.env');"`), {})
    expect(result.action).toBe('deny')
  })

  it('php -R "<code touching .env>" -> deny (process-code hook, same hazard as -r)', () => {
    const result = decide(bashCall(`php -R "readfile('.env');"`), {})
    expect(result.action).toBe('deny')
  })

  it('php -E "<code touching .env>" -> deny (process-end hook, same hazard as -r)', () => {
    const result = decide(bashCall(`php -E "readfile('.env');"`), {})
    expect(result.action).toBe('deny')
  })

  it('php --run "<code touching .env>" -> deny (long-form alias of -r)', () => {
    const result = decide(bashCall(`php --run "readfile('.env');"`), {})
    expect(result.action).toBe('deny')
  })

  // Discriminating (third-round finding F-D: the original version of this
  // test used a plain filename with no .env reference at all, so it passed
  // identically whether or not -F was correctly excluded from php's
  // inline-code short-flag chars). This one denies if -F is ever
  // (wrongly) added to those chars, and allows under the current, correct
  // set — proving the exclusion is actually load-bearing, not just stated.
  it('php -F "<text touching .env>" -> allow (-F names a per-line script FILE argument, not inline code — its value is a filename, never scanned as script text)', () => {
    const result = decide(bashCall(`php -F "readfile('.env')"`), {})
    expect(result).toEqual(ALLOW_RESULT)
  })

  // Finding F6: awk/sed are on READER_COMMANDS (the guard's own declared
  // surface) but their inline PROGRAM TEXT was never scanned before this
  // fix — only their bare argv tokens were, so a protected-file reference
  // embedded inside the script itself sailed through.

  it('awk BEGIN-block reading .env -> deny (positional script text, no -f flag)', () => {
    const result = decide(bashCall(`awk 'BEGIN{while((getline l < ".env")>0) print l}'`), {})
    expect(result.action).toBe('deny')
  })

  it('awk -f script.awk file.txt -> allow (ordinary usage, no .env reference anywhere)', () => {
    const result = decide(bashCall('awk -f script.awk file.txt'), {})
    expect(result).toEqual(ALLOW_RESULT)
  })

  it("sed 'r .env' -> deny (GNU sed's r command reads and prints an arbitrary file)", () => {
    const result = decide(bashCall("sed 'r .env' input.txt"), {})
    expect(result.action).toBe('deny')
  })

  it("sed -e 'r .env' -> deny (same hazard via the explicit -e flag)", () => {
    const result = decide(bashCall("sed -e 'r .env' input.txt"), {})
    expect(result.action).toBe('deny')
  })

  it('sed -f script.sed input.txt -> allow (ordinary usage, no .env reference anywhere)', () => {
    const result = decide(bashCall('sed -f script.sed input.txt'), {})
    expect(result).toEqual(ALLOW_RESULT)
  })
})

describe('decide() — third-round adversarial confirmation findings F-A/F-B/F-C (SMI-6361)', () => {
  // A third round found the second round's own awk/sed fix (which tried
  // to model each flag's arity — skip -f's value, treat -e's value as
  // script, take the "first non-flag" as the positional default) missed
  // any VALUE-TAKING flag written in separated form: the value token itself
  // doesn't start with "-", so it was wrongly treated as "the script"
  // while the REAL script (later in argv) was never examined. Also missed
  // the attached short-option form entirely (`-e'r .env'` tokenizes as one
  // string starting with "-", which the old code skipped outright). Fixed
  // by scanning every argument uniformly instead of trying to identify
  // which single one is "the script" (see scanPositionalScriptText's own
  // header comment for the full rationale).

  it('awk -v n=1 \'BEGIN{...".env"...}\' -> deny (F-A: a value-taking flag in separated form previously hid the real script)', () => {
    const result = decide(bashCall(`awk -v n=1 'BEGIN{while((getline l < ".env")>0) print l}'`), {})
    expect(result.action).toBe('deny')
  })

  it('awk -F , \'BEGIN{...".env"...}\' -> deny (same shape, a different separated value-taking flag)', () => {
    const result = decide(bashCall(`awk -F , 'BEGIN{while((getline l < ".env")>0) print l}'`), {})
    expect(result.action).toBe('deny')
  })

  it("sed -l 70 'r .env' file -> deny (F-A: GNU sed's --line-length value flag hid the real script)", () => {
    const result = decide(bashCall("sed -l 70 'r .env' input.txt"), {})
    expect(result.action).toBe('deny')
  })

  it("sed -e'r .env' input.txt -> deny (F-B: attached short-option form, one token starting with '-')", () => {
    const result = decide(bashCall("sed -e'r .env' input.txt"), {})
    expect(result.action).toBe('deny')
  })

  it("sed -n -e'r .env' input.txt -> deny (attached form combined with an unrelated boolean flag)", () => {
    const result = decide(bashCall("sed -n -e'r .env' input.txt"), {})
    expect(result.action).toBe('deny')
  })

  it("gawk --source='BEGIN{...\".env\"...}' -> deny (F-C: gawk's own inline-program long flag)", () => {
    const result = decide(
      bashCall(`gawk --source='BEGIN{while((getline l < ".env")>0) print l}'`),
      {}
    )
    expect(result.action).toBe('deny')
  })

  it("sed -i '' 'r .env' input.txt -> deny (BSD in-place form; bonus fix from scanning uniformly)", () => {
    const result = decide(bashCall("sed -i '' 'r .env' input.txt"), {})
    expect(result.action).toBe('deny')
  })

  // Non-regression: the same flags in ordinary, .env-free usage must still
  // allow — the fix scans more text, not more aggressively per match.

  it("awk -v n=1 '{print $n}' data.txt -> allow (ordinary -v usage, no .env reference)", () => {
    const result = decide(bashCall(`awk -v n=1 '{print $n}' data.txt`), {})
    expect(result).toEqual(ALLOW_RESULT)
  })

  it("sed -i '' 's/a/b/' file.txt -> allow (ordinary BSD in-place edit, no .env reference)", () => {
    const result = decide(bashCall("sed -i '' 's/a/b/' file.txt"), {})
    expect(result).toEqual(ALLOW_RESULT)
  })

  it("sed 's/foo/bar/' file.txt -> allow (ordinary substitution, no false positive)", () => {
    const result = decide(bashCall("sed 's/foo/bar/' file.txt"), {})
    expect(result).toEqual(ALLOW_RESULT)
  })
})

describe('decide() — fourth-round adversarial confirmation finding (SMI-6361)', () => {
  // A fourth round found the third round's own uniform-scan rewrite
  // regressed a case the arity-modeling code it replaced actually got
  // right: `--` (end-of-options) does not precede junk for awk/sed, it
  // precedes the SCRIPT ITSELF -- `awk -- 'BEGIN{...}'` puts the real
  // program right after it. scanPositionalScriptText's loop inherited a
  // `break` on `--` from the flag-scanning loops elsewhere in this file
  // (correct there, since `--` means "stop, no more flags" for THEM), so
  // it silently stopped scanning before ever reaching the script text --
  // a real regression from the parent commit, which deliberately looked
  // past `--` in both of the functions this one replaced.

  it('awk -- \'BEGIN{...".env"...}\' -> deny (was a confirmed regression: -- broke the scan before it reached the script)', () => {
    const result = decide(bashCall(`awk -- 'BEGIN{while((getline l < ".env")>0) print l}'`), {})
    expect(result.action).toBe('deny')
  })

  it("sed -- 'r .env' file.txt -> deny (same regression, sed side)", () => {
    const result = decide(bashCall("sed -- 'r .env' file.txt"), {})
    expect(result.action).toBe('deny')
  })

  it("sed -n -- 'r .env' file.txt -> deny (-- combined with an unrelated boolean flag)", () => {
    const result = decide(bashCall("sed -n -- 'r .env' file.txt"), {})
    expect(result.action).toBe('deny')
  })

  it("sed -- -e 'r .env' file.txt -> deny (-- followed by a literal dash-prefixed script argument)", () => {
    const result = decide(bashCall("sed -- -e 'r .env' file.txt"), {})
    expect(result.action).toBe('deny')
  })

  it('docker exec skillsmith-dev-1 awk -- \'BEGIN{...".env"...}\' -> deny (the wrapper this guard exists for, combined with the -- regression)', () => {
    const result = decide(
      bashCall(
        `docker exec skillsmith-dev-1 awk -- 'BEGIN{while((getline l < "/app/.env")>0) print l}'`
      ),
      {}
    )
    expect(result.action).toBe('deny')
  })

  it("awk -F: '{print $1}' /etc/passwd -> allow (ordinary field-separator usage, no false positive)", () => {
    const result = decide(bashCall("awk -F: '{print $1}' /etc/passwd"), {})
    expect(result).toEqual(ALLOW_RESULT)
  })

  // A fifth confirmation round on the -- fix above surfaced a separate,
  // pre-existing bug in the embedded-text scan itself: it was anchored on
  // the leading side only, so `.envrc`/`.environment`/`.env-backup` (which
  // this file's own docs already say are "not env files at all") could
  // false-positive as an embedded `.env` reference. A false positive
  // (over-blocking), not a bypass -- but it contradicted this file's own
  // stated classification, so it's fixed alongside rather than left as a
  // known inconsistency.

  it("awk '{print}' .envrc -> allow (.envrc is not an env file, per this guard's own classifyBasename rule)", () => {
    const result = decide(bashCall("awk '{print}' .envrc"), {})
    expect(result).toEqual(ALLOW_RESULT)
  })

  it('node -e "console.log(\'.envrc\')" -> allow (same boundary fix, inline-interpreter text-scan path)', () => {
    const result = decide(bashCall(`node -e "console.log('.envrc')"`), {})
    expect(result).toEqual(ALLOW_RESULT)
  })

  it('node -e "console.log(\'.environment\')" -> allow (a different .env-prefixed non-env filename)', () => {
    const result = decide(bashCall(`node -e "console.log('.environment')"`), {})
    expect(result).toEqual(ALLOW_RESULT)
  })

  it('node -e "console.log(\'.env-backup\')" -> allow (hyphen-suffixed, not dot-suffixed)', () => {
    const result = decide(bashCall(`node -e "console.log('.env-backup')"`), {})
    expect(result).toEqual(ALLOW_RESULT)
  })

  it('node -e "console.log(\'.env.local\')" -> deny (still correctly protected: a real dot-suffixed variant)', () => {
    const result = decide(bashCall(`node -e "console.log('.env.local')"`), {})
    expect(result.action).toBe('deny')
  })
})

describe("decide() — C1: ANSI-C $'...' octal escapes evade the guard (SMI-6744 delta round)", () => {
  // This guard shares its tokenizer with scripts/ruflo-host-guard.mjs
  // (scripts/lib/shell-command-normalize.mjs -> shell-command-tokenize.mjs),
  // so the SAME `$'...'` decode gap applied here: `cat $'\056env'` (octal
  // 056 = '.') reached this guard as the literal text `\056env`, never
  // equalling the decoded `.env` its classifyPath/EMBEDDED_ENV_RE test
  // for — MEASURED to allow before the C1 fix.
  it("cat $'\\056env' -> deny (octal 056 decodes to '.', spelling .env)", () => {
    const result = decide(bashCall(String.raw`cat $'\056env'`), {})
    expect(result.action).toBe('deny')
  })

  // Regression pin, not a red arm: the \xHH hex arm was already fixed by
  // the ORIGINAL H-6 fix and MEASURED to already deny before this C1 fix —
  // kept here so a future regression in the shared decoder's hex arm is
  // caught alongside the octal arm above.
  it("cat $'\\x2e'env -> deny (hex 0x2e decodes to '.', spelling .env; already correct pre-C1)", () => {
    const result = decide(bashCall(String.raw`cat $'\x2e'env`), {})
    expect(result.action).toBe('deny')
  })
})

// SMI-6869 Fix A: this guard shares the tokenizer with
// scripts/ruflo-host-guard.mjs, so the same redirect-operator fix applies
// here too — before the fix, `2>&1` glued onto a preceding bare digit
// swallowed the digit into a leftover word, splitting the trailing `1`
// into what LOOKED like a second, unrelated argv element; this guard's own
// argv-building must now exclude the redirect token entirely rather than
// treat any part of it as a command argument.
describe('decide() — SMI-6869 Fix A: a trailing redirect does not change the verdict', () => {
  it("cat $'\\056env' 2>&1 -> deny (still reads .env; 2>&1 is excluded from argv, not misparsed into it)", () => {
    const result = decide(bashCall(String.raw`cat $'\056env' 2>&1`), {})
    expect(result.action).toBe('deny')
  })

  it('control: cat notes.txt 2>&1 -> allow (an ordinary redirect on an unrelated read stays harmless)', () => {
    const result = decide(bashCall('cat notes.txt 2>&1'), {})
    expect(result).toEqual(ALLOW_RESULT)
  })
})

// SMI-6869 governance round High (regression): this guard's own
// `evaluateCommand` recursed into a word token's `.subs` but silently
// DROPPED every `heredoc`-type token — a heredoc body fed to a shell
// (`bash <<EOF`) or reached through a pipe (`cat <<EOF | sh`) is executed
// verbatim by that shell, exactly like the `.env`-reading command it
// contains, but the guard never looked at it at all. Fixed with a second
// loop (after the existing `.subs` recursion) that recurses
// `evaluateCommand` over every heredoc token's own `.value`, regardless of
// quoting (unlike the ruflo-host-guard's `subs`-only distinction, quoting
// a heredoc delimiter only disables `$()`/backtick SUBSTITUTION — it does
// not stop the CONSUMING shell from executing the body text it receives).
describe('decide() — SMI-6869 governance round High: heredoc body dropped from evaluation (regression)', () => {
  const redArms = [
    "bash <<'EOF'\ncat .env\nEOF",
    'bash <<EOF\ncat .env\nEOF',
    'cat <<EOF | sh\ncat .env\nEOF',
    'sh <<A <<B\nx\nA\ncat .env\nB',
  ]
  it.each(redArms)('%s -> deny (the heredoc body is now recursed into)', (command) => {
    expect(decide(bashCall(command), {}).action).toBe('deny')
  })

  const controls = [
    'cat <<EOF\nthis mentions .env harmlessly\nEOF',
    "cat <<'EOF' > /tmp/doc.md\n# how to run\nnpm test\nEOF",
  ]
  it.each(controls)(
    'control: %s -> allow (a docs heredoc with no reader-command-shaped text)',
    (command) => {
      expectAllow(command)
    }
  )
})

// SMI-6869 governance round 11, F1 (Critical): a command substitution in an
// ARGUMENT slot supplies its own OUTPUT as that argument, so a protected
// path written inside the substitution's body is a read target of the
// ENCLOSING command, not only of the body's own command --
// `cat $(echo /app/.env)` reads the file even though `echo /app/.env` does
// not. Before this fix the read check saw only a word's own `.value`: the
// old tokenizer inlined a backtick body into that value, so the backtick
// spelling denied by accident while the `$(...)` spelling never did.
// Normalizing the backtick spelling removed the accident; the read check
// now reads a substitution body's words as the enclosing command's
// arguments, so both spellings deny.
describe('decide() — SMI-6869 governance round 11 F1: a command substitution in an argument slot supplies its output as that argument: a protected path inside the body is a read target of the enclosing command', () => {
  it.each([
    ['cat `echo /app/.env`', 'cat $(echo /app/.env)'],
    ['cat "`echo /app/.env`"', 'cat "$(echo /app/.env)"'],
    [
      'docker exec skillsmith-dev-1 cat `echo /app/.env`',
      'docker exec skillsmith-dev-1 cat $(echo /app/.env)',
    ],
    ['cat `echo ./.env`', 'cat $(echo ./.env)'],
    ['cat `echo .worktrees/x/.env`', 'cat $(echo .worktrees/x/.env)'],
    ['sudo cat `echo /app/.env`', 'sudo cat $(echo /app/.env)'],
    ['varlock run -- cat `echo /app/.env`', 'varlock run -- cat $(echo /app/.env)'],
    ['`cat` .env', '$(cat) .env'],
    ['`cat` /app/.env', '$(cat) /app/.env'],
  ])('%s and its $(...) twin %s -> deny', (backtickCmd, dollarCmd) => {
    expect(decide(bashCall(backtickCmd), {}).action).toBe('deny')
    expect(decide(bashCall(dollarCmd), {}).action).toBe('deny')
  })

  it.each([
    'cat `echo .env`',
    'cat $(echo .env)',
    'cat "$(echo .env)"',
    'cat `echo .env.registry`',
    'cat $(echo .env.registry)',
  ])('%s -> deny', (command) => {
    expect(decide(bashCall(command), {}).action).toBe('deny')
  })

  it.each([
    'cat $(echo .env.example)',
    'cat $(echo .env.schema)',
    'ls $(git rev-parse --show-toplevel)',
    "grep -qE '^KEY=' .env",
    'echo $(date)',
    'echo `date`',
    'cat `echo README.md`',
  ])('control: %s -> allow', (command) => {
    expectAllow(command)
  })

  it('known-positive control: cat .env -> deny', () => {
    expect(decide(bashCall('cat .env'), {}).action).toBe('deny')
  })
})

// SMI-6869 governance round 12 (cross-family gate, class 1, finding 1): the
// round-11 flatten tokenizes a substitution BODY once and takes its words,
// so a NESTED `$(...)` inside that body stays one unopened word -- its own
// `.subs` is never read. `flattenSubWords` (shell-command-normalize.mjs)
// now recurses into every resulting word's own `.subs` in turn, at any
// depth up to MAX_DEPTH, failing closed (denies) rather than silently
// under-reading past the bound.
describe('decide() — SMI-6869 governance round 12 F1: a nested command substitution is opened at every depth, not just the first level', () => {
  it.each([
    'cat $(echo $(echo .env))',
    'cat $(echo "$(echo /app/.env)")',
    'docker exec skillsmith-dev-1 cat $(echo $(echo /app/.env))',
  ])('%s -> deny', (command) => {
    expect(decide(bashCall(command), {}).action).toBe('deny')
  })

  it.each(['cat $(echo $(echo README.md))', 'ls $(dirname $(git rev-parse --show-toplevel))'])(
    'control: %s -> allow',
    (command) => {
      expectAllow(command)
    }
  )
})

// SMI-6869 governance round 12 (cross-family gate, class 1, finding 2): when
// argv[0] IS a substitution, the pre-existing "does the body print its own
// name" re-check substitutes the body's HEAD word (`echo` in
// `$(echo cat) .env`) for argv[0] -- never what the body actually PRINTS
// (`cat`). A protected file in a REMAINING argument is still that unnamed
// command's argument regardless of what it turns out to be, so
// `checkUnresolvedHeadTail` now checks the remaining arguments FIRST,
// independent of resolving the head.
describe('decide() — SMI-6869 governance round 12 F2: a computed reader with a protected argument denies, whatever the substitution body says', () => {
  it.each(['$(echo cat) .env', '$(which cat) /app/.env', '`echo cat` .worktrees/x/.env'])(
    '%s -> deny',
    (command) => {
      expect(decide(bashCall(command), {}).action).toBe('deny')
    }
  )

  it.each(['$(echo ls) .env.example', '$(echo cat) README.md'])(
    'control: %s -> allow',
    (command) => {
      expectAllow(command)
    }
  )

  it('control: $(cat) .env still denies (the body prints its own name, the pre-existing shape)', () => {
    expect(decide(bashCall('$(cat) .env'), {}).action).toBe('deny')
  })
})

// SMI-6892 (round 16, ADR-172 sec 1): round 12 caught a SUBSTITUTION head
// (`$(echo cat) .env`) but not a bare VARIABLE head with no substitution
// at all -- `$X cat .env` / `$EDITOR .env` tokenize with NO `.subs`, so
// `checkUnresolvedHeadTail`'s old `(aligned[0].subs?.length ?? 0) === 0`
// early-return treated them as an ordinary, resolved head and never
// re-checked the tail at all. This is a narrower fix than round 12's own
// "documented limit" ruling just below (a name a shell only ASSEMBLES at
// runtime, like `cat ${f}v`, stays out of reach by design) -- a bare `$X`
// or `$EDITOR` used AS THE COMMAND NAME, with an ALREADY-LITERAL protected
// argument, is exactly the shape ADR-172 sec 1 names as a read target,
// not a "variable-built path" the guard was never meant to resolve.
describe('decide() — SMI-6892 (ADR-172 sec 1): a bare variable head (no substitution) with a protected argument denies, the same as a substitution head', () => {
  it.each([
    ['$X cat .env', '$X cat .env'],
    ['$EDITOR .env (single-word variable head)', '$EDITOR .env'],
    ['sudo $X cat .env (wrapper-peeled first)', 'sudo $X cat .env'],
    ['$X $(echo cat) .env (variable head, substitution tail)', '$X $(echo cat) .env'],
  ])('%s -> deny', (_label, command) => {
    expect(decide(bashCall(command), {}).action).toBe('deny')
  })

  it.each([
    ['$X cat README.md (no protected argument)', '$X cat README.md'],
    ['$CMD .env.example (safe file)', '$CMD .env.example'],
    ['$X ls -la (no protected argument at all)', '$X ls -la'],
    ['echo $X cat .env (a LITERAL, resolved echo head)', 'echo $X cat .env'],
  ])('%s -> allow (control)', (_label, command) => {
    expectAllow(command)
  })

  it("grep -qE '^KEY=' .env -> allow (control: the sanctioned output-free exception is unaffected)", () => {
    expectAllow("grep -qE '^KEY=' .env")
  })
})

// SMI-6869 governance round 12 (ruling, not a fix): `cat $(echo /app/.en)v`
// allows and stays allowed. The guard's contract is literal text -- a
// protected name spelled anywhere, substitution bodies included, is a read
// target; a name the shell only ASSEMBLES at runtime (a variable, a
// non-literal emitter, or a literal split across a substitution boundary)
// is out of reach, the same limit a plain shell variable already has.
// Making that fail closed would deny every computed-reader path
// (`cat "$LOG"` included) -- a design change outside this PR.
describe('decide() — documented limit: a protected name assembled across a substitution boundary is not spelled anywhere and stays out of reach, like a variable-built path', () => {
  it('cat $(echo /app/.en)v -> allow', () => {
    expectAllow('cat $(echo /app/.en)v')
  })

  it('f=.en; cat ${f}v -> allow', () => {
    expectAllow('f=.en; cat ${f}v')
  })
})

// SMI-6869 governance round 14 L5: a reader that receives the filename from
// another command's own OUTPUT, not as a literal argv token, is the same
// class of documented limit as the substitution-boundary case above -- the
// name is spelled literally in the command text, but never lands in the
// consuming reader's own argv, which is all `checkArgv` inspects.
describe("decide() — documented limit: a reader that receives the filename from another command's output, not its own argv, stays out of reach", () => {
  it('echo .env | xargs cat -> allow', () => {
    expectAllow('echo .env | xargs cat')
  })

  it('find . -name .env -exec cat {} \\; -> allow', () => {
    expectAllow('find . -name .env -exec cat {} \\;')
  })
})

// SMI-6869 governance round 12 F4 (tokenizer comment rule) — these two are
// CONTROLS for this guard, not red arms: both already deny/allow correctly
// on the merged tree too, since the protected name here sits BEFORE any
// `#`, or the whole line is nothing but a comment (nothing executes either
// way). Kept here to confirm the tokenizer's new comment rule doesn't
// regress either shape.
describe('decide() — SMI-6869 governance round 12 F4 controls: a comment does not change a verdict decided before it, or a whole-line comment', () => {
  it('cat .env # x -> deny (the read happens before the comment)', () => {
    expect(decide(bashCall('cat .env # x'), {}).action).toBe('deny')
  })

  it('# cat .env -> allow (the whole line is a comment; nothing runs)', () => {
    expectAllow('# cat .env')
  })
})

// SMI-6869 governance round 15 (C1 regression, this PR's own comment rule):
// the round-12 F4 fix used `cur === null` alone as the comment boundary,
// which is the TOKENIZER's word boundary, not bash's. `{`/`}` are flushed
// as op tokens unconditionally, so a `#` glued right after one looked like
// a fresh word start though bash does not end a word there; and the
// whitespace flush used JS `/\s/`, which treats CR/VT/FF/NBSP as blanks
// though bash's only word-ending blanks are space/tab/newline. Either gap
// let the "comment" swallow real command text after it. Fixed with a
// positive allowlist (`COMMENT_BOUNDARY_CHARS`): a `#` starts a comment
// only right after one of bash's own word-ending characters, or at the
// start of input.
describe('decide() — SMI-6869 governance round 15 C1: a # glued to }/{ or to a non-bash blank is not a comment boundary, so the read after it still denies', () => {
  it.each([
    ['glued to } (${X}#x)', 'echo ${X}#x; cat .env'],
    ['glued to } via a literal brace-expansion attempt (a{b}#x)', 'echo a{b}#x; cat .env'],
    ['glued to a non-bash blank (NBSP)', 'echo hi\u00a0#x; cat .env'],
  ])('%s -> deny (the # never starts a comment, so the read is not hidden)', (_label, command) => {
    expect(decide(bashCall(command), {}).action).toBe('deny')
  })

  it('echo hi # x; cat .env -> allow (control: a REAL comment, preceded by an actual space, still hides the read)', () => {
    expectAllow('echo hi # x; cat .env')
  })

  it('echo a\\#b; cat .env -> deny (control: an escaped # never starts a comment, boundary or not)', () => {
    expect(decide(bashCall('echo a\\#b; cat .env'), {}).action).toBe('deny')
  })

  it.each([
    ['parameter-length operator (${#arr[@]})', 'echo ${#arr[@]}; cat .env'],
    ['parameter-pattern operator (${v#pat})', 'echo ${v#pat}; cat .env'],
    ['a URL fragment (http://x/#f)', 'echo http://x/#f; cat .env'],
  ])(
    '%s -> deny (control: unaffected by this fix, a genuine non-comment # the guard already read correctly)',
    (_label, command) => {
      expect(decide(bashCall(command), {}).action).toBe('deny')
    }
  )
})

// SMI-6892 C3 (round 16): a `)` is a comment boundary only when it closes
// a COMMAND-position `(` (a real subshell/group, or `((...))`), or it is
// UNMATCHED (a `case` pattern) -- measured in bash 3.2, bash 5.2 and zsh
// 5.9, all three agreeing. A WORD-position `)` is NOT a boundary: zsh's
// glob-alternation group `(a|b)#x` (measured live -- with no match, zsh's
// own parse error is `no matches found: (a|b)#x`, i.e. `#x` was already
// part of the glob token, not split off as a comment) and bash's
// array-assignment parens `a=(1 2)#x` (bash runs the tail; zsh reads a
// comment -- the shells disagree, so the word-position reading wins, the
// safer direction for a guard) both keep `#x` live. A `\`+newline
// continuation removed just before the `#` does not change either verdict
// (the continuation rows below).
describe('decide() — SMI-6892 C3: a ) is a comment boundary only when it closes a command-position ( or is unmatched, not unconditionally', () => {
  it('(echo x)#x; cat .env -> allow (a command-position close -- a real subshell -- IS a comment boundary)', () => {
    expectAllow('(echo x)#x; cat .env')
  })

  it('true && (echo x)#x; cat .env -> allow (command-position close after &&)', () => {
    expectAllow('true && (echo x)#x; cat .env')
  })

  it('((1))#x; cat .env -> allow (command-position close, arithmetic ((...)))', () => {
    expectAllow('((1))#x; cat .env')
  })

  it('case a in a)#x; cat .env<nl>esac -> allow (an UNMATCHED ) ending a case pattern IS a comment boundary too)', () => {
    expectAllow('case a in a)#x; cat .env\nesac')
  })

  it('echo (a|b)#x; cat .env -> deny (a WORD-position close -- the zsh glob-alternation shape -- is NOT a boundary, measured live in zsh 5.9)', () => {
    expect(decide(bashCall('echo (a|b)#x; cat .env'), {}).action).toBe('deny')
  })

  it('a=(1 2)#x; cat .env -> deny (a WORD-position close -- array assignment -- keeps the tail live in bash; the shells disagree, so the word-position reading wins)', () => {
    expect(decide(bashCall('a=(1 2)#x; cat .env'), {}).action).toBe('deny')
  })

  it('echo (a|b)\\<nl>#x; cat .env -> deny (a removed continuation right before # does not turn a word-position close into a boundary)', () => {
    expect(decide(bashCall('echo (a|b)\\\n#x; cat .env'), {}).action).toBe('deny')
  })

  it('a=(1 2)\\<nl>#x; cat .env -> deny (same, for the array-assignment shape)', () => {
    expect(decide(bashCall('a=(1 2)\\\n#x; cat .env'), {}).action).toBe('deny')
  })

  it('(echo x)\\<nl>#x; cat .env -> allow (same continuation removal, but a command-position close -- still a boundary)', () => {
    expectAllow('(echo x)\\\n#x; cat .env')
  })

  it('f()#x; cat .env<nl>{ :; } -> allow (SMI-6892 round 17: an EMPTY function-definition ) glued to the name IS a comment boundary)', () => {
    expectAllow('f()#x; cat .env\n{ :; }')
  })

  it("function f ()#x; cat .env<nl>{ :; } -> allow (same, with the 'function' keyword and a spaced name)", () => {
    expectAllow('function f ()#x; cat .env\n{ :; }')
  })

  it("case a in (a)#x; cat .env<nl>:;;<nl>esac -> allow (SMI-6892 round 17: a case statement's own leading pattern ( IS a comment boundary too)", () => {
    expectAllow('case a in (a)#x; cat .env\n:;;\nesac')
  })

  it('f ( )#x; cat .env<nl>{ :; } -> deny (a SPACED function-paren close -- the zsh glob-word shape -- is NOT a boundary)', () => {
    expect(decide(bashCall('f ( )#x; cat .env\n{ :; }'), {}).action).toBe('deny')
  })

  it('a=()#x; cat .env -> deny (an empty array-assignment ) keeps the tail live in bash; the name carries =, so it is not a function definition)', () => {
    expect(decide(bashCall('a=()#x; cat .env'), {}).action).toBe('deny')
  })

  it("echo in (a|b)#x; cat .env -> deny ('in' here is an argument, not the case keyword, so its ( is not a case pattern paren)", () => {
    expect(decide(bashCall('echo in (a|b)#x; cat .env'), {}).action).toBe('deny')
  })

  it('f (\\<nl>)#x; cat .env<nl>{ :; } -> deny (SMI-6892 round 18: a continuation INSIDE the function parens makes zsh read ()#x as a glob word and run the tail; bash reads a comment; the shells disagree, so the tail stays live)', () => {
    expect(decide(bashCall('f (\\\n)#x; cat .env\n{ :; }'), {}).action).toBe('deny')
  })

  it('f(\\<nl>)#x; cat .env<nl>{ :; } -> deny (same, glued: zsh runs the tail under nonomatch)', () => {
    expect(decide(bashCall('f(\\\n)#x; cat .env\n{ :; }'), {}).action).toBe('deny')
  })

  it.each([
    ['a real read inside a subshell, no # at all', '(cat .env)'],
    ['a real read after a subshell, no #', '(echo x); cat .env'],
    ['a real read after a glob word, no #', 'echo (a|b) ; cat .env'],
    ['a real read inside a function body, no # at all', 'f() { cat .env; }'],
    ['a real read inside a case arm, no # at all', 'case a in (a) cat .env;; esac'],
  ])('%s: %j -> deny (control: no # at all, unaffected by this rule)', (_label, command) => {
    expect(decide(bashCall(command), {}).action).toBe('deny')
  })
})

// SMI-6869 governance round 15 C2 (pre-existing): `evaluateCommand` used to
// segment on every op token `tokenize` emits, `{`/`}` included -- but
// `{`/`}` are bash RESERVED WORDS, not separators, so splitting on them tore
// `${HOME}/.env` into three pieces (`$`, an empty segment between the
// braces, `/.env`) and the `/.env` piece alone never resolved to a protected
// path. `cat $HOME/.env` (no braces at all) was never affected, since there
// are no `{`/`}` tokens to mis-split on -- the same divergence round 11
// already fixed for the config-value path (`SEGMENT_BOUNDARY_OPS`). Fixed
// by segmenting on the shared `SEGMENT_SEPARATOR_OPS` (real separators only)
// via `splitCommandSegments`, imported from shell-command-normalize.mjs.
describe('decide() — SMI-6869 governance round 15 C2: an unquoted ${VAR} expansion is not torn apart by the segmenter, so a protected path inside it still denies', () => {
  it('cat ${HOME}/.env -> deny (the whole word resolves as one, braces and all)', () => {
    expect(decide(bashCall('cat ${HOME}/.env'), {}).action).toBe('deny')
  })

  it('cat ${HOME}/.env.example -> allow (the safe-file allowlist still applies through the brace expansion)', () => {
    expectAllow('cat ${HOME}/.env.example')
  })

  it('cat ${X} -> allow (control: a braced expansion naming nothing protected)', () => {
    expectAllow('cat ${X}')
  })

  it.each([
    ['double-quoted', 'cat "${HOME}/.env"'],
    ['no braces at all', 'cat $HOME/.env'],
  ])(
    '%s: %s -> deny (control: already denied before this fix, unaffected by it)',
    (_label, command) => {
      expect(decide(bashCall(command), {}).action).toBe('deny')
    }
  )
})

// SMI-6892 C1 (round 16, regression in the round-15 C2 fix): not splitting
// on `{`/`}` is what lets `cat ${HOME}/.env` read as ONE command, but it
// also MERGES the words on either side of a dropped brace into one
// segment -- so `${X} cat .env` tokenizes as `$` `{` `X` `}` `cat` `.env`,
// and the merged segment's own argv[0] is the bare `$`, not the shell's
// real command name `cat`, which reached ALLOW. Fixed with
// `groupingOpSubRuns` (shell-command-segments.mjs): every run of words
// starting right after a DROPPED op (a `{` or `}`) is checked as its OWN
// segment too, alongside the coarse `splitCommandSegments` one -- a
// violation in either denies (monotone: this can only ADD denials, never
// remove one). Measured in bash 3.2 (host), bash 5.2 (container) AND zsh
// 5.9 (host): with `X` unset, `${X} cat probe.txt`, `${X}cat probe.txt`
// (glued) and `V=${X} cat probe.txt` all really read the probe file in
// all three shells -- an unset unquoted expansion contributes ZERO words,
// so the real head is `cat`, not `$`.
describe('decide() — SMI-6892 C1: a merged ${VAR} segment does not hide the real command name behind the brace', () => {
  it.each([
    ['${X} cat .env', '${X} cat .env'],
    ['${X}cat .env (glued)', '${X}cat .env'],
    ['${A}${B} cat .env (two adjacent braces)', '${A}${B} cat .env'],
    ['{ ${X} cat .env; } (inside a brace GROUP too)', '{ ${X} cat .env; }'],
    ['V=${X} cat .env (assignment prefix)', 'V=${X} cat .env'],
    ['${} cat .env (empty braces)', '${} cat .env'],
  ])('%s -> deny', (_label, command) => {
    expect(decide(bashCall(command), {}).action).toBe('deny')
  })

  it.each([
    [
      'a{b} cat README.md (invalid brace expansion, stays literal, no protected arg)',
      'a{b} cat README.md',
    ],
    ['echo ${X} cat README.md (literal echo head, no protected arg)', 'echo ${X} cat README.md'],
  ])('%s -> allow (control)', (_label, command) => {
    expectAllow(command)
  })
})

// SMI-6892 C2 (round 16, pre-existing, both guards): a backslash + newline
// is a LINE CONTINUATION bash and zsh both remove before word splitting,
// but the tokenizer's backslash branch appended the newline into the word
// instead -- `cat \<nl>.env` reached the read check as the literal string
// `"\n.env"`, which is not `.env`, and allowed. Each row below must give
// the EXACT SAME verdict and reason as its non-continuation spelling, the
// same equality-pair shape the backtick/`$(...)`  pairs above use.
describe('decide() — SMI-6892 C2: a line continuation (backslash + newline) is invisible to the guard, exactly like its non-continuation spelling', () => {
  function reasonOf(result: ReturnType<typeof decide>): string {
    return result.json?.hookSpecificOutput.permissionDecisionReason ?? ''
  }

  it.each([
    ['cat \\<nl>.env', 'cat \\\n.env', 'cat .env'],
    ['ca\\<nl>t .env (command NAME split)', 'ca\\\nt .env', 'cat .env'],
    ['cat .en\\<nl>v (mid-argument split)', 'cat .en\\\nv', 'cat .env'],
    ['cat "\\<nl>.env" (removed inside double quotes too)', 'cat "\\\n.env"', 'cat ".env"'],
    [
      'bash -c "cat \\<nl>.env" (nested shell body)',
      'bash -c "cat \\\n.env"',
      'bash -c "cat .env"',
    ],
  ] as const)('%s matches its plain spelling', (_label, contCmd, plainCmd) => {
    const contResult = decide(bashCall(contCmd), {})
    const plainResult = decide(bashCall(plainCmd), {})
    expect(contResult.action).toBe(plainResult.action)
    expect(contResult.action).toBe('deny')
    expect(reasonOf(contResult)).toBe(reasonOf(plainResult))
  })
})

// SMI-6869 governance round 15 C3 (pre-existing): `evaluateCommand`'s own
// depth cap failed OPEN -- `if (depth > MAX_DEPTH || ...) return null`, with
// `null` meaning ALLOW -- while `ruflo-host-guard.mjs`'s own
// `evaluateGuardCommand` fails CLOSED at the same shared `MAX_DEPTH`, and
// this file's own `flattenSubWords` docblock already claimed the fail-closed
// posture for substitution bodies. A `bash -c` chain nested past MAX_DEPTH
// (6) hid its innermost `cat .env` behind the cap instead of denying it.
// Each nest level's own lexical VALIDITY (that bash actually runs the
// innermost command through that many `bash -c "..."` wrappers) is
// confirmed by retro14-depth3-validity.out, not re-derived here.
describe('decide() — SMI-6869 governance round 15 C3: the depth cap fails CLOSED, not open -- a command nested past MAX_DEPTH denies, it is never silently allowed unread', () => {
  function nestBashC(n: number, inner: string): string {
    let s = inner
    for (let k = 0; k < n; k++) {
      s = 'bash -c "' + s.replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"'
    }
    return s
  }

  function reasonOf(result: ReturnType<typeof decide>): string {
    return result.json?.hookSpecificOutput.permissionDecisionReason ?? ''
  }

  it('a 6-level bash -c chain around cat .env still denies as an ordinary read (within MAX_DEPTH)', () => {
    const result = decide(bashCall(nestBashC(6, 'cat .env')), {})
    expect(result.action).toBe('deny')
    expect(reasonOf(result)).not.toContain('past depth')
    expect(reasonOf(result)).toContain('.env')
  })

  it('a 7-level bash -c chain around cat .env denies depth-cap -- past MAX_DEPTH, the innermost read is never reached, let alone allowed', () => {
    const result = decide(bashCall(nestBashC(7, 'cat .env')), {})
    expect(result.action).toBe('deny')
    expect(reasonOf(result)).toContain('past depth 6')
  })

  it('a 7-level bash -c chain around a BENIGN command (echo hi) also denies depth-cap: the fail-closed consequence is unconditional on content, not a read-specific check', () => {
    const result = decide(bashCall(nestBashC(7, 'echo hi')), {})
    expect(result.action).toBe('deny')
    expect(reasonOf(result)).toContain('past depth 6')
  })

  // M6: `varlock load` is not the fix for a command that nests too deep --
  // the depth-cap reason gets its own alternative tail instead of the
  // shared one every other reason uses.
  it('the depth-cap reason names its own disable var and never mentions varlock', () => {
    const reason = reasonOf(decide(bashCall(nestBashC(7, 'cat .env')), {}))
    expect(reason).toContain('SKILLSMITH_ENV_READ_GUARD_DISABLE=1')
    expect(reason).not.toContain('varlock')
  })
})

// Round 13 (the confirmation gate): a computed reader's ARGUMENTS are opened
// like any other argument's substitutions, and the head check runs on the
// wrapper-peeled argv, so a wrapper in front of a computed reader does not
// hide it. Before this fix the head check saw `sudo`/`docker` as the head
// and read a tail substitution as the literal text `$(echo .env)`.
describe('decide() — SMI-6869 round 13: a computed reader is judged after wrapper peeling, with its tail substitutions opened', () => {
  it.each([
    '$(echo cat) $(echo .env)',
    '$(echo cat) "$(echo /app/.env)"',
    '$(echo cat) $(echo $(echo .env))',
    'sudo $(echo cat) .env',
    'sudo $(echo cat) $(echo .env)',
    'docker exec skillsmith-dev-1 $(echo cat) /app/.env',
    'varlock run -- $(echo cat) /app/.env',
  ])('%s -> deny', (command) => {
    expect(decide(bashCall(command), {}).action).toBe('deny')
  })

  it.each([
    '$(echo ls) $(echo .env.example)',
    'sudo $(echo ls) .env.example',
    '$(echo cat) $(echo README.md)',
    'sudo $(echo cat) README.md',
    "grep -qE '^KEY=' .env",
  ])('control: %s -> allow', (command) => {
    expectAllow(command)
  })

  it.each(['$(echo cat) .env', 'sudo cat .env', 'docker exec skillsmith-dev-1 cat /app/.env'])(
    'known-positive control: %s -> deny',
    (command) => {
      expect(decide(bashCall(command), {}).action).toBe('deny')
    }
  )
})

describe('decide() — SKILLSMITH_ENV_READ_GUARD_DISABLE hard-disable', () => {
  it('a command that would normally deny is allowed when the disable var is set', () => {
    const result = decide(bashCall('grep PAT .env'), { SKILLSMITH_ENV_READ_GUARD_DISABLE: '1' })
    expect(result).toEqual(ALLOW_RESULT)
  })

  it('a non-"1" value does not disable the guard (still denies)', () => {
    const result = decide(bashCall('grep PAT .env'), { SKILLSMITH_ENV_READ_GUARD_DISABLE: 'true' })
    expect(result.action).toBe('deny')
  })
})

describe('decide() — malformed / non-Bash input fails open to allow', () => {
  it('a non-Bash tool_name always allows, regardless of command content', () => {
    const result = decide({ tool_name: 'Read', tool_input: { command: 'cat .env' } }, {})
    expect(result).toEqual(ALLOW_RESULT)
  })

  it('a null toolCall allows, does not throw', () => {
    expect(() => decide(null, {})).not.toThrow()
    expect(decide(null, {})).toEqual(ALLOW_RESULT)
  })

  it('an undefined toolCall allows, does not throw', () => {
    expect(() => decide(undefined, {})).not.toThrow()
    expect(decide(undefined, {})).toEqual(ALLOW_RESULT)
  })

  it('a Bash tool_call with a missing command allows', () => {
    const result = decide({ tool_name: 'Bash', tool_input: {} }, {})
    expect(result).toEqual(ALLOW_RESULT)
  })

  it('a Bash tool_call with an empty/whitespace-only command allows', () => {
    const result = decide(bashCall('   '), {})
    expect(result).toEqual(ALLOW_RESULT)
  })
})

// SMI-6903 C1 (Critical regression, introduced by `50d38872d` / PR #2959 and
// found by the post-merge retro of PR #2970): an INPUT redirect's source is a
// read target. SMI-6869 Fix A tagged both the redirect operator word AND a
// space-separated target `redirect: true` so a trailing `2>&1` could not
// perturb a verdict, and `evaluateCommand` drops every redirect-marked word
// from argv -- right for an output redirect, wrong for an input one. Sixteen
// spellings went from deny to allow at that commit; `cat < .env` and
// `cat <.env` were measured printing a decoy file's contents in bash 3.2,
// bash 5.2 and zsh 5.9. Every arm below was watched FAILING against the
// unfixed tree (the PR #2970 merge state) before the fix landed.
describe('decide() — SMI-6903 C1: an input redirect source is a read target', () => {
  const redArms = [
    'cat < .env',
    'cat <.env',
    'cat 0< .env',
    'cat <> .env',
    'grep KEY < .env',
    'head -5 < .env',
    'base64 < .env',
    'sudo cat < .env',
    'bash -c "cat < .env"',
    'docker exec c cat < /app/.env',
    'cat < ./.env',
    'cat < .env.local',
    '$X < .env',
  ]
  it.each(redArms)('%s -> deny (the redirect source is the read target)', (command) => {
    expect(decide(bashCall(command), {}).action).toBe('deny')
  })

  const controls = [
    // An unrelated file, a safe file, and a trailing stderr redirect.
    'cat < notes.txt',
    'cat < .env.example',
    'cat notes.txt 2>&1',
    // An OUTPUT redirect writes; it does not emit the file's contents.
    'echo hi > .env',
    // A here-string's operand is TEXT, not a filename: measured in all three
    // shells, `cat <<< .env` prints the four characters `.env`.
    'cat <<< .env',
  ]
  it.each(controls)('control: %s -> allow', (command) => {
    expectAllow(command)
  })

  // Asserted as a PROPERTY rather than a pinned verdict: whatever posture the
  // guard takes for a metadata-only reader, the redirect spelling must match
  // the argv spelling. This stays correct if `wc` ever leaves
  // METADATA_COMMANDS, where a hardcoded `allow` would silently go stale.
  it('`wc < .env` and `wc .env` reach the SAME verdict (metadata-only parity)', () => {
    expect(decide(bashCall('wc < .env'), {}).action).toBe(decide(bashCall('wc .env'), {}).action)
  })

  // Same parity argument for the one sanctioned exception.
  it('`grep -q KEY < .env` and `grep -q KEY .env` reach the SAME verdict', () => {
    expect(decide(bashCall('grep -q KEY < .env'), {}).action).toBe(
      decide(bashCall('grep -q KEY .env'), {}).action
    )
  })
})

// SMI-6903 C2 (Critical, pre-existing): a `#` inside an arithmetic command
// `((…))` is NOT a comment. Measured in bash 3.2, bash 5.2 and zsh 5.9:
// `(( 1 #2 )); printf MARK` prints MARK in all three, and
// `(( 1 #2 )); cat <decoy>` prints the decoy's contents -- while the comment
// rule discarded the whole rest of the line, so both guards allowed it.
// Adjacency is the discriminator and it was measured, not reasoned.
describe('decide() — SMI-6903 C2: no comment inside an arithmetic ((…))', () => {
  const redArms = [
    '(( 1 #2 )); cat .env',
    '(( #2 )); cat .env',
    'if (( 1 #2 )); then :; fi; cat .env',
    'true && (( 1 #2 )); cat .env',
    '(( $(echo 1) #2 )); cat .env',
  ]
  it.each(redArms)('%s -> deny (the tail after the `#` is live)', (command) => {
    expect(decide(bashCall(command), {}).action).toBe('deny')
  })

  const controls = [
    // A SPACE between the parens makes them nested subshells, where the `#`
    // IS a comment in all three shells, so the tail never runs.
    '( ( 1 #2 ) ); cat .env',
    // A `#` after the arithmetic pair CLOSES is an ordinary comment
    // (measured: `(( 1 )) #c; printf MARK` prints nothing in all three).
    '(( 1 )) #c; cat .env',
  ]
  it.each(controls)('control: %s -> allow (a real comment there)', (command) => {
    expectAllow(command)
  })

  it('control: a glued `16#ff` base literal is not a comment and still denies', () => {
    expect(decide(bashCall('((1#2)); cat .env'), {}).action).toBe('deny')
  })
})

// SMI-6903 C3 (Critical, pre-existing): a zsh glob group in ARGUMENT position
// is one word, so the separator segmentation (which splits on `(`, `|` and
// `)`) tore the protected path away from the reader consuming it and left it
// as a harmless-looking `argv[0]`. Reachability was demonstrated inside the
// gated context itself: Claude Code's Bash tool runs `/bin/zsh` 5.9 on this
// machine, and a tool call of this exact shape printed a decoy file's
// contents. The paren twin of the brace fault round 15 fixed for
// `cat ${HOME}/.env`, and fixed the same way: an extra reading.
describe('decide() — SMI-6903 C3: a zsh glob group cannot hide a read target', () => {
  const redArms = [
    'cat (.env|zzz)',
    'cat (zzz|.env)',
    'cat (.env)',
    'head -5 (.env|zzz)',
    'cat /app/(.env|zzz)',
    'cat ./(.env|zzz)',
    'cat $D/(.env|zzz)',
  ]
  it.each(redArms)('%s -> deny (one zsh word; the reader keeps its argument)', (command) => {
    expect(decide(bashCall(command), {}).action).toBe('deny')
  })

  it('control: a real subshell (cat .env) still denies (command-position paren)', () => {
    expect(decide(bashCall('(cat .env)'), {}).action).toBe('deny')
  })

  it('control: echo (a|b); cat .env -> deny (the second segment is a real read)', () => {
    expect(decide(bashCall('echo (a|b); cat .env'), {}).action).toBe('deny')
  })

  const allowControls = [
    'echo (a|b)',
    'cat (notes.txt|zzz)',
    'cat (.env.example|zzz)',
    // An array assignment is NOT a glob alternation: its alternative holds
    // two words, which no glob alternative can.
    'a=(1 2); echo ok',
  ]
  it.each(allowControls)('control: %s -> allow', (command) => {
    expectAllow(command)
  })
})

// SMI-6903 round 21 F1 (Critical, pre-existing and older than this branch):
// a shell RESERVED WORD or command modifier at a segment's head is not the
// command. None of them is an operator, so no segmentation splits there, and
// `argv[0]` was the modifier while the reader's own name was a mere argument.
// Every arm below ALLOWED on the pre-fix tree (the branch head before this
// commit) and every one emits a decoy file's contents in bash 3.2 (host),
// bash 5.2 (container) and zsh 5.9 (host, the shell Claude Code's Bash tool
// runs on this machine) -- measured, with the decoy actually read. The WORD
// twin of the brace fault round 15 fixed for `cat \${HOME}/.env` and the paren
// fault C3 fixed above; fixed the same way, with an extra reading.
describe('decide() — SMI-6903 F1: a reserved word or modifier cannot hide a reader', () => {
  const redArms = [
    'if true; then cat .env; fi',
    'if true; then :; else cat .env; fi',
    'if true; then :; elif true; then cat .env; fi',
    'if cat .env; then :; fi',
    'for f in a b; do cat .env; done',
    'for ((i=0;i<3;i++)); do cat .env; done',
    'while :; do cat .env; done',
    'until false; do cat .env; done',
    'select f in a; do cat .env; done',
    'time cat .env',
    'command cat .env',
    'exec cat .env',
    'eval cat .env',
    'builtin cat .env',
    '! cat .env',
    // The peel is iterative, so a stacked pair still reaches the reader.
    'then command cat .env',
    // The peeled segment keeps its own redirect words, so an input-redirect
    // source behind a reserved word is still this segment's read target.
    'do cat < .env',
  ]
  it.each(redArms)('%s -> deny (the head word is not the command)', (command) => {
    expect(decide(bashCall(command), {}).action).toBe('deny')
  })

  const controls = [
    'if true; then cat notes.txt; fi',
    'if true; then cat .env.example; fi',
    'for f in a b; do echo "$f"; done',
    // `echo` is not a reader, so peeling reaches it and still allows.
    'then echo .env',
    'command -v cat',
    // ADR-172 sec 1's named out-of-contract shapes stay allowed: `read` prints
    // nothing, and the loop body's `echo "$l"` is variable indirection.
    'read -r line < .env',
    'while IFS= read -r l; do echo "$l"; done < .env',
  ]
  it.each(controls)('control: %s -> allow', (command) => {
    expectAllow(command)
  })

  // Still a pin, still out of contract (ADR-172 sec 1): xargs's command gets
  // its arguments from stdin as TEXT, not as an argv path the guard can see.
  // The launcher rows that used to sit beside it here were a leak, not a
  // limit; they are arms in the round 22 block below.
  it('pin (out of contract): echo .env | xargs cat -> allow', () => {
    expectAllow('echo .env | xargs cat')
  })
})

// SMI-6903 round 22 F1 (Critical, pre-existing; found by the cross-family
// gate): a process LAUNCHER takes its own options and operands BEFORE the
// command, so the one-word peel above stopped at `5` in `timeout 5 cat .env`,
// and the branch had pinned that shape as an allowed limit. ADR-172 sec 1
// class 1 covers an argv path behind a modifier head and names only `xargs`
// out of contract, so the pin recorded a leak. The ruflo guard has read these
// through its launcher table since SMI-6744 Wave 4; that table now lives in
// `shell-command-launchers.mjs`, and the transparent-head reading consumes a
// launcher's own flags and positionals, and a wrapper prefix the guard already
// peels, before peeling on. Every arm below ALLOWED on `827a0b910`, and each
// launcher emits a decoy file's contents on whichever of bash 3.2, bash 5.2
// and zsh 5.9 has it (measured; the per-shell table is in that module).
describe("decide() — SMI-6903 round 22 F1: a launcher's own operands cannot hide a reader", () => {
  const redArms = [
    'timeout 5 cat .env',
    'timeout --foreground -k 2 5 cat .env',
    'timeout -s TERM 5 cat .env',
    '/usr/bin/timeout 5 cat .env',
    'nice cat .env',
    'nice -n 5 cat .env',
    'nice -n5 cat .env',
    'nice -5 cat .env',
    'nice --adjustment=5 cat .env',
    'nohup cat .env',
    'setsid -w cat .env',
    'stdbuf -oL cat .env',
    'stdbuf -o L cat .env',
    'ionice -c3 -n7 cat .env',
    'caffeinate -t 5 cat .env',
    'taskset -c 0 cat .env',
    'flock -n /tmp/l cat .env',
    'chroot / cat .env',
    'script -q /dev/null cat .env',
    // A transparent word's own flag: round 21 peeled the word and left `-a`.
    'exec -a x cat .env',
    'command -p cat .env',
    // Chains, in both orders, and behind wrappers the guard already peels.
    'timeout 5 nice cat .env',
    'nice timeout 5 cat .env',
    'nohup nice -n 5 cat .env',
    'env X=1 timeout 5 cat .env',
    'sudo timeout 5 cat .env',
    'docker exec c timeout 5 cat /app/.env',
    'if true; then timeout 5 cat .env; fi',
    // The peeled segment keeps its own redirect words (F3 reaches the body).
    'timeout 5 cat < .env',
    'timeout 5 bash -c cat < .env',
  ]
  it.each(redArms)('%s -> deny (the launcher is not the command)', (command) => {
    expect(decide(bashCall(command), {}).action).toBe('deny')
  })

  const controls = [
    'timeout 5 ls',
    'nice -n 5 npm test',
    'nohup npm run build',
    'timeout 5 cat notes.txt',
    'flock -n /tmp/l ls -la',
    'sudo timeout 5 ls',
    // The sanctioned output-free presence check survives a launcher.
    "timeout 5 grep -qE '^KEY=' .env",
    // `echo` is not a reader; peeling reaches it and still allows.
    'timeout 5 echo .env',
    // A launcher with nothing after its own operands has no command to judge.
    'timeout 5',
    'nice -n 5',
  ]
  it.each(controls)('control: %s -> allow', (command) => {
    expectAllow(command)
  })
})

// SMI-6903 round 23 (Critical, the cross-family re-gate): three launchers IN
// the table had an incomplete option model, so a value sat where the command
// should be and the reader behind it was never reached: BSD `script -t TIME`
// (`script -q -t 1 /dev/null cat .env` printed a decoy in bash 3.2 and zsh
// 5.9), GNU `stdbuf --output L` and util-linux `ionice --class 3` /
// `--classdata 7` (printed in bash 5.2). Every row's value flags are now the
// launcher's full synopsis, separated long forms included. The same round
// closes a launcher's own `-c` body as shell text, one level deep: util-linux
// `script -c`, `--command`, `--command=`, `-c` after the file, `flock FILE
// -c`, `su -c` (each but `su` measured printing in bash 5.2), and a
// short-flag cluster carrying a stop flag (`command -pv cat .env` prints
// cat's path and runs nothing). Every arm below ALLOWED on `e5396e581`.
describe("decide() — SMI-6903 round 23: a launcher's full option model, and its -c body", () => {
  const redArms = [
    'script -q -t 1 /dev/null cat .env',
    'script -F /tmp/p /dev/null cat .env',
    'stdbuf --output L cat .env',
    'stdbuf --error L cat .env',
    'ionice --class 3 cat .env',
    'ionice --classdata 7 cat .env',
    'ionice -c 2 --classdata 7 cat .env',
    'flock --wait 5 /tmp/l cat .env',
    'flock --timeout 5 /tmp/l cat .env',
    'chrt -d -T 1000 -P 2000 -D 3000 0 cat .env',
    // The `-c` body is shell text.
    "script -q -c 'cat .env' /dev/null",
    "script -q --command 'cat .env' /dev/null",
    "script -q --command='cat .env' /dev/null",
    "script -q /dev/null -c 'cat .env'",
    "script -q -c 'ls; cat .env' /dev/null",
    "script -q -c 'ls && cat .env' /dev/null",
    "flock /tmp/l -c 'cat .env'",
    "su -c 'cat .env'",
    "su root -c 'cat .env'",
    "sudo script -q -c 'cat .env' /dev/null",
    "timeout 5 script -q -c 'cat .env' /dev/null",
    // A shell inside the body is the guard's own wrapper arm, reached through
    // the body's segment.
    'script -q -c "bash -c \'cat .env\'" /dev/null',
  ]
  it.each(redArms)('%s -> deny', (command) => {
    expect(decide(bashCall(command), {}).action).toBe('deny')
  })

  // Round 24 (the re-gate on round 23's fix), each ALLOWED on `733427c82` and
  // each measured printing a decoy in bash 5.2 unless noted: a short-flag
  // cluster whose `c` is last takes the next word as the body (getopt's
  // rule); a launcher INSIDE the body is peeled by the same reading; a body
  // inside the body is extracted one level further; `doas -a style` takes a
  // value (documented; no doas here); `flock --command`.
  const round24Arms = [
    "script -qc 'cat .env' /dev/null",
    "script -qc'cat .env' /dev/null",
    "script -q -c 'timeout 5 cat .env' /dev/null",
    "script -q -c 'nice -n 5 cat .env' /dev/null",
    "script -q -c 'if true; then cat .env; fi' /dev/null",
    "script -q -c 'ls; timeout 5 cat .env' /dev/null",
    'script -q -c "script -q -c \'cat .env\' /dev/null" /dev/null',
    'script -q --command="script -q -c \'timeout 5 cat .env\' /dev/null" /dev/null',
    'doas -a style cat .env',
  ]
  it.each(round24Arms)('%s -> deny (round 24)', (command) => {
    expect(decide(bashCall(command), {}).action).toBe('deny')
  })

  // A pin against the intra-branch tree `733427c82` (this guard's extractor
  // already read `--command` there; the round-24 arm for that spelling is the
  // RUFLO guard's), and an ARM against main's own history: on `60da8b5a8`,
  // the base of PR #2973, this allowed. Labelled with both trees because the
  // squash erased the round boundary (SMI-6908 F-7).
  it("arm against 60da8b5a8, pin against 733427c82: flock /tmp/l --command 'cat .env' -> deny", () => {
    expect(decide(bashCall("flock /tmp/l --command 'cat .env'"), {}).action).toBe('deny')
  })

  // A cluster whose `c` is NOT last takes the rest of the token as the body:
  // `script -cq 'cat .env'` runs `q` (measured: nothing printed), so this
  // reads `q`, never `cat .env`. Allowed, and a pin of getopt's rule.
  it("pin: script -cq 'cat .env' /dev/null -> allow (the body is `q`)", () => {
    expectAllow("script -cq 'cat .env' /dev/null")
  })

  // Three levels of `-c` nesting is past MAX_DASH_C_DEPTH: the innermost
  // body is not extracted (stated limit; the launcher row's own peel leaves
  // the quoted body as a positional). Pinned so the limit is recorded.
  it('pin (stated limit): a -c body three levels deep is not read', () => {
    const three = 'script -q -c "script -q -c \\"script -q -c \'cat .env\' f\\" f" f'
    expectAllow(three)
  })

  const controls = [
    "script -q -c 'ls -la' /dev/null",
    'script -q /dev/null ls',
    'stdbuf --output L ls',
    'ionice --class 3 ls',
    "flock /tmp/l -c 'ls'",
    // `command -v`/`-V` describe, in a cluster too; `command -v` with two
    // names describes both and reads neither.
    'command -pv cat .env',
    'command -v cat .env',
  ]
  it.each(controls)('control: %s -> allow', (command) => {
    expectAllow(command)
  })
})

// SMI-6908 (the post-merge retro of PR #2973): five residual shapes of the
// classes that PR closed, one level further out, every one ALLOWING on the
// pre-PR base `60da8b5a8` and on the merged `673f19ceb`, each measured with a
// decoy in bash 3.2 and zsh 5.9 on the host and bash 5.2 in the container.
describe('decide() — SMI-6908: a wrapper body read with every reading, the brace sub-run peeled, time -o, arch/xcrun, nocorrect', () => {
  // F-1: a wrapper's redirect body was read with the separator reading only
  // and never recursed, so a reader behind a reserved word, a launcher or a
  // second wrapper inside the body never met the source (35 of 37 heads).
  const wrapperBodyArms = [
    'bash -c "eval cat" < .env',
    'bash -c "command cat" < .env',
    'bash -c "nohup cat" < .env',
    'bash -c "if true; then cat; fi" < .env',
    'bash -c "nice -n 5 cat" < .env',
    'bash -c "timeout 5 cat" < .env',
    'bash -c "stdbuf -oL cat" < .env',
    'bash -c "bash -c \'cat\'" < .env',
    'sh -c "bash -c cat" < .env',
    'bash -c "eval cat" <.env',
    'bash -c "eval cat" 0< .env',
    'bash -c "eval cat" < $(echo .env)',
    'docker exec c bash -c "nohup cat" < /app/.env',
    'sudo bash -c "eval cat" < .env',
    'timeout 5 bash -c "nohup cat" < .env',
    'bash -c "echo hi; nohup cat" < .env',
  ]
  it.each(wrapperBodyArms)('%s -> deny (F-1, the body is read with every reading)', (command) => {
    expect(decide(bashCall(command), {}).action).toBe('deny')
  })

  // F-2: an assignment prefix carrying a brace tokenizes as `V=$`, `{`, `X`,
  // `}`, so the separator reading's head after the assignment peel is `X` and
  // only the brace sub-run held the real head, which had no head reading.
  const braceSubRunArms = [
    'V=${X} nohup cat .env',
    'V=${X} eval cat .env',
    'V=${X} command cat .env',
    'V=${X} exec cat .env',
    'V=${X} time cat .env',
    'V=${X} timeout 5 cat .env',
    'V=${X} nice -n 5 cat .env',
    'V=${X} setsid cat .env',
    'V=${X} stdbuf -oL cat .env',
    'V=${X} caffeinate -t 1 cat .env',
    'V=${HOME} nohup cat .env',
  ]
  it.each(braceSubRunArms)(
    '%s -> deny (F-2, the brace sub-run gets its head reading)',
    (command) => {
      expect(decide(bashCall(command), {}).action).toBe('deny')
    }
  )

  // F-3: BSD time's `-o FILE`; F-4: macOS `arch` and `xcrun`; F-5: zsh's
  // `nocorrect` precommand modifier.
  const launcherArms = [
    '/usr/bin/time -o /tmp/t cat .env',
    'time -a -o /tmp/t cat .env',
    'time -p -o /tmp/t cat .env',
    'arch -arm64 cat .env',
    'arch -x86_64 cat .env',
    'arch -arch arm64 cat .env',
    'xcrun cat .env',
    'xcrun --sdk macosx cat .env',
    'xcrun --toolchain default cat .env',
    'nocorrect cat .env',
    'nocorrect timeout 5 cat .env',
    'nocorrect eval cat .env',
  ]
  it.each(launcherArms)('%s -> deny (F-3/F-4/F-5)', (command) => {
    expect(decide(bashCall(command), {}).action).toBe('deny')
  })

  const controls = [
    // The caller's own exceptions still apply inside a body.
    'bash -c "wc -l" < .env',
    'bash -c "grep -q K" < .env',
    'bash -c "nohup wc -l" < .env',
    // The brace sub-run's peel reaches no reader here.
    'V=${X} ls',
    'foo ${X} nohup ls',
    // Launchers before a non-reader, and the describe-only forms.
    '/usr/bin/time -o /tmp/t ls',
    'arch -h',
    'xcrun --show-sdk-path',
    'xcrun -f cat',
    'nocorrect ls',
  ]
  it.each(controls)('control: %s -> allow', (command) => {
    expectAllow(command)
  })

  // PINS, measured identical on `60da8b5a8`, `673f19ceb` and here: the
  // unbraced assignment twin always read through the separator reading's
  // peel, and `V=${X} cat .env` had no head to peel.
  it.each(['V=$Y nohup cat .env', 'A=1 nohup cat .env', 'V=${X} cat .env'])(
    'pin (denied on every tree): %s -> deny',
    (command) => {
      expect(decide(bashCall(command), {}).action).toBe('deny')
    }
  )
})

// SMI-6908 round 27 F-17 (the cross-family gate on 4552e41a7): xcrun's own
// option spelling is single-dash, and the F-4 row carried only the
// double-dash forms, so `xcrun -sdk macosx cat .env` left `macosx` as argv[0]
// and allowed while the shell ran cat (the reviewer measured `xcrun -sdk
// macosx printf` printing; every row below re-measured with a decoy in bash
// 3.2 and zsh 5.9 on this host).
describe('decide() — SMI-6908 round 27 F-17: xcrun single-dash spellings', () => {
  const arms = [
    'xcrun -sdk macosx cat .env',
    'xcrun -toolchain default cat .env',
    'xcrun -sdk macosx -toolchain default cat .env',
    'xcrun -sdk macosx -- cat .env',
    'xcrun -sdk macosx -log cat .env',
    // Round 28: orderings and combinations, each measured printing a decoy
    // (a value-less flag before the value flag, `-run`/`-r` on either side,
    // an empty SDK, a repeated SDK in either spelling).
    'xcrun -log -sdk macosx cat .env',
    'xcrun -run -sdk macosx cat .env',
    'xcrun -r -sdk macosx cat .env',
    'xcrun -sdk macosx -r cat .env',
    'xcrun -sdk macosx -run cat .env',
    'xcrun -sdk "" cat .env',
    'xcrun -sdk macosx -sdk iphoneos cat .env',
    'xcrun --sdk macosx -sdk macosx cat .env',
  ]
  it.each(arms)('%s -> deny (allowed on 4552e41a7)', (command) => {
    expect(decide(bashCall(command), {}).action).toBe('deny')
  })

  // PINS, denied on 4552e41a7 too: the value-less flags that run the command
  // fall to the generic skip (singly or clustered), and the double-dash forms
  // were already rows.
  it.each([
    'xcrun -log cat .env',
    'xcrun -v cat .env',
    'xcrun -run cat .env',
    'xcrun -l -v -n -k cat .env',
    'xcrun --sdk macosx cat .env',
  ])('pin: %s -> deny', (command) => {
    expect(decide(bashCall(command), {}).action).toBe('deny')
  })

  // Controls, allowed on every tree and running nothing natively (exit 64):
  // a describe-only flag anywhere among the options stops the peel, and
  // options are case-sensitive, so `-SDK` is an unknown flag whose next word
  // is left as the command (an over-approximation that allows).
  it.each([
    'xcrun -sdk macosx -f cat',
    'xcrun -f -sdk macosx cat .env',
    'xcrun -show-sdk-path -sdk macosx cat .env',
    'xcrun -SDK macosx cat .env',
  ])('control (nothing runs): %s -> allow', (command) => {
    expectAllow(command)
  })

  // Describe-only spellings run nothing (exit 64 with a trailing command,
  // measured), so they stop the peel. These five were DENIED on 4552e41a7,
  // where only the double-dash forms stopped: over-blocks corrected, not
  // arms (round 28 named the split).
  it.each([
    'xcrun -show-sdk-path cat .env',
    'xcrun -show-sdk-version cat .env',
    'xcrun -h cat .env',
    'xcrun -help cat .env',
    'xcrun -version cat .env',
  ])('corrected over-block (nothing runs): %s -> allow', (command) => {
    expectAllow(command)
  })
  // PINS, allowed on 4552e41a7 too: `-f` already stopped through the cluster
  // rule, and after `-sdk macosx` the peel there stopped at `macosx`.
  it.each(['xcrun -find cat .env', 'xcrun -sdk macosx -find cat .env', 'xcrun -f cat .env'])(
    'pin (nothing runs, allowed on every tree): %s -> allow',
    (command) => {
      expectAllow(command)
    }
  )

  // Residue, pinned: usage errors that run nothing still deny, since the
  // guard cannot know xcrun rejects a glued or `=` value and a cluster.
  it.each(['xcrun -sdk=macosx cat .env', 'xcrun -sdkmacosx cat .env', 'xcrun -ln cat .env'])(
    'residue (over-block of a usage error): %s -> deny',
    (command) => {
      expect(decide(bashCall(command), {}).action).toBe('deny')
    }
  )
})

// SMI-6920 (the post-merge retro of PR #2978, round 29): a head whose single
// quoted operand is shell text was never re-tokenized, so `eval "cat .env"`
// allowed while `eval cat .env` denied (F-A, Critical; every tree back to
// 60da8b5a8; decoys printed in bash 3.2, zsh 5.9 and bash 5.2; the live
// hook pair let `eval "cat <path>/.env"` through). And a computed command
// name inside a wrapper's redirect-fed body never met the source (F-B,
// High): the body got every reading but not the computed-head check.
describe('decide() — SMI-6920: a quoted operand that is shell text, and a computed head fed by a redirect', () => {
  function reasonOf(result: ReturnType<typeof decide>): string {
    return result.json?.hookSpecificOutput.permissionDecisionReason ?? ''
  }

  const shellTextArms = [
    'eval "cat .env"',
    "eval 'cat .env'",
    'eval "grep KEY .env"',
    'eval "nohup cat .env"',
    'eval "if true; then cat .env; fi"',
    'eval "bash -c \'cat .env\'"',
    'env -S "cat .env"',
    'env -S "nohup cat .env"',
    'env --split-string="cat .env"',
    'env -S"cat .env"',
    'env X=1 -S "cat .env"',
    'sudo env -S "cat .env"',
    'nohup env -S "cat .env"',
    'trap -- "cat .env" EXIT',
    'trap "cat .env" EXIT INT',
    'V=${X} eval "cat .env"',
    // macOS ships `/usr/bin/command`, a program, so `nohup command eval`
    // PRINTED in bash 3.2 and zsh 5.9 on the host (SILENT in the container,
    // which has no such program); `command trap` and `command eval` are
    // bash-only (zsh's `command` runs external commands and was SILENT).
    'nohup command eval "cat .env"',
    'command trap "cat .env" EXIT',
    'trap "cat .env" EXIT',
    'trap "nohup cat .env" INT TERM',
    'bash -c "eval \\"nohup cat\\"" < .env',
    'sudo bash -c "eval \\"nohup cat\\"" < .env',
    'eval "varlock load --format json"',
    'command eval "cat .env"',
    'eval -- cat .env',
  ]
  it.each(shellTextArms)('%s -> deny (F-A, allowed on cfc96eccd)', (command) => {
    expect(decide(bashCall(command), {}).action).toBe('deny')
  })

  // A launcher that execs a PROGRAM never runs a builtin behind it: every
  // row here was SILENT in bash 3.2, zsh 5.9 and bash 5.2 (`nohup: eval:
  // No such file or directory`). The deny is the additive reading keeping
  // the quoted spelling at the posture its separate-word twin (`nohup eval
  // cat .env`) already had on every tree -- an over-approximation ADR-172
  // accepts, and not a leak closed, so these are pins, not arms.
  it.each([
    'nohup eval "cat .env"',
    'nohup trap "cat .env" EXIT',
    'sudo eval "cat .env"',
    'sudo nohup eval "cat .env"',
    'timeout 5 eval "cat .env"',
    'env X=1 eval "cat .env"',
  ])('over-block pin (the builtin never runs; allowed on cfc96eccd): %s -> deny', (command) => {
    expect(decide(bashCall(command), {}).action).toBe('deny')
  })

  const computedHeadArms = [
    'bash -c "$(echo cat)" < .env',
    'sh -c "$X" < .env',
    'bash -c "${READER}" < .env',
    'bash -c "nohup $(echo cat)" < .env',
  ]
  it.each(computedHeadArms)('%s -> deny (F-B, allowed on cfc96eccd)', (command) => {
    expect(decide(bashCall(command), {}).action).toBe('deny')
  })

  // PINS, denied on every tree: the separate-word spellings and the
  // computed head with a visible source.
  it.each([
    'eval cat .env',
    'eval "cat" ".env"',
    'env -S cat .env',
    '$(echo cat) < .env',
    'bash -c "$(echo cat) .env"',
    'bash -c cat < .env',
    'env -S "cat" .env',
  ])('pin: %s -> deny', (command) => {
    expect(decide(bashCall(command), {}).action).toBe('deny')
  })

  // Controls: shell text that reads nothing, the sanctioned idiom inside an
  // operand, the forms of `trap` that run nothing, and an operand whose
  // only `.env` is behind an expansion the shell assembles at runtime.
  it.each([
    'eval "echo hi"',
    'eval "ls -la"',
    'env -S "ls -la"',
    'trap "echo bye" EXIT',
    'trap - EXIT',
    'trap -l',
    'trap -p',
    'eval "grep -q KEY .env"',
    'eval "wc -l .env"',
    'eval "cat $F"',
    'bash -c "wc -l" < .env',
    'env -S "printf harmless"',
    "env -S 'printf harmless' .env.example",
  ])('control: %s -> allow', (command) => {
    expectAllow(command)
  })

  // The depth cap still governs the new reading: an operand nested past
  // MAX_DEPTH levels fails closed rather than falling through.
  it('an eval chain past the depth cap fails closed', () => {
    let chain = 'cat .env'
    for (let i = 0; i < 8; i++) chain = `eval ${JSON.stringify(chain)}`
    const verdict = decide(bashCall(chain), {})
    expect(verdict.action).toBe('deny')
    expect(reasonOf(verdict)).toContain('past depth')
  })
})
// SMI-6903 round 21 F2 (Critical, pre-existing): an input-redirect source that
// is a command substitution supplies its OUTPUT as the filename, so the body's
// own words are this segment's read targets -- the same flatten an argv-slot
// substitution already got. Every arm ALLOWED on the pre-fix tree while its
// argv twin DENIED, and each emits a decoy file's contents in all three
// shells (measured). ADR-172 sec 1 names both classes; this is one reaching
// the other.
describe('decide() — SMI-6903 F2: a redirect source that is a substitution', () => {
  const redArms = [
    'cat < $(echo .env)',
    'cat <$(echo .env)',
    'cat < `echo .env`',
    'cat < $(echo $(echo .env))',
    'cat <> $(echo .env)',
    'cat 0< $(echo .env)',
    'head -5 < $(echo .env)',
  ]
  it.each(redArms)('%s -> deny (the body spells the read target)', (command) => {
    expect(decide(bashCall(command), {}).action).toBe('deny')
  })

  const controls = ['cat < $(echo notes.txt)', 'cat < $(echo .env.example)']
  it.each(controls)('control: %s -> allow', (command) => {
    expectAllow(command)
  })

  // Asserted as a PROPERTY: whatever posture a metadata-only reader has, the
  // substitution-source spelling must match the argv spelling.
  it('`wc < $(echo .env)` and `wc $(echo .env)` reach the SAME verdict', () => {
    expect(decide(bashCall('wc < $(echo .env)'), {}).action).toBe(
      decide(bashCall('wc $(echo .env)'), {}).action
    )
  })

  // The ARM for the cap boundary: six levels is the deepest the new path
  // reads, and it ALLOWED before the fix.
  it('a 6-deep substitution source still denies as a read', () => {
    const six = 'cat < $(echo $(echo $(echo $(echo $(echo $(echo .env))))))'
    const result = decide(bashCall(six), {})
    expect(result.action).toBe('deny')
    expect(reasonText(result)).not.toContain('past depth')
  })

  // PIN, not an arm: this already denied `depth-cap` on the pre-fix tree
  // (measured), because the segment's own `.subs` recursion caps at the same
  // MAX_DEPTH and runs BEFORE the redirect sources are collected. That is
  // exactly why `inputRedirectSources` needs no truncation handling of its
  // own, and the row is here so that argument stops being a claim.
  it('pin (denied depth-cap before the fix too): a 7-deep source fails CLOSED', () => {
    const seven = 'cat < $(echo $(echo $(echo $(echo $(echo $(echo $(echo .env)))))))'
    const result = decide(bashCall(seven), {})
    expect(result.action).toBe('deny')
    expect(reasonText(result)).toContain('past depth 6')
  })

  function reasonText(result: ReturnType<typeof decide>): string {
    return result.json?.hookSpecificOutput.permissionDecisionReason ?? ''
  }
})

// SMI-6903 round 21 F3 (Critical, pre-existing): a wrapper's own input
// redirect feeds the NESTED body's stdin, and that body is evaluated as text
// with no argv for the guard to append the source to -- so the source was
// never checked at all. Every arm ALLOWED on the pre-fix tree while its argv
// twin DENIED, and each emits a decoy file's contents in bash 3.2, bash 5.2
// and zsh 5.9 (measured).
describe('decide() — SMI-6903 F3: a redirect on a wrapper reaches its body', () => {
  const redArms = [
    "bash -c 'cat' < .env",
    "sh -c 'cat' < .env",
    "docker exec c bash -c 'cat' < /app/.env",
    "varlock run -- bash -c 'cat' < .env",
    // Every segment head of the body is checked, not just the first.
    "bash -c 'echo hi; cat' < .env",
    // The body's own argv is wrapper-normalized, so a nested `sudo` peels.
    "bash -c 'sudo cat' < .env",
  ]
  it.each(redArms)('%s -> deny (the body consumes the redirected file)', (command) => {
    expect(decide(bashCall(command), {}).action).toBe('deny')
  })

  const controls = [
    // The caller's own exceptions still apply, because its own `checkArgv`
    // runs: a metadata-only reader and an output-free grep stay allowed.
    "bash -c 'wc -l' < .env",
    "bash -c 'grep -q K' < .env",
    "bash -c 'echo hi' < .env",
    "bash -c 'cat' < notes.txt",
  ]
  it.each(controls)('control: %s -> allow', (command) => {
    expectAllow(command)
  })

  // Property, not a pinned verdict: the redirect spelling must agree with the
  // argv spelling for the same body command, whatever that posture is.
  it("`bash -c 'wc -l' < .env` and `wc -l .env` reach the SAME verdict", () => {
    expect(decide(bashCall("bash -c 'wc -l' < .env"), {}).action).toBe(
      decide(bashCall('wc -l .env'), {}).action
    )
  })

  // A pin against the intra-branch tree `733427c82` (the redirect INSIDE the
  // body was already denied there, since the body is tokenized as its own
  // command) and an ARM against main's history: on `60da8b5a8`, the base of
  // PR #2973, this allowed. Both trees named, both measured, because the
  // squash erased the round boundary (SMI-6908 F-7). Kept so the two
  // spellings are visibly distinguished.
  it('arm against 60da8b5a8, pin against 733427c82: bash -c "cat < .env" -> deny', () => {
    expect(decide(bashCall('bash -c "cat < .env"'), {}).action).toBe('deny')
  })
})

// SMI-6920 round 2 (the governance review of 243a96847): two Criticals
// INSIDE the first fix. C-1: `env -S` appends its remaining operands
// verbatim, but the first version joined them bare and re-tokenized, so an
// operand carrying `#`, `;`, `|`, `&`, `>` or a quote became a comment, a
// separator or a redirect and the reader vanished (eight spellings moved
// from deny to allow; every one printed a decoy through /usr/bin/env). C-2:
// the substitution recursion never saw the inherited redirect sources, and
// the peel had stopped at a shell-text head instead of also emitting the
// fully peeled reading, so `eval 'echo $(cat)' < .env` moved from deny to
// allow (printed a decoy in bash 3.2 and zsh 5.9). Each fix was watched
// failing on a tree of 243a96847; the corrected rows passed on cfc96eccd.
describe('decide() — SMI-6920 round 2: a quoted env -S remainder, inherited sources in a substitution, both readings at a shell-text head', () => {
  // C-1: corrected regressions (allowed on 243a96847, denied on cfc96eccd).
  it.each([
    'env -S cat "#x" .env',
    'env -S cat "#" .env',
    'env -S cat ";" .env',
    'env -S cat "|" .env',
    'env -S cat "&" .env',
    'env -S cat ">" .env',
    'env -S cat "\\"" .env',
    'env -S cat "\'" .env',
  ])('corrected regression (C-1): %s -> deny', (command) => {
    expect(decide(bashCall(command), {}).action).toBe('deny')
  })

  // C-2: the two corrected regressions, then the siblings that allowed on
  // every tree (arms), each measured printing a decoy.
  it.each(["eval 'echo $(cat)' < .env", 'eval "echo $X" < .env'])(
    'corrected regression (C-2): %s -> deny',
    (command) => {
      expect(decide(bashCall(command), {}).action).toBe('deny')
    }
  )
  it.each([
    "bash -c 'echo $(cat)' < .env",
    "bash -c 'echo `cat`' < .env",
    "bash -c '{ echo $(cat); }' < .env",
    "eval 'echo `cat`' < .env",
    "trap 'echo $(cat)' EXIT < .env",
  ])('%s -> deny (C-2, allowed on cfc96eccd)', (command) => {
    expect(decide(bashCall(command), {}).action).toBe('deny')
  })

  // A space-carrying operand denied on every tree (the join split it into
  // words the reader still saw): a pin beside the metacharacter rows.
  it('pin: env -S cat "a b" .env -> deny', () => {
    expect(decide(bashCall('env -S cat "a b" .env'), {}).action).toBe('deny')
  })

  // L-2: `watch` without `-x` joins its operands into `sh -c` text; the
  // quoted spelling is read now (documented semantics, `watch` is installed
  // nowhere here).
  it('watch "cat .env" -> deny (L-2, allowed on cfc96eccd)', () => {
    expect(decide(bashCall('watch "cat .env"'), {}).action).toBe('deny')
  })
  it('pin: watch cat .env -> deny', () => {
    expect(decide(bashCall('watch cat .env'), {}).action).toBe('deny')
  })

  // A RESTORED denial, not a new over-block (round 3, F-3): measured deny on
  // cfc96eccd, allow on 243a96847, deny here. Harmless either way -- env
  // rejects the substitution in its split
  // text (`Only ${VARNAME} expansion is supported`), so the line runs
  // nothing; the substitution recursion now carries the inherited source.
  it("restored denial (allowed on 243a96847, denied on cfc96eccd): env -S 'echo $(cat)' < .env -> deny", () => {
    expect(decide(bashCall("env -S 'echo $(cat)' < .env"), {}).action).toBe('deny')
  })

  // SMI-6920 round 4, F-B: the `-c`-launcher branch in
  // `shell-command-readings.mjs` used to return without the readings
  // `peelHead` had just pushed, and round 3 recorded that as unreachable
  // because the `-c` launcher set is disjoint from the shell-text heads. The
  // inference was wrong: the push and the return need not be the same loop
  // iteration, and `watch` is BOTH a shell-text head and a peelable launcher,
  // so a reading pushed at `watch` survives into a later `script`/`su`/
  // `flock` head. Measured: 40 of 747 probed commands moved from allow to deny
  // across that one-word change, none the other way. The leading launcher is
  // needed because the push is gated on having peeled something.
  //
  // Red arm: restore `return segs.concat(...)` and all three fail.
  it.each([
    'nohup watch script -c cat < .env',
    'nohup watch su -c cat < .env',
    'nohup watch flock /tmp/l -c cat < .env',
  ])('round 4 F-B (allowed on 2e5d5bbb1 and cfc96eccd): %s -> deny', (command) => {
    expect(decide(bashCall(command), {}).action).toBe('deny')
  })
  // The same shapes without the leading launcher deny on both trees: the pin
  // that keeps the rows above from passing on a guard that denies all of them.
  it('pin: watch script -c cat < .env -> deny on both trees', () => {
    expect(decide(bashCall('watch script -c cat < .env'), {}).action).toBe('deny')
  })

  // Controls assert the WHOLE result (M-2): a fail-open allow carries a
  // stderr line, so `.action` alone passed on a guard whose shell-text
  // mechanism was entirely dead (measured: 13 of 13 with the import removed).
  it.each([
    'echo $(cat) < .env',
    'watch -x "cat .env"',
    'env -S cat "#x" notes.txt',
    'eval "echo $X"',
  ])('control: %s -> allow', (command) => {
    expectAllow(command)
  })
})
