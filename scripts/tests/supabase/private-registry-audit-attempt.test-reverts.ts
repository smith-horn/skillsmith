/**
 * SMI-6114 — SMI-6598 revert variants for the attempt RPC and the volume predicate.
 *
 * Every variant is an EXACT in-memory string replacement against the shipped migration text; the
 * migration FILE is never edited. A missed anchor THROWS (`replaceExactlyOnce`) rather than
 * returning the unmodified migration, because a silently-ineffective "revert" would make its
 * paired red-test pass by testing nothing.
 *
 * @module scripts/tests/supabase/private-registry-audit-attempt.test-reverts
 */

import { migrationSql } from './private-registry-audit-attempt.test-helpers.ts'

function replaceExactlyOnce(sql: string, anchor: string, replacement: string, id: string): string {
  const count = sql.split(anchor).length - 1
  if (count !== 1) {
    throw new Error(
      `SMI-6114 revert (${id}): anchor matched ${count} times, expected exactly 1. The migration ` +
        'text has drifted since this revert helper was written -- update the anchor.'
    )
  }
  return sql.replace(anchor, () => replacement)
}

export type RevertVariant =
  | 'audit-source-clause-dropped'
  | 'upper-bound-le-now'
  | 'null-operation-admitted'
  | 'null-result-admitted'
  | 'anon-revoke-removed'
  | 'anon-revoke-removed-smoke-blind'
  | 'namespace-equality-dropped'
  | 'non-member-attributed'
  | 'mutation-success-refusal-removed'
  | 'team-id-key-added'
  | 'octet-length-bound'
  | 'service-role-revoke-removed'

const OP_CHECK =
  '  IF p_operation IS NULL OR char_length(p_operation) > 32 OR p_operation NOT IN\n' +
  "     ('publish', 'deprecate', 'undeprecate', 'approve', 'reject',\n" +
  "      'content_read', 'list', 'get', 'namespace') THEN\n"
const RESULT_CHECK =
  '  IF p_result IS NULL OR char_length(p_result) > 32 OR p_result NOT IN\n' +
  "     ('success', 'denied', 'not_found', 'error') THEN\n"
const REVOKE_ANON =
  'REVOKE ALL ON FUNCTION public.record_private_registry_audit_attempt(\n' +
  '  TEXT, TEXT, TEXT, TEXT, TEXT, INTEGER, TEXT, TEXT, TEXT, TEXT) FROM anon;\n'
const MUTATION_SUCCESS_REFUSAL =
  "  IF p_result = 'success'\n" +
  "     AND p_operation IN ('publish', 'deprecate', 'undeprecate', 'approve', 'reject') THEN\n" +
  "    RAISE EXCEPTION 'a mutation success is written by trg_prs_audit only' USING ERRCODE = '22023';\n" +
  '  END IF;\n'

export function brokenMigrationSql(variant: RevertVariant): string {
  const real = migrationSql()
  switch (variant) {
    case 'audit-source-clause-dropped':
      return replaceExactlyOnce(
        real,
        "     AND al.metadata->>'audit_source' = 'client_reported'\n",
        '     -- SMI-6114 REVERT-TEST: audit_source clause dropped\n',
        variant
      )
    case 'upper-bound-le-now':
      return replaceExactlyOnce(
        real,
        '     AND al.created_at <  v_closed_before\n',
        '     AND al.created_at <= p_now -- SMI-6114 REVERT-TEST: open bucket admitted\n',
        variant
      )
    case 'null-operation-admitted':
      // The precedent's `IS NOT NULL AND ... NOT IN` idiom, which a NULL slips straight through.
      return replaceExactlyOnce(
        real,
        OP_CHECK,
        '  IF p_operation IS NOT NULL AND (char_length(p_operation) > 32 OR p_operation NOT IN\n' +
          "     ('publish', 'deprecate', 'undeprecate', 'approve', 'reject',\n" +
          "      'content_read', 'list', 'get', 'namespace')) THEN\n",
        variant
      )
    case 'null-result-admitted':
      return replaceExactlyOnce(
        real,
        RESULT_CHECK,
        '  IF p_result IS NOT NULL AND (char_length(p_result) > 32 OR p_result NOT IN\n' +
          "     ('success', 'denied', 'not_found', 'error')) THEN\n",
        variant
      )
    case 'anon-revoke-removed':
      return replaceExactlyOnce(
        real,
        REVOKE_ANON,
        '-- SMI-6114 REVERT-TEST: anon REVOKE removed\n',
        variant
      )
    case 'anon-revoke-removed-smoke-blind': {
      // Removing the REVOKE alone trips the migration's OWN smoke block (the point of that block).
      // To watch THIS suite's has_function_privilege('anon') assertion fail, blind the smoke too.
      const noRevoke = replaceExactlyOnce(
        real,
        REVOKE_ANON,
        '-- REVERT-TEST: anon REVOKE removed\n',
        variant
      )
      return replaceExactlyOnce(
        noRevoke,
        "    IF has_function_privilege('anon', v_proc, 'EXECUTE') THEN\n",
        '    IF FALSE THEN -- REVERT-TEST: smoke anon check blinded\n',
        variant + '/smoke'
      )
    }
    case 'namespace-equality-dropped':
      return replaceExactlyOnce(
        real,
        "    AND v_ns IS NOT NULL\n    AND v_ns = split_part(p_skill_id, '/', 1);",
        '    AND v_ns IS NOT NULL; -- SMI-6114 REVERT-TEST: namespace equality dropped',
        variant
      )
    case 'non-member-attributed': {
      // Let a NON-member populate skill_id: drop the membership term from the attribution AND
      // resolve the requested team's namespace for everyone, so the realistic non-member fixture
      // (slash-form skill of the requested team's real namespace) is attributed.
      const a = replaceExactlyOnce(
        real,
        'v_attributed := v_member\n    AND p_skill_id IS NOT NULL',
        'v_attributed := p_skill_id IS NOT NULL -- SMI-6114 REVERT-TEST: membership term dropped',
        variant + '/attr'
      )
      return replaceExactlyOnce(
        a,
        '    SELECT t.skill_namespace INTO v_ns FROM public.teams t WHERE t.id = v_verified;\n  END IF;\n',
        '    SELECT t.skill_namespace INTO v_ns FROM public.teams t WHERE t.id = v_verified;\n  END IF;\n' +
          '  SELECT t.skill_namespace INTO v_ns FROM public.teams t WHERE t.id = p_team_id; -- REVERT-TEST\n',
        variant + '/ns'
      )
    }
    case 'mutation-success-refusal-removed':
      return replaceExactlyOnce(
        real,
        MUTATION_SUCCESS_REFUSAL,
        '  -- SMI-6114 REVERT-TEST: mutation-success refusal removed\n',
        variant
      )
    case 'service-role-revoke-removed':
      return replaceExactlyOnce(
        real,
        'REVOKE ALL ON FUNCTION public.record_private_registry_audit_attempt(\n' +
          '  TEXT, TEXT, TEXT, TEXT, TEXT, INTEGER, TEXT, TEXT, TEXT, TEXT) FROM service_role;\n',
        '-- SMI-6114 REVERT-TEST: service_role REVOKE removed\n',
        variant
      )
    case 'octet-length-bound':
      // Bytes instead of characters on p_skill_id: a 256-character multibyte value is 768 bytes.
      return replaceExactlyOnce(
        real,
        'IF p_skill_id IS NOT NULL AND char_length(p_skill_id) > 256 THEN',
        'IF p_skill_id IS NOT NULL AND octet_length(p_skill_id) > 256 THEN',
        variant
      )
    case 'team-id-key-added':
      return replaceExactlyOnce(
        real,
        "      'registry_team_id', v_verified,\n",
        "      'registry_team_id', v_verified,\n      'team_id', v_verified, -- SMI-6114 REVERT-TEST: member-visible key added\n",
        variant
      )
  }
}
