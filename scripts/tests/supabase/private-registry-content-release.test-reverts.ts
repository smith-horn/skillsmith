/**
 * SMI-6651 — SMI-6598 revert-then-restore variants for
 * `release_private_registry_skill_content()`.
 *
 * Split out of private-registry-content-release.test-helpers.ts (queen verification round,
 * 2026-09-15) purely to keep that file under the 500-line pre-commit gate — the length check's
 * test-file exemption matches a basename containing `.test.` or `.spec.`
 * (scripts/file-length-policy.mjs's `isExemptFromLengthCheck`), and neither
 * `...test-helpers.ts` nor this file's own `...test-reverts.ts` qualifies, so both must stay
 * under the limit on their own merits, not by riding the sibling `.pg.test.ts` file's exemption.
 *
 * WHY A MISSED ANCHOR THROWS. Each variant below does an EXACT string replacement against the
 * real, shipped migration text. If the migration is edited later and an anchor no longer matches
 * exactly once, `replaceExactlyOnce` throws immediately rather than silently returning the
 * UNMODIFIED real migration — a silently-ineffective "revert" would make its paired
 * revert-then-restore test pass by testing nothing, the exact decorative-test failure mode
 * CLAUDE.md's SMI-6598 rule exists to catch ("the only thing that distinguishes a real test from
 * a decorative one is watching it fail"). A thrown error at test-run time is loud and immediate;
 * a revert that silently no-ops would look identical to a genuine pass until someone thought to
 * check the diff by hand.
 *
 * @module scripts/tests/supabase/private-registry-content-release.test-reverts
 */

import { migrationSql, TEAM_ENT } from './private-registry-content-release.test-helpers.ts'

/** Exact text of the success-row `metadata` object (SMI-6114 shape), reused by variant (b)'s
 *  anchor below — kept as one constant so a future migration edit that changes this block only
 *  needs updating once, not once per variant that happens to reference it. */
const SUCCESS_METADATA =
  "      'team_id', v_row.team_id,\n" +
  "      'registry_team_id', v_row.team_id,\n" +
  '      -- Caller-supplied, unverified (see no_visible_row branch above) -- p_team_id as given,\n' +
  '      -- never authoritative; usually equals team_id above or is NULL when p_team_id was omitted.\n' +
  "      'requested_team_id', p_team_id,\n" +
  "      'member_visible', true,\n" +
  "      'skill_id', v_row.skill_id,\n" +
  "      'version', v_row.version,\n" +
  "      'auth_path', 'user_jwt',\n" +
  "      'actor_user_id', v_uid::text,\n" +
  "      'transport', p_transport,\n" +
  "      'request_id', p_request_id,\n" +
  "      'detail', NULL,\n" +
  "      'file_count', (SELECT count(*) FROM jsonb_object_keys(v_content)),\n" +
  "      'content_hash', v_row.content_hash,\n" +
  "      'audit_writer', 'release_rpc'\n"

function replaceExactlyOnce(sql: string, anchor: string, replacement: string, id: string): string {
  const count = sql.split(anchor).length - 1
  if (count !== 1) {
    throw new Error(
      `SMI-6651 revert (${id}): anchor matched ${count} times, expected exactly 1. The migration ` +
        'text has drifted since this revert helper was written — update the anchor.'
    )
  }
  return sql.replace(anchor, replacement)
}

export type RevertVariant = 'a' | 'b' | 'c' | 'd' | 'e' | 'g' | 'h' | 'i' | 'j' | 'k' | 'l'

export function brokenMigrationSql(variant: RevertVariant): string {
  const real = migrationSql()
  switch (variant) {
    case 'a':
      // (a) remove the team-membership filter from the metadata lookup.
      return replaceExactlyOnce(
        real,
        '     AND prs.team_id IN (SELECT public.user_team_ids())\n',
        '     AND TRUE -- SMI-6651 REVERT-TEST (a): team filter removed\n',
        'a'
      )
    case 'b': {
      // (b) swallow the success-audit insert failure instead of letting it propagate.
      const anchor =
        '  INSERT INTO public.audit_logs (event_type, actor, resource, action, result, metadata)\n' +
        '  VALUES (\n' +
        "    'private_registry:content_read',\n" +
        "    'user:' || v_uid::text,\n" +
        '    v_resource,\n' +
        "    'content_read',\n" +
        "    'success',\n" +
        '    jsonb_build_object(\n' +
        SUCCESS_METADATA +
        '    )\n' +
        '  );\n'
      const wrapped =
        '  BEGIN\n' +
        anchor.replace(/\n$/, '') +
        '\n  EXCEPTION WHEN OTHERS THEN NULL; -- SMI-6651 REVERT-TEST (b): audit failure swallowed\n' +
        '  END;\n'
      return replaceExactlyOnce(real, anchor, wrapped, 'b')
    }
    case 'c':
      // (c) tag every no_visible_row audit with p_team_id unconditionally, dropping the
      // membership re-verification.
      return replaceExactlyOnce(
        real,
        '    IF p_team_id IS NOT NULL AND p_team_id IN (SELECT public.user_team_ids()) THEN\n',
        '    IF p_team_id IS NOT NULL THEN -- SMI-6651 REVERT-TEST (c): membership check removed\n',
        'c'
      )
    case 'd':
      // (d) drop the deprecated = false predicate from the STEP 2 metadata lookup only (step 4's
      // own re-check is untouched, so this variant is caught via the audit `detail`/`resource`
      // shape changing, not via content ever leaking — see the migration's own step-4 comment).
      return replaceExactlyOnce(
        real,
        '     AND prs.deprecated = false\n',
        '     -- SMI-6651 REVERT-TEST (d): deprecated predicate removed from step 2\n',
        'd'
      )
    case 'e':
      // (e) column-only REVOKE instead of REVOKE-table + GRANT-columns — MEASURED ineffective
      // while the pre-existing table-wide GRANT (schemaSql's baseline, mirroring
      // 20260724000000:110) survives.
      return replaceExactlyOnce(
        real,
        'REVOKE SELECT ON TABLE public.private_registry_skills FROM anon, authenticated;\n\n' +
          'GRANT SELECT (id, team_id, skill_id, version, description, content_hash, deprecated, published_by,\n' +
          '              published_at, approval_status, approval_mode, approved_by, approved_at, review_note)\n' +
          '  ON public.private_registry_skills TO authenticated;',
        'REVOKE SELECT (content) ON public.private_registry_skills FROM anon, authenticated;',
        'e'
      )
    case 'g':
      // (g) entitlement checked against A CALLER TEAM instead of the row's own team — the exact
      // cross-team leak class registry-tools.live.content.ts's own header warns about. Hardcodes
      // TEAM_ENT (a real, entitled team the fixture MEMBER genuinely belongs to) so the leak is
      // deterministic regardless of which row is actually being requested.
      return replaceExactlyOnce(
        real,
        '  v_ent := public.check_registry_team_entitlement(v_row.team_id);\n',
        `  v_ent := public.check_registry_team_entitlement('${TEAM_ENT}'); ` +
          '-- SMI-6651 REVERT-TEST (g): caller-team id instead of v_row.team_id\n',
        'g'
      )
    case 'h':
      // (h) tag the denied row with `team_id` unconditionally (SMI-6114 untag rule violation) --
      // a denied row may be naming a pending/other-team submission, so this would let any fellow
      // team member read it via audit_logs_team_scoped_read. Anchored on the literal 'denied',
      // immediately preceding jsonb_build_object(...), which is unique to this one INSERT (the
      // content_missing_or_malformed branch opens the identical object but under 'not_found').
      return replaceExactlyOnce(
        real,
        "      'denied',\n      jsonb_build_object(\n        'registry_team_id', v_row.team_id,\n        -- Caller-supplied, unverified (see no_visible_row branch above) -- p_team_id as given,\n        -- never authoritative.\n        'requested_team_id', p_team_id,\n        'member_visible', false,\n",
        "      'denied',\n      jsonb_build_object(\n        'team_id', v_row.team_id, -- SMI-6651 REVERT-TEST (h): denied row tagged\n        'registry_team_id', v_row.team_id,\n        -- Caller-supplied, unverified (see no_visible_row branch above) -- p_team_id as given,\n        -- never authoritative.\n        'requested_team_id', p_team_id,\n        'member_visible', false,\n",
        'h'
      )
    case 'i':
      // (i) drop the step-4 content re-read's own team_id re-pin (GPT-5.6-Sol review finding 4):
      // a concurrent team transfer landing between the metadata lookup (step 2) and this re-read
      // would then hand back content keyed to whatever team the row NOW belongs to, even though
      // entitlement above was verified against v_row.team_id specifically.
      return replaceExactlyOnce(
        real,
        '     AND prs.team_id = v_row.team_id\n',
        '     -- SMI-6651 REVERT-TEST (i): team_id re-pin removed from step 4\n',
        'i'
      )
    case 'j':
      // (j) drop the malformed-content string-value guard (GPT-5.6-Sol review finding 1): a
      // stored row whose content is an object but carries a non-string value under some key
      // (e.g. {"SKILL.md":"ok","x":123}) would then be handed back as if it were well-formed.
      return replaceExactlyOnce(
        real,
        "  IF NOT FOUND OR jsonb_typeof(v_content) IS DISTINCT FROM 'object'\n" +
          '     OR EXISTS (\n' +
          '          SELECT 1\n' +
          '            FROM jsonb_each(\n' +
          "                   CASE WHEN jsonb_typeof(v_content) = 'object' THEN v_content ELSE '{}'::JSONB END\n" +
          '                 ) AS e(k, v)\n' +
          "           WHERE jsonb_typeof(e.v) <> 'string'\n" +
          '        ) THEN\n',
        "  IF NOT FOUND OR jsonb_typeof(v_content) IS DISTINCT FROM 'object' THEN " +
          '-- SMI-6651 REVERT-TEST (j): string-value guard removed\n',
        'j'
      )
    case 'k':
      // (k) drop `requested_team_id` from the no_visible_row row (round 5 review): the requested
      // team would then go unrecorded on the one outcome where it is most useful (the caller
      // asked about a team they may not even be in, or the skill doesn't exist at all).
      return replaceExactlyOnce(
        real,
        '        -- Caller-supplied, UNVERIFIED (round 5): the raw p_team_id, always -- including NULL and\n' +
          '        -- including a team the caller is not actually in (registry_team_id above nulls that case\n' +
          '        -- out). Records WHICH team was asked for, never WHO gets attributed -- never feeds\n' +
          '        -- registry_team_id/team_id, and must never be read as authoritative.\n' +
          "        'requested_team_id', p_team_id,\n",
        '        -- SMI-6651 REVERT-TEST (k): requested_team_id dropped from no_visible_row\n',
        'k'
      )
    case 'l': {
      // (l) write `actor` as a bare uuid instead of the `'user:' || ` prefix, on all four audit
      // rows (round 5 review): the actor would then match audit_logs_team_scoped_read's FIRST
      // branch (`actor = auth.uid()::text`) directly, so the caller could read their own
      // denied/not_found rows -- the actor-visibility test's whole point is that they cannot.
      // Four separate replacements: the literal actor line repeats identically across all four
      // INSERTs, so each anchor below widens to the surrounding event_type/resource/result lines
      // (which DO differ per branch) to stay unique.
      let sql = real
      sql = replaceExactlyOnce(
        sql,
        '    INSERT INTO public.audit_logs (event_type, actor, resource, action, result, metadata)\n' +
          '    VALUES (\n' +
          "      'private_registry:content_read',\n" +
          "      'user:' || v_uid::text,\n" +
          "      'private_registry_skills/' || p_skill_id,\n" +
          "      'content_read',\n" +
          "      'not_found',\n",
        '    INSERT INTO public.audit_logs (event_type, actor, resource, action, result, metadata)\n' +
          '    VALUES (\n' +
          "      'private_registry:content_read',\n" +
          '      v_uid::text, -- SMI-6651 REVERT-TEST (l): bare uuid, no user: prefix\n' +
          "      'private_registry_skills/' || p_skill_id,\n" +
          "      'content_read',\n" +
          "      'not_found',\n",
        'l-no_visible_row'
      )
      sql = replaceExactlyOnce(
        sql,
        '    INSERT INTO public.audit_logs (event_type, actor, resource, action, result, metadata)\n' +
          '    VALUES (\n' +
          "      'private_registry:content_read',\n" +
          "      'user:' || v_uid::text,\n" +
          '      v_resource,\n' +
          "      'content_read',\n" +
          "      'denied',\n",
        '    INSERT INTO public.audit_logs (event_type, actor, resource, action, result, metadata)\n' +
          '    VALUES (\n' +
          "      'private_registry:content_read',\n" +
          '      v_uid::text, -- SMI-6651 REVERT-TEST (l): bare uuid, no user: prefix\n' +
          '      v_resource,\n' +
          "      'content_read',\n" +
          "      'denied',\n",
        'l-denied'
      )
      sql = replaceExactlyOnce(
        sql,
        '    INSERT INTO public.audit_logs (event_type, actor, resource, action, result, metadata)\n' +
          '    VALUES (\n' +
          "      'private_registry:content_read',\n" +
          "      'user:' || v_uid::text,\n" +
          '      v_resource,\n' +
          "      'content_read',\n" +
          "      'not_found',\n",
        '    INSERT INTO public.audit_logs (event_type, actor, resource, action, result, metadata)\n' +
          '    VALUES (\n' +
          "      'private_registry:content_read',\n" +
          '      v_uid::text, -- SMI-6651 REVERT-TEST (l): bare uuid, no user: prefix\n' +
          '      v_resource,\n' +
          "      'content_read',\n" +
          "      'not_found',\n",
        'l-malformed'
      )
      sql = replaceExactlyOnce(
        sql,
        '  INSERT INTO public.audit_logs (event_type, actor, resource, action, result, metadata)\n' +
          '  VALUES (\n' +
          "    'private_registry:content_read',\n" +
          "    'user:' || v_uid::text,\n" +
          '    v_resource,\n' +
          "    'content_read',\n" +
          "    'success',\n",
        '  INSERT INTO public.audit_logs (event_type, actor, resource, action, result, metadata)\n' +
          '  VALUES (\n' +
          "    'private_registry:content_read',\n" +
          '    v_uid::text, -- SMI-6651 REVERT-TEST (l): bare uuid, no user: prefix\n' +
          '    v_resource,\n' +
          "    'content_read',\n" +
          "    'success',\n",
        'l-success'
      )
      return sql
    }
  }
}
