/**
 * Shared primitives for suites that assert on Postgres migration TEXT (SMI-6690).
 *
 * WHY THIS MODULE EXISTS. `private-registry-audit-trigger.static.test.ts` worked out, over several
 * adversarial review rounds, what a migration-text guard has to handle: git-crypt lock state as a
 * three-way outcome, enumeration of ALL migrations rather than one pinned filename, identifier
 * matching that tolerates the spellings Postgres treats as equivalent, and tamper verbs beyond
 * `CREATE`. A second suite then re-implemented the same guard by hand and omitted one of those
 * four in each of three consecutive review rounds — the lock gate, then the all-migrations scan,
 * then identifier tolerance and the non-`CREATE` verbs. The third omission was measured as an
 * end-to-end bypass: a later migration redefining the guarded function with its tenant predicate
 * removed, spelled `"public"."fn"`, passed every assertion.
 *
 * So the primitives live here once and both suites import them. A third suite asserting on
 * migration text should import them too rather than re-deriving them.
 *
 * WHAT IS DELIBERATELY NOT HERE: anything shaped by one function's own signature or body. The
 * audit-trigger suite's `DEF_RE` captures a header and a dollar-quoted body via backreference and
 * pins each to a SHA; that is specific to a zero-argument function and stays in that file.
 *
 * @module scripts/tests/lib/migration-text-guards
 */

import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

// Module-private on purpose. These were exported when this module landed and had ZERO importers,
// while four other files re-declared them locally — the de-duplication this module exists for,
// unperformed, six lines from a header claiming it (SMI-6690 retro, finding 2). A caller that
// needs the lock contract should call `readMigrationText`, which is the behaviour; a caller that
// needs these constants is re-implementing it. The remaining repo-wide copies are tracked
// separately — un-exporting here stops this module pretending they are consolidated.
const GIT_CRYPT_MAGIC = Buffer.from([0x00, 0x47, 0x49, 0x54, 0x43, 0x52, 0x59, 0x50, 0x54])
const EXPECT_LOCKED_ENV_VAR = 'SKILLSMITH_GIT_CRYPT_EXPECTED_LOCKED'
const MIGRATIONS_DIR = 'supabase/migrations'

/**
 * Reads a migration, returning `null` when it is git-crypt ciphertext AND that was declared
 * expected, and THROWING when it is ciphertext and was not (SMI-5984).
 *
 * The three-way outcome is the point. `supabase/migrations/` is git-crypt-scoped, so a locked
 * checkout yields ciphertext rather than SQL: `post-merge-verify.yml` runs locked by design. A
 * caller that treated locked-and-undeclared as "just skip" would absorb a real unlock failure
 * into a green run, which is the failure class these suites exist to detect.
 */
export function readMigrationText(name: string, dir: string = MIGRATIONS_DIR): string | null {
  const raw = readFileSync(join(dir, name))
  if (raw.subarray(0, GIT_CRYPT_MAGIC.length).equals(GIT_CRYPT_MAGIC)) {
    if (process.env[EXPECT_LOCKED_ENV_VAR] !== '1') {
      throw new Error(
        `${name} is git-crypt-locked but ${EXPECT_LOCKED_ENV_VAR} is not set — treat as an unlock ` +
          'failure, not a lock-state edge case (SMI-5984).'
      )
    }
    return null
  }
  return raw.toString('utf8')
}

/** Every `.sql` migration, filename-sorted. */
export function allMigrationFiles(dir: string = MIGRATIONS_DIR): string[] {
  return readdirSync(dir)
    .filter((f) => f.endsWith('.sql'))
    .sort()
}

/**
 * Every migration whose numeric prefix is strictly greater than `pinnedFile`'s.
 *
 * Numeric, not lexicographic: a plain string comparison is right only while every filename has
 * the same prefix width, and silently wrong the moment one does not.
 *
 * KNOWN RESIDUAL GAP, shared with the audit-trigger suite and accepted rather than solved: this
 * orders by the filename's declared version, not by APPLY order. A migration added later but
 * numbered earlier — `supabase db push` will apply a new `20260914…` after an already-applied
 * `20260915…` — sorts as "not later" and escapes the scan. Closing it needs the applied ledger
 * (`supabase_migrations.schema_migrations`), which is a live-database read these text-only suites
 * deliberately do not make.
 *
 * ALSO NARROWER THAN A STRING COMPARISON, deliberately: a sibling sharing `pinnedFile`'s exact
 * numeric prefix (`20260915000000_part2.sql`) is "not later" here, where `f > pinnedFile` would
 * have scanned it. Measured: no two migrations share a prefix today, and the sets are identical
 * over the real directory — but the narrowing is real and is the price of ordering numerically.
 */
export function laterMigrationFiles(pinnedFile: string, dir: string = MIGRATIONS_DIR): string[] {
  const pinned = Number(pinnedFile.match(/^(\d+)/)?.[1] ?? NaN)
  if (Number.isNaN(pinned)) {
    throw new Error(`laterMigrationFiles: ${pinnedFile} has no numeric version prefix`)
  }
  const all = allMigrationFiles(dir)
  // Fail loudly rather than dropping them. An earlier version filtered these out silently, so a
  // hotpatch named `fix_urgent.sql` would have vanished from every tamper scan in every consuming
  // suite with no signal at all — the same invisible-success class these suites exist to catch
  // (SMI-6690 round 4). None exist today; this is the guard against the first one.
  const unversioned = all.filter((f) => !/^\d/.test(f))
  if (unversioned.length > 0) {
    throw new Error(
      `laterMigrationFiles: ${unversioned.join(', ')} have no numeric version prefix and cannot ` +
        'be ordered — they would be silently excluded from every tamper scan'
    )
  }
  return all.filter((f) => Number(f.match(/^(\d+)/)![1]) > pinned)
}

/**
 * Regex source matching a `public`-qualified identifier the way Postgres resolves it: optional
 * schema qualification, optional double quotes on either part, and arbitrary whitespace around
 * the dot. `public.fn`, `"public"."fn"`, `"fn"`, and `public . fn` all name the same object, and a
 * guard that matches only the bare spelling is defeated by typing one of the others.
 */
export function qualifiedIdent(name: string): string {
  // `name` is interpolated into a regex unescaped, so a caller passing anything but a bare
  // identifier gets a pattern that means something else. Throwing beats escaping here because the
  // dangerous case is SILENT: `qualifiedIdent('public.fn')` — a very plausible call, since the
  // fragment already handles the schema — would build `"?public.fn"?`, where the `.` is a wildcard
  // that MATCHES `publicXfn`, so the guard quietly accepts a differently-named function as the
  // guarded one. Escaping would instead produce a regex matching nothing, which is equally silent.
  // A throw names the mistake (SMI-6690 round 4).
  if (!/^[A-Za-z_][A-Za-z0-9_$]*$/.test(name)) {
    throw new Error(
      `qualifiedIdent: ${JSON.stringify(name)} is not a bare identifier — pass the unqualified ` +
        'name; the optional schema prefix is already part of this fragment'
    )
  }
  // `U&"name"` is a Unicode-escape identifier. With no `\XXXX` escapes inside it, Postgres
  // resolves it to exactly `name`, so accepting the optional prefix is a true positive rather
  // than a widening. Measured valid on PG 17.11 (SMI-6690 retro, finding 7).
  return String.raw`(?:(?:[Uu]&)?"?public"?\s*\.\s*)?(?:[Uu]&)?"?${name}"?`
}

/** `CREATE [OR REPLACE] FUNCTION <name>(` — any argument list, any case, any spelling. */
export function createFunctionRe(name: string): RegExp {
  return new RegExp(
    String.raw`CREATE\s+(?:OR\s+REPLACE\s+)?FUNCTION\s+${qualifiedIdent(name)}\s*\(`,
    'i'
  )
}

/**
 * Guards against matching a LONGER identifier that merely starts with `name` — without it,
 * `release_fn` would match inside `release_fn_v2`.
 */
const NOT_IDENT_CHAR = String.raw`(?![A-Za-z0-9_$])`

/**
 * `DROP FUNCTION a, public.fn;` is valid Postgres — the grammar is `DROP FUNCTION name [, ...]` —
 * so the guarded name need NOT be the first name after the verb. Without this prefix, putting any
 * other function ahead of it evades the scan while still dropping the target; measured valid AND
 * effective on PG 17.11, with the target gone from `pg_proc` and the scan silent (SMI-6690 retro,
 * finding 1).
 *
 * `[^;]*?` is bounded to the statement: lazy, and it cannot cross a `;`, so it consumes at most
 * one statement's own list. Callers already split on statements and strip comments.
 *
 * ASYMMETRY, deliberate and measured: `ALTER` takes no list — `ALTER FUNCTION a, b RESET ALL` is a
 * syntax error — so `alterFunctionRe` neither needs nor uses this. Do not "fix" that by adding it
 * there; it would only widen the match for no valid statement.
 */
const DROP_LIST_PREFIX = String.raw`(?:[^;]*?,\s*)?`

/**
 * `DROP FUNCTION|ROUTINE [IF EXISTS] <name>` — removing the function is tampering too.
 *
 * The argument list is OPTIONAL and `ROUTINE` is a synonym; see `alterFunctionRe` for the
 * measurement that established both.
 */
export function dropFunctionRe(name: string): RegExp {
  return new RegExp(
    String.raw`DROP\s+(?:FUNCTION|ROUTINE)\s+(?:IF\s+EXISTS\s+)?${DROP_LIST_PREFIX}${qualifiedIdent(name)}${NOT_IDENT_CHAR}`,
    'i'
  )
}

/**
 * `ALTER FUNCTION|ROUTINE <name>` — the verb that needs no `CREATE`.
 *
 * `ALTER FUNCTION … RESET ALL` strips a pinned `search_path` from a `SECURITY DEFINER` function,
 * and `… SECURITY INVOKER` discards its privilege model. Both leave the function's own definition
 * text untouched, so a guard anchored on `CREATE` never sees them.
 *
 * TWO SPELLINGS THIS DELIBERATELY ACCEPTS, both measured valid on PostgreSQL 17.11 (SMI-6690
 * round 4). An earlier version required `\s*\(` after the name and missed 12 of 21 valid tamper
 * spellings, including two that a prior review round had itself supplied in their parenthesised
 * form — so the red-test passed while the paren-free form of the same statement went undetected:
 *
 *   1. The ARGUMENT LIST IS OPTIONAL whenever the function name is unique in its schema.
 *      `ALTER FUNCTION public.fn RESET ALL;` is valid and clears `proconfig` while leaving
 *      `prosecdef = t` — a `SECURITY DEFINER` function left search-path-hijackable.
 *   2. `ROUTINE` is an accepted synonym for `FUNCTION` in both `ALTER` and `DROP`.
 *      (Not in `CREATE` — `CREATE OR REPLACE ROUTINE` is a syntax error, which is why
 *      `createFunctionRe` is NOT widened and still requires its argument list.)
 *
 * Callers must pass comment-stripped SQL (`stripComments`): these patterns are broad enough that
 * a commented-out rollback block naming the function would otherwise read as a live statement,
 * and this repo's migration convention includes exactly such blocks.
 */
export function alterFunctionRe(name: string): RegExp {
  return new RegExp(
    String.raw`ALTER\s+(?:FUNCTION|ROUTINE)\s+${qualifiedIdent(name)}${NOT_IDENT_CHAR}`,
    'i'
  )
}

/**
 * Strips both `--` line comments and `/* ... *\/` block comments (Postgres allows nesting, so this
 * tracks depth) WITHOUT touching text inside single-quoted string literals, escape-string literals
 * (`E'...'` / `e'...'`), or dollar-quoted bodies (`$$ ... $$` / `$tag$ ... $tag$`) -- a
 * character-scanning state machine, not a regex, since comment/string/dollar-quote nesting isn't a
 * regular language. Used only by the checks that need to see through comments to find a real
 * statement, or avoid a false-positive on a commented-out example: the disabled-trigger,
 * later-trigger and audit-sink tripwires, plus the by-name tamper and GRANT scans. NEVER applied to
 * the raw function/trigger pins above -- those hash/compare the exact text, comments included, by
 * design (round-2 gate finding 4). Verified against a 5-case table (a block comment containing a
 * fake CREATE RULE, a string literal containing `/* x *\/`, a dollar-quoted body containing `--`,
 * nested `/* /* *\/ *\/`, and a real CREATE RULE right after a comment) before being relied on
 * (SMI-6114 retro round 3, gate finding 2, PR #2855).
 *
 * ASSUMES `standard_conforming_strings = on` (Postgres' default, and this project's): in a plain
 * `'...'` string a backslash is a literal character and `''` is the only way to embed a quote, so
 * the plain-string branch below never treats `\` specially. An `E'...'`/`e'...'` ESCAPE string is
 * different regardless of that setting -- Postgres always interprets backslash escapes inside one,
 * so `\` there DOES escape the next character, including a quote (`E'prefix \' /*'` is one complete
 * string, not one that ends at the `\'`). A prior version of this scanner had no E-string branch and
 * fell through to the plain-string rule, which closes at that `\'` early because it never treats `\`
 * as an escape -- turning the text after it (`/*';\nALTER TABLE ...`) into what looks like a real
 * block comment, hiding a real statement from every check below (round-4 gate finding, PR #2855).
 * Escape strings also still allow the doubled-quote `''` embed alongside `\'` (Postgres accepts
 * both), and the `E`/`e` is only recognized as an escape-string opener when it is not the tail of a
 * longer identifier -- checked via the character immediately before it, so `type'x'` parses as
 * plain text followed by an ordinary string, not as an (invalid) escape-string opener. Verified
 * against a 5-case table (the exact hidden-DROP shape above, a real backslash-escaped backslash
 * `e'\\'` ahead of a real statement, doubled quotes inside an escape string `E'it''s'`, the
 * preceding-identifier-char guard via `type'x'`/`CASE'...'`, and a plain string ending at the quote
 * right after a backslash) before being relied on (SMI-6114 retro round 4, PR #2855) -- see the `stripComments()` `it()` blocks in
 * `../private-registry-audit-trigger.static.test.ts`, which remain that suite's own.
 */
export function stripComments(sql: string): string {
  let out = ''
  let i = 0
  const n = sql.length
  while (i < n) {
    const c = sql[i]
    const c2 = i + 1 < n ? sql[i + 1] : ''
    if ((c === 'E' || c === 'e') && c2 === "'" && !/[A-Za-z0-9_]/.test(i > 0 ? sql[i - 1] : '')) {
      // Postgres escape-string literal: E'...' / e'...', recognized only when the E/e isn't the
      // tail of a longer identifier (the preceding-character check above). Inside one, a backslash
      // escapes the next character -- including a quote -- and, same as a plain string, '' still
      // embeds a literal quote (Postgres allows both forms in an escape string).
      let j = i + 2
      while (j < n) {
        if (sql[j] === '\\') {
          j += 2
          continue
        }
        if (sql[j] === "'") {
          if (sql[j + 1] === "'") {
            j += 2
            continue
          }
          j += 1
          break
        }
        j += 1
      }
      out += sql.slice(i, j)
      i = j
      continue
    }
    if (c === "'") {
      // Single-quoted string literal: '' is an escaped quote, not a terminator. Under
      // standard_conforming_strings=on a backslash here is a literal character, not an escape, so
      // (unlike the E-string branch above) it is never special-cased.
      let j = i + 1
      while (j < n) {
        if (sql[j] === "'") {
          if (sql[j + 1] === "'") {
            j += 2
            continue
          }
          j += 1
          break
        }
        j += 1
      }
      out += sql.slice(i, j)
      i = j
      continue
    }
    if (c === '$') {
      // Dollar-quoted body: $$ ... $$ or $tag$ ... $tag$. Matched by literal tag re-occurrence,
      // not nesting -- Postgres dollar-quote bodies do not nest with the same tag.
      const tagMatch = /^\$[A-Za-z_][A-Za-z0-9_]*\$|^\$\$/.exec(sql.slice(i))
      if (tagMatch) {
        const tag = tagMatch[0]
        const closeIdx = sql.indexOf(tag, i + tag.length)
        const end = closeIdx === -1 ? n : closeIdx + tag.length
        out += sql.slice(i, end)
        i = end
        continue
      }
    }
    if (c === '-' && c2 === '-') {
      // Line comment: drop through end of line, keep the newline itself (matches
      // stripLineComments' own behavior above).
      let j = sql.indexOf('\n', i)
      if (j === -1) j = n
      i = j
      continue
    }
    if (c === '/' && c2 === '*') {
      // Block comment, Postgres-style nested: track depth, drop the whole span including any
      // nested /* ... */ inside it.
      let depth = 1
      let j = i + 2
      while (j < n && depth > 0) {
        if (sql[j] === '/' && sql[j + 1] === '*') {
          depth += 1
          j += 2
          continue
        }
        if (sql[j] === '*' && sql[j + 1] === '/') {
          depth -= 1
          j += 2
          continue
        }
        j += 1
      }
      i = j
      continue
    }
    out += c
    i += 1
  }
  return out
}
