---
title: "The Function We Almost Deleted"
description: "We built a dead-code scanner for our own codebase, ran it for real, and it flagged a function that was actually load-bearing. Here's the near-miss, the root cause, and why the tool is now open source."
author: "Ryan Smith"
date: 2026-08-14
updated: 2026-08-15
category: "Engineering"
tags: ["dead-code", "code-health", "developer-tooling", "open-source", "engineering-culture", "monorepo", "code-quality"]
featured: false
draft: false
ogImage: "https://res.cloudinary.com/diqcbcmaq/image/upload/f_auto,q_auto,w_1200,h_630,c_fill/blog/the-function-we-almost-deleted/01-hero"
---

<!-- IMAGE: 01-hero
  A wide-format hero graphic with a dark gradient background (deep navy to charcoal).
  Center composition: a single code function block rendered as a small glowing card,
  caught mid-fall toward a trash icon, with a bold red "STOP" hand/shield intercepting it
  just above the bin. Around the falling card, faint ghosted lines suggest a call stack
  reaching back up into the codebase, implying "this thing is still connected to
  something." Style: flat/geometric, consistent with the existing Skillsmith blog
  aesthetic. Dimensions: 1200x630.
-->
![The Function We Almost Deleted](https://res.cloudinary.com/diqcbcmaq/image/upload/f_auto,q_auto,w_1200/blog/the-function-we-almost-deleted/01-hero)

Our scanner's report had one line that would have broken a working command: `compareCandidates: Safe to delete`.

`compareCandidates` sorts the list of skills our CLI's `sklx audit security` command shows you. Delete it, and that command stops rendering results in any sensible order the moment you run it. The scanner was confident. The scanner was wrong. And figuring out *why* it was wrong turned into the most useful part of this whole project.

## Why we went looking for dead code in the first place

Our codebase has grown fast: over 2,700 commits in about seven months. At that pace, dead code piles up quietly. Helpers get superseded by rewrites, wrappers get bypassed, and nobody circles back to delete the leftovers, because deleting code you didn't write feels riskier than ignoring it. We'd been eyeballing candidates ad hoc and wanted something principled instead.

We're also not the first to take this seriously. Farhan Thawar, VP and Head of Engineering at Shopify, runs an internal program called the [Dead Code Club](https://x.com/fnthawar/status/2085713494838526424): 5 million lines of code deleted in one push last summer, then another 15 million at the company's Summit event in July. That's the precedent. Our version needed to be smaller and a lot more paranoid.

## Building a scanner that's allowed to say "I don't know"

Plenty of tools exist for finding unused code. The interesting design problem wasn't finding candidates. It was building something that could tell the difference between "nothing calls this" and "nothing calls this *that I can see*." It also had to admit when it genuinely couldn't tell.

We modeled the tool after a pattern we'd already used elsewhere in-house: a static scan generates candidates, then a second pass checks each one against real test coverage before it's allowed anywhere near a "safe to delete" label. Before we wrote a line of implementation, we sent the design to a second AI model, from a different vendor, specifically to argue with our own reasoning. It came back with thirteen real problems. The sharpest one: our plan for figuring out whether a Supabase function was still live checked for a config file. That config file turned out to be missing on nine of fifty functions we know for a fact are running in production right now. If we'd shipped that check, it would have been wrong about a live production system roughly one time in five, wearing the exact same confident tone as when it was right.

So we added a fourth category most tools skip: *needs runtime verification, insufficient evidence*. When the scanner genuinely can't tell, it says so instead of guessing.

## Running it for real

We pointed the finished tool at one package (our CLI) and let it work. Six functions came back tagged "safe to delete." Four more got flagged as possible duplicates worth a second look.

Then we did something a lot of automated cleanup tools skip: we didn't trust the "safe" label at face value. We had a second, more careful pass re-check every single candidate by hand, searching the *entire* codebase rather than only the one package the scanner looked at, and confirming none of it was secretly part of a public interface other code depends on.

Two of the six didn't survive that check. `compareCandidates` was one false alarm. A validation function guarding our private registry install path was the other, which would have quietly removed a security check if we'd trusted the scanner's first answer.

Both false alarms failed for the *same* underlying reason, and it wasn't a coincidence. Our test-coverage check was reading results from the CLI package's official test command, and that command deliberately only counts one style of test file. Both of the functions in question were tested by the *other* style, the one that command doesn't count. The functions were fully tested. Our tool just wasn't looking in the right place to notice. We fixed the coverage check, added a regression test that reproduces exactly this trap, and wrote down why in the tool's own documentation so nobody rediscovers this the hard way.

The four functions that survived every check really were dead: two quota-display helpers nothing had called in about seven months, superseded by a rewrite that inlined the same logic elsewhere; a one-line color-lookup wrapper that every real caller had already learned to skip; and a logging helper whose own coverage data told the story on its own, a sibling function right next to it had seventeen real hits, this one had zero. Ninety-eight lines, gone, verified safe from three separate directions before a single line was deleted.

## What this actually proves

This first pass was small on purpose. Ninety-eight lines out of a codebase with a couple thousand test files isn't a headline number, and pretending otherwise would be the kind of overclaiming we'd rather not do. What it *does* prove is that the safety net holds under a real test instead of a hypothetical one. The tool caught genuinely dead code. It also almost shipped two false positives, and the verification pass caught both before they became a real regression. That's why we built a scanner that proposes and a separate pass that verifies, instead of one script that just deletes: the interesting failures don't show up until you run it against a real, messy codebase with conventions the tool has never seen before.

The tool keeps running here, one package at a time, each pass teaching it more about our own codebase's quirks. And now it can run on yours too.

## The tool is public now

The scanner started life as an internal skill for our own coding agents. As of this week the whole thing is public at [smith-horn/code-health-auditor](https://github.com/smith-horn/code-health-auditor). This post describes the tool; the repo lets you install it and point your own coding agent at your own codebase.

Getting it from "works for us" to "honest to publish" took its own cleanup pass, and we used our own CLI to do it.

### Commands we ran

First, structure validation:

```
$ skillsmith validate .claude/skills/code-health-auditor
VALID
Warnings:
  - Consider adding tags for better searchability
```

Sound structure, one warning about missing tags. We added the tags.

Then the reference check. `skillsmith publish --check-references` ships with default patterns for structural leaks: Docker container names, npm scopes, project URLs, GitHub repo references, suspicious line counts. On top of those we supplied three custom patterns for this repo's own fingerprints: our brand name, our issue-tracker prefix, and our internal package paths.

```
$ skillsmith publish --check-references \
    --reference-patterns 'Skillsmith,SMI-[0-9]+,packages/(cli|mcp-server|core)' \
    .claude/skills/code-health-auditor

  References in SKILL.md:
    L4: Skillsmith (Custom pattern)
    L82: SMI-5447 (Custom pattern)
    L34: packages/cli (Custom pattern)
    ...

  References in patterns/README.md:
    L24: SMI-5879 (Custom pattern)
    ...

  ⚠️  Found 30 project-specific reference(s) across 2 file(s)
  These may leak internal project details. Review before publishing.

✔ Skill prepared for publishing
```

Thirty real internal references across two files, and every one of them would have made the "reusable" claim a lie: package names from our monorepo, issue numbers from our tracker, our own product name woven through the prose.

One honest note for anyone else preparing a skill for release: every hit above says "Custom pattern." The default patterns alone found zero of the thirty, because a plain-English mention of your own product name isn't a URL, a container name, or an npm scope. The defaults catch structural leaks; they can't know your brand. A clean default run is not the same as a clean skill, so pass your own name, tracker prefix, and internal paths as custom patterns before you trust the result.

After genericizing the package names, stripping the issue-tracker numbers, and replacing brand mentions with generic language, a second `skillsmith publish --check-references` run came back clean: zero references found.

---

## Key Takeaways

- **Dead-code deletion is a real engineering discipline, with real precedent.** Shopify's internal Dead Code Club deleted 5 million lines of code in one push, then 15 million more at its Summit event in July. Our version is smaller and adds a verification pass.
- **A dead-code scanner needs a fourth answer besides "delete it" and "keep it."** Ours added "I can't tell yet" as an explicit, first-class category, after an adversarial design review found real cases where a confident answer would have been wrong.
- **"Safe to delete" from a tool is a candidate, not a verdict.** A second, independent verification pass against the full codebase caught two false positives in this run's very first outing, one of them a security-relevant validation check.
- **Both false positives traced back to one root cause**: a test-coverage check blind to half our test-file conventions. The tool now defends against it with a regression test.
- **The real cleanup was small on purpose**: 4 functions, 98 lines, verified from three directions before deletion. Small and verifiably safe beats large and merely plausible.
- **The tool is now open source.** [smith-horn/code-health-auditor](https://github.com/smith-horn/code-health-auditor) is public and installable. Preparing it surfaced 30 internal references across 2 files, all from custom patterns, so bring your own brand name and tracker prefix to `--check-references` before trusting a clean run.
