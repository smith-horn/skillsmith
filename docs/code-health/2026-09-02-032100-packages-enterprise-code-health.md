# Code Health Report

Generated: 2026-09-02T03:21:00.959Z

## SCAN FAILURES (0)

A Knip pass failed or returned malformed/incomplete data for these workspaces. Every candidate from a listed workspace is force-routed to Needs runtime verification below, regardless of coverage or calibration status, and is NOT eligible for Safe-to-delete or Consolidation-candidate until re-scanned successfully. This is never absorbed as "no findings" -- see patterns/README.md Decision Log.

_None._

## Safe to delete (0)

Never auto-applied. Zero static references + zero coverage on the exact flagged range — not a deletion guarantee, do a final project-wide grep before deleting. See patterns/README.md Bucket 1.

_None._

## Consolidation candidate (8)

Human judgment only, never auto-merged. See patterns/README.md Bucket 2.

| workspace | file | name | files | note | source |
|---|---|---|---|---|---|
| packages/enterprise | packages/enterprise/package.json | @opentelemetry/instrumentation-aws-sdk |  | unused dependency — requires a human runtime-import check before removal; never auto-classified as safe |  |
| packages/enterprise | packages/enterprise/package.json | @smithy/config-resolver |  | unused dependency — requires a human runtime-import check before removal; never auto-classified as safe |  |
| packages/enterprise | packages/enterprise/package.json | @smithy/core |  | unused dependency — requires a human runtime-import check before removal; never auto-classified as safe |  |
| packages/enterprise | packages/enterprise/package.json | @smithy/middleware-endpoint |  | unused dependency — requires a human runtime-import check before removal; never auto-classified as safe |  |
| packages/enterprise | packages/enterprise/package.json | @smithy/middleware-retry |  | unused dependency — requires a human runtime-import check before removal; never auto-classified as safe |  |
| packages/enterprise | packages/enterprise/package.json | @smithy/protocol-http |  | unused dependency — requires a human runtime-import check before removal; never auto-classified as safe |  |
| packages/enterprise | packages/enterprise/package.json | @smithy/smithy-client |  | unused dependency — requires a human runtime-import check before removal; never auto-classified as safe |  |
| packages/enterprise | packages/enterprise/package.json | @smithy/util-retry |  | unused dependency — requires a human runtime-import check before removal; never auto-classified as safe |  |

## Looks bad but is fine (0)

### False positives (0)

_None._

### Known blind spots (0)

_None._

## Needs runtime verification — insufficient evidence (12)

Not a verdict. Never promoted to Safe-to-delete on missing data. See patterns/README.md Bucket 4.

| workspace | file | category | name | line | reason |
|---|---|---|---|---|---|
| packages/enterprise | packages/enterprise/src/audit/formatters/index.ts | files |  |  | workspace is EXPERIMENTAL (uncalibrated) |
| packages/enterprise | packages/enterprise/src/audit/storage/index.ts | files |  |  | workspace is EXPERIMENTAL (uncalibrated) |
| packages/enterprise | packages/enterprise/src/audit/AuditEventTypes.ts | exports | SSOAuditEventSchema | 21 | workspace is EXPERIMENTAL (uncalibrated) |
| packages/enterprise | packages/enterprise/src/audit/AuditEventTypes.ts | exports | RBACAuditEventSchema | 28 | workspace is EXPERIMENTAL (uncalibrated) |
| packages/enterprise | packages/enterprise/src/audit/AuditEventTypes.ts | exports | LicenseAuditEventSchema | 34 | workspace is EXPERIMENTAL (uncalibrated) |
| packages/enterprise | packages/enterprise/src/audit/AuditEventTypes.ts | types | SSOAuditEvent | 112 | workspace is EXPERIMENTAL (uncalibrated) |
| packages/enterprise | packages/enterprise/src/license/GracefulDegradation.ts | exports | BASE_URL | 13 | workspace is EXPERIMENTAL (uncalibrated) |
| packages/enterprise | packages/enterprise/src/audit/exporters/CloudWatchExporter.ts | exports | VALID_RETENTION_DAYS | 28 | workspace is EXPERIMENTAL (uncalibrated) |
| packages/enterprise | packages/enterprise/src/audit/exporters/CloudWatchExporter.ts | exports | MAX_BATCH_SIZE | 29 | workspace is EXPERIMENTAL (uncalibrated) |
| packages/enterprise | packages/enterprise/src/audit/exporters/CloudWatchExporter.ts | exports | MAX_BATCH_BYTES | 30 | workspace is EXPERIMENTAL (uncalibrated) |
| packages/enterprise | packages/enterprise/src/audit/exporters/CloudWatchExporter.ts | exports | EVENT_OVERHEAD_BYTES | 31 | workspace is EXPERIMENTAL (uncalibrated) |
| packages/enterprise | packages/enterprise/src/audit/scheduled-scan.lock.ts | types | LockCachedResult | 61 | workspace is EXPERIMENTAL (uncalibrated) |

## Suppressed by marker (0)

_None._

## Stale suppression markers (0)

Present in source, no current finding matches — consider removing.

_None._
