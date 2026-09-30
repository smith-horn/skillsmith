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
    expect(result.action).toBe('allow')
  })

  it('5. cat .env.schema -> allow (safe file)', () => {
    const result = decide(bashCall('cat .env.schema'), {})
    expect(result.action).toBe('allow')
  })

  it('6. cat .env.example -> allow (safe file)', () => {
    const result = decide(bashCall('cat .env.example'), {})
    expect(result.action).toBe('allow')
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
    expect(result.action).toBe('allow')
  })

  it('grep -o PAT .env (quiet-less, output-producing) -> deny', () => {
    const result = decide(bashCall('grep -o PAT .env'), {})
    expect(result.action).toBe('deny')
  })

  it('[ -f .env ] presence/metadata check -> allow', () => {
    const result = decide(bashCall('[ -f .env ]'), {})
    expect(result.action).toBe('allow')
  })

  it('test -f .env presence/metadata check -> allow', () => {
    const result = decide(bashCall('test -f .env'), {})
    expect(result.action).toBe('allow')
  })

  it('wc -c .env metadata check -> allow', () => {
    const result = decide(bashCall('wc -c .env'), {})
    expect(result.action).toBe('allow')
  })

  it('varlock load (default pretty format, no --format flag) -> allow', () => {
    const result = decide(bashCall('varlock load'), {})
    expect(result.action).toBe('allow')
  })

  it('varlock load --format pretty -> allow (explicit default format)', () => {
    const result = decide(bashCall('varlock load --format pretty'), {})
    expect(result.action).toBe('allow')
  })

  it('varlock load --quiet -> allow (validation only)', () => {
    const result = decide(bashCall('varlock load --quiet'), {})
    expect(result.action).toBe('allow')
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
    expect(result.action).toBe('allow')
  })

  it('cat some-other-file.txt -> allow (no protected file referenced)', () => {
    const result = decide(bashCall('cat some-other-file.txt'), {})
    expect(result.action).toBe('allow')
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
    expect(result.action).toBe('allow')
  })

  it('node -pe "<code with no .env reference>" -> allow (combined short flags, no false positive)', () => {
    const result = decide(bashCall('node -pe "1+1"'), {})
    expect(result.action).toBe('allow')
  })

  it('ruby -r json -e "puts 1" -> allow (ruby\'s -r means require-a-library, not run-code — must not be pooled with php\'s -r)', () => {
    const result = decide(bashCall('ruby -r json -e "puts 1"'), {})
    expect(result.action).toBe('allow')
  })

  it('php -v -> allow (a real php flag that happens to start with a different letter than -r)', () => {
    const result = decide(bashCall('php -v'), {})
    expect(result.action).toBe('allow')
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
    expect(result.action).toBe('allow')
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
    expect(result.action).toBe('allow')
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
    expect(result.action).toBe('allow')
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
    expect(result.action).toBe('allow')
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
    expect(result.action).toBe('allow')
  })

  it("sed -i '' 's/a/b/' file.txt -> allow (ordinary BSD in-place edit, no .env reference)", () => {
    const result = decide(bashCall("sed -i '' 's/a/b/' file.txt"), {})
    expect(result.action).toBe('allow')
  })

  it("sed 's/foo/bar/' file.txt -> allow (ordinary substitution, no false positive)", () => {
    const result = decide(bashCall("sed 's/foo/bar/' file.txt"), {})
    expect(result.action).toBe('allow')
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
    expect(result.action).toBe('allow')
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
    expect(result.action).toBe('allow')
  })

  it('node -e "console.log(\'.envrc\')" -> allow (same boundary fix, inline-interpreter text-scan path)', () => {
    const result = decide(bashCall(`node -e "console.log('.envrc')"`), {})
    expect(result.action).toBe('allow')
  })

  it('node -e "console.log(\'.environment\')" -> allow (a different .env-prefixed non-env filename)', () => {
    const result = decide(bashCall(`node -e "console.log('.environment')"`), {})
    expect(result.action).toBe('allow')
  })

  it('node -e "console.log(\'.env-backup\')" -> allow (hyphen-suffixed, not dot-suffixed)', () => {
    const result = decide(bashCall(`node -e "console.log('.env-backup')"`), {})
    expect(result.action).toBe('allow')
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
    expect(result.action).toBe('allow')
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
      expect(decide(bashCall(command), {}).action).toBe('allow')
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
    expect(decide(bashCall(command), {}).action).toBe('allow')
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
      expect(decide(bashCall(command), {}).action).toBe('allow')
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
      expect(decide(bashCall(command), {}).action).toBe('allow')
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
    expect(decide(bashCall(command), {}).action).toBe('allow')
  })

  it("grep -qE '^KEY=' .env -> allow (control: the sanctioned output-free exception is unaffected)", () => {
    expect(decide(bashCall("grep -qE '^KEY=' .env"), {}).action).toBe('allow')
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
    expect(decide(bashCall('cat $(echo /app/.en)v'), {}).action).toBe('allow')
  })

  it('f=.en; cat ${f}v -> allow', () => {
    expect(decide(bashCall('f=.en; cat ${f}v'), {}).action).toBe('allow')
  })
})

// SMI-6869 governance round 14 L5: a reader that receives the filename from
// another command's own OUTPUT, not as a literal argv token, is the same
// class of documented limit as the substitution-boundary case above -- the
// name is spelled literally in the command text, but never lands in the
// consuming reader's own argv, which is all `checkArgv` inspects.
describe("decide() — documented limit: a reader that receives the filename from another command's output, not its own argv, stays out of reach", () => {
  it('echo .env | xargs cat -> allow', () => {
    expect(decide(bashCall('echo .env | xargs cat'), {}).action).toBe('allow')
  })

  it('find . -name .env -exec cat {} \\; -> allow', () => {
    expect(decide(bashCall('find . -name .env -exec cat {} \\;'), {}).action).toBe('allow')
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
    expect(decide(bashCall('# cat .env'), {}).action).toBe('allow')
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
    expect(decide(bashCall('echo hi # x; cat .env'), {}).action).toBe('allow')
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

// SMI-6892 C3 (High, round 16): this tokenizer cannot tell a STANDALONE
// subshell command `(cmd)` -- whose closing `)` really is a bash comment
// boundary -- from a zsh GLOB-ALTERNATION pattern `(a|b)`, where `)` is
// just another character inside one WORD and a glued `#suffix` is part of
// that same glob text, never a comment. Measured directly (not inferred):
// in zsh 5.9 (the shell Claude Code's own Bash tool runs on this machine),
// `printf "[%s]" (a|b)#x` with a file literally named `a#x` present in cwd
// expands the WHOLE `(a|b)#x` to that filename and the command after it
// still runs; with no match, zsh's own parse error is `no matches found:
// (a|b)#x`, i.e. `#x` was already part of the glob token, not split off as
// a comment. Bash lacks this glob form entirely (`echo (a|b)#x` is a
// syntax error in bash 3.2 and 5.2 -- confirmed live on both), so bash
// alone could never surface this ambiguity. Ruling (queen, fail-closed,
// zero corpus hits): `(` and `)` are dropped from `COMMENT_BOUNDARY_CHARS`
// entirely, so a `#` right after `)` is NEVER treated as a comment start,
// in EITHER shell -- an accepted OVER-block for the real-subshell case
// (bash and zsh both agree `(echo x)#x; cat .env` is a genuine comment,
// per `retro14-bash-truth.sh`'s own `)#x` measurement and this round's own
// zsh confirmation), traded for closing the glob-ambiguous case no simple
// tokenizer can distinguish from it.
describe('decide() — SMI-6892 C3: a # right after a closing ) is never a comment boundary -- zsh may be closing a glob alternation there, not a subshell', () => {
  it('(echo x)#x; cat .env -> deny (accepted over-block: bash AND zsh both treat this as a real comment, but the tokenizer cannot tell it apart from the zsh glob shape below)', () => {
    expect(decide(bashCall('(echo x)#x; cat .env'), {}).action).toBe('deny')
  })

  it('echo (a|b)#x; cat .env -> deny (the zsh-glob shape itself: measured live in zsh 5.9, (a|b)#x is ONE glob word with # inside it, never a comment)', () => {
    expect(decide(bashCall('echo (a|b)#x; cat .env'), {}).action).toBe('deny')
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
    expect(decide(bashCall('cat ${HOME}/.env.example'), {}).action).toBe('allow')
  })

  it('cat ${X} -> allow (control: a braced expansion naming nothing protected)', () => {
    expect(decide(bashCall('cat ${X}'), {}).action).toBe('allow')
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
    expect(decide(bashCall(command), {}).action).toBe('allow')
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
    expect(decide(bashCall(command), {}).action).toBe('allow')
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
    expect(result).toEqual({ action: 'allow', json: null, stderr: null })
  })

  it('a non-"1" value does not disable the guard (still denies)', () => {
    const result = decide(bashCall('grep PAT .env'), { SKILLSMITH_ENV_READ_GUARD_DISABLE: 'true' })
    expect(result.action).toBe('deny')
  })
})

describe('decide() — malformed / non-Bash input fails open to allow', () => {
  it('a non-Bash tool_name always allows, regardless of command content', () => {
    const result = decide({ tool_name: 'Read', tool_input: { command: 'cat .env' } }, {})
    expect(result).toEqual({ action: 'allow', json: null, stderr: null })
  })

  it('a null toolCall allows, does not throw', () => {
    expect(() => decide(null, {})).not.toThrow()
    expect(decide(null, {})).toEqual({ action: 'allow', json: null, stderr: null })
  })

  it('an undefined toolCall allows, does not throw', () => {
    expect(() => decide(undefined, {})).not.toThrow()
    expect(decide(undefined, {})).toEqual({ action: 'allow', json: null, stderr: null })
  })

  it('a Bash tool_call with a missing command allows', () => {
    const result = decide({ tool_name: 'Bash', tool_input: {} }, {})
    expect(result).toEqual({ action: 'allow', json: null, stderr: null })
  })

  it('a Bash tool_call with an empty/whitespace-only command allows', () => {
    const result = decide(bashCall('   '), {})
    expect(result).toEqual({ action: 'allow', json: null, stderr: null })
  })
})
