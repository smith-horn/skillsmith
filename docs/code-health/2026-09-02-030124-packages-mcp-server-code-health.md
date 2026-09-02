# Code Health Report

Generated: 2026-09-02T03:01:25.897Z

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
| packages/mcp-server | packages/mcp-server/src/tools/uninstall.ts |  |  | Knip duplicate-export finding; no per-line coverage signal available — human review, never auto-classified as safe |  |
| packages/mcp-server | packages/mcp-server/src/tools/install.tool.ts |  |  | Knip duplicate-export finding; no per-line coverage signal available — human review, never auto-classified as safe |  |
| packages/mcp-server |  | readBody | packages/mcp-server/src/utils/local-inventory.helpers.ts,packages/mcp-server/src/webhooks/webhook-helpers.ts |  | name-repeat-detector |
| packages/mcp-server |  | parseSkillId | packages/mcp-server/src/tools/install.helpers.ts,packages/mcp-server/src/utils/validation.ts |  | name-repeat-detector |
| packages/mcp-server |  | main | packages/mcp-server/src/webhooks/stripe-webhook-endpoint.ts,packages/mcp-server/src/webhooks/webhook-endpoint.ts |  | name-repeat-detector |
| packages/mcp-server |  | loadManifest | packages/mcp-server/src/tools/install.helpers.manifest.ts,packages/mcp-server/src/utils/local-inventory.helpers.ts |  | name-repeat-detector |
| packages/mcp-server |  | getLocalIndexer | packages/mcp-server/src/indexer/LocalIndexer.ts,packages/mcp-server/src/tools/LocalSkillSearch.ts |  | name-repeat-detector |
| packages/mcp-server |  | attachShutdownHandlers | packages/mcp-server/src/webhooks/stripe-webhook-endpoint.ts,packages/mcp-server/src/webhooks/webhook-endpoint.ts |  | name-repeat-detector |

## Looks bad but is fine (152)

### False positives (0)

_None._

### Known blind spots (152)

| workspace | file | tag | detail |
|---|---|---|---|
| packages/mcp-server | packages/mcp-server/src/tools/LocalSkillSearch.ts | mcp-string-dispatch-unmatched | no case-string hit found in tool-dispatch.ts (defensive check — direct-import dispatch is expected to satisfy this) |
| packages/mcp-server | packages/mcp-server/src/tools/agent-pack.assets.test.ts | mcp-string-dispatch-unmatched | no case-string hit found in tool-dispatch.ts (defensive check — direct-import dispatch is expected to satisfy this) |
| packages/mcp-server | packages/mcp-server/src/tools/analytics.service.test.ts | mcp-string-dispatch-unmatched | no case-string hit found in tool-dispatch.ts (defensive check — direct-import dispatch is expected to satisfy this) |
| packages/mcp-server | packages/mcp-server/src/tools/analytics.service.ts | mcp-string-dispatch-unmatched | no case-string hit found in tool-dispatch.ts (defensive check — direct-import dispatch is expected to satisfy this) |
| packages/mcp-server | packages/mcp-server/src/tools/analytics.stub.ts | mcp-string-dispatch-unmatched | no case-string hit found in tool-dispatch.ts (defensive check — direct-import dispatch is expected to satisfy this) |
| packages/mcp-server | packages/mcp-server/src/tools/analytics.supabase.service.test.ts | mcp-string-dispatch-unmatched | no case-string hit found in tool-dispatch.ts (defensive check — direct-import dispatch is expected to satisfy this) |
| packages/mcp-server | packages/mcp-server/src/tools/analytics.supabase.service.ts | mcp-string-dispatch-unmatched | no case-string hit found in tool-dispatch.ts (defensive check — direct-import dispatch is expected to satisfy this) |
| packages/mcp-server | packages/mcp-server/src/tools/analytics.test.ts | mcp-string-dispatch-unmatched | no case-string hit found in tool-dispatch.ts (defensive check — direct-import dispatch is expected to satisfy this) |
| packages/mcp-server | packages/mcp-server/src/tools/analyze.ts | mcp-string-dispatch-unmatched | no case-string hit found in tool-dispatch.ts (defensive check — direct-import dispatch is expected to satisfy this) |
| packages/mcp-server | packages/mcp-server/src/tools/apply-journal.helpers.ts | mcp-string-dispatch-unmatched | no case-string hit found in tool-dispatch.ts (defensive check — direct-import dispatch is expected to satisfy this) |
| packages/mcp-server | packages/mcp-server/src/tools/apply-namespace-rename.ts | mcp-string-dispatch-unmatched | no case-string hit found in tool-dispatch.ts (defensive check — direct-import dispatch is expected to satisfy this) |
| packages/mcp-server | packages/mcp-server/src/tools/apply-namespace-rename.types.ts | mcp-string-dispatch-unmatched | no case-string hit found in tool-dispatch.ts (defensive check — direct-import dispatch is expected to satisfy this) |
| packages/mcp-server | packages/mcp-server/src/tools/apply-recommended-edit.ts | mcp-string-dispatch-unmatched | no case-string hit found in tool-dispatch.ts (defensive check — direct-import dispatch is expected to satisfy this) |
| packages/mcp-server | packages/mcp-server/src/tools/apply-recommended-edit.types.ts | mcp-string-dispatch-unmatched | no case-string hit found in tool-dispatch.ts (defensive check — direct-import dispatch is expected to satisfy this) |
| packages/mcp-server | packages/mcp-server/src/tools/apply-session.helpers.ts | mcp-string-dispatch-unmatched | no case-string hit found in tool-dispatch.ts (defensive check — direct-import dispatch is expected to satisfy this) |
| packages/mcp-server | packages/mcp-server/src/tools/audit-tools.test.ts | mcp-string-dispatch-unmatched | no case-string hit found in tool-dispatch.ts (defensive check — direct-import dispatch is expected to satisfy this) |
| packages/mcp-server | packages/mcp-server/src/tools/audit-tools.ts | mcp-string-dispatch-unmatched | no case-string hit found in tool-dispatch.ts (defensive check — direct-import dispatch is expected to satisfy this) |
| packages/mcp-server | packages/mcp-server/src/tools/compare.helpers.ts | mcp-string-dispatch-unmatched | no case-string hit found in tool-dispatch.ts (defensive check — direct-import dispatch is expected to satisfy this) |
| packages/mcp-server | packages/mcp-server/src/tools/compare.types.ts | mcp-string-dispatch-unmatched | no case-string hit found in tool-dispatch.ts (defensive check — direct-import dispatch is expected to satisfy this) |
| packages/mcp-server | packages/mcp-server/src/tools/compliance-tools.cyclonedx.test.ts | mcp-string-dispatch-unmatched | no case-string hit found in tool-dispatch.ts (defensive check — direct-import dispatch is expected to satisfy this) |
| packages/mcp-server | packages/mcp-server/src/tools/compliance-tools.cyclonedx.ts | mcp-string-dispatch-unmatched | no case-string hit found in tool-dispatch.ts (defensive check — direct-import dispatch is expected to satisfy this) |
| packages/mcp-server | packages/mcp-server/src/tools/compliance-tools.service.test.ts | mcp-string-dispatch-unmatched | no case-string hit found in tool-dispatch.ts (defensive check — direct-import dispatch is expected to satisfy this) |
| packages/mcp-server | packages/mcp-server/src/tools/compliance-tools.service.ts | mcp-string-dispatch-unmatched | no case-string hit found in tool-dispatch.ts (defensive check — direct-import dispatch is expected to satisfy this) |
| packages/mcp-server | packages/mcp-server/src/tools/compliance-tools.test.ts | mcp-string-dispatch-unmatched | no case-string hit found in tool-dispatch.ts (defensive check — direct-import dispatch is expected to satisfy this) |
| packages/mcp-server | packages/mcp-server/src/tools/compliance-tools.ts | mcp-string-dispatch-unmatched | no case-string hit found in tool-dispatch.ts (defensive check — direct-import dispatch is expected to satisfy this) |
| packages/mcp-server | packages/mcp-server/src/tools/get-skill.format.ts | mcp-string-dispatch-unmatched | no case-string hit found in tool-dispatch.ts (defensive check — direct-import dispatch is expected to satisfy this) |
| packages/mcp-server | packages/mcp-server/src/tools/get-skill.ts | mcp-string-dispatch-unmatched | no case-string hit found in tool-dispatch.ts (defensive check — direct-import dispatch is expected to satisfy this) |
| packages/mcp-server | packages/mcp-server/src/tools/index-local.ts | mcp-string-dispatch-unmatched | no case-string hit found in tool-dispatch.ts (defensive check — direct-import dispatch is expected to satisfy this) |
| packages/mcp-server | packages/mcp-server/src/tools/install.backup-gc.ts | mcp-string-dispatch-unmatched | no case-string hit found in tool-dispatch.ts (defensive check — direct-import dispatch is expected to satisfy this) |
| packages/mcp-server | packages/mcp-server/src/tools/install.conflict-helpers.ts | mcp-string-dispatch-unmatched | no case-string hit found in tool-dispatch.ts (defensive check — direct-import dispatch is expected to satisfy this) |
| packages/mcp-server | packages/mcp-server/src/tools/install.conflict.ts | mcp-string-dispatch-unmatched | no case-string hit found in tool-dispatch.ts (defensive check — direct-import dispatch is expected to satisfy this) |
| packages/mcp-server | packages/mcp-server/src/tools/install.helpers.manifest.ts | mcp-string-dispatch-unmatched | no case-string hit found in tool-dispatch.ts (defensive check — direct-import dispatch is expected to satisfy this) |
| packages/mcp-server | packages/mcp-server/src/tools/install.helpers.tips.test.ts | mcp-string-dispatch-unmatched | no case-string hit found in tool-dispatch.ts (defensive check — direct-import dispatch is expected to satisfy this) |
| packages/mcp-server | packages/mcp-server/src/tools/install.helpers.ts | mcp-string-dispatch-unmatched | no case-string hit found in tool-dispatch.ts (defensive check — direct-import dispatch is expected to satisfy this) |
| packages/mcp-server | packages/mcp-server/src/tools/install.ledger-replay.ts | mcp-string-dispatch-unmatched | no case-string hit found in tool-dispatch.ts (defensive check — direct-import dispatch is expected to satisfy this) |
| packages/mcp-server | packages/mcp-server/src/tools/install.namespace-gate.ts | mcp-string-dispatch-unmatched | no case-string hit found in tool-dispatch.ts (defensive check — direct-import dispatch is expected to satisfy this) |
| packages/mcp-server | packages/mcp-server/src/tools/install.optimize.ts | mcp-string-dispatch-unmatched | no case-string hit found in tool-dispatch.ts (defensive check — direct-import dispatch is expected to satisfy this) |
| packages/mcp-server | packages/mcp-server/src/tools/install.test.ts | mcp-string-dispatch-unmatched | no case-string hit found in tool-dispatch.ts (defensive check — direct-import dispatch is expected to satisfy this) |
| packages/mcp-server | packages/mcp-server/src/tools/install.tool.ts | mcp-string-dispatch-unmatched | no case-string hit found in tool-dispatch.ts (defensive check — direct-import dispatch is expected to satisfy this) |
| packages/mcp-server | packages/mcp-server/src/tools/install.types.test.ts | mcp-string-dispatch-unmatched | no case-string hit found in tool-dispatch.ts (defensive check — direct-import dispatch is expected to satisfy this) |
| packages/mcp-server | packages/mcp-server/src/tools/install.types.ts | mcp-string-dispatch-unmatched | no case-string hit found in tool-dispatch.ts (defensive check — direct-import dispatch is expected to satisfy this) |
| packages/mcp-server | packages/mcp-server/src/tools/integration-tools.service.hash.test.ts | mcp-string-dispatch-unmatched | no case-string hit found in tool-dispatch.ts (defensive check — direct-import dispatch is expected to satisfy this) |
| packages/mcp-server | packages/mcp-server/src/tools/integration-tools.service.test.ts | mcp-string-dispatch-unmatched | no case-string hit found in tool-dispatch.ts (defensive check — direct-import dispatch is expected to satisfy this) |
| packages/mcp-server | packages/mcp-server/src/tools/integration-tools.service.ts | mcp-string-dispatch-unmatched | no case-string hit found in tool-dispatch.ts (defensive check — direct-import dispatch is expected to satisfy this) |
| packages/mcp-server | packages/mcp-server/src/tools/integration-tools.stub.ts | mcp-string-dispatch-unmatched | no case-string hit found in tool-dispatch.ts (defensive check — direct-import dispatch is expected to satisfy this) |
| packages/mcp-server | packages/mcp-server/src/tools/integration-tools.test.ts | mcp-string-dispatch-unmatched | no case-string hit found in tool-dispatch.ts (defensive check — direct-import dispatch is expected to satisfy this) |
| packages/mcp-server | packages/mcp-server/src/tools/integration-tools.ts | mcp-string-dispatch-unmatched | no case-string hit found in tool-dispatch.ts (defensive check — direct-import dispatch is expected to satisfy this) |
| packages/mcp-server | packages/mcp-server/src/tools/inventory-push.test.ts | mcp-string-dispatch-unmatched | no case-string hit found in tool-dispatch.ts (defensive check — direct-import dispatch is expected to satisfy this) |
| packages/mcp-server | packages/mcp-server/src/tools/inventory-push.ts | mcp-string-dispatch-unmatched | no case-string hit found in tool-dispatch.ts (defensive check — direct-import dispatch is expected to satisfy this) |
| packages/mcp-server | packages/mcp-server/src/tools/manifest-skill-ids.helpers.test.ts | mcp-string-dispatch-unmatched | no case-string hit found in tool-dispatch.ts (defensive check — direct-import dispatch is expected to satisfy this) |
| packages/mcp-server | packages/mcp-server/src/tools/manifest-skill-ids.helpers.ts | mcp-string-dispatch-unmatched | no case-string hit found in tool-dispatch.ts (defensive check — direct-import dispatch is expected to satisfy this) |
| packages/mcp-server | packages/mcp-server/src/tools/merge.test.ts | mcp-string-dispatch-unmatched | no case-string hit found in tool-dispatch.ts (defensive check — direct-import dispatch is expected to satisfy this) |
| packages/mcp-server | packages/mcp-server/src/tools/merge.ts | mcp-string-dispatch-unmatched | no case-string hit found in tool-dispatch.ts (defensive check — direct-import dispatch is expected to satisfy this) |
| packages/mcp-server | packages/mcp-server/src/tools/outdated.test.ts | mcp-string-dispatch-unmatched | no case-string hit found in tool-dispatch.ts (defensive check — direct-import dispatch is expected to satisfy this) |
| packages/mcp-server | packages/mcp-server/src/tools/publish-private.test.ts | mcp-string-dispatch-unmatched | no case-string hit found in tool-dispatch.ts (defensive check — direct-import dispatch is expected to satisfy this) |
| packages/mcp-server | packages/mcp-server/src/tools/publish-private.ts | mcp-string-dispatch-unmatched | no case-string hit found in tool-dispatch.ts (defensive check — direct-import dispatch is expected to satisfy this) |
| packages/mcp-server | packages/mcp-server/src/tools/publish.helpers.ts | mcp-string-dispatch-unmatched | no case-string hit found in tool-dispatch.ts (defensive check — direct-import dispatch is expected to satisfy this) |
| packages/mcp-server | packages/mcp-server/src/tools/publish.types.ts | mcp-string-dispatch-unmatched | no case-string hit found in tool-dispatch.ts (defensive check — direct-import dispatch is expected to satisfy this) |
| packages/mcp-server | packages/mcp-server/src/tools/rbac-tools.action.ts | mcp-string-dispatch-unmatched | no case-string hit found in tool-dispatch.ts (defensive check — direct-import dispatch is expected to satisfy this) |
| packages/mcp-server | packages/mcp-server/src/tools/rbac-tools.live.auth.ts | mcp-string-dispatch-unmatched | no case-string hit found in tool-dispatch.ts (defensive check — direct-import dispatch is expected to satisfy this) |
| packages/mcp-server | packages/mcp-server/src/tools/rbac-tools.live.test.ts | mcp-string-dispatch-unmatched | no case-string hit found in tool-dispatch.ts (defensive check — direct-import dispatch is expected to satisfy this) |
| packages/mcp-server | packages/mcp-server/src/tools/rbac-tools.live.ts | mcp-string-dispatch-unmatched | no case-string hit found in tool-dispatch.ts (defensive check — direct-import dispatch is expected to satisfy this) |
| packages/mcp-server | packages/mcp-server/src/tools/rbac-tools.meta-permission-migration.test.ts | mcp-string-dispatch-unmatched | no case-string hit found in tool-dispatch.ts (defensive check — direct-import dispatch is expected to satisfy this) |
| packages/mcp-server | packages/mcp-server/src/tools/rbac-tools.meta-permission-not-grantable.test.ts | mcp-string-dispatch-unmatched | no case-string hit found in tool-dispatch.ts (defensive check — direct-import dispatch is expected to satisfy this) |
| packages/mcp-server | packages/mcp-server/src/tools/rbac-tools.schemas.ts | mcp-string-dispatch-unmatched | no case-string hit found in tool-dispatch.ts (defensive check — direct-import dispatch is expected to satisfy this) |
| packages/mcp-server | packages/mcp-server/src/tools/rbac-tools.stub.ts | mcp-string-dispatch-unmatched | no case-string hit found in tool-dispatch.ts (defensive check — direct-import dispatch is expected to satisfy this) |
| packages/mcp-server | packages/mcp-server/src/tools/rbac-tools.test.ts | mcp-string-dispatch-unmatched | no case-string hit found in tool-dispatch.ts (defensive check — direct-import dispatch is expected to satisfy this) |
| packages/mcp-server | packages/mcp-server/src/tools/rbac-tools.ts | mcp-string-dispatch-unmatched | no case-string hit found in tool-dispatch.ts (defensive check — direct-import dispatch is expected to satisfy this) |
| packages/mcp-server | packages/mcp-server/src/tools/rbac-tools.types.ts | mcp-string-dispatch-unmatched | no case-string hit found in tool-dispatch.ts (defensive check — direct-import dispatch is expected to satisfy this) |
| packages/mcp-server | packages/mcp-server/src/tools/recommend.format.ts | mcp-string-dispatch-unmatched | no case-string hit found in tool-dispatch.ts (defensive check — direct-import dispatch is expected to satisfy this) |
| packages/mcp-server | packages/mcp-server/src/tools/recommend.helpers.ts | mcp-string-dispatch-unmatched | no case-string hit found in tool-dispatch.ts (defensive check — direct-import dispatch is expected to satisfy this) |
| packages/mcp-server | packages/mcp-server/src/tools/recommend.types.ts | mcp-string-dispatch-unmatched | no case-string hit found in tool-dispatch.ts (defensive check — direct-import dispatch is expected to satisfy this) |
| packages/mcp-server | packages/mcp-server/src/tools/registry-tools.api-key-fallback.test.ts | mcp-string-dispatch-unmatched | no case-string hit found in tool-dispatch.ts (defensive check — direct-import dispatch is expected to satisfy this) |
| packages/mcp-server | packages/mcp-server/src/tools/registry-tools.content.types.ts | mcp-string-dispatch-unmatched | no case-string hit found in tool-dispatch.ts (defensive check — direct-import dispatch is expected to satisfy this) |
| packages/mcp-server | packages/mcp-server/src/tools/registry-tools.cross-transport.test.ts | mcp-string-dispatch-unmatched | no case-string hit found in tool-dispatch.ts (defensive check — direct-import dispatch is expected to satisfy this) |
| packages/mcp-server | packages/mcp-server/src/tools/registry-tools.install-action.test.ts | mcp-string-dispatch-unmatched | no case-string hit found in tool-dispatch.ts (defensive check — direct-import dispatch is expected to satisfy this) |
| packages/mcp-server | packages/mcp-server/src/tools/registry-tools.install-action.ts | mcp-string-dispatch-unmatched | no case-string hit found in tool-dispatch.ts (defensive check — direct-import dispatch is expected to satisfy this) |
| packages/mcp-server | packages/mcp-server/src/tools/registry-tools.live.admin-auth.test.ts | mcp-string-dispatch-unmatched | no case-string hit found in tool-dispatch.ts (defensive check — direct-import dispatch is expected to satisfy this) |
| packages/mcp-server | packages/mcp-server/src/tools/registry-tools.live.adversarial-content.test.ts | mcp-string-dispatch-unmatched | no case-string hit found in tool-dispatch.ts (defensive check — direct-import dispatch is expected to satisfy this) |
| packages/mcp-server | packages/mcp-server/src/tools/registry-tools.live.audit.ts | mcp-string-dispatch-unmatched | no case-string hit found in tool-dispatch.ts (defensive check — direct-import dispatch is expected to satisfy this) |
| packages/mcp-server | packages/mcp-server/src/tools/registry-tools.live.auth.test.ts | mcp-string-dispatch-unmatched | no case-string hit found in tool-dispatch.ts (defensive check — direct-import dispatch is expected to satisfy this) |
| packages/mcp-server | packages/mcp-server/src/tools/registry-tools.live.auth.ts | mcp-string-dispatch-unmatched | no case-string hit found in tool-dispatch.ts (defensive check — direct-import dispatch is expected to satisfy this) |
| packages/mcp-server | packages/mcp-server/src/tools/registry-tools.live.content.test.ts | mcp-string-dispatch-unmatched | no case-string hit found in tool-dispatch.ts (defensive check — direct-import dispatch is expected to satisfy this) |
| packages/mcp-server | packages/mcp-server/src/tools/registry-tools.live.content.ts | mcp-string-dispatch-unmatched | no case-string hit found in tool-dispatch.ts (defensive check — direct-import dispatch is expected to satisfy this) |
| packages/mcp-server | packages/mcp-server/src/tools/registry-tools.live.malformed-input.test.ts | mcp-string-dispatch-unmatched | no case-string hit found in tool-dispatch.ts (defensive check — direct-import dispatch is expected to satisfy this) |
| packages/mcp-server | packages/mcp-server/src/tools/registry-tools.live.manage.test.ts | mcp-string-dispatch-unmatched | no case-string hit found in tool-dispatch.ts (defensive check — direct-import dispatch is expected to satisfy this) |
| packages/mcp-server | packages/mcp-server/src/tools/registry-tools.live.member-reads.ts | mcp-string-dispatch-unmatched | no case-string hit found in tool-dispatch.ts (defensive check — direct-import dispatch is expected to satisfy this) |
| packages/mcp-server | packages/mcp-server/src/tools/registry-tools.live.reads.ts | mcp-string-dispatch-unmatched | no case-string hit found in tool-dispatch.ts (defensive check — direct-import dispatch is expected to satisfy this) |
| packages/mcp-server | packages/mcp-server/src/tools/registry-tools.live.review-decision.test.ts | mcp-string-dispatch-unmatched | no case-string hit found in tool-dispatch.ts (defensive check — direct-import dispatch is expected to satisfy this) |
| packages/mcp-server | packages/mcp-server/src/tools/registry-tools.live.review-rbac-widening.test.ts | mcp-string-dispatch-unmatched | no case-string hit found in tool-dispatch.ts (defensive check — direct-import dispatch is expected to satisfy this) |
| packages/mcp-server | packages/mcp-server/src/tools/registry-tools.live.submissions.ts | mcp-string-dispatch-unmatched | no case-string hit found in tool-dispatch.ts (defensive check — direct-import dispatch is expected to satisfy this) |
| packages/mcp-server | packages/mcp-server/src/tools/registry-tools.live.test-helpers.ts | mcp-string-dispatch-unmatched | no case-string hit found in tool-dispatch.ts (defensive check — direct-import dispatch is expected to satisfy this) |
| packages/mcp-server | packages/mcp-server/src/tools/registry-tools.live.test.ts | mcp-string-dispatch-unmatched | no case-string hit found in tool-dispatch.ts (defensive check — direct-import dispatch is expected to satisfy this) |
| packages/mcp-server | packages/mcp-server/src/tools/registry-tools.live.ts | mcp-string-dispatch-unmatched | no case-string hit found in tool-dispatch.ts (defensive check — direct-import dispatch is expected to satisfy this) |
| packages/mcp-server | packages/mcp-server/src/tools/registry-tools.review-action.test.ts | mcp-string-dispatch-unmatched | no case-string hit found in tool-dispatch.ts (defensive check — direct-import dispatch is expected to satisfy this) |
| packages/mcp-server | packages/mcp-server/src/tools/registry-tools.review-action.ts | mcp-string-dispatch-unmatched | no case-string hit found in tool-dispatch.ts (defensive check — direct-import dispatch is expected to satisfy this) |
| packages/mcp-server | packages/mcp-server/src/tools/registry-tools.review-parity.test.ts | mcp-string-dispatch-unmatched | no case-string hit found in tool-dispatch.ts (defensive check — direct-import dispatch is expected to satisfy this) |
| packages/mcp-server | packages/mcp-server/src/tools/registry-tools.review.types.ts | mcp-string-dispatch-unmatched | no case-string hit found in tool-dispatch.ts (defensive check — direct-import dispatch is expected to satisfy this) |
| packages/mcp-server | packages/mcp-server/src/tools/registry-tools.schemas.ts | mcp-string-dispatch-unmatched | no case-string hit found in tool-dispatch.ts (defensive check — direct-import dispatch is expected to satisfy this) |
| packages/mcp-server | packages/mcp-server/src/tools/registry-tools.skill-id.ts | mcp-string-dispatch-unmatched | no case-string hit found in tool-dispatch.ts (defensive check — direct-import dispatch is expected to satisfy this) |
| packages/mcp-server | packages/mcp-server/src/tools/registry-tools.stub.ts | mcp-string-dispatch-unmatched | no case-string hit found in tool-dispatch.ts (defensive check — direct-import dispatch is expected to satisfy this) |
| packages/mcp-server | packages/mcp-server/src/tools/registry-tools.submissions.test.ts | mcp-string-dispatch-unmatched | no case-string hit found in tool-dispatch.ts (defensive check — direct-import dispatch is expected to satisfy this) |
| packages/mcp-server | packages/mcp-server/src/tools/registry-tools.test.ts | mcp-string-dispatch-unmatched | no case-string hit found in tool-dispatch.ts (defensive check — direct-import dispatch is expected to satisfy this) |
| packages/mcp-server | packages/mcp-server/src/tools/registry-tools.ts | mcp-string-dispatch-unmatched | no case-string hit found in tool-dispatch.ts (defensive check — direct-import dispatch is expected to satisfy this) |
| packages/mcp-server | packages/mcp-server/src/tools/scan-coverage.format.ts | mcp-string-dispatch-unmatched | no case-string hit found in tool-dispatch.ts (defensive check — direct-import dispatch is expected to satisfy this) |
| packages/mcp-server | packages/mcp-server/src/tools/search.formatter.test.ts | mcp-string-dispatch-unmatched | no case-string hit found in tool-dispatch.ts (defensive check — direct-import dispatch is expected to satisfy this) |
| packages/mcp-server | packages/mcp-server/src/tools/search.formatter.ts | mcp-string-dispatch-unmatched | no case-string hit found in tool-dispatch.ts (defensive check — direct-import dispatch is expected to satisfy this) |
| packages/mcp-server | packages/mcp-server/src/tools/search.helpers.test.ts | mcp-string-dispatch-unmatched | no case-string hit found in tool-dispatch.ts (defensive check — direct-import dispatch is expected to satisfy this) |
| packages/mcp-server | packages/mcp-server/src/tools/search.helpers.ts | mcp-string-dispatch-unmatched | no case-string hit found in tool-dispatch.ts (defensive check — direct-import dispatch is expected to satisfy this) |
| packages/mcp-server | packages/mcp-server/src/tools/search.schema.ts | mcp-string-dispatch-unmatched | no case-string hit found in tool-dispatch.ts (defensive check — direct-import dispatch is expected to satisfy this) |
| packages/mcp-server | packages/mcp-server/src/tools/skill-audit.test.ts | mcp-string-dispatch-unmatched | no case-string hit found in tool-dispatch.ts (defensive check — direct-import dispatch is expected to satisfy this) |
| packages/mcp-server | packages/mcp-server/src/tools/skill-audit.ts | mcp-string-dispatch-unmatched | no case-string hit found in tool-dispatch.ts (defensive check — direct-import dispatch is expected to satisfy this) |
| packages/mcp-server | packages/mcp-server/src/tools/skill-diff.test.ts | mcp-string-dispatch-unmatched | no case-string hit found in tool-dispatch.ts (defensive check — direct-import dispatch is expected to satisfy this) |
| packages/mcp-server | packages/mcp-server/src/tools/skill-diff.ts | mcp-string-dispatch-unmatched | no case-string hit found in tool-dispatch.ts (defensive check — direct-import dispatch is expected to satisfy this) |
| packages/mcp-server | packages/mcp-server/src/tools/skill-inventory-audit.ts | mcp-string-dispatch-unmatched | no case-string hit found in tool-dispatch.ts (defensive check — direct-import dispatch is expected to satisfy this) |
| packages/mcp-server | packages/mcp-server/src/tools/skill-inventory-audit.types.ts | mcp-string-dispatch-unmatched | no case-string hit found in tool-dispatch.ts (defensive check — direct-import dispatch is expected to satisfy this) |
| packages/mcp-server | packages/mcp-server/src/tools/skill-pack-audit.helpers.ts | mcp-string-dispatch-unmatched | no case-string hit found in tool-dispatch.ts (defensive check — direct-import dispatch is expected to satisfy this) |
| packages/mcp-server | packages/mcp-server/src/tools/skill-pack-audit.ts | mcp-string-dispatch-unmatched | no case-string hit found in tool-dispatch.ts (defensive check — direct-import dispatch is expected to satisfy this) |
| packages/mcp-server | packages/mcp-server/src/tools/skill-pack-audit.types.ts | mcp-string-dispatch-unmatched | no case-string hit found in tool-dispatch.ts (defensive check — direct-import dispatch is expected to satisfy this) |
| packages/mcp-server | packages/mcp-server/src/tools/skill-recover-source.test.ts | mcp-string-dispatch-unmatched | no case-string hit found in tool-dispatch.ts (defensive check — direct-import dispatch is expected to satisfy this) |
| packages/mcp-server | packages/mcp-server/src/tools/skill-recover-source.ts | mcp-string-dispatch-unmatched | no case-string hit found in tool-dispatch.ts (defensive check — direct-import dispatch is expected to satisfy this) |
| packages/mcp-server | packages/mcp-server/src/tools/skill-recover-source.types.ts | mcp-string-dispatch-unmatched | no case-string hit found in tool-dispatch.ts (defensive check — direct-import dispatch is expected to satisfy this) |
| packages/mcp-server | packages/mcp-server/src/tools/skill-rescan.helpers.ts | mcp-string-dispatch-unmatched | no case-string hit found in tool-dispatch.ts (defensive check — direct-import dispatch is expected to satisfy this) |
| packages/mcp-server | packages/mcp-server/src/tools/skill-rescan.test.ts | mcp-string-dispatch-unmatched | no case-string hit found in tool-dispatch.ts (defensive check — direct-import dispatch is expected to satisfy this) |
| packages/mcp-server | packages/mcp-server/src/tools/skill-rescan.ts | mcp-string-dispatch-unmatched | no case-string hit found in tool-dispatch.ts (defensive check — direct-import dispatch is expected to satisfy this) |
| packages/mcp-server | packages/mcp-server/src/tools/skill-updates.test.ts | mcp-string-dispatch-unmatched | no case-string hit found in tool-dispatch.ts (defensive check — direct-import dispatch is expected to satisfy this) |
| packages/mcp-server | packages/mcp-server/src/tools/skill-updates.ts | mcp-string-dispatch-unmatched | no case-string hit found in tool-dispatch.ts (defensive check — direct-import dispatch is expected to satisfy this) |
| packages/mcp-server | packages/mcp-server/src/tools/sso-tools.action.ts | mcp-string-dispatch-unmatched | no case-string hit found in tool-dispatch.ts (defensive check — direct-import dispatch is expected to satisfy this) |
| packages/mcp-server | packages/mcp-server/src/tools/sso-tools.live.auth.ts | mcp-string-dispatch-unmatched | no case-string hit found in tool-dispatch.ts (defensive check — direct-import dispatch is expected to satisfy this) |
| packages/mcp-server | packages/mcp-server/src/tools/sso-tools.live.errors.ts | mcp-string-dispatch-unmatched | no case-string hit found in tool-dispatch.ts (defensive check — direct-import dispatch is expected to satisfy this) |
| packages/mcp-server | packages/mcp-server/src/tools/sso-tools.live.test.ts | mcp-string-dispatch-unmatched | no case-string hit found in tool-dispatch.ts (defensive check — direct-import dispatch is expected to satisfy this) |
| packages/mcp-server | packages/mcp-server/src/tools/sso-tools.live.ts | mcp-string-dispatch-unmatched | no case-string hit found in tool-dispatch.ts (defensive check — direct-import dispatch is expected to satisfy this) |
| packages/mcp-server | packages/mcp-server/src/tools/sso-tools.stub.ts | mcp-string-dispatch-unmatched | no case-string hit found in tool-dispatch.ts (defensive check — direct-import dispatch is expected to satisfy this) |
| packages/mcp-server | packages/mcp-server/src/tools/sso-tools.test.ts | mcp-string-dispatch-unmatched | no case-string hit found in tool-dispatch.ts (defensive check — direct-import dispatch is expected to satisfy this) |
| packages/mcp-server | packages/mcp-server/src/tools/sso-tools.ts | mcp-string-dispatch-unmatched | no case-string hit found in tool-dispatch.ts (defensive check — direct-import dispatch is expected to satisfy this) |
| packages/mcp-server | packages/mcp-server/src/tools/sso-tools.types.ts | mcp-string-dispatch-unmatched | no case-string hit found in tool-dispatch.ts (defensive check — direct-import dispatch is expected to satisfy this) |
| packages/mcp-server | packages/mcp-server/src/tools/stub-data-source.ts | mcp-string-dispatch-unmatched | no case-string hit found in tool-dispatch.ts (defensive check — direct-import dispatch is expected to satisfy this) |
| packages/mcp-server | packages/mcp-server/src/tools/team-permission-error.ts | mcp-string-dispatch-unmatched | no case-string hit found in tool-dispatch.ts (defensive check — direct-import dispatch is expected to satisfy this) |
| packages/mcp-server | packages/mcp-server/src/tools/team-resolver.test.ts | mcp-string-dispatch-unmatched | no case-string hit found in tool-dispatch.ts (defensive check — direct-import dispatch is expected to satisfy this) |
| packages/mcp-server | packages/mcp-server/src/tools/team-resolver.ts | mcp-string-dispatch-unmatched | no case-string hit found in tool-dispatch.ts (defensive check — direct-import dispatch is expected to satisfy this) |
| packages/mcp-server | packages/mcp-server/src/tools/team-workspace.live.test.ts | mcp-string-dispatch-unmatched | no case-string hit found in tool-dispatch.ts (defensive check — direct-import dispatch is expected to satisfy this) |
| packages/mcp-server | packages/mcp-server/src/tools/team-workspace.live.ts | mcp-string-dispatch-unmatched | no case-string hit found in tool-dispatch.ts (defensive check — direct-import dispatch is expected to satisfy this) |
| packages/mcp-server | packages/mcp-server/src/tools/team-workspace.stub.ts | mcp-string-dispatch-unmatched | no case-string hit found in tool-dispatch.ts (defensive check — direct-import dispatch is expected to satisfy this) |
| packages/mcp-server | packages/mcp-server/src/tools/team-workspace.test.ts | mcp-string-dispatch-unmatched | no case-string hit found in tool-dispatch.ts (defensive check — direct-import dispatch is expected to satisfy this) |
| packages/mcp-server | packages/mcp-server/src/tools/team-workspace.ts | mcp-string-dispatch-unmatched | no case-string hit found in tool-dispatch.ts (defensive check — direct-import dispatch is expected to satisfy this) |
| packages/mcp-server | packages/mcp-server/src/tools/undo-apply.ts | mcp-string-dispatch-unmatched | no case-string hit found in tool-dispatch.ts (defensive check — direct-import dispatch is expected to satisfy this) |
| packages/mcp-server | packages/mcp-server/src/tools/undo-apply.types.ts | mcp-string-dispatch-unmatched | no case-string hit found in tool-dispatch.ts (defensive check — direct-import dispatch is expected to satisfy this) |
| packages/mcp-server | packages/mcp-server/src/tools/validate-bundled-scan.ts | mcp-string-dispatch-unmatched | no case-string hit found in tool-dispatch.ts (defensive check — direct-import dispatch is expected to satisfy this) |
| packages/mcp-server | packages/mcp-server/src/tools/validate-typosquat-scan.ts | mcp-string-dispatch-unmatched | no case-string hit found in tool-dispatch.ts (defensive check — direct-import dispatch is expected to satisfy this) |
| packages/mcp-server | packages/mcp-server/src/tools/validate.dep.test.ts | mcp-string-dispatch-unmatched | no case-string hit found in tool-dispatch.ts (defensive check — direct-import dispatch is expected to satisfy this) |
| packages/mcp-server | packages/mcp-server/src/tools/validate.helpers.ts | mcp-string-dispatch-unmatched | no case-string hit found in tool-dispatch.ts (defensive check — direct-import dispatch is expected to satisfy this) |
| packages/mcp-server | packages/mcp-server/src/tools/validate.types.ts | mcp-string-dispatch-unmatched | no case-string hit found in tool-dispatch.ts (defensive check — direct-import dispatch is expected to satisfy this) |

## Needs runtime verification — insufficient evidence (171)

Not a verdict. Never promoted to Safe-to-delete on missing data. See patterns/README.md Bucket 4.

| workspace | file | category | name | line | reason |
|---|---|---|---|---|---|
| packages/mcp-server | packages/mcp-server/src/core-shim.ts | files |  |  | workspace is EXPERIMENTAL (uncalibrated) |
| packages/mcp-server | packages/mcp-server/src/context/index.ts | files |  |  | workspace is EXPERIMENTAL (uncalibrated) |
| packages/mcp-server | packages/mcp-server/src/indexer/index.ts | files |  |  | workspace is EXPERIMENTAL (uncalibrated) |
| packages/mcp-server | packages/mcp-server/src/middleware/degradation.ts | files |  |  | workspace is EXPERIMENTAL (uncalibrated) |
| packages/mcp-server | packages/mcp-server/src/middleware/index.ts | files |  |  | workspace is EXPERIMENTAL (uncalibrated) |
| packages/mcp-server | packages/mcp-server/src/onboarding/index.ts | files |  |  | workspace is EXPERIMENTAL (uncalibrated) |
| packages/mcp-server | packages/mcp-server/src/suggestions/index.ts | files |  |  | workspace is EXPERIMENTAL (uncalibrated) |
| packages/mcp-server | packages/mcp-server/src/tools/install.optimize.ts | files |  |  | workspace is EXPERIMENTAL (uncalibrated) |
| packages/mcp-server | packages/mcp-server/src/webhooks/index.ts | files |  |  | workspace is EXPERIMENTAL (uncalibrated) |
| packages/mcp-server | packages/mcp-server/tests/unit/agent-pack.conformance.test.ts | unlisted | smol-toml | 20 | workspace is EXPERIMENTAL (uncalibrated) |
| packages/mcp-server | packages/mcp-server/tests/unit/agent-pack.conformance.test.ts | unlisted | yaml | 21 | workspace is EXPERIMENTAL (uncalibrated) |
| packages/mcp-server | packages/mcp-server/src/context.ts | exports | ensureDbDirectory | 56 | workspace is EXPERIMENTAL (uncalibrated) |
| packages/mcp-server | packages/mcp-server/src/context.ts | exports | resetToolContext | 330 | workspace is EXPERIMENTAL (uncalibrated) |
| packages/mcp-server | packages/mcp-server/src/context.ts | types | TelemetryConfig | 50 | workspace is EXPERIMENTAL (uncalibrated) |
| packages/mcp-server | packages/mcp-server/src/context.ts | types | BackgroundSyncConfig | 51 | workspace is EXPERIMENTAL (uncalibrated) |
| packages/mcp-server | packages/mcp-server/src/tools/get-skill.ts | exports | getSkillInputSchema | 50 | workspace is EXPERIMENTAL (uncalibrated) |
| packages/mcp-server | packages/mcp-server/src/tools/uninstall.ts | exports | default | 263 | workspace is EXPERIMENTAL (uncalibrated) |
| packages/mcp-server | packages/mcp-server/src/tools/suggest.ts | exports | formatSuggestions | 363 | workspace is EXPERIMENTAL (uncalibrated) |
| packages/mcp-server | packages/mcp-server/src/tools/suggest.ts | types | SkillSuggestion | 66 | workspace is EXPERIMENTAL (uncalibrated) |
| packages/mcp-server | packages/mcp-server/src/tools/analytics.ts | exports | periodDays | 27 | workspace is EXPERIMENTAL (uncalibrated) |
| packages/mcp-server | packages/mcp-server/src/tools/analytics.ts | exports | generateDailyTrend | 27 | workspace is EXPERIMENTAL (uncalibrated) |
| packages/mcp-server | packages/mcp-server/src/tools/sso-tools.ts | exports | getSSOConfigService | 168 | workspace is EXPERIMENTAL (uncalibrated) |
| packages/mcp-server | packages/mcp-server/src/tools/sso-tools.ts | types | SSOConfig | 34 | workspace is EXPERIMENTAL (uncalibrated) |
| packages/mcp-server | packages/mcp-server/src/tools/sso-tools.ts | types | SSOConfigService | 35 | workspace is EXPERIMENTAL (uncalibrated) |
| packages/mcp-server | packages/mcp-server/src/tools/sso-tools.ts | types | SsoDomainClaim | 36 | workspace is EXPERIMENTAL (uncalibrated) |
| packages/mcp-server | packages/mcp-server/src/tools/sso-tools.ts | types | SsoDomainVerification | 37 | workspace is EXPERIMENTAL (uncalibrated) |
| packages/mcp-server | packages/mcp-server/src/tools/sso-tools.ts | types | ConfigureSsoResult | 165 | workspace is EXPERIMENTAL (uncalibrated) |
| packages/mcp-server | packages/mcp-server/src/tools/sso-tools.ts | types | SsoSettingsResult | 165 | workspace is EXPERIMENTAL (uncalibrated) |
| packages/mcp-server | packages/mcp-server/src/tools/registry-tools.ts | exports | skillContentSchema | 62 | workspace is EXPERIMENTAL (uncalibrated) |
| packages/mcp-server | packages/mcp-server/src/tools/registry-tools.ts | exports | getPrivateRegistryService | 206 | workspace is EXPERIMENTAL (uncalibrated) |
| packages/mcp-server | packages/mcp-server/src/tools/registry-tools.ts | types | StubActor | 53 | workspace is EXPERIMENTAL (uncalibrated) |
| packages/mcp-server | packages/mcp-server/src/tools/rbac-tools.ts | exports | getRBACService | 71 | workspace is EXPERIMENTAL (uncalibrated) |
| packages/mcp-server | packages/mcp-server/src/tools/rbac-tools.ts | types | EffectivePermission | 31 | workspace is EXPERIMENTAL (uncalibrated) |
| packages/mcp-server | packages/mcp-server/src/tools/rbac-tools.ts | types | GrantableRole | 32 | workspace is EXPERIMENTAL (uncalibrated) |
| packages/mcp-server | packages/mcp-server/src/tools/rbac-tools.ts | types | PermissionEffect | 33 | workspace is EXPERIMENTAL (uncalibrated) |
| packages/mcp-server | packages/mcp-server/src/tools/rbac-tools.ts | types | PermissionSource | 34 | workspace is EXPERIMENTAL (uncalibrated) |
| packages/mcp-server | packages/mcp-server/src/tools/rbac-tools.ts | types | RBACService | 35 | workspace is EXPERIMENTAL (uncalibrated) |
| packages/mcp-server | packages/mcp-server/src/tools/rbac-tools.ts | types | RbacAssignRoleResult | 36 | workspace is EXPERIMENTAL (uncalibrated) |
| packages/mcp-server | packages/mcp-server/src/tools/rbac-tools.ts | types | RbacCreatePolicyPermissionOutcome | 37 | workspace is EXPERIMENTAL (uncalibrated) |
| packages/mcp-server | packages/mcp-server/src/tools/rbac-tools.ts | types | RbacCreatePolicyResult | 38 | workspace is EXPERIMENTAL (uncalibrated) |
| packages/mcp-server | packages/mcp-server/src/tools/rbac-tools.ts | types | RbacManageResult | 39 | workspace is EXPERIMENTAL (uncalibrated) |
| packages/mcp-server | packages/mcp-server/src/tools/rbac-tools.ts | types | RbacToolError | 40 | workspace is EXPERIMENTAL (uncalibrated) |
| packages/mcp-server | packages/mcp-server/src/tools/rbac-tools.ts | types | RolePermissionsView | 41 | workspace is EXPERIMENTAL (uncalibrated) |
| packages/mcp-server | packages/mcp-server/src/tools/rbac-tools.ts | types | TeamMemberAssignment | 42 | workspace is EXPERIMENTAL (uncalibrated) |
| packages/mcp-server | packages/mcp-server/src/tools/rbac-tools.ts | types | TeamMemberRole | 43 | workspace is EXPERIMENTAL (uncalibrated) |
| packages/mcp-server | packages/mcp-server/src/tools/rbac-tools.ts | types | TeamPermission | 44 | workspace is EXPERIMENTAL (uncalibrated) |
| packages/mcp-server | packages/mcp-server/src/tools/rbac-tools.ts | types | RbacManageInput | 60 | workspace is EXPERIMENTAL (uncalibrated) |
| packages/mcp-server | packages/mcp-server/src/tools/rbac-tools.ts | types | RbacAssignRoleInput | 61 | workspace is EXPERIMENTAL (uncalibrated) |
| packages/mcp-server | packages/mcp-server/src/tools/rbac-tools.ts | types | RbacCreatePolicyInput | 62 | workspace is EXPERIMENTAL (uncalibrated) |
| packages/mcp-server | packages/mcp-server/src/middleware/license.ts | exports | createProfileIncompleteResponse | 489 | workspace is EXPERIMENTAL (uncalibrated) |
| packages/mcp-server | packages/mcp-server/src/middleware/license.ts | exports | createTierResolver | 494 | workspace is EXPERIMENTAL (uncalibrated) |
| packages/mcp-server | packages/mcp-server/src/middleware/license.ts | exports | createSessionTokenResolver | 494 | workspace is EXPERIMENTAL (uncalibrated) |
| packages/mcp-server | packages/mcp-server/src/middleware/toolProfile.ts | exports | AGENT_TOOL_PROFILE_VALUE | 37 | workspace is EXPERIMENTAL (uncalibrated) |
| packages/mcp-server | packages/mcp-server/src/webhooks/stripe-webhook-endpoint.ts | exports | createStripeWebhookServer | 109 | workspace is EXPERIMENTAL (uncalibrated) |
| packages/mcp-server | packages/mcp-server/src/webhooks/stripe-webhook-endpoint.ts | exports | startStripeWebhookServer | 261 | workspace is EXPERIMENTAL (uncalibrated) |
| packages/mcp-server | packages/mcp-server/src/webhooks/stripe-webhook-endpoint.ts | exports | main | 310 | workspace is EXPERIMENTAL (uncalibrated) |
| packages/mcp-server | packages/mcp-server/src/webhooks/stripe-webhook-endpoint.ts | types | StripeWebhookServerConfig | 57 | workspace is EXPERIMENTAL (uncalibrated) |
| packages/mcp-server | packages/mcp-server/src/webhooks/stripe-webhook-endpoint.ts | types | StripeWebhookServerOptions | 84 | workspace is EXPERIMENTAL (uncalibrated) |
| packages/mcp-server | packages/mcp-server/src/audit/framework-adapter.ts | exports | newAuditId | 325 | workspace is EXPERIMENTAL (uncalibrated) |
| packages/mcp-server | packages/mcp-server/src/audit/framework-adapter.ts | types | FileRenameAction | 326 | workspace is EXPERIMENTAL (uncalibrated) |
| packages/mcp-server | packages/mcp-server/src/audit/framework-adapter.ts | types | InlineEditAction | 326 | workspace is EXPERIMENTAL (uncalibrated) |
| packages/mcp-server | packages/mcp-server/src/health/healthCheck.ts | exports | getHealthCheck | 126 | workspace is EXPERIMENTAL (uncalibrated) |
| packages/mcp-server | packages/mcp-server/src/health/readinessCheck.ts | exports | getReadinessCheck | 310 | workspace is EXPERIMENTAL (uncalibrated) |
| packages/mcp-server | packages/mcp-server/src/health/readinessCheck.ts | exports | configureReadinessCheck | 334 | workspace is EXPERIMENTAL (uncalibrated) |
| packages/mcp-server | packages/mcp-server/src/health/index.ts | exports | HealthCheck | 11 | workspace is EXPERIMENTAL (uncalibrated) |
| packages/mcp-server | packages/mcp-server/src/health/index.ts | exports | getHealthCheck | 12 | workspace is EXPERIMENTAL (uncalibrated) |
| packages/mcp-server | packages/mcp-server/src/health/index.ts | exports | createHealthCheck | 13 | workspace is EXPERIMENTAL (uncalibrated) |
| packages/mcp-server | packages/mcp-server/src/health/index.ts | exports | checkHealth | 14 | workspace is EXPERIMENTAL (uncalibrated) |
| packages/mcp-server | packages/mcp-server/src/health/index.ts | exports | formatHealthResponse | 15 | workspace is EXPERIMENTAL (uncalibrated) |
| packages/mcp-server | packages/mcp-server/src/health/index.ts | exports | ReadinessCheck | 22 | workspace is EXPERIMENTAL (uncalibrated) |
| packages/mcp-server | packages/mcp-server/src/health/index.ts | exports | getReadinessCheck | 23 | workspace is EXPERIMENTAL (uncalibrated) |
| packages/mcp-server | packages/mcp-server/src/health/index.ts | exports | createReadinessCheck | 24 | workspace is EXPERIMENTAL (uncalibrated) |
| packages/mcp-server | packages/mcp-server/src/health/index.ts | exports | checkReadiness | 25 | workspace is EXPERIMENTAL (uncalibrated) |
| packages/mcp-server | packages/mcp-server/src/health/index.ts | exports | configureReadinessCheck | 26 | workspace is EXPERIMENTAL (uncalibrated) |
| packages/mcp-server | packages/mcp-server/src/health/index.ts | exports | formatReadinessResponse | 27 | workspace is EXPERIMENTAL (uncalibrated) |
| packages/mcp-server | packages/mcp-server/src/health/index.ts | types | HealthResponse | 16 | workspace is EXPERIMENTAL (uncalibrated) |
| packages/mcp-server | packages/mcp-server/src/health/index.ts | types | HealthCheckConfig | 17 | workspace is EXPERIMENTAL (uncalibrated) |
| packages/mcp-server | packages/mcp-server/src/health/index.ts | types | ReadinessResponse | 28 | workspace is EXPERIMENTAL (uncalibrated) |
| packages/mcp-server | packages/mcp-server/src/health/index.ts | types | ReadinessCheckConfig | 29 | workspace is EXPERIMENTAL (uncalibrated) |
| packages/mcp-server | packages/mcp-server/src/health/index.ts | types | DependencyCheck | 30 | workspace is EXPERIMENTAL (uncalibrated) |
| packages/mcp-server | packages/mcp-server/src/tools/recommend.types.ts | exports | skillRoleSchema | 21 | workspace is EXPERIMENTAL (uncalibrated) |
| packages/mcp-server | packages/mcp-server/src/tools/install.types.ts | exports | VALID_TRUST_TIERS | 35 | workspace is EXPERIMENTAL (uncalibrated) |
| packages/mcp-server | packages/mcp-server/src/tools/install.types.ts | exports | TRUST_TIER_SCANNER_OPTIONS | 82 | workspace is EXPERIMENTAL (uncalibrated) |
| packages/mcp-server | packages/mcp-server/src/tools/install.types.ts | types | OptimizationInfo | 311 | workspace is EXPERIMENTAL (uncalibrated) |
| packages/mcp-server | packages/mcp-server/src/tools/install.types.ts | types | ParsedRepoUrl | 383 | workspace is EXPERIMENTAL (uncalibrated) |
| packages/mcp-server | packages/mcp-server/src/tools/skill-inventory-audit.ts | exports | skillInventoryAuditInputSchema | 43 | workspace is EXPERIMENTAL (uncalibrated) |
| packages/mcp-server | packages/mcp-server/src/tools/skill-inventory-audit.ts | types | SkillInventoryAuditValidatedInput | 59 | workspace is EXPERIMENTAL (uncalibrated) |
| packages/mcp-server | packages/mcp-server/src/tools/skill-inventory-audit.ts | types | SkillInventoryAuditInput | 180 | workspace is EXPERIMENTAL (uncalibrated) |
| packages/mcp-server | packages/mcp-server/src/tools/apply-recommended-edit.ts | exports | applyRecommendedEditInputSchema | 47 | workspace is EXPERIMENTAL (uncalibrated) |
| packages/mcp-server | packages/mcp-server/src/utils/local-inventory.helpers.ts | exports | lookupAuthor | 332 | workspace is EXPERIMENTAL (uncalibrated) |
| packages/mcp-server | packages/mcp-server/src/utils/local-inventory.helpers.ts | exports | joinPath | 385 | workspace is EXPERIMENTAL (uncalibrated) |
| packages/mcp-server | packages/mcp-server/src/tools/recommend.helpers.ts | exports | transformSkillToMatchData | 254 | workspace is EXPERIMENTAL (uncalibrated) |
| packages/mcp-server | packages/mcp-server/src/tools/undo-apply.ts | exports | undoApplyInputSchema | 51 | workspace is EXPERIMENTAL (uncalibrated) |
| packages/mcp-server | packages/mcp-server/src/webhooks/webhook-endpoint.ts | exports | createWebhookServer | 125 | workspace is EXPERIMENTAL (uncalibrated) |
| packages/mcp-server | packages/mcp-server/src/webhooks/webhook-endpoint.ts | exports | startWebhookServer | 268 | workspace is EXPERIMENTAL (uncalibrated) |
| packages/mcp-server | packages/mcp-server/src/webhooks/webhook-endpoint.ts | exports | stopWebhookServer | 286 | workspace is EXPERIMENTAL (uncalibrated) |
| packages/mcp-server | packages/mcp-server/src/webhooks/webhook-endpoint.ts | exports | main | 334 | workspace is EXPERIMENTAL (uncalibrated) |
| packages/mcp-server | packages/mcp-server/src/webhooks/webhook-endpoint.ts | types | WebhookServerOptions | 51 | workspace is EXPERIMENTAL (uncalibrated) |
| packages/mcp-server | packages/mcp-server/src/webhooks/webhook-endpoint.ts | types | ServerStartOptions | 90 | workspace is EXPERIMENTAL (uncalibrated) |
| packages/mcp-server | packages/mcp-server/src/supabase-client.ts | exports | resetSupabaseClients | 150 | workspace is EXPERIMENTAL (uncalibrated) |
| packages/mcp-server | packages/mcp-server/src/audit/security-audit.acceptance.test-helpers.ts | exports | ZERO_BREAKDOWN | 23 | workspace is EXPERIMENTAL (uncalibrated) |
| packages/mcp-server | packages/mcp-server/src/tools/team-permission-error.ts | exports | PERMISSION_DENIED_CODE | 36 | workspace is EXPERIMENTAL (uncalibrated) |
| packages/mcp-server | packages/mcp-server/src/tools/team-permission-error.ts | types | PermissionDeniedResult | 52 | workspace is EXPERIMENTAL (uncalibrated) |
| packages/mcp-server | packages/mcp-server/src/tools/sso-tools.live.ts | exports | SsoAuthError | 66 | workspace is EXPERIMENTAL (uncalibrated) |
| packages/mcp-server | packages/mcp-server/src/tools/sso-tools.live.ts | exports | SsoValidationError | 67 | workspace is EXPERIMENTAL (uncalibrated) |
| packages/mcp-server | packages/mcp-server/src/tools/sso-tools.live.ts | exports | SsoDomainClaimedByAnotherTeamError | 69 | workspace is EXPERIMENTAL (uncalibrated) |
| packages/mcp-server | packages/mcp-server/src/tools/sso-tools.live.ts | exports | SsoDomainVerificationFailedError | 70 | workspace is EXPERIMENTAL (uncalibrated) |
| packages/mcp-server | packages/mcp-server/src/tools/sso-tools.live.ts | exports | SsoDomainNotClaimedError | 71 | workspace is EXPERIMENTAL (uncalibrated) |
| packages/mcp-server | packages/mcp-server/src/tools/sso-tools.live.ts | exports | SsoExpireUnavailableError | 72 | workspace is EXPERIMENTAL (uncalibrated) |
| packages/mcp-server | packages/mcp-server/src/tools/sso-tools.live.ts | exports | SsoServiceUnavailableError | 73 | workspace is EXPERIMENTAL (uncalibrated) |
| packages/mcp-server | packages/mcp-server/src/middleware/errorFormatter.ts | exports | ERROR_MESSAGES | 18 | workspace is EXPERIMENTAL (uncalibrated) |
| packages/mcp-server | packages/mcp-server/src/middleware/errorFormatter.ts | exports | DEFAULT_UPGRADE_URL_CONFIG | 18 | workspace is EXPERIMENTAL (uncalibrated) |
| packages/mcp-server | packages/mcp-server/src/middleware/errorFormatter.ts | exports | formatAuthenticationError | 26 | workspace is EXPERIMENTAL (uncalibrated) |
| packages/mcp-server | packages/mcp-server/src/middleware/errorFormatter.ts | exports | isAuthenticationError | 27 | workspace is EXPERIMENTAL (uncalibrated) |
| packages/mcp-server | packages/mcp-server/src/middleware/errorFormatter.ts | exports | extractAuthErrorDetails | 28 | workspace is EXPERIMENTAL (uncalibrated) |
| packages/mcp-server | packages/mcp-server/src/middleware/errorFormatter.ts | types | MCPErrorContent | 11 | workspace is EXPERIMENTAL (uncalibrated) |
| packages/mcp-server | packages/mcp-server/src/middleware/errorFormatter.ts | types | LicenseErrorDetails | 13 | workspace is EXPERIMENTAL (uncalibrated) |
| packages/mcp-server | packages/mcp-server/src/middleware/errorFormatter.ts | types | UpgradeUrlConfig | 15 | workspace is EXPERIMENTAL (uncalibrated) |
| packages/mcp-server | packages/mcp-server/src/middleware/errorFormatter.ts | types | ApiAuthErrorDetails | 16 | workspace is EXPERIMENTAL (uncalibrated) |
| packages/mcp-server | packages/mcp-server/src/tools/analytics.stub.ts | exports | generateDailyTrend | 30 | workspace is EXPERIMENTAL (uncalibrated) |
| packages/mcp-server | packages/mcp-server/src/tools/sso-tools.action.ts | exports | getSSOConfigService | 60 | workspace is EXPERIMENTAL (uncalibrated) |
| packages/mcp-server | packages/mcp-server/src/tools/registry-tools.schemas.ts | exports | skillContentSchema | 37 | workspace is EXPERIMENTAL (uncalibrated) |
| packages/mcp-server | packages/mcp-server/src/tools/rbac-tools.action.ts | exports | getRBACService | 70 | workspace is EXPERIMENTAL (uncalibrated) |
| packages/mcp-server | packages/mcp-server/src/tools/stub-data-source.ts | exports | isStubService | 30 | workspace is EXPERIMENTAL (uncalibrated) |
| packages/mcp-server | packages/mcp-server/src/audit/collision-detector.helpers.ts | exports | LOCAL_INVENTORY_PACK_NAME | 27 | workspace is EXPERIMENTAL (uncalibrated) |
| packages/mcp-server | packages/mcp-server/src/audit/collision-detector.helpers.ts | exports | normalizeIdentifier | 34 | workspace is EXPERIMENTAL (uncalibrated) |
| packages/mcp-server | packages/mcp-server/src/audit/collision-detector.helpers.ts | exports | groupByIdentifier | 42 | workspace is EXPERIMENTAL (uncalibrated) |
| packages/mcp-server | packages/mcp-server/src/audit/collision-detector.semantic.helpers.ts | exports | inventoryToTriggerPhraseSkill | 40 | workspace is EXPERIMENTAL (uncalibrated) |
| packages/mcp-server | packages/mcp-server/src/utils/local-inventory.path-safety.helpers.ts | exports | joinPath | 19 | workspace is EXPERIMENTAL (uncalibrated) |
| packages/mcp-server | packages/mcp-server/src/tools/registry-tools.live.audit.ts | exports | licenseKeyFingerprint | 152 | workspace is EXPERIMENTAL (uncalibrated) |
| packages/mcp-server | packages/mcp-server/src/tools/registry-tools.live.audit.ts | types | RegistryAuditOperation | 83 | workspace is EXPERIMENTAL (uncalibrated) |
| packages/mcp-server | packages/mcp-server/src/tools/registry-tools.live.audit.ts | types | RegistryAuditAuthPath | 99 | workspace is EXPERIMENTAL (uncalibrated) |
| packages/mcp-server | packages/mcp-server/src/tools/registry-tools.live.content.ts | exports | isTeamEnterpriseEntitled | 91 | workspace is EXPERIMENTAL (uncalibrated) |
| packages/mcp-server | packages/mcp-server/src/tools/scan-coverage.format.ts | exports | formatScanCoverageNote | 28 | workspace is EXPERIMENTAL (uncalibrated) |
| packages/mcp-server | packages/mcp-server/src/middleware/errorFormatter.types.ts | exports | ERROR_MESSAGES | 109 | workspace is EXPERIMENTAL (uncalibrated) |
| packages/mcp-server | packages/mcp-server/src/middleware/errorFormatter.types.ts | types | MCPErrorContent | 15 | workspace is EXPERIMENTAL (uncalibrated) |
| packages/mcp-server | packages/mcp-server/src/tools/skill-pack-audit.ts | types | PackSkillStatus | 71 | workspace is EXPERIMENTAL (uncalibrated) |
| packages/mcp-server | packages/mcp-server/src/tools/skill-pack-audit.ts | types | PackSkillEntry | 81 | workspace is EXPERIMENTAL (uncalibrated) |
| packages/mcp-server | packages/mcp-server/src/tools/compliance-tools.ts | types | AuditSummary | 120 | workspace is EXPERIMENTAL (uncalibrated) |
| packages/mcp-server | packages/mcp-server/src/tools/compliance-tools.ts | types | UserActivitySummary | 129 | workspace is EXPERIMENTAL (uncalibrated) |
| packages/mcp-server | packages/mcp-server/src/middleware/quota.ts | types | QuotaCheckResult | 32 | workspace is EXPERIMENTAL (uncalibrated) |
| packages/mcp-server | packages/mcp-server/src/middleware/quota.ts | types | QuotaMetadata | 33 | workspace is EXPERIMENTAL (uncalibrated) |
| packages/mcp-server | packages/mcp-server/src/middleware/quota.ts | types | WarningLevel | 37 | workspace is EXPERIMENTAL (uncalibrated) |
| packages/mcp-server | packages/mcp-server/src/audit/collision-detector.ts | types | ExactCollisionFlag | 234 | workspace is EXPERIMENTAL (uncalibrated) |
| packages/mcp-server | packages/mcp-server/src/audit/collision-detector.ts | types | GenericTokenFlag | 235 | workspace is EXPERIMENTAL (uncalibrated) |
| packages/mcp-server | packages/mcp-server/src/audit/collision-detector.ts | types | SemanticCollisionFlag | 237 | workspace is EXPERIMENTAL (uncalibrated) |
| packages/mcp-server | packages/mcp-server/src/tools/install.helpers.ts | types | ParsedRepoUrl | 13 | workspace is EXPERIMENTAL (uncalibrated) |
| packages/mcp-server | packages/mcp-server/src/tools/install.helpers.ts | types | ModificationResult | 381 | workspace is EXPERIMENTAL (uncalibrated) |
| packages/mcp-server | packages/mcp-server/src/tools/apply-namespace-rename.types.ts | types | ApplyNamespaceRenameInput | 29 | workspace is EXPERIMENTAL (uncalibrated) |
| packages/mcp-server | packages/mcp-server/src/tools/apply-recommended-edit.types.ts | types | ApplyRecommendedEditInput | 25 | workspace is EXPERIMENTAL (uncalibrated) |
| packages/mcp-server | packages/mcp-server/src/middleware/first-run-welcome.ts | types | PendingWelcomeState | 53 | workspace is EXPERIMENTAL (uncalibrated) |
| packages/mcp-server | packages/mcp-server/src/audit/rename-engine.helpers.ts | types | FrontmatterRewriteError | 26 | workspace is EXPERIMENTAL (uncalibrated) |
| packages/mcp-server | packages/mcp-server/src/context.types.ts | types | TelemetryConfig | 55 | workspace is EXPERIMENTAL (uncalibrated) |
| packages/mcp-server | packages/mcp-server/src/context.types.ts | types | BackgroundSyncConfig | 75 | workspace is EXPERIMENTAL (uncalibrated) |
| packages/mcp-server | packages/mcp-server/src/tools/analytics.service.ts | types | AnalyticsData | 16 | workspace is EXPERIMENTAL (uncalibrated) |
| packages/mcp-server | packages/mcp-server/src/tools/analytics.service.ts | types | UsageReportData | 24 | workspace is EXPERIMENTAL (uncalibrated) |
| packages/mcp-server | packages/mcp-server/src/tools/analytics.supabase.service.ts | types | TopSkillRow | 25 | workspace is EXPERIMENTAL (uncalibrated) |
| packages/mcp-server | packages/mcp-server/src/tools/analytics.supabase.service.ts | types | StaleSkillRow | 45 | workspace is EXPERIMENTAL (uncalibrated) |
| packages/mcp-server | packages/mcp-server/src/tools/analytics.supabase.service.ts | types | CooccurrenceRow | 64 | workspace is EXPERIMENTAL (uncalibrated) |
| packages/mcp-server | packages/mcp-server/src/tools/rbac-tools.types.ts | types | RolePermissionsView | 145 | workspace is EXPERIMENTAL (uncalibrated) |
| packages/mcp-server | packages/mcp-server/src/tools/rbac-tools.stub.ts | types | StubRbacActor | 38 | workspace is EXPERIMENTAL (uncalibrated) |
| packages/mcp-server | packages/mcp-server/src/tools/registry-tools.live.ts | types | SupabaseError | 133 | workspace is EXPERIMENTAL (uncalibrated) |
| packages/mcp-server | packages/mcp-server/src/tools/registry-tools.live.ts | types | SupabaseQueryResult | 139 | workspace is EXPERIMENTAL (uncalibrated) |
| packages/mcp-server | packages/mcp-server/src/tools/registry-tools.live.ts | types | SupabaseTableQuery | 144 | workspace is EXPERIMENTAL (uncalibrated) |
| packages/mcp-server | packages/mcp-server/src/tools/skill-recover-source.ts | types | SkillRecoverSourceValidatedInput | 76 | workspace is EXPERIMENTAL (uncalibrated) |
| packages/mcp-server | packages/mcp-server/src/tools/registry-tools.stub.ts | types | StubActor | 115 | workspace is EXPERIMENTAL (uncalibrated) |
| packages/mcp-server | packages/mcp-server/src/tools/undo-apply.types.ts | types | UndoApplyInput | 9 | workspace is EXPERIMENTAL (uncalibrated) |
| packages/mcp-server | packages/mcp-server/src/tools/rbac-tools.live.auth.ts | types | RbacRpcResult | 138 | workspace is EXPERIMENTAL (uncalibrated) |
| packages/mcp-server | packages/mcp-server/src/tools/rbac-tools.live.auth.ts | types | RbacSupabaseClient | 143 | workspace is EXPERIMENTAL (uncalibrated) |
| packages/mcp-server | packages/mcp-server/src/tools/registry-tools.live.submissions.ts | types | PrivateRegistryReviewRow | 162 | workspace is EXPERIMENTAL (uncalibrated) |
| packages/mcp-server | packages/mcp-server/src/tools/skill-recover-source.types.ts | types | SkillRecoverSourceInput | 13 | workspace is EXPERIMENTAL (uncalibrated) |

## Suppressed by marker (0)

_None._

## Stale suppression markers (0)

Present in source, no current finding matches — consider removing.

_None._
