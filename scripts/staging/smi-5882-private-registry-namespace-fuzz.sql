-- ============================================================================
-- Invocation: run via scripts/staging/smi-5882-private-registry-namespace-fuzz.sh (from
-- any cwd -- that wrapper resolves this file's path relative to its own location, not the
-- caller's cwd, and refuses to run if this file is missing). Never invoke this file directly
-- through `./scripts/pooler-psql.sh -f <path>` -- that resolves the path INSIDE the container,
-- and from a worktree resolves against the MAIN checkout's container (SMI-5559), where this
-- file does not exist. See the wrapper script's own header for the exact piped-stdin form it
-- uses; do not hand-reproduce it here where it could drift out of sync.
-- ============================================================================

-- SMI-5882 Wave 2 Step 2: private_registry_skills.skill_id namespace-bypass fuzzing.
-- Adapted from scripts/staging/smi-5882-private-registry-rls-role-boundary.sql (Wave 1),
-- which itself adapted scripts/staging/smi-5817-rls-role-boundary.sql -- same conventions:
-- role-switching via SET LOCAL ROLE + request.jwt.claims, BEGIN/ROLLBACK fixtures,
-- self-verifying DO blocks, two-gate prod-safety refusal, GUC-based namespace passing.
--
-- WHAT THIS FUZZES (plan doc "Wave 2 Step 2", What Changes §6):
--   1. Embedded newlines/control characters in skill_id -- does
--      CHECK (skill_id ~ '^[^/]+/[^/]+$') (20260724000000:43) actually block them, given
--      Postgres regex bracket expressions match newline by default (non-newline-sensitive
--      mode) unless the 'n' flag is set? Verified empirically here, not assumed.
--   2. Unicode normalization (NFC vs NFD) of an otherwise-matching team name, and
--      homoglyph/confusable variants of a seeded reserved name -- does derivation or
--      reserved_namespaces matching (exact string equality, 20260727000000:259/296) catch
--      these?
--   3. Case variants of a reserved name.
--   4. Reserved-seed staleness -- a skills.author value that postdates the migration's
--      one-time seed is NOT retroactively reserved (a known, accepted gap per the plan --
--      this block CONFIRMS it, it does not need to fix it).
--
-- WHY THESE RESULTS ARE REPORTED AS NOTICE, NOT PASS/FAIL. Unlike smi-5882-private-registry-
-- rls-role-boundary.sql's T1 (a KNOWN, already-proven-on-staging outcome), the outcomes here
-- were genuinely unknown before this script ran -- the plan doc explicitly says "verify this
-- empirically, don't just trust the analysis." Both "the CHECK blocks it" and "the CHECK does
-- not block it" are valid, informative results, so blocks below RAISE NOTICE either way rather
-- than treating one direction as a script failure. Expected exit status is 0 (a clean run);
-- read the NOTICE lines for the actual findings, same discipline as the RLS script's PASS
-- lines.
--
-- STAGING ONLY (ovhcifugwqnzoebwfuku). All fixtures rolled back.
--
-- HARD GUARD. This script INSERTs rows into auth.users, profiles, skills, teams, team_members
-- and private_registry_skills. `pooler-psql.sh` connects with SUPABASE_PROJECT_REF, which in
-- .env is the PROD ref -- so "I ran the documented command" is NOT evidence that this hit
-- staging. Two independent gates, same shape as the Wave 1 script:
--   (1) the shell wrapper refuses unless STAGING_SUPABASE_PROJECT_REF is set, and passes it in
--       as :confirm_ref;
--   (2) this block refuses unless :confirm_ref is BOTH set AND equal to the staging ref.
-- A bare `cat file | ./scripts/pooler-psql.sh` leaves :confirm_ref unset and stops at (2).
\set ON_ERROR_STOP on

-- `\quit` deliberately NOT used here: it exits psql with status 0 (it is not an error to psql,
-- just an early stop), which would make a bare `cat file | ./scripts/pooler-psql.sh` --
-- skipping the wrapper entirely -- silently "succeed" having asserted nothing. A RAISE
-- EXCEPTION inside ON_ERROR_STOP is what actually makes this refusal a non-zero exit.
\if :{?confirm_ref}
\else
  \echo '*** REFUSING: :confirm_ref is not set. Run this through'
  \echo '*** scripts/staging/smi-5882-private-registry-namespace-fuzz.sh'
  DO $guard0$ BEGIN
    RAISE EXCEPTION 'REFUSING: :confirm_ref is not set -- this script must be invoked via '
                    'scripts/staging/smi-5882-private-registry-namespace-fuzz.sh, never '
                    'piped directly.';
  END $guard0$;
\endif

SELECT :'confirm_ref' = 'ovhcifugwqnzoebwfuku' AS is_staging \gset
\if :is_staging
\else
  \echo '*** REFUSING: connected project ref is not staging.'
  DO $guard$ BEGIN
    RAISE EXCEPTION 'REFUSING: this script INSERTs fixture rows into auth.users, skills, and '
                    'teams; it may only run against staging (ovhcifugwqnzoebwfuku).';
  END $guard$;
\endif

BEGIN;

-- ============================================================================
-- ENVIRONMENT. Pure SELECTs, no side effects -- records the live DB's collation/encoding
-- so the "collation-dependent" caveat in What Changes §6 is answered with data, not assumed.
-- ============================================================================
DO $$
DECLARE v_collate TEXT; v_encoding TEXT;
BEGIN
  -- current_setting('lc_collate') is not queryable through Supabase's pooler connection
  -- ("unrecognized configuration parameter") -- pg_database.datcollate is the portable way to
  -- read the database's actual collation regardless of connection path.
  SELECT datcollate, pg_encoding_to_char(encoding) INTO v_collate, v_encoding
    FROM pg_database WHERE datname = current_database();
  RAISE NOTICE 'ENV: datcollate=% encoding=%', v_collate, v_encoding;
END $$;

-- ============================================================================
-- FIXTURES. One tenant is enough for shape/derivation fuzzing (this is not a cross-tenant
-- RLS suite -- that is Wave 1's job). owner is also the sole team_members row (role admin),
-- which satisfies user_member_team_ids() for the INSERT tests below without a second user.
-- ============================================================================

INSERT INTO auth.users (id, email) VALUES
  ('5882fa22-0000-0000-0000-0000000000f1', 'smi5882-fuzz-owner@example.test')
ON CONFLICT (id) DO NOTHING;

INSERT INTO profiles (id, email, tier, role) VALUES
  ('5882fa22-0000-0000-0000-0000000000f1', 'smi5882-fuzz-owner@example.test', 'enterprise', 'user')
ON CONFLICT (id) DO UPDATE SET tier = EXCLUDED.tier;

-- teams.skill_namespace is NOT set explicitly: it must be produced by
-- derive_team_skill_namespace() (BEFORE INSERT ON teams, 20260727000000:270-276), same
-- discipline as the Wave 1 script -- every namespace assertion below must exercise the real
-- derivation path, not a hand-set value.
INSERT INTO teams (id, name, owner_id) VALUES
  ('5882fa22-0000-0000-0000-00000000f001', 'SMI5882 Fuzz Team FZ', '5882fa22-0000-0000-0000-0000000000f1')
ON CONFLICT (id) DO NOTHING;

INSERT INTO team_members (team_id, user_id, role, joined_at) VALUES
  ('5882fa22-0000-0000-0000-00000000f001', '5882fa22-0000-0000-0000-0000000000f1', 'admin', NOW())
ON CONFLICT (team_id, user_id) DO NOTHING;

-- Stash the fuzz team's namespace in a transaction-local custom GUC, set here while still
-- privileged, for the same reason the Wave 1 script does this: `teams` is itself
-- RLS-protected, so the impersonated authenticated role below must not resolve the namespace
-- by reading `teams` directly, or a denial could be attributable to trg_prs_namespace (23514)
-- rejecting a namespace it never got to see, instead of to the CHECK constraint under test.
SELECT set_config('smi5882fz.ns',
  (SELECT skill_namespace FROM teams WHERE id = '5882fa22-0000-0000-0000-00000000f001'), true);

DO $$
DECLARE v_ns TEXT; v_rows INT;
BEGIN
  SELECT skill_namespace INTO v_ns FROM teams WHERE id = '5882fa22-0000-0000-0000-00000000f001';
  IF v_ns IS NULL THEN
    RAISE EXCEPTION 'FAIL (F1): derive_team_skill_namespace() did not populate skill_namespace for the fuzz team';
  END IF;
  IF current_setting('smi5882fz.ns', true) IS DISTINCT FROM v_ns THEN
    RAISE EXCEPTION 'FAIL (F1): namespace GUC did not take (ns=%)', current_setting('smi5882fz.ns', true);
  END IF;
  SELECT count(*) INTO v_rows FROM team_members WHERE team_id = '5882fa22-0000-0000-0000-00000000f001';
  IF v_rows <> 1 THEN
    RAISE EXCEPTION 'FAIL (F1): expected 1 team_members fixture row, got %', v_rows;
  END IF;
  RAISE NOTICE 'PASS (F1): fuzz team derived namespace=%, GUC set, fixture team_members row present', v_ns;
END $$;

-- ============================================================================
-- SECTION 1/4 -- embedded newlines / control characters in skill_id (What Changes §6, item 1)
--
-- All INSERTs below are attempted as the fuzz team's authenticated admin, under the fuzz
-- team's OWN (derived, GUC-passed) namespace as the skill_id's first segment -- so
-- trg_prs_namespace's split_part(skill_id,'/',1) = teams.skill_namespace check passes
-- regardless of outcome, and any rejection is attributable to the shape CHECK
-- (skill_id ~ '^[^/]+/[^/]+$', 20260724000000:43), not to a namespace mismatch. Same
-- discipline as I2/I3 in the RLS script.
-- ============================================================================

RESET ROLE;
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claims',
  '{"sub":"5882fa22-0000-0000-0000-0000000000f1","role":"authenticated"}', true);

-- N1 (CONTROL): an ordinary skill_id under the fuzz team's own namespace succeeds. Without
-- this control, "no error" on the control-character cases below would be ambiguous -- it
-- could mean the whole INSERT path is broken, not that control characters specifically pass
-- the CHECK.
DO $$
DECLARE v_rows INT;
BEGIN
  INSERT INTO private_registry_skills (team_id, skill_id, version, content, content_hash)
  VALUES ('5882fa22-0000-0000-0000-00000000f001',
          current_setting('smi5882fz.ns') || '/control-probe', '1.0.0',
          '{"SKILL.md":"x"}'::jsonb, repeat('0', 64));
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  IF v_rows <> 1 THEN
    RAISE EXCEPTION 'FAIL (N1 control): an ordinary skill_id under the fuzz team''s own '
                    'namespace was rejected (% rows) -- the fixture itself is broken; N2-N7 '
                    'prove nothing', v_rows;
  END IF;
  RAISE NOTICE 'PASS (N1 control): ordinary skill_id under own namespace accepted -- fixture is sound';
END $$;

-- N2: embedded LF (chr(10)) in the skill-name segment.
DO $$
DECLARE v_id TEXT := current_setting('smi5882fz.ns') || '/embedded' || chr(10) || 'newline';
BEGIN
  INSERT INTO private_registry_skills (team_id, skill_id, version, content, content_hash)
  VALUES ('5882fa22-0000-0000-0000-00000000f001', v_id, '1.0.1', '{"SKILL.md":"x"}'::jsonb, repeat('1', 64));
  RAISE NOTICE 'GAP-DEMO PASS (N2): embedded LF (chr(10)) in skill_id ACCEPTED by '
               '''^[^/]+/[^/]+$'' -- confirms the plan''s hypothesis that Postgres bracket '
               'expressions match newline by default (non-newline-sensitive mode). skill_id=%',
               replace(v_id, chr(10), '\n');
EXCEPTION
  WHEN check_violation THEN
    RAISE NOTICE 'SURPRISE (N2): embedded LF was REJECTED (23514) -- contradicts the plan''s '
                 'hypothesis; the live CHECK/collation apparently runs in newline-sensitive mode';
  WHEN OTHERS THEN
    RAISE NOTICE 'RESULT (N2): embedded LF rejected at an UNEXPECTED layer -- SQLSTATE=%, MESSAGE=%',
      SQLSTATE, SQLERRM;
END $$;

-- N3: embedded CR (chr(13)).
DO $$
DECLARE v_id TEXT := current_setting('smi5882fz.ns') || '/embedded' || chr(13) || 'cr';
BEGIN
  INSERT INTO private_registry_skills (team_id, skill_id, version, content, content_hash)
  VALUES ('5882fa22-0000-0000-0000-00000000f001', v_id, '1.0.2', '{"SKILL.md":"x"}'::jsonb, repeat('2', 64));
  RAISE NOTICE 'GAP-DEMO PASS (N3): embedded CR (chr(13)) in skill_id ACCEPTED by the shape CHECK';
EXCEPTION
  WHEN check_violation THEN
    RAISE NOTICE 'SURPRISE (N3): embedded CR was REJECTED (23514)';
  WHEN OTHERS THEN
    RAISE NOTICE 'RESULT (N3): embedded CR rejected at an UNEXPECTED layer -- SQLSTATE=%, MESSAGE=%',
      SQLSTATE, SQLERRM;
END $$;

-- N4: embedded TAB (chr(9)) and a generic control character (chr(1), SOH) -- the plan says
-- "control characters" plural, not just newline; TAB/SOH cover that more broadly.
DO $$
DECLARE v_id TEXT := current_setting('smi5882fz.ns') || '/tab' || chr(9) || 'and' || chr(1) || 'soh';
BEGIN
  INSERT INTO private_registry_skills (team_id, skill_id, version, content, content_hash)
  VALUES ('5882fa22-0000-0000-0000-00000000f001', v_id, '1.0.3', '{"SKILL.md":"x"}'::jsonb, repeat('3', 64));
  RAISE NOTICE 'GAP-DEMO PASS (N4): embedded TAB (chr(9)) and SOH (chr(1)) both ACCEPTED by the shape CHECK';
EXCEPTION
  WHEN check_violation THEN
    RAISE NOTICE 'SURPRISE (N4): embedded TAB/SOH was REJECTED (23514)';
  WHEN OTHERS THEN
    RAISE NOTICE 'RESULT (N4): embedded TAB/SOH rejected at an UNEXPECTED layer -- SQLSTATE=%, MESSAGE=%',
      SQLSTATE, SQLERRM;
END $$;

-- N5: embedded NUL (chr(0)) -- Postgres TEXT cannot store a NUL byte at all, so this is
-- expected to fail at a DIFFERENT layer than the shape CHECK (an encoding/representation
-- error, not 23514). Recorded for completeness: NUL is not a viable bypass vector regardless
-- of what the regex itself would permit.
DO $$
DECLARE v_id TEXT;
BEGIN
  v_id := current_setting('smi5882fz.ns') || '/embedded' || chr(0) || 'nul';
  INSERT INTO private_registry_skills (team_id, skill_id, version, content, content_hash)
  VALUES ('5882fa22-0000-0000-0000-00000000f001', v_id, '1.0.4', '{"SKILL.md":"x"}'::jsonb, repeat('4', 64));
  RAISE NOTICE 'GAP-DEMO PASS (N5): embedded NUL byte was ACCEPTED end to end (unexpected -- '
               'Postgres TEXT is not supposed to permit this)';
EXCEPTION
  WHEN check_violation THEN
    RAISE NOTICE 'RESULT (N5): embedded NUL rejected by the shape CHECK itself (23514)';
  WHEN OTHERS THEN
    RAISE NOTICE 'RESULT (N5): embedded NUL rejected at a DIFFERENT layer than the shape CHECK '
                 '-- SQLSTATE=%, MESSAGE=% -- confirms NUL is not a viable bypass vector '
                 'regardless of shape-CHECK permissiveness', SQLSTATE, SQLERRM;
END $$;

-- N6: leading/trailing whitespace WITHIN the skill-name segment (not the namespace segment --
-- that is N7 below, a different question).
DO $$
DECLARE v_id TEXT := current_setting('smi5882fz.ns') || '/  padded-name  ';
BEGIN
  INSERT INTO private_registry_skills (team_id, skill_id, version, content, content_hash)
  VALUES ('5882fa22-0000-0000-0000-00000000f001', v_id, '1.0.5', '{"SKILL.md":"x"}'::jsonb, repeat('5', 64));
  RAISE NOTICE 'GAP-DEMO PASS (N6): leading/trailing whitespace in the skill-name segment '
               'ACCEPTED (not trimmed, not rejected)';
EXCEPTION
  WHEN check_violation THEN
    RAISE NOTICE 'SURPRISE (N6): leading/trailing whitespace in the skill-name segment was REJECTED';
  WHEN OTHERS THEN
    RAISE NOTICE 'RESULT (N6): whitespace-padded skill-name segment rejected at an UNEXPECTED '
                 'layer -- SQLSTATE=%, MESSAGE=%', SQLSTATE, SQLERRM;
END $$;

-- N7 (CONFIRM-NOT-BROKEN, different question from N6): trailing whitespace appended to the
-- NAMESPACE segment itself must NOT be silently trimmed and treated as a match --
-- trg_prs_namespace's split_part(skill_id,'/',1) = teams.skill_namespace comparison is a
-- plain string equality, so "ns " (with a trailing space) must be denied as a mismatch, same
-- as any other non-equal string.
DO $$
DECLARE v_id TEXT := current_setting('smi5882fz.ns') || ' /namespace-segment-has-trailing-space';
BEGIN
  INSERT INTO private_registry_skills (team_id, skill_id, version, content, content_hash)
  VALUES ('5882fa22-0000-0000-0000-00000000f001', v_id, '1.0.6', '{"SKILL.md":"x"}'::jsonb, repeat('6', 64));
  RAISE EXCEPTION 'FAIL (N7): a namespace segment with a trailing space was NOT rejected -- '
                  'split_part()-based matching is silently whitespace-tolerant';
EXCEPTION
  WHEN check_violation THEN
    RAISE NOTICE 'PASS (N7 confirm-not-broken): namespace segment with trailing whitespace '
                 'correctly denied as a non-match (23514) -- namespace comparison is exact, '
                 'not whitespace-tolerant';
END $$;

RESET ROLE;

-- ============================================================================
-- SECTION 2/4 -- Unicode normalization (NFC vs NFD) of an otherwise-identical team name
-- (What Changes §6, item 2, first half)
--
-- None of the seeded reserved names contain combining characters (all pure ASCII --
-- microsoft, anthropics, openai, etc.), so NFC/NFD only diverges for a name containing
-- accented characters. Uses Postgres's own normalize() (PG13+) rather than hand-typing
-- combining-character byte sequences, so the NFC/NFD forms are unambiguously correct.
-- Privileged (RESET ROLE already done above) -- team creation exercises the derivation
-- TRIGGER, which fires regardless of the inserting role; this is not an RLS test.
-- ============================================================================

DO $$
DECLARE
  v_name_nfc TEXT := normalize('café', NFC);  -- single precomposed codepoint U+00E9 for é
  v_name_nfd TEXT := normalize('café', NFD);  -- 'e' + combining acute accent (U+0065 U+0301)
  v_ns_nfc TEXT;
  v_ns_nfd TEXT;
BEGIN
  IF v_name_nfc = v_name_nfd THEN
    RAISE EXCEPTION 'FAIL (N8 setup): normalize() produced IDENTICAL NFC/NFD byte sequences -- '
                    'this DB/locale cannot distinguish the two forms, so N8 tests nothing';
  END IF;

  INSERT INTO teams (id, name, owner_id)
  VALUES ('5882fa22-0000-0000-0000-00000000f008', v_name_nfc, '5882fa22-0000-0000-0000-0000000000f1');
  INSERT INTO teams (id, name, owner_id)
  VALUES ('5882fa22-0000-0000-0000-00000000f009', v_name_nfd, '5882fa22-0000-0000-0000-0000000000f1');

  SELECT skill_namespace INTO v_ns_nfc FROM teams WHERE id = '5882fa22-0000-0000-0000-00000000f008';
  SELECT skill_namespace INTO v_ns_nfd FROM teams WHERE id = '5882fa22-0000-0000-0000-00000000f009';

  IF v_ns_nfc IS DISTINCT FROM v_ns_nfd THEN
    RAISE NOTICE 'GAP-DEMO PASS (N8): the CANONICALLY IDENTICAL, visually-identical team name '
                 '''café'' derives to TWO DIFFERENT namespaces depending only on its Unicode '
                 'normalization form -- NFC="%" -> namespace="%", NFD="%" (byte-distinct, same '
                 'rendered glyphs) -> namespace="%". derive_team_skill_namespace() does not '
                 'normalize before its [^a-z0-9]+ substitution, so the two forms are not '
                 'recognized as the same name.', v_name_nfc, v_ns_nfc, v_name_nfd, v_ns_nfd;
  ELSE
    RAISE NOTICE 'RESULT (N8): NFC and NFD forms of the same visual name derived the SAME '
                 'namespace ("%") -- no normalization gap observed here', v_ns_nfc;
  END IF;
END $$;

-- ============================================================================
-- SECTION 3/4 -- homoglyph/confusable variant of a seeded reserved name, and case variants
-- (What Changes §6, items 2 (second half) and 3)
-- ============================================================================

-- Pure-SELECT collation probes first (no side effects): does this DB's [a-z] range, used by
-- both derive_team_skill_namespace()'s '[^a-z0-9]+' substitution and
-- teams_skill_namespace_shape_check's '^[a-z0-9][a-z0-9-]{0,38}[a-z0-9]$', admit non-ASCII
-- characters that could visually pass as Latin letters? Answered with data, not assumed --
-- What Changes §6 flags this as "collation-dependent — verify against the actual database".
DO $$
DECLARE v_cyr_o BOOLEAN; v_cyr_c BOOLEAN; v_latin_agrave BOOLEAN;
BEGIN
  v_cyr_o := (U&'\043E' ~ '[a-z]');       -- Cyrillic о (U+043E), looks identical to Latin o
  v_cyr_c := (U&'\0441' ~ '[a-z]');       -- Cyrillic с (U+0441), looks identical to Latin c
  v_latin_agrave := ('à' ~ '[a-z]');      -- Latin-1 Supplement à (U+00E0)
  RAISE NOTICE 'INFO (collation probe): Cyrillic о matches [a-z]=%, Cyrillic с matches [a-z]=%, '
               'Latin à matches [a-z]=% -- on this DB/collation', v_cyr_o, v_cyr_c, v_latin_agrave;
END $$;

-- N9: homoglyph-of-reserved-name team creation. "anthropics" is a seeded reserved_namespaces
-- entry (20260727000000:64). Team name below substitutes Cyrillic look-alikes for the Latin
-- 'a' and 'c' (positions 1 and 3): U+0430 (а) and U+0441 (с) -- indistinguishable from Latin
-- "anthropics" in most fonts, but a DIFFERENT Unicode string.
DO $$
DECLARE
  -- Built from concatenated pieces (not one Unicode-escape literal) so the substitution
  -- position is unambiguous at a glance: Cyrillic а (U+0430) + Latin "nthropics".
  v_name TEXT := U&'\0430' || 'nthropics';
  v_ns TEXT;
BEGIN
  INSERT INTO teams (id, name, owner_id)
  VALUES ('5882fa22-0000-0000-0000-00000000f010', v_name, '5882fa22-0000-0000-0000-0000000000f1');
  SELECT skill_namespace INTO v_ns FROM teams WHERE id = '5882fa22-0000-0000-0000-00000000f010';

  IF v_ns = 'anthropics' THEN
    RAISE EXCEPTION 'FAIL (N9): homoglyph team name derived the LITERAL reserved namespace '
                    '"anthropics" -- reserved_namespaces exact-match was bypassed AND the '
                    'derivation preserved the deception';
  ELSIF v_ns LIKE '%-%' THEN
    RAISE NOTICE 'PASS (N9, incidental protection): homoglyph team name "%" (Cyrillic а + '
                 '"nthropics") did NOT derive the literal reserved namespace "anthropics" -- '
                 'derive_team_skill_namespace()''s ASCII-only [^a-z0-9]+ substitution replaced '
                 'the non-ASCII character with a hyphen, producing "%" -- visually distinct '
                 '(hyphen-broken) from the reserved word, not a stealthy squat. This is '
                 'INCIDENTAL (a side effect of ASCII-only sanitization, not a designed '
                 'anti-homoglyph screen) and depends on this DB''s collation treating Cyrillic '
                 'as outside [a-z0-9] (confirmed above) -- reserved_namespaces matching itself '
                 'remains plain exact-string equality with no confusable handling.', v_name, v_ns;
  ELSE
    RAISE NOTICE 'RESULT (N9): homoglyph team name "%" derived namespace "%" -- neither the '
                 'literal reserved word nor a hyphen-broken form; inspect manually', v_name, v_ns;
  END IF;
END $$;

-- N10: case variant of a reserved name. derive_team_skill_namespace() lower()s the candidate
-- before comparing against reserved_namespaces (exact string equality on the LOWERED value),
-- so this is a confirm-not-broken check, not expected to find a gap.
DO $$
DECLARE v_ns TEXT;
BEGIN
  INSERT INTO teams (id, name, owner_id)
  VALUES ('5882fa22-0000-0000-0000-00000000f011', 'MicroSoft', '5882fa22-0000-0000-0000-0000000000f1');
  SELECT skill_namespace INTO v_ns FROM teams WHERE id = '5882fa22-0000-0000-0000-00000000f011';

  IF v_ns = 'microsoft' THEN
    RAISE EXCEPTION 'FAIL (N10): team named "MicroSoft" claimed the LITERAL reserved namespace '
                    '"microsoft" -- case-insensitive reserved-name screening is broken';
  ELSE
    RAISE NOTICE 'PASS (N10 confirm-not-broken): team named "MicroSoft" derived namespace "%" '
                 '(not the literal "microsoft") -- lower() before the reserved_namespaces '
                 'comparison correctly catches case variants of a reserved name', v_ns;
  END IF;
END $$;

-- ============================================================================
-- SECTION 4/4 -- reserved-seed staleness (What Changes §6, "point-in-time snapshot" gap;
-- What Changes §5852's own self-documented gap). Confirms the ALREADY-KNOWN, ALREADY-ACCEPTED
-- finding empirically -- this block does not need to "fix" anything.
-- ============================================================================

DO $$
DECLARE
  v_author CONSTANT TEXT := 'smi5882fuzzauthor';
  v_already_reserved BOOLEAN;
  v_ns TEXT;
BEGIN
  SELECT EXISTS (SELECT 1 FROM reserved_namespaces WHERE namespace = v_author)
    INTO v_already_reserved;
  IF v_already_reserved THEN
    RAISE EXCEPTION 'FAIL (N11 setup): "%" is unexpectedly ALREADY in reserved_namespaces -- '
                    'pick a different probe author, this one collides with real seed data',
      v_author;
  END IF;

  -- A public-registry skill authored by a brand-new author, postdating the migration's
  -- one-time reserved_namespaces seed (20260727000000:106-113, which only ran once, at
  -- `db push` time, against skills.author values that existed THEN).
  INSERT INTO skills (name, author) VALUES ('SMI-5882 fuzz probe skill', v_author);

  -- A team whose name IS that author string (already lowercase/alnum, so
  -- derive_team_skill_namespace()'s regexp_replace leaves it unchanged) claims it directly.
  INSERT INTO teams (id, name, owner_id)
  VALUES ('5882fa22-0000-0000-0000-00000000f012', v_author, '5882fa22-0000-0000-0000-0000000000f1');
  SELECT skill_namespace INTO v_ns FROM teams WHERE id = '5882fa22-0000-0000-0000-00000000f012';

  IF v_ns = v_author THEN
    RAISE NOTICE 'GAP-DEMO PASS (N11): a skills.author value ("%") that postdates the '
                 'reserved_namespaces migration seed was NOT retroactively reserved -- a new '
                 'team claimed it as its LITERAL skill_namespace with no suffixing. Confirms '
                 'the plan''s documented, accepted gap (20260727000000:30-33, "see SMI-5852''s '
                 'plan doc Open Questions for the seed-refresh gap") empirically; this script '
                 'does not attempt to close it.', v_author;
  ELSE
    RAISE EXCEPTION 'FAIL (N11): expected namespace="%" (unsuffixed) but got "%" -- either the '
                    'gap has been closed since the plan was written, or this probe author '
                    'unexpectedly collided with something else', v_author, v_ns;
  END IF;
END $$;

-- ============================================================================
DO $$ BEGIN RAISE NOTICE 'SMI-5882 namespace-fuzz run complete -- see NOTICE lines above for findings.'; END $$;

ROLLBACK;
