# Phase 6 Website Completion Plan (Updated)

**Created:** 2026-01-18
**Updated:** 2026-01-18 (post-audit)
**Project:** Skillsmith Phase 6: Website & Portal
**Execution:** Hive Mind in Git Worktree
**Resource Profile:** MacBook Pro M4 (2-3 concurrent agents per wave)

---

## Audit Results

| Category | Before | After |
|----------|--------|-------|
| Total Issues | 48 | 48 |
| Already Done | 10 | 35 |
| Closed Today | - | 25 |
| **Remaining** | **38** | **13** |

### Waves 1 & 2: COMPLETE ✅
All brand compliance and dark theme issues verified done in codebase:
- Satoshi font loaded from fontshare.com
- Coral gradients (#E07A5F → #D4694E) implemented
- All pages using dark theme (background: #0D0D0F)
- Components using proper brand colors

---

## Remaining Work (13 Issues)

### Wave 3: Database & Auth (3 issues)

| Issue | Title | Status |
|-------|-------|--------|
| SMI-1178 | Database schema and setup (Supabase) | Partial - needs users/subscriptions tables |
| SMI-1168 | User registration and login | Not started - login.astro exists but no auth |
| SMI-1169 | Email verification flow | Not started |

**Files to create:**
- `supabase/migrations/011_users_subscriptions.sql`
- `supabase/functions/auth-register/index.ts`
- `supabase/functions/auth-login/index.ts`
- `supabase/functions/auth-verify/index.ts`
- `packages/website/src/lib/auth.ts`

### Wave 4: Stripe Integration (4 issues)

| Issue | Title | Status |
|-------|-------|--------|
| SMI-1177 | Stripe webhook handlers | Not started |
| SMI-1161 | Stripe Checkout for Team tier | Partial - checkout function exists |
| SMI-1162 | Stripe Checkout for Enterprise tier | Partial - checkout function exists |
| SMI-1164 | License key delivery after payment | Not started |

**Files to create:**
- `supabase/functions/stripe-webhook/index.ts`
- `supabase/functions/generate-license/index.ts`

**Existing:** `supabase/functions/checkout/index.ts` ✓

### Wave 5: Account Features (3 issues)

| Issue | Title | Status |
|-------|-------|--------|
| SMI-1163 | Account dashboard with subscription status | Not started |
| SMI-1165 | Subscription upgrade/downgrade flow | Not started |
| SMI-1167 | Seat management for team admins | Not started |

**Files to create:**
- `packages/website/src/pages/account/index.astro`
- `packages/website/src/pages/account/subscription.astro`
- `packages/website/src/pages/account/team.astro`
- `supabase/functions/manage-subscription/index.ts`

### Wave 6: Content & Polish (3 issues)

| Issue | Title | Status |
|-------|-------|--------|
| SMI-1158 | Feature comparison table component | Not started |
| SMI-1160 | FAQ page for common questions | Not started |
| SMI-1166 | Billing history and invoice download | Not started |

**Files to create:**
- `packages/website/src/components/ComparisonTable.astro`
- `packages/website/src/pages/faq.astro`
- `packages/website/src/pages/account/billing.astro`

---

## Updated Wave Structure

| Wave | Focus | Issues | Priority | Est. Effort |
|------|-------|--------|----------|-------------|
| ~~1~~ | ~~Brand Compliance~~ | ~~5~~ | ~~P1~~ | ✅ DONE |
| ~~2~~ | ~~Dark Theme~~ | ~~6~~ | ~~P2~~ | ✅ DONE |
| 3 | Database & Auth | 3 | P1 | High |
| 4 | Stripe Integration | 4 | P1 | High |
| 5 | Account Features | 3 | P2 | Medium |
| 6 | Content & Polish | 3 | P3 | Low |

---

## Hive Mind Configuration (Updated)

```yaml
# .claude/hive-mind/phase6-config.yaml
name: phase6-website-completion
description: Complete remaining Phase 6 website issues (13 remaining)

topology: hierarchical
queen_model: sonnet
worker_model: haiku
max_concurrent_agents: 2
resource_profile: laptop

waves:
  # Wave 3: Database & Auth (MUST BE FIRST)
  - name: database-auth
    description: "Set up users/subscriptions schema and auth flow"
    priority: 1
    max_agents: 2
    sequential: true
    issues:
      - id: SMI-1178
        title: "Database schema - users and subscriptions tables"
      - id: SMI-1168
        title: "User registration and login"
      - id: SMI-1169
        title: "Email verification flow"

  # Wave 4: Stripe Integration
  - name: stripe-integration
    description: "Complete Stripe webhook and license delivery"
    priority: 1
    max_agents: 2
    depends_on: [database-auth]
    issues:
      - id: SMI-1177
        title: "Stripe webhook handlers"
      - id: SMI-1161
        title: "Stripe Checkout for Team tier"
      - id: SMI-1162
        title: "Stripe Checkout for Enterprise tier"
      - id: SMI-1164
        title: "License key delivery after payment"

  # Wave 5: Account Features
  - name: account-features
    description: "Build account management pages"
    priority: 2
    max_agents: 2
    depends_on: [stripe-integration]
    issues:
      - id: SMI-1163
        title: "Account dashboard with subscription status"
      - id: SMI-1165
        title: "Subscription upgrade/downgrade flow"
      - id: SMI-1167
        title: "Seat management for team admins"

  # Wave 6: Content & Polish
  - name: content-polish
    description: "Final content pages"
    priority: 3
    max_agents: 2
    issues:
      - id: SMI-1158
        title: "Feature comparison table component"
      - id: SMI-1160
        title: "FAQ page for common questions"
      - id: SMI-1166
        title: "Billing history and invoice download"
```

---

## Execution Commands (Updated)

```bash
cd ../skillsmith-phase6

# Start with backend foundation (recommended order)
./start-hive-mind.sh wave3    # Database & Auth
./start-hive-mind.sh wave4    # Stripe Integration
./start-hive-mind.sh wave5    # Account Features
./start-hive-mind.sh wave6    # Content & Polish

# Or run all remaining waves
./start-hive-mind.sh backend  # Waves 3 & 4
./start-hive-mind.sh all      # All remaining
```

---

## Success Metrics

- [x] Wave 1: Brand Compliance (5 issues) - **DONE**
- [x] Wave 2: Dark Theme (6 issues) - **DONE**
- [ ] Wave 3: Database & Auth (3 issues)
- [ ] Wave 4: Stripe Integration (4 issues)
- [ ] Wave 5: Account Features (3 issues)
- [ ] Wave 6: Content & Polish (3 issues)

**Total Remaining:** 13 issues
