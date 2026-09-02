# Code Health Report

Generated: 2026-09-02T03:33:41.898Z

## SCAN FAILURES (0)

A Knip pass failed or returned malformed/incomplete data for these workspaces. Every candidate from a listed workspace is force-routed to Needs runtime verification below, regardless of coverage or calibration status, and is NOT eligible for Safe-to-delete or Consolidation-candidate until re-scanned successfully. This is never absorbed as "no findings" -- see patterns/README.md Decision Log.

_None._

## Safe to delete (0)

Never auto-applied. Zero static references + zero coverage on the exact flagged range — not a deletion guarantee, do a final project-wide grep before deleting. See patterns/README.md Bucket 1.

_None._

## Consolidation candidate (12)

Human judgment only, never auto-merged. See patterns/README.md Bucket 2.

| workspace | file | name | files | note | source |
|---|---|---|---|---|---|
| packages/website | packages/website/package.json | cookie |  | unused dependency — requires a human runtime-import check before removal; never auto-classified as safe |  |
| packages/website | packages/website/package.json | tailwindcss |  | unused dependency — requires a human runtime-import check before removal; never auto-classified as safe |  |
| packages/website | packages/website/package.json | @tailwindcss/typography |  | unused dependency — requires a human runtime-import check before removal; never auto-classified as safe |  |
| packages/website | packages/website/package.json | loupe |  | unused dependency — requires a human runtime-import check before removal; never auto-classified as safe |  |
| packages/website | packages/website/package.json | picomatch |  | unused dependency — requires a human runtime-import check before removal; never auto-classified as safe |  |
| packages/website | packages/website/package.json | prettier-plugin-astro |  | unused dependency — requires a human runtime-import check before removal; never auto-classified as safe |  |
| packages/website | packages/website/package.json | strip-ansi |  | unused dependency — requires a human runtime-import check before removal; never auto-classified as safe |  |
| packages/website | packages/website/package.json | strip-literal |  | unused dependency — requires a human runtime-import check before removal; never auto-classified as safe |  |
| packages/website | packages/website/package.json | web-vitals |  | unused dependency — requires a human runtime-import check before removal; never auto-classified as safe |  |
| packages/website |  | formatRelativeTime | packages/website/src/lib/inventory-view.ts,packages/website/src/lib/team-activity-format.ts |  | name-repeat-detector |
| packages/website |  | formatPrice | packages/website/src/lib/pricing-data.ts,packages/website/src/lib/pricing.ts |  | name-repeat-detector |
| packages/website |  | GET | packages/website/src/pages/blog/rss.xml.ts,packages/website/src/pages/status.rss.xml.ts |  | name-repeat-detector |

## Looks bad but is fine (0)

### False positives (0)

_None._

### Known blind spots (0)

_None._

## Needs runtime verification — insufficient evidence (68)

Not a verdict. Never promoted to Safe-to-delete on missing data. See patterns/README.md Bucket 4.

| workspace | file | category | name | line | reason |
|---|---|---|---|---|---|
| packages/website | packages/website/src/components/index.ts | files |  |  | workspace is EXPERIMENTAL (uncalibrated) |
| packages/website | packages/website/src/constants/index.ts | files |  |  | workspace is EXPERIMENTAL (uncalibrated) |
| packages/website | packages/website/src/lib/api.ts | files |  |  | workspace is EXPERIMENTAL (uncalibrated) |
| packages/website | packages/website/src/scripts/web-vitals.ts | files |  |  | workspace is EXPERIMENTAL (uncalibrated) |
| packages/website | packages/website/src/components/auth/index.ts | files |  |  | workspace is EXPERIMENTAL (uncalibrated) |
| packages/website | packages/website/src/constants/terminology.ts | exports | QUARANTINE_SEVERITY | 77 | workspace is EXPERIMENTAL (uncalibrated) |
| packages/website | packages/website/src/constants/terminology.ts | exports | SKILL_CATEGORIES | 121 | workspace is EXPERIMENTAL (uncalibrated) |
| packages/website | packages/website/src/constants/terminology.ts | exports | PRICING_TIERS | 144 | workspace is EXPERIMENTAL (uncalibrated) |
| packages/website | packages/website/src/constants/terminology.ts | exports | CONTACT_TOPICS | 187 | workspace is EXPERIMENTAL (uncalibrated) |
| packages/website | packages/website/src/constants/terminology.ts | exports | getTrustTierById | 202 | workspace is EXPERIMENTAL (uncalibrated) |
| packages/website | packages/website/src/constants/terminology.ts | exports | getQuarantineSeverityById | 209 | workspace is EXPERIMENTAL (uncalibrated) |
| packages/website | packages/website/src/constants/terminology.ts | types | QuarantineSeverityId | 115 | workspace is EXPERIMENTAL (uncalibrated) |
| packages/website | packages/website/src/constants/terminology.ts | types | CategoryId | 136 | workspace is EXPERIMENTAL (uncalibrated) |
| packages/website | packages/website/src/constants/terminology.ts | types | PricingTierId | 182 | workspace is EXPERIMENTAL (uncalibrated) |
| packages/website | packages/website/src/lib/auth-callback-handler.ts | exports | handleRecovery | 89 | workspace is EXPERIMENTAL (uncalibrated) |
| packages/website | packages/website/src/lib/auth-callback-handler.ts | exports | handleGenericOAuth | 94 | workspace is EXPERIMENTAL (uncalibrated) |
| packages/website | packages/website/src/lib/auth-callback-handler.ts | exports | handleAlreadyLoggedInOrPkce | 116 | workspace is EXPERIMENTAL (uncalibrated) |
| packages/website | packages/website/src/lib/auth-callback-handler.ts | types | RecordSsoLoginResult | 38 | workspace is EXPERIMENTAL (uncalibrated) |
| packages/website | packages/website/src/lib/auth-callback-handler.ts | types | SsoLinkCandidate | 39 | workspace is EXPERIMENTAL (uncalibrated) |
| packages/website | packages/website/src/lib/skills-page-render.ts | exports | BADGE_CONFIG | 32 | workspace is EXPERIMENTAL (uncalibrated) |
| packages/website | packages/website/src/lib/status-poller.ts | exports | isRovingNavKey | 20 | workspace is EXPERIMENTAL (uncalibrated) |
| packages/website | packages/website/src/lib/team-invite-ui.ts | exports | renderMemberRow | 318 | workspace is EXPERIMENTAL (uncalibrated) |
| packages/website | packages/website/src/lib/team-invite-ui.ts | types | TeamMemberRow | 29 | workspace is EXPERIMENTAL (uncalibrated) |
| packages/website | packages/website/src/middleware.utils.ts | exports | assignAbVariant | 165 | workspace is EXPERIMENTAL (uncalibrated) |
| packages/website | packages/website/src/lib/complete-profile-copy.ts | exports | humanizePath | 52 | workspace is EXPERIMENTAL (uncalibrated) |
| packages/website | packages/website/src/lib/pricing-data.ts | exports | ANNUAL_DISCOUNT_MONTHS | 32 | workspace is EXPERIMENTAL (uncalibrated) |
| packages/website | packages/website/src/lib/pricing-data.ts | types | PricingFeature | 15 | workspace is EXPERIMENTAL (uncalibrated) |
| packages/website | packages/website/src/lib/pricing.ts | exports | formatApiCalls | 21 | workspace is EXPERIMENTAL (uncalibrated) |
| packages/website | packages/website/src/lib/pricing.ts | exports | getTierById | 21 | workspace is EXPERIMENTAL (uncalibrated) |
| packages/website | packages/website/src/lib/pricing.ts | exports | formatPrice | 26 | workspace is EXPERIMENTAL (uncalibrated) |
| packages/website | packages/website/src/lib/status-client.ts | exports | STATUS_CACHE_KEY | 47 | workspace is EXPERIMENTAL (uncalibrated) |
| packages/website | packages/website/src/lib/status-client.ts | exports | STATUS_CACHE_TTL_MS | 48 | workspace is EXPERIMENTAL (uncalibrated) |
| packages/website | packages/website/src/lib/status-client.ts | exports | dedupeComponentsBySlug | 54 | workspace is EXPERIMENTAL (uncalibrated) |
| packages/website | packages/website/src/lib/status-client.ts | exports | buildAffectedComponentsText | 62 | workspace is EXPERIMENTAL (uncalibrated) |
| packages/website | packages/website/src/lib/status-client.ts | exports | computeRovingTabindexMove | 77 | workspace is EXPERIMENTAL (uncalibrated) |
| packages/website | packages/website/src/lib/status-client.ts | exports | INITIAL_POLL_OUTCOME_STATE | 79 | workspace is EXPERIMENTAL (uncalibrated) |
| packages/website | packages/website/src/lib/status-client.ts | exports | isRovingNavKey | 80 | workspace is EXPERIMENTAL (uncalibrated) |
| packages/website | packages/website/src/lib/status-client.ts | exports | nextPollOutcomeState | 81 | workspace is EXPERIMENTAL (uncalibrated) |
| packages/website | packages/website/src/lib/status-client.ts | exports | STALE_AFTER_CONSECUTIVE_FAILURES | 82 | workspace is EXPERIMENTAL (uncalibrated) |
| packages/website | packages/website/src/lib/status-client.ts | types | ComponentDedupeResult | 56 | workspace is EXPERIMENTAL (uncalibrated) |
| packages/website | packages/website/src/lib/status-client.ts | types | ReconcilePlan | 57 | workspace is EXPERIMENTAL (uncalibrated) |
| packages/website | packages/website/src/lib/status-client.ts | types | ComponentRowContent | 68 | workspace is EXPERIMENTAL (uncalibrated) |
| packages/website | packages/website/src/lib/status-client.ts | types | IncidentContent | 70 | workspace is EXPERIMENTAL (uncalibrated) |
| packages/website | packages/website/src/lib/status-client.ts | types | IncidentUpdateContent | 71 | workspace is EXPERIMENTAL (uncalibrated) |
| packages/website | packages/website/src/lib/status-client.ts | types | PollOutcomeState | 84 | workspace is EXPERIMENTAL (uncalibrated) |
| packages/website | packages/website/src/lib/status-client.ts | types | StatusPoller | 85 | workspace is EXPERIMENTAL (uncalibrated) |
| packages/website | packages/website/src/lib/status-client.ts | types | StatusPollerCallbacks | 86 | workspace is EXPERIMENTAL (uncalibrated) |
| packages/website | packages/website/src/lib/status-client.ts | types | StatusPollerOptions | 87 | workspace is EXPERIMENTAL (uncalibrated) |
| packages/website | packages/website/src/lib/account-profile-data.ts | exports | isEmail | 74 | workspace is EXPERIMENTAL (uncalibrated) |
| packages/website | packages/website/src/lib/account-nav.ts | types | AccountNavItem | 21 | workspace is EXPERIMENTAL (uncalibrated) |
| packages/website | packages/website/src/lib/oauth-popup.ts | types | OAuthPopupOutcome | 19 | workspace is EXPERIMENTAL (uncalibrated) |
| packages/website | packages/website/src/lib/private-registry-dashboard.ts | types | RegistryApprovalStatus | 17 | workspace is EXPERIMENTAL (uncalibrated) |
| packages/website | packages/website/src/lib/seat-update-error.ts | types | SeatUpdateErrorBody | 9 | workspace is EXPERIMENTAL (uncalibrated) |
| packages/website | packages/website/src/lib/skills-utils.ts | types | QualityTier | 3 | workspace is EXPERIMENTAL (uncalibrated) |
| packages/website | packages/website/src/lib/sso-link-consent.ts | types | PendingSsoLinkRequest | 31 | workspace is EXPERIMENTAL (uncalibrated) |
| packages/website | packages/website/src/lib/status-vocab.ts | types | IncidentUpdate | 50 | workspace is EXPERIMENTAL (uncalibrated) |
| packages/website | packages/website/src/lib/status-render.ts | types | IncidentUpdateContent | 224 | workspace is EXPERIMENTAL (uncalibrated) |
| packages/website | packages/website/src/types/index.ts | types | Skill | 41 | workspace is EXPERIMENTAL (uncalibrated) |
| packages/website | packages/website/src/types/index.ts | types | SkillCategory | 65 | workspace is EXPERIMENTAL (uncalibrated) |
| packages/website | packages/website/src/types/index.ts | types | SkillSearchParams | 79 | workspace is EXPERIMENTAL (uncalibrated) |
| packages/website | packages/website/src/types/index.ts | types | SkillSearchResult | 91 | workspace is EXPERIMENTAL (uncalibrated) |
| packages/website | packages/website/src/types/index.ts | types | NavItem | 100 | workspace is EXPERIMENTAL (uncalibrated) |
| packages/website | packages/website/src/types/index.ts | types | Feature | 110 | workspace is EXPERIMENTAL (uncalibrated) |
| packages/website | packages/website/src/types/index.ts | types | Testimonial | 119 | workspace is EXPERIMENTAL (uncalibrated) |
| packages/website | packages/website/src/types/index.ts | types | ApiResponse | 130 | workspace is EXPERIMENTAL (uncalibrated) |
| packages/website | packages/website/src/lib/account-summary-data.ts | types | SummaryProfile | 18 | workspace is EXPERIMENTAL (uncalibrated) |
| packages/website | packages/website/src/lib/account-summary-data.ts | types | SummaryQuota | 24 | workspace is EXPERIMENTAL (uncalibrated) |
| packages/website | packages/website/src/lib/account-overview-data.ts | types | TeamOverviewUsage | 21 | workspace is EXPERIMENTAL (uncalibrated) |

## Suppressed by marker (0)

_None._

## Stale suppression markers (0)

Present in source, no current finding matches — consider removing.

_None._
