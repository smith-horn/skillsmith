/**
 * SMI-6114 / SMI-6680: the five fail-closed "later migration" tripwire detectors for
 * `audit_private_registry_skills_change()` and its audit_logs sink. Split out of the single
 * ~1000-line test file (SMI-6680 governance retro F1) so every non-test file here stays under the
 * repo's 500-line gate. See `private-registry-audit-trigger.pins.test.ts`'s module doc comment
 * for the full MODEL and DOES-NOT-DETECT list.
 *
 * Every detector accepts an optional `dir` (default the real `MIGRATIONS_DIR`), threaded down into
 * `laterMigrationFiles()`/`readMigration()`, so `.detectors.test.ts`'s F1 fixture suite can point
 * these at a `mkdtempSync()` directory instead of the real one (SMI-6680 F1 -- the real directory
 * makes `laterMigrationFiles()` return `[]`, so a committed test pointed only at the real directory
 * can never exercise any of this file's logic).
 */

import {
  FUNCTION_NAME,
  laterMigrationFiles,
  readMigration,
} from './private-registry-audit-trigger.migrations.ts'
import { splitStatements, stripComments } from './private-registry-audit-trigger.scanner.ts'

/**
 * List of migrations exempt from the three fail-closed checks that honour it (disabled triggers,
 * any other trigger/overload on private_registry_skills, tampering with the audit_logs sink) --
 * EMPTY BY DEFAULT. Add a filename only after reviewing that migration against ADR-164. Deliberately
 * NOT consulted by `triggerOrFunctionTamperViolations()` or `grantExecuteViolations()` below -- see
 * `nonExemptRemediation()`.
 *
 *   REVIEWED_LATER_MIGRATIONS: string[] = [
 *     // '20991231000000_example.sql', // reviewed by <name> on <yyyy-mm-dd>: <why this is safe>
 *   ]
 */
export const REVIEWED_LATER_MIGRATIONS: string[] = []

/** Standard remediation text appended to an offender from one of the three allowlist-honouring
 * checks (SMI-6680 F5). */
export const reviewRemediation = (file: string): string =>
  `If this change is intended, review it against ADR-164, then add ${file} to ` +
  'REVIEWED_LATER_MIGRATIONS with the reviewer and date.'

/** Remediation text for the two checks below that have NO allowlist escape hatch, by design: they
 * guard the pinned function/trigger names and the pinned function's own EXECUTE grant directly, so
 * the correct response to an intended change is to update the pin itself (reviewed the same way),
 * not to add a bypass (SMI-6680 F5). */
export const nonExemptRemediation = (file: string): string =>
  `${file} has no REVIEWED_LATER_MIGRATIONS exemption for this check -- if this change is ` +
  'intended, update the pinned constant(s) in private-registry-audit-trigger.pins.ts instead ' +
  '(see ADR-164), reviewed the same way as any other pin change.'

function dropTriggerRe(name: string): RegExp {
  return new RegExp(
    String.raw`DROP\s+TRIGGER\s+(?:IF\s+EXISTS\s+)?(?:"?public"?\s*\.\s*)?"?${name}"?\b`,
    'i'
  )
}
function alterTriggerRe(name: string): RegExp {
  return new RegExp(String.raw`ALTER\s+TRIGGER\s+(?:"?public"?\s*\.\s*)?"?${name}"?\b`, 'i')
}
const DROP_FUNCTION_RE = new RegExp(
  String.raw`DROP\s+FUNCTION\s+(?:IF\s+EXISTS\s+)?(?:"?public"?\s*\.\s*)?"?${FUNCTION_NAME}"?\s*\(`,
  'i'
)
const ALTER_FUNCTION_RE = new RegExp(
  String.raw`ALTER\s+FUNCTION\s+(?:"?public"?\s*\.\s*)?"?${FUNCTION_NAME}"?\s*\(`,
  'i'
)

/**
 * Every migration strictly after MIGRATION_FILE that drops or alters the pinned function or
 * either trigger by name. NOT exemptable (see `nonExemptRemediation()`).
 */
export function triggerOrFunctionTamperViolations(dir?: string): string[] {
  const offenders: string[] = []
  for (const file of laterMigrationFiles(dir)) {
    const content = readMigration(file, dir)
    if (content === null) continue
    const sql = stripComments(content)
    if (dropTriggerRe('trg_prs_audit_truncate').test(sql)) {
      offenders.push(`${file}: DROP TRIGGER trg_prs_audit_truncate. ${nonExemptRemediation(file)}`)
    }
    if (dropTriggerRe('trg_prs_audit').test(sql)) {
      offenders.push(`${file}: DROP TRIGGER trg_prs_audit. ${nonExemptRemediation(file)}`)
    }
    if (DROP_FUNCTION_RE.test(sql)) {
      offenders.push(`${file}: DROP FUNCTION ${FUNCTION_NAME}. ${nonExemptRemediation(file)}`)
    }
    if (ALTER_FUNCTION_RE.test(sql)) {
      offenders.push(`${file}: ALTER FUNCTION ${FUNCTION_NAME}. ${nonExemptRemediation(file)}`)
    }
    if (alterTriggerRe('trg_prs_audit_truncate').test(sql)) {
      offenders.push(`${file}: ALTER TRIGGER trg_prs_audit_truncate. ${nonExemptRemediation(file)}`)
    }
    if (alterTriggerRe('trg_prs_audit').test(sql)) {
      offenders.push(`${file}: ALTER TRIGGER trg_prs_audit. ${nonExemptRemediation(file)}`)
    }
  }
  return offenders
}

/**
 * Every migration strictly after MIGRATION_FILE that GRANTs EXECUTE on the pinned function, by
 * name, to anon/authenticated/PUBLIC (the original shape); OR that grants EXECUTE schema-wide via
 * `ON ALL FUNCTIONS IN SCHEMA public`, or future-proofs it via
 * `ALTER DEFAULT PRIVILEGES ... GRANT EXECUTE ON FUNCTIONS` -- neither of which names the function,
 * so the by-name check alone missed both (SMI-6680 F3, measured against all three real shapes).
 * Uses `splitStatements()` (SMI-6680 F2) so a semicolon inside an unrelated string literal earlier
 * in the same migration can't sever a GRANT from its own `TO` clause. NOT exemptable (see
 * `nonExemptRemediation()`).
 */
export function grantExecuteViolations(dir?: string): string[] {
  const offenders: string[] = []
  const nameRe = new RegExp(String.raw`\b${FUNCTION_NAME}\b`, 'i')
  const schemaWideRe = /\bON\s+ALL\s+FUNCTIONS\s+IN\s+SCHEMA\s+"?public"?\b/i
  const defaultPrivilegesRe = /\bALTER\s+DEFAULT\s+PRIVILEGES\b/i
  const onFunctionsPluralRe = /\bON\s+FUNCTIONS\b/i
  for (const file of laterMigrationFiles(dir)) {
    const content = readMigration(file, dir)
    if (content === null) continue
    const sql = stripComments(content)
    for (const stmt of splitStatements(sql)) {
      if (!/\bGRANT\b/i.test(stmt) || !/\bEXECUTE\b/i.test(stmt)) continue
      const toIdx = stmt.search(/\bTO\b/i)
      if (toIdx === -1 || !/\b(anon|authenticated|PUBLIC)\b/i.test(stmt.slice(toIdx))) continue
      const trimmed = stmt.trim().replace(/\s+/g, ' ').slice(0, 160)
      if (/\bON\s+FUNCTION\b/i.test(stmt) && nameRe.test(stmt)) {
        offenders.push(`${file}: ${trimmed}. ${nonExemptRemediation(file)}`)
      } else if (schemaWideRe.test(stmt)) {
        offenders.push(
          `${file}: GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public re-grants every function in ` +
            `the schema, including the pinned one -- ${trimmed}. ${nonExemptRemediation(file)}`
        )
      } else if (defaultPrivilegesRe.test(stmt) && onFunctionsPluralRe.test(stmt)) {
        offenders.push(
          `${file}: ALTER DEFAULT PRIVILEGES ... GRANT EXECUTE ON FUNCTIONS applies to every ` +
            `future function too, including a redefinition of the pinned one -- ${trimmed}. ` +
            nonExemptRemediation(file)
        )
      }
    }
  }
  return offenders
}

/** Regex source for `[public.]private_registry_skills`, optionally quoted, either half optional. */
const TABLE_REF_SRC = String.raw`(?:"?public"?\s*\.\s*)?"?private_registry_skills"?`
/** Regex source for `[public.]audit_logs`, optionally quoted, either half optional. */
const AUDIT_LOGS_REF_SRC = String.raw`(?:"?public"?\s*\.\s*)?"?audit_logs"?`
/** A trigger target for DISABLE TRIGGER: any bare/quoted identifier, or the keywords ALL/USER. */
const ANY_TRIGGER_TARGET_SRC = String.raw`(?:"?[A-Za-z_][A-Za-z0-9_]*"?|ALL|USER)`
/** A trigger target scoped to the two audit triggers (or ALL/USER, which include them). */
const AUDIT_TRIGGER_TARGET_SRC = String.raw`(?:"?trg_prs_audit_truncate"?|"?trg_prs_audit"?|ALL|USER)`

/**
 * Every migration strictly after MIGRATION_FILE that disables an audit trigger, or re-enables it
 * under a non-default firing mode, via `ALTER TABLE`. Exempt only via REVIEWED_LATER_MIGRATIONS
 * (`reviewed`, default the module-level `REVIEWED_LATER_MIGRATIONS`, overridable for fixtures).
 */
export function disableTriggerViolations(
  dir?: string,
  reviewed: string[] = REVIEWED_LATER_MIGRATIONS
): string[] {
  const offenders: string[] = []
  const disableRe = new RegExp(
    String.raw`ALTER\s+TABLE\s+(?:IF\s+EXISTS\s+)?(?:ONLY\s+)?${TABLE_REF_SRC}\s+DISABLE\s+TRIGGER\s+${ANY_TRIGGER_TARGET_SRC}\b`,
    'gi'
  )
  const enableRe = new RegExp(
    String.raw`ALTER\s+TABLE\s+(?:IF\s+EXISTS\s+)?(?:ONLY\s+)?${TABLE_REF_SRC}\s+ENABLE\s+(?:REPLICA|ALWAYS)\s+TRIGGER\s+${AUDIT_TRIGGER_TARGET_SRC}\b`,
    'gi'
  )
  for (const file of laterMigrationFiles(dir)) {
    if (reviewed.includes(file)) continue
    const content = readMigration(file, dir)
    if (content === null) continue
    const sql = stripComments(content)
    for (const m of sql.matchAll(disableRe)) {
      offenders.push(
        `${file}: disables a trigger on private_registry_skills -- ` +
          `${m[0].replace(/\s+/g, ' ').trim()}. ${reviewRemediation(file)}`
      )
    }
    for (const m of sql.matchAll(enableRe)) {
      offenders.push(
        `${file}: re-enables an audit trigger under a non-default firing mode -- ` +
          `${m[0].replace(/\s+/g, ' ').trim()}. ${reviewRemediation(file)}`
      )
    }
  }
  return offenders
}

/**
 * Every migration strictly after MIGRATION_FILE that either (a) CREATEs ANY trigger on
 * private_registry_skills, or (b) redefines audit_private_registry_skills_change() with a
 * non-empty argument list (an overload). Statement-scoped via `splitStatements()` (SMI-6680 F2) so
 * a trigger on an unrelated table doesn't false-positive, and a semicolon inside an unrelated
 * literal can't hide a real one. Exempt only via REVIEWED_LATER_MIGRATIONS (`reviewed`).
 */
export function laterTriggerViolations(
  dir?: string,
  reviewed: string[] = REVIEWED_LATER_MIGRATIONS
): string[] {
  const offenders: string[] = []
  const onTableRe = new RegExp(String.raw`\bON\s+(?:ONLY\s+)?${TABLE_REF_SRC}\b`, 'i')
  const overloadRe = new RegExp(
    String.raw`CREATE\s+(?:OR\s+REPLACE\s+)?FUNCTION\s+(?:"?public"?\s*\.\s*)?"?${FUNCTION_NAME}"?\s*\(\s*([^()]+)\)`,
    'gi'
  )
  for (const file of laterMigrationFiles(dir)) {
    if (reviewed.includes(file)) continue
    const content = readMigration(file, dir)
    if (content === null) continue
    const sql = stripComments(content)
    for (const stmt of splitStatements(sql)) {
      if (!/\bCREATE\s+(?:OR\s+REPLACE\s+)?(?:CONSTRAINT\s+)?TRIGGER\b/i.test(stmt)) continue
      if (!onTableRe.test(stmt)) continue
      offenders.push(
        `${file}: unreviewed trigger on private_registry_skills -- ` +
          `${stmt.replace(/\s+/g, ' ').trim().slice(0, 160)}. ${reviewRemediation(file)}`
      )
    }
    for (const m of sql.matchAll(overloadRe)) {
      if (m[1].trim().length === 0) continue // the pinned zero-arg signature; not an overload.
      offenders.push(
        `${file}: unreviewed overload ${FUNCTION_NAME}(${m[1].trim()}). ${reviewRemediation(file)}`
      )
    }
  }
  return offenders
}

/**
 * Every migration strictly after MIGRATION_FILE that rewrites, drops, renames, or adds a
 * trigger/rule to the audit_logs sink itself, or changes its column shape underneath the pinned
 * insert. Statement-scoped via `splitStatements()` (SMI-6680 F2 -- a semicolon inside a string
 * literal in the same ALTER TABLE, e.g. a DEFAULT clause, previously severed the table reference
 * from a DROP COLUMN in the same statement, defeating this check silently). Exempt only via
 * REVIEWED_LATER_MIGRATIONS (`reviewed`).
 */
export function auditSinkViolations(
  dir?: string,
  reviewed: string[] = REVIEWED_LATER_MIGRATIONS
): string[] {
  const offenders: string[] = []
  const ruleToAuditLogsRe = new RegExp(String.raw`\bTO\s+${AUDIT_LOGS_REF_SRC}\b`, 'i')
  const triggerOnAuditLogsRe = new RegExp(
    String.raw`\bON\s+(?:ONLY\s+)?${AUDIT_LOGS_REF_SRC}\b`,
    'i'
  )
  const dropAuditLogsRe = new RegExp(
    String.raw`\bDROP\s+TABLE\s+(?:IF\s+EXISTS\s+)?${AUDIT_LOGS_REF_SRC}\b`,
    'i'
  )
  const alterAuditLogsRe = new RegExp(
    String.raw`\bALTER\s+TABLE\s+(?:IF\s+EXISTS\s+)?(?:ONLY\s+)?${AUDIT_LOGS_REF_SRC}\b`,
    'i'
  )
  const dropColumnRe = /\bDROP\s+COLUMN\b/i
  const alterColumnTypeRe =
    /\bALTER\s+COLUMN\s+"?[A-Za-z_][A-Za-z0-9_]*"?\s+(?:SET\s+DATA\s+)?TYPE\b/i
  const setNotNullRe = /\bSET\s+NOT\s+NULL\b/i
  const addConstraintRe = /\bADD\s+(?:CONSTRAINT|CHECK)\b/i
  for (const file of laterMigrationFiles(dir)) {
    if (reviewed.includes(file)) continue
    const content = readMigration(file, dir)
    if (content === null) continue
    const sql = stripComments(content)
    for (const stmt of splitStatements(sql)) {
      const trimmed = () => stmt.replace(/\s+/g, ' ').trim().slice(0, 160)
      if (/\bCREATE\s+(?:OR\s+REPLACE\s+)?RULE\b/i.test(stmt) && ruleToAuditLogsRe.test(stmt)) {
        offenders.push(
          `${file}: CREATE RULE targeting audit_logs -- ${trimmed()}. ${reviewRemediation(file)}`
        )
      }
      if (
        /\bCREATE\s+(?:OR\s+REPLACE\s+)?(?:CONSTRAINT\s+)?TRIGGER\b/i.test(stmt) &&
        triggerOnAuditLogsRe.test(stmt)
      ) {
        offenders.push(
          `${file}: CREATE TRIGGER on audit_logs -- ${trimmed()}. ${reviewRemediation(file)}`
        )
      }
      if (dropAuditLogsRe.test(stmt)) {
        offenders.push(`${file}: DROP TABLE audit_logs -- ${trimmed()}. ${reviewRemediation(file)}`)
      }
      if (alterAuditLogsRe.test(stmt) && /\bRENAME\b/i.test(stmt)) {
        offenders.push(
          `${file}: ALTER TABLE audit_logs ... RENAME -- ${trimmed()}. ${reviewRemediation(file)}`
        )
      }
      if (alterAuditLogsRe.test(stmt) && /\bDISABLE\s+TRIGGER\b/i.test(stmt)) {
        offenders.push(
          `${file}: ALTER TABLE audit_logs ... DISABLE TRIGGER -- ${trimmed()}. ` +
            reviewRemediation(file)
        )
      }
      if (alterAuditLogsRe.test(stmt) && dropColumnRe.test(stmt)) {
        offenders.push(
          `${file}: ALTER TABLE audit_logs ... DROP COLUMN -- ${trimmed()}. ` +
            reviewRemediation(file)
        )
      }
      if (alterAuditLogsRe.test(stmt) && alterColumnTypeRe.test(stmt)) {
        offenders.push(
          `${file}: ALTER TABLE audit_logs ... ALTER COLUMN ... TYPE -- ${trimmed()}. ` +
            reviewRemediation(file)
        )
      }
      if (alterAuditLogsRe.test(stmt) && setNotNullRe.test(stmt)) {
        offenders.push(
          `${file}: ALTER TABLE audit_logs ... SET NOT NULL -- ${trimmed()}. ` +
            reviewRemediation(file)
        )
      }
      if (alterAuditLogsRe.test(stmt) && addConstraintRe.test(stmt)) {
        offenders.push(
          `${file}: ALTER TABLE audit_logs ... ADD CONSTRAINT/CHECK -- ${trimmed()}. ` +
            reviewRemediation(file)
        )
      }
    }
  }
  return offenders
}
