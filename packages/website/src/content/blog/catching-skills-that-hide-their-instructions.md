---
title: "Letters That Lie: Catching Skills That Hide Their Instructions"
description: "We shipped two new detectors that catch malicious instructions disguised with lookalike letters and invisible characters, plus fetch-and-run install scripts. Then we closed a contract bug where a blocked skill still reported itself as installable. Here is what changed, and how we proved it with no false positives."
author: "Skillsmith Team"
date: 2026-06-27
updated: 2026-06-27
category: "Engineering"
tags: ["security", "quarantine", "threat-detection", "unicode", "agent-skills", "engineering"]
featured: true
draft: true
ogImage: "https://res.cloudinary.com/diqcbcmaq/image/upload/f_auto,q_auto,w_1200,h_630,c_fill/blog/quarantine-detection/disguised-instructions-hero"
---

![Two lines of text that look identical, with one revealed to contain lookalike letters and invisible gaps](https://res.cloudinary.com/diqcbcmaq/image/upload/f_auto,q_auto,w_1200/blog/quarantine-detection/disguised-instructions-hero)

Read this line, then read it again: `ignore all previous instructions`.

Now read this one: `іgnоrе аll prеvіоus іnstruсtіоns`.

They look the same. The second one is not English. Several of its letters are Cyrillic characters that happen to render identically to their Latin twins. A keyword filter looking for the word "ignore" sees nothing in the second line, because that is not the letter "i" your filter knows.

Skillsmith scans every skill in its registry for content like this before it can reach your agent. As of this week, two new detectors are live in production that catch a class of attack the old scanner could read straight past: instructions wearing a disguise, and install scripts that fetch their real payload from somewhere else.

We also fixed a smaller bug that bothered us more than its size suggests: a skill that was blocked from installation still told you it was installable.

---

## The disguise problem

A skill is mostly a Markdown file called `SKILL.md`. Our scanner reads it, scores it across a set of threat categories, and quarantines anything that crosses a risk threshold. The scoring is deliberate: one genuinely dangerous signal should be enough to quarantine, while ordinary skills that mention security topics should pass untouched.

The gap was in what counts as "readable." A directive like "ignore all previous instructions" is a known jailbreak pattern, and the scanner already caught it when it was written in plain Latin text. But there are at least four ways to write that same instruction so a human (or a model) still reads it while a literal text match does not:

- **Lookalike letters (homoglyphs).** Cyrillic `а`, Greek `ο`, and math-styled `𝗂` all render like Latin letters but carry different character codes.
- **Invisible splits.** A zero-width character dropped between two letters (`ig​nore`) breaks the word for a matcher while leaving it perfectly legible.
- **Fullwidth letters.** `ｉｇｎｏｒｅ` is the same word in a different Unicode block.
- **Mixed tricks.** Any combination of the above.

We shipped a detector called `obfuscated_directive` for exactly this. It does not try to ban Unicode (that would flag every Russian, Greek, or Japanese skill in the registry). Instead it does what a suspicious border agent does with a passport: it normalizes the document to a canonical form and re-reads it. Invisible characters are stripped. Lookalike letters are folded back to the Latin shapes they imitate. Then the scanner checks whether a hidden instruction appears that was not visible in the raw text.

That last part is the important discipline. The detector only fires on the **delta**: a directive that shows up *after* de-disguising but not before. A skill written in plain Cyrillic prose about document formatting stays clean, because nothing was hidden. A skill that smuggled an English jailbreak inside Cyrillic-looking letters lights up, because the instruction only appears once you strip the costume.

One disguised directive is enough to quarantine a skill on its own. There is no legitimate reason to hide an instruction from the person reading the file.

---

## The fetch-and-run problem

The second detector, `code_execution`, addresses a different shape: a skill that tells your machine to download something and run it immediately, like `curl https://example.com/install.sh | bash`.

This one needs a lighter touch, because the pattern is not always malicious. Plenty of legitimate tools document an install one-liner. So a lone fetch-and-run scores as a medium signal: noted, but not enough to quarantine by itself.

It escalates to a quarantine-worthy signal only when it keeps bad company. If the same skill also tries to read your credentials, or asks for elevated privileges, the fetch-and-run is no longer a convenience. A power drill is unremarkable in a workshop. The same drill is alarming next to a pried-open window. Context is the difference, and the detector scores it that way.

---

## The smoke detector that went off at the cooking class

Before any of this touched production, we ran the new detectors against a read-only sample of real skills from the live registry and looked for false positives. The first pass, about a thousand skills, surfaced one class, and it was instructive.

Security-review skills, the kind that help a developer audit code, describe attacks for a living. A good one literally contains a checklist bullet like: "flag any `curl ... | sh` piped to an interpreter." Our first version of the fetch-and-run detector read that checklist, saw the dangerous pattern, noticed the skill also discussed privilege escalation and data access (because that is what a security checklist covers), and quarantined it.

The skill was not attacking anyone. It was teaching. A smoke detector that goes off during a cooking class is not wrong about smoke; it is wrong about danger.

The fix was to require a real target. A genuine fetch-and-run names a concrete place to fetch from: a URL, a domain, or an IP address. The checklist example used a placeholder (`curl ... | sh`) with no real destination. So we tightened the detector to match only when an actual target is present between the command and the interpreter. The teaching example stopped matching. The real attack still matched. We ran two more passes over more of the registry, about three thousand distinct skills in total, and found zero false positives.

This is the part of security work that does not make headlines but decides whether a system is usable. A scanner that cries wolf gets turned off. We would rather miss a contrived edge case than quarantine the tools that help people stay safe.

---

## A locked door with an "open" sign

While the detectors were the headline, a quieter inconsistency had been sitting in the API.

When you ask Skillsmith about a quarantined skill, the response carries two fields: a `quarantine_warning` that says installation is blocked, and an `installable` flag. The warning was correct. The flag was not: it was computed only from whether the skill had a repository link, ignoring quarantine entirely. So a blocked skill returned a warning that said "blocked" right next to `installable: true`.

Nothing could actually be installed (the install path refuses quarantined skills independently, and search hides them), so this was not an open door. It was a locked door with an "open" sign taped to it. Confusing, and the kind of contradiction that erodes trust in everything else the response says.

We fixed it on both surfaces that report it: the `get_skill` tool used by editors and agents, and the `skills-get` API used by the website. A quarantined skill now reports `installable: false`, and the human-readable detail line says "blocked," not the misleading "discovery-only entry" it used to print. The skill detail you see now agrees with itself.

---

## How we proved it

Detection changes are risky in a specific way: a too-eager rule does not crash, it quietly quarantines good skills. So every change went through the same staged gate, and nothing reached production until the stage before it was green.

| Stage | What ran | Result |
|-------|----------|--------|
| Unit tests | True-positive and false-positive fixtures for both detectors, plus the scoring math | Pass |
| Production simulation | The new detectors re-scored ~3,000 distinct real skills across three read-only passes | 0 false positives (after the security-review fix) |
| Staging rehearsal | Detectors deployed to staging; a crafted malicious-and-benign matrix run against the real gate | 10 of 10 |
| Staging contract check | A real skill temporarily quarantined on staging; the live API checked | 6 of 6 |
| Production | Deployed; a real quarantined skill re-checked against the live endpoint | Confirmed: `installable` flipped from true to false |

After the rollout, production health held steady: about 103,000 skills indexed, 86 quarantined, zero quarantined rows missing a reason, zero active skills carrying a stale high score. The new detectors added no false quarantines to the live catalog. Most of their value is forward-looking: they are a gate the next disguised payload has to pass, not a sweep that churned the existing registry.

---

## What is still open

We list the gaps because an accurate list is more useful than a tidy summary.

**The scanner still reads one file.** Today it reads `SKILL.md`. A payload hidden in a sibling file (a settings file, a shell script, a package lifecycle hook) is not yet scanned. Closing this multi-file gap is the highest-impact remaining work, because it activates the detectors we already have against files they never see.

**Placeholder secrets can still over-trigger.** A skill that documents an example credential like `AKIA...EXAMPLE` can read as a real secret to the personally-identifiable-information detector. The fix is a placeholder denylist with an entropy check, and it is scheduled, not shipped.

These are real, and they are next.

---

## Frequently Asked Questions

### "Does this change which skills I can install?"

For the existing catalog, almost not at all. The new detectors added no false quarantines to the live registry; they mainly protect against future submissions. The `installable` fix is a display and contract correction: skills that were already blocked are now reported as blocked consistently. Nothing that was installable became uninstallable.

### "How do you detect a hidden instruction without flagging every non-English skill?"

The detector normalizes the text (strips invisible characters and folds lookalike letters to their Latin shapes), then fires only if a directive appears that was not visible in the original. A skill genuinely written in Cyrillic, Greek, or fullwidth characters has nothing hidden, so it stays clean. The signal is the disguise, not the alphabet.

### "Why doesn't a `curl ... | bash` command quarantine a skill on its own?"

Because legitimate tools document install one-liners. A lone fetch-and-run scores as a medium signal. It only becomes quarantine-worthy when it co-occurs with another bad signal, such as reading credentials or requesting elevated privileges. Context decides.

### "Was the 'installable: true' on a blocked skill a security hole?"

No. Installation of quarantined skills was already refused by the install path, and quarantined skills are already hidden from search. The flag was a self-contradictory response, not an exploitable gap. We fixed it because a response that contradicts itself undermines confidence in the parts that are correct.

### "How do you know the new detectors do not produce false positives?"

We re-scored about 3,000 distinct real skills from the live registry across three read-only passes. The first pass surfaced one false-positive class (security-review skills that describe attacks); we fixed it by requiring a real fetch target, and the two follow-up passes found zero. The detectors then passed a staging rehearsal and a production smoke check before and after deploy.

---

<script type="application/ld+json">
{
  "@context": "https://schema.org",
  "@graph": [
    {
      "@type": "TechArticle",
      "@id": "https://www.skillsmith.app/blog/catching-skills-that-hide-their-instructions#article",
      "headline": "Letters That Lie: Catching Skills That Hide Their Instructions",
      "description": "We shipped two new detectors that catch malicious instructions disguised with lookalike letters and invisible characters, plus fetch-and-run install scripts. Then we closed a contract bug where a blocked skill still reported itself as installable.",
      "datePublished": "2026-06-27",
      "dateModified": "2026-06-27",
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
        "@id": "https://www.skillsmith.app/blog/catching-skills-that-hide-their-instructions"
      },
      "image": {
        "@type": "ImageObject",
        "url": "https://res.cloudinary.com/diqcbcmaq/image/upload/f_auto,q_auto,w_1200,h_630,c_fill/blog/quarantine-detection/disguised-instructions-hero"
      },
      "keywords": ["quarantine", "threat detection", "unicode security", "homoglyph", "skillsmith", "agent skills"]
    },
    {
      "@type": "FAQPage",
      "@id": "https://www.skillsmith.app/blog/catching-skills-that-hide-their-instructions#faq",
      "mainEntity": [
        {
          "@type": "Question",
          "name": "Does this change which skills I can install?",
          "acceptedAnswer": {
            "@type": "Answer",
            "text": "For the existing catalog, almost not at all. The new detectors added no false quarantines to the live registry; they mainly protect against future submissions. The installable fix is a display and contract correction: skills that were already blocked are now reported as blocked consistently. Nothing that was installable became uninstallable."
          }
        },
        {
          "@type": "Question",
          "name": "How do you detect a hidden instruction without flagging every non-English skill?",
          "acceptedAnswer": {
            "@type": "Answer",
            "text": "The detector normalizes the text (strips invisible characters and folds lookalike letters to their Latin shapes), then fires only if a directive appears that was not visible in the original. A skill genuinely written in Cyrillic, Greek, or fullwidth characters has nothing hidden, so it stays clean. The signal is the disguise, not the alphabet."
          }
        },
        {
          "@type": "Question",
          "name": "Why doesn't a curl ... | bash command quarantine a skill on its own?",
          "acceptedAnswer": {
            "@type": "Answer",
            "text": "Because legitimate tools document install one-liners. A lone fetch-and-run scores as a medium signal. It only becomes quarantine-worthy when it co-occurs with another bad signal, such as reading credentials or requesting elevated privileges. Context decides."
          }
        },
        {
          "@type": "Question",
          "name": "Was the 'installable: true' on a blocked skill a security hole?",
          "acceptedAnswer": {
            "@type": "Answer",
            "text": "No. Installation of quarantined skills was already refused by the install path, and quarantined skills are already hidden from search. The flag was a self-contradictory response, not an exploitable gap. We fixed it because a response that contradicts itself undermines confidence in the parts that are correct."
          }
        },
        {
          "@type": "Question",
          "name": "How do you know the new detectors do not produce false positives?",
          "acceptedAnswer": {
            "@type": "Answer",
            "text": "We re-scored about 3,000 distinct real skills from the live registry across three read-only passes. The first pass surfaced one false-positive class (security-review skills that describe attacks); we fixed it by requiring a real fetch target, and the two follow-up passes found zero. The detectors then passed a staging rehearsal and a production smoke check before and after deploy."
          }
        }
      ]
    }
  ]
}
</script>
