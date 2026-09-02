# Wave 6 Triage — packages/enterprise

**Date:** 2026-09-02
**Branch:** cleanup/code-health-wave-6-enterprise
**Machine:** Windows 11, wrsmith108

## Scan artifacts

| File | Path |
|------|------|
| Scan JSON | `docs/code-health/2026-09-02-032044-enterprise-scan-repo.json` |
| Scan MD | `docs/code-health/2026-09-02-032044-enterprise-scan-repo.md` |
| Verify MD | `docs/code-health/2026-09-02-032100-packages-enterprise-code-health.md` |

## Triage results

Candidate partition (20 total — from verify report):

| Bucket | Count | Action |
|--------|-------|--------|
| B1 Safe-to-delete | 0 | EXPERIMENTAL workspace — no source deletions |
| B2 Consolidation candidate | 8 | Human review on Mac with Docker (treat conservatively) |
| B4 Needs-runtime-verification | 12 | EXPERIMENTAL — all routed by calibration absence |

**Total candidates:** 20 (B1 0 + B2 8 + B4 12 = 20) ✓
**FP tags:** 0 (none)

## Why no Bucket 1 items

EXPERIMENTAL workspace (`calibrated=false`). Source deletions not performed from Windows.
Bucket 1 requires calibration + Mac Docker re-run.

## Coverage run status

Not attempted — uncalibrated workspace.

## Conservative treatment (wave plan directive)

The wave plan explicitly directs: **treat findings conservatively — enterprise tier business logic.**
All 8 B2 candidates are package.json dependency entries. `@smithy/*` packages are the
Smithy TypeScript runtime — AWS SDK v3 depends on these as transitive deps for
`@aws-sdk/client-cloudwatch-logs` and similar. Knip cannot see transitive peer-dependency
chains without full module-graph resolution. These should NOT be removed without first
confirming via `npm ls @smithy/smithy-client --workspace=packages/enterprise` that
none are direct requirements of the CloudWatch integration.

## Consolidation candidates (B2)

### Likely-transitive AWS SDK / Smithy dependencies

These 7 `@smithy/*` devDependencies were flagged as unused by Knip's static analysis.
Given `CloudWatchExporter.ts` in B4, these are almost certainly transitive deps of the
AWS SDK CloudWatch client — verify before any removal.

| Package | File | Line | Priority |
|---------|------|------|----------|
| `@smithy/config-resolver` | package.json | devDep | MEDIUM — likely transitive; `npm ls` before removal |
| `@smithy/core` | package.json | devDep | MEDIUM — likely transitive |
| `@smithy/middleware-endpoint` | package.json | devDep | MEDIUM — likely transitive |
| `@smithy/middleware-retry` | package.json | devDep | MEDIUM — likely transitive |
| `@smithy/protocol-http` | package.json | devDep | MEDIUM — likely transitive |
| `@smithy/smithy-client` | package.json | devDep | MEDIUM — likely transitive |
| `@smithy/util-retry` | package.json | devDep | MEDIUM — likely transitive |

### OpenTelemetry instrumentation

| Package | File | Line | Priority |
|---------|------|------|----------|
| `@opentelemetry/instrumentation-aws-sdk` | package.json | dep | MEDIUM — OpenTelemetry AWS instrumentation; check if used via auto-instrumentation bootstrap |

## Needs-runtime-verification candidates (B4)

All 12 routed to B4 due to EXPERIMENTAL/uncalibrated workspace. High-level summary:

| File | Name | Category | Note |
|------|------|----------|------|
| `audit/formatters/index.ts` | — | files | Index barrel file — usage via re-exports |
| `audit/storage/index.ts` | — | files | Index barrel file — usage via re-exports |
| `audit/AuditEventTypes.ts` | SSOAuditEventSchema | exports | Enterprise SSO audit event schema |
| `audit/AuditEventTypes.ts` | RBACAuditEventSchema | exports | Enterprise RBAC audit event schema |
| `audit/AuditEventTypes.ts` | LicenseAuditEventSchema | exports | Enterprise license audit event schema |
| `audit/AuditEventTypes.ts` | SSOAuditEvent | types | Enterprise SSO audit event type |
| `license/GracefulDegradation.ts` | BASE_URL | exports | License grace degradation base URL — likely used at runtime |
| `audit/exporters/CloudWatchExporter.ts` | VALID_RETENTION_DAYS | exports | CloudWatch batch config constant |
| `audit/exporters/CloudWatchExporter.ts` | MAX_BATCH_SIZE | exports | CloudWatch batch config constant |
| `audit/exporters/CloudWatchExporter.ts` | MAX_BATCH_BYTES | exports | CloudWatch batch config constant |
| `audit/exporters/CloudWatchExporter.ts` | EVENT_OVERHEAD_BYTES | exports | CloudWatch batch config constant |
| `audit/scheduled-scan.lock.ts` | LockCachedResult | types | Scan lock type — likely internal |

All are enterprise-tier business logic (SSO, RBAC, license, CloudWatch audit export).
Treat all conservatively — do not delete without Mac Docker re-run with coverage data.

## Stale suppression markers

0 found. No `audit:code-health-ok` markers in `packages/enterprise/src/`.

## Wave objective and success criteria

This wave establishes a conservative baseline scan of `packages/enterprise`. 20 candidates:
8 in B2 (all dep/devDep entries — likely transitive Smithy/AWS SDK packages) and 12 in B4
(enterprise-tier audit, license, and CloudWatch export symbols). No source deletions.
MacBook Docker re-run required for all bucket promotions.

**Critical pre-removal check for B2:** Run `npm ls @smithy/<package> --workspace=packages/enterprise`
before any removal — `@smithy/*` are almost certainly transitive peers of `@aws-sdk/client-cloudwatch-logs`.

## Post-merge obligations (Mac)

- [ ] Create/update SMI issue; comment with squash SHA
- [ ] Post project update using PR Business Summary
- [ ] Update `docs/code-health/index.md` with wave-6 row
- [ ] Run `npm ls @smithy/smithy-client --workspace=packages/enterprise` to confirm transitive dep status
- [ ] Check `@opentelemetry/instrumentation-aws-sdk` usage: is it registered via auto-instrumentation?
- [ ] Calibrate `packages/enterprise` before treating any B4 candidates as B1 candidates
