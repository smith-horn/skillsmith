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
