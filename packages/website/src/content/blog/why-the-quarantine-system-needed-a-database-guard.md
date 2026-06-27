---
title: "163 Rows, No Alarm: Auditing and Hardening Skillsmith's Quarantine System"
description: "We audited our own quarantine database and found 163 quietly-broken rows across three defect classes. One untended twin file was responsible. Here is what we fixed, and how a database-level CHECK constraint means it cannot happen again."
author: "Skillsmith Team"
date: 2026-06-25
updated: 2026-06-25
category: "Engineering"
tags: ["security", "quarantine", "data-integrity", "infrastructure", "engineering", "database"]
featured: true
draft: true
ogImage: "https://res.cloudinary.com/diqcbcmaq/image/upload/f_auto,q_auto,w_1200,h_630,c_fill/blog/quarantine-hardening/quarantine-audit-hero"
---

![Database rows with warning indicators and a CHECK constraint guard](https://res.cloudinary.com/diqcbcmaq/image/upload/f_auto,q_auto,w_1200/blog/quarantine-hardening/quarantine-audit-hero)

Skillsmith's quarantine system sits between the public registry and the skills you can install. It blocks malicious content, stale references, and dead repositories from reaching your agent. Going into our June 2026 audit, it held ~5,582 quarantined records across a registry of ~73,347 skills.

It was also silently wrong in 163 of those rows. For about 10 weeks. With no alert.

After the rollout described in this post: 71,728 skills in the registry, 86 quarantined, down from ~5,582.

---

## What We Found

We ran a direct audit of the live production database on June 25, 2026. Three defect classes surfaced.

![Three columns showing the three defect classes: NULL reasons, phantom scores, and mislabeled dead references](https://res.cloudinary.com/diqcbcmaq/image/upload/f_auto,q_auto,w_1200/blog/quarantine-hardening/three-defect-classes)

### Defect 1: 86 quarantined rows with no recorded reason

Skillsmith's internal data contract requires every quarantined row to carry a `quarantine_reason`. Without one, the entry is not actionable: no reviewer can evaluate it, no user can be told why installation is blocked.

86 rows violated this contract.

All 86 came from a single non-GitHub source (refoundai.com/lenny-skills). Each carried a single `stale` finding. Each had a `last_seen_at` value frozen on April 14, 2026. None had a quarantine reason.

They had been sitting with `quarantine_reason = NULL` for about 10 weeks, invisible to the alert system, because no alert was configured for that condition.

**Before:** 86 rows. **After:** 0.

### Defect 2: 44 active skills carrying a phantom security score

Active (non-quarantined) skills in search results and `skills-get` responses show a `security_score`. The score is expected to be 0 when there are no `security_findings`.

44 skills had `security_score` values between 59 and 100 with completely empty `security_findings` arrays. A prior scan sweep had removed the findings but had not reset the score. Anyone fetching or searching those skills would see a score that pointed to nothing.

**Before:** 44 rows. **After:** 0.

### Defect 3: 33 quarantined rows mislabeled as security threats

33 quarantined rows described their reason as "Security scan detected...". That label implies a real content threat. A content reviewer investigating them would be looking for malicious patterns.

The actual problem was path drift. The skill repositories still existed but the specific SKILL.md path was gone (repositories that had deleted subdirectories, renamed files, or restructured). A live re-check returned a fetch failure on 33 of 33 attempted fetches. These were dead references, not security findings.

Mislabeling them had three consequences. They could never be triaged correctly (there was no content threat to evaluate). They were excluded from the dead-repo cleanup path, which is keyed on the dead-repo reason family. And they inflated the apparent security-finding count.

**Before:** 33 mislabeled rows. **After:** 0 mislabeled; all 33 re-tagged and disposed.

---

## The Root Cause: A Twin File That Was Never Updated

Think of it like two synchronized clocks where one battery was never replaced. Both clocks look identical. Both run independently. The one with the dead battery drifts without announcing it.

Skillsmith runs two separate implementations of its quarantine helper: one in Node.js for the indexer (`scripts/indexer/_shared/quarantine.ts`) and one in Deno for the edge functions (`supabase/functions/_shared/quarantine.ts`). Same logical operation, two runtimes. In this codebase we call these files "twins."

In an earlier change, the team added a required `reason` parameter to the Node quarantine helper and the `quarantine_stale_skills` RPC. Stale quarantines would now always record why they were quarantined. This change was correct and well-tested on the Node side.

The Deno twin was not updated.

The Deno stale reconciler continued using a fallback `.update()` call that wrote `quarantined = true` but omitted `quarantine_reason`. It also had no filter for GitHub-sourced skills, so it reached the refoundai.com catalog that the Node-side paths never touched.

Because the Deno reconciler is not GitHub-keyed, the standard healing process that resolves stale GitHub quarantines could not find these rows. No GitHub repo URL meant no GitHub-keyed lookup. The rows sat with a NULL reason until we queried for them directly.

The twin divergence also explained why tests had not caught it. The Node-side had unit coverage for the `reason` parameter. The Deno-side had no equivalent parity test.

---

## What We Shipped

Two pull requests merged to main.

### PR #1560: Backfill, score reset, and database enforcement

**Squash SHA:** `1b41fb06`

Migration `20260625000001` (schema_version 96) did three things.

**Backfilled the 86 NULL reasons.** A precedence-correct `CASE` statement set `quarantine_reason = 'stale'` for the affected rows. The migration also included an abort guard: if any row matched the stale pattern but carried an unexpected compound-flag combination, the migration would stop rather than silently overwrite.

**Reset the 44 phantom scores.** A targeted `UPDATE` set `security_score = 0` for active skills carrying an empty `security_findings` array.

**Added a CHECK constraint.** The new constraint `skills_quarantine_has_reason` encodes Contract 4 directly in the database schema:

```sql
CHECK (quarantined = FALSE OR quarantine_reason IS NOT NULL)
```

The constraint was added `NOT VALID`, then validated with `VALIDATE CONSTRAINT` inside `lock_timeout` and `statement_timeout` guards (the `ACCESS EXCLUSIVE` lock is taken only during `VALIDATE`, not for the full table scan).

The old system was a sticky note: "please write a reason here." The new constraint is a door that will not close without one. Application code can forget. The database cannot.

**Applied the Deno/Node parity fix.** The Deno twin now passes `quarantine_reason` on every write path. A new byte-parity test (`quarantine-twin-parity.test.ts`) asserts that both helpers thread `quarantine_reason` identically going forward. If they diverge again, CI fails.

### PR #1562: Re-tagging dead references and the purge lever

**Squash SHA:** `b92fc94d`

**Dequarantine sweep extension.** When the sweep checks a quarantined skill and gets a path-level 404 (the repository exists but the recorded SKILL.md sub-path is gone), it now re-tags the row into the dead-repo reason family: "Repository skill path unreachable (SKILL.md 404): `<url>`". Previously, a path-level 404 was a no-op. The row stayed with its original (incorrect) label forever. This extension re-tagged all 33 mislabeled rows.

**A gated purge lever.** Dead-repo quarantine rows had no automated cleanup path before this wave. They accumulated with no scheduled truck on the route. We built one: `run_type=purge` on the dequarantine workflow, with three gates.

1. `PURGE_DRY_RUN` is the default. The workflow reports what it would delete without deleting anything.
2. `workflow_dispatch`-only. `repository_dispatch` and cron triggers are rejected. The workflow cannot be triggered by a push or a schedule.
3. `runPurge --apply` must be explicitly passed. Omitting `--apply` produces a dry-run regardless of other inputs.

A separate `purge_limit` parameter caps the number of rows deleted per execution as a staged-apply row budget, a safety valve, not a gate.

The staged purge on June 25 deleted 5,496 rows in bounded batches (100 → 1,000 → 1,000 → 2,000 → 1,396), including all 33 re-tagged dead references and the full pre-existing repo-deleted backlog.

---

## Validation Chain

Five stages before production contact.

| Stage | What ran | Result |
|-------|----------|--------|
| Plan review | 21 findings reviewed and folded before implementation | Clean |
| `supabase-migration-reviewer` (Opus) | Live read-only against prod schema; checked for ACCESS EXCLUSIVE surprises | Clean |
| Governance retro (x2, Opus) | Full diff review | Clean |
| Stage 1 local | Throwaway Postgres; seeded synthetic rows; tested backfill logic, CHECK guard, and the abort path | Pass |
| Stage 2 staging | Migration applied to real prod-mirror schema; dequarantine dry-run flagged 3 repo-gone of 23 checked | Pass |
| Stage 3 prod | Migration applied; fallback fired 0 times; dequarantine re-tagged 33 of 33; staged purge deleted 5,496 rows (batches: 100 → 1,000 → 1,000 → 2,000 → 1,396); errors: 0 | Pass |

---

## What Is Coming Next

This wave closed three data-integrity defects. It did not address the full detection coverage gap.

A 2026 threat review identified 81 applicable new attack vectors: 1 P0, 24 P1, and 56 P2/P3. Two findings stand out.

**Detection coverage.** The production edge scanner currently runs 5 of 11 detection categories. It has zero coverage for Unicode-category threats and no `ai_defence` integration. Unicode-smuggling payloads bypass the quarantine gate today. Addressing this is the work of a later wave (Wave 4 detection hardening) and is not shipped here.

**False-positive risk.** A "PII placeholder pitfall" pattern can cause false positives under certain scanning conditions. Investigation and remediation are scheduled for a later wave.

Additional future work includes: the CLI install-block gap (a quarantined skill can be installed via direct CLI invocation without the MCP layer), 9 missing test cases identified in the 2026 threat review, multi-file scan corpus coverage, and edge Unicode/`ai_defence` parity.

We list these gaps here because the accurate list is more useful than a tidy summary.

---

## Frequently Asked Questions

### "Did this affect which skills I could install?"

Not in a harmful way. The 86 NULL-reason rows were all stale-quarantined skills from refoundai.com, so they were already blocked from installation. They stayed blocked throughout. The 44 phantom-score rows were active (not quarantined) and could be installed, but their displayed `security_score` did not correspond to any real finding. The 33 mislabeled rows were quarantined and blocked for installation, just categorized under the wrong reason family.

### "How do I know a quarantined skill is quarantined for the right reason?"

After this rollout, every quarantined row in the database carries a non-NULL `quarantine_reason`. The `skills_quarantine_has_reason` CHECK constraint makes it impossible to write a quarantined row without one. The reason text is visible on the skill detail page when a skill is blocked.

### "What is a twin file divergence?"

Skillsmith's quarantine logic is implemented twice: once in Node.js for the indexer and once in Deno for the edge functions. When one file is updated and the other is not, they diverge. The new `quarantine-twin-parity.test.ts` test fails CI via a byte-parity test asserting both helpers thread `quarantine_reason` identically, so this specific divergence cannot recur undetected.

### "Can I see what the purge deleted?"

The purge deletes dead-repo quarantine rows: skills whose SKILL.md path now returns a 404 and for which no valid content can be fetched or scanned. Every deleted row is logged in the `audit_logs` table before deletion. The workflow is manually triggered and gated behind dry-run defaults, so each purge run is deliberate and traceable.

### "Why did no alert fire for 10 weeks?"

No alert was configured for `quarantine_reason IS NULL`. The rows were written by the Deno stale reconciler starting April 14, 2026 and sat silently until the direct audit on June 25. The CHECK constraint now prevents any future row from entering this state. A monitoring query for this condition is on the backlog for the next wave.

---

<script type="application/ld+json">
{
  "@context": "https://schema.org",
  "@graph": [
    {
      "@type": "TechArticle",
      "@id": "https://www.skillsmith.app/blog/why-the-quarantine-system-needed-a-database-guard#article",
      "headline": "163 Rows, No Alarm: Auditing and Hardening Skillsmith's Quarantine System",
      "description": "We audited our own quarantine database and found 163 quietly-broken rows across three defect classes. One untended twin file was responsible. Here is what we fixed, and how a database-level CHECK constraint means it cannot happen again.",
      "datePublished": "2026-06-25",
      "dateModified": "2026-06-25",
      "author": {
        "@type": "Organization",
        "name": "Skillsmith Team",
        "url": "https://www.skillsmith.app"
      },
      "publisher": {
        "@type": "Organization",
        "name": "Skillsmith",
        "url": "https://www.skillsmith.app",
        "logo": {
          "@type": "ImageObject",
          "url": "https://www.skillsmith.app/logo.png"
        }
      },
      "mainEntityOfPage": {
        "@type": "WebPage",
        "@id": "https://www.skillsmith.app/blog/why-the-quarantine-system-needed-a-database-guard"
      },
      "image": {
        "@type": "ImageObject",
        "url": "https://res.cloudinary.com/diqcbcmaq/image/upload/f_auto,q_auto,w_1200,h_630,c_fill/blog/quarantine-hardening/quarantine-audit-hero"
      },
      "keywords": ["quarantine", "data integrity", "database", "security", "skillsmith", "agent skills"]
    },
    {
      "@type": "FAQPage",
      "@id": "https://www.skillsmith.app/blog/why-the-quarantine-system-needed-a-database-guard#faq",
      "mainEntity": [
        {
          "@type": "Question",
          "name": "Did this affect which skills I could install?",
          "acceptedAnswer": {
            "@type": "Answer",
            "text": "Not in a harmful way. The 86 NULL-reason rows were all stale-quarantined skills from refoundai.com, so they were already blocked from installation and stayed blocked throughout. The 44 phantom-score rows were active and could be installed, but their displayed security_score did not correspond to any real finding. The 33 mislabeled rows were quarantined and blocked, just categorized under the wrong reason family."
          }
        },
        {
          "@type": "Question",
          "name": "How do I know a quarantined skill is quarantined for the right reason?",
          "acceptedAnswer": {
            "@type": "Answer",
            "text": "After this rollout, every quarantined row in the database carries a non-NULL quarantine_reason. The skills_quarantine_has_reason CHECK constraint makes it impossible to write a quarantined row without one. The reason text is visible on the skill detail page when a skill is blocked."
          }
        },
        {
          "@type": "Question",
          "name": "What is a twin file divergence?",
          "acceptedAnswer": {
            "@type": "Answer",
            "text": "Skillsmith's quarantine logic is implemented twice: once in Node.js for the indexer and once in Deno for the edge functions. When one file is updated and the other is not, they diverge. A new quarantine-twin-parity.test.ts test fails CI via a byte-parity test asserting both helpers thread quarantine_reason identically, so this specific divergence cannot recur undetected."
          }
        },
        {
          "@type": "Question",
          "name": "Can I see what the purge deleted?",
          "acceptedAnswer": {
            "@type": "Answer",
            "text": "The purge deletes dead-repo quarantine rows: skills whose SKILL.md path now returns a 404 and for which no valid content can be fetched or scanned. Every deleted row is logged in the audit_logs table before deletion. The workflow is manually triggered and gated behind dry-run defaults, so each purge run is deliberate and traceable."
          }
        },
        {
          "@type": "Question",
          "name": "Why did no alert fire for 10 weeks?",
          "acceptedAnswer": {
            "@type": "Answer",
            "text": "No alert was configured for quarantine_reason IS NULL. The rows were written by the Deno stale reconciler starting April 14, 2026 and sat silently until the direct audit on June 25. The CHECK constraint now prevents any future row from entering this state."
          }
        }
      ]
    }
  ]
}
</script>
