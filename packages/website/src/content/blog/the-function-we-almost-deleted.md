---
title: "The Function We Almost Deleted"
description: "We built a dead-code scanner for our own codebase, ran it for real, and it flagged a function that was actually load-bearing. Here's the near-miss, the fix, and what was really slowing down our Docker containers."
author: "Ryan Smith"
date: 2026-08-14
updated: 2026-08-14
category: "Engineering"
tags: ["dead-code", "code-health", "developer-tooling", "docker", "engineering-culture", "monorepo", "code-quality"]
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

We'd noticed our Docker containers running hotter than they used to, and the easy explanation was sitting right there: our codebase has grown fast (over 2,700 commits in about seven months), so of course every build and test run costs more compute than it did six months ago. More code, more work. Obvious.

It's also only part of the story.

We dug into `docker-compose.yml` and found the real bottleneck: our dev containers have no CPU or memory limit set. Picture a parking garage with no posted capacity. Cars keep pulling in, and nobody ever gets turned away at the gate. Every container we spin up, for every parallel task, competes for the exact same slice of the host machine's CPU and memory, with no ceiling on how many can pile in at once. We work in a style that spins up a fresh container per task by design, so as the number of things happening in parallel grows, the squeeze grows with it. That's an infrastructure fix, riskier and slower to review, and we've filed it separately. This post isn't about that fix. It's about the smaller, complementary thing we could actually ship this week: making sure every build only pays for code that's actually doing something.

## Building a scanner that's allowed to say "I don't know"

Plenty of tools exist for finding unused code. The interesting design problem wasn't finding candidates. It was building something that could tell the difference between "nothing calls this" and "nothing calls this *that I can see*." It also had to admit when it genuinely couldn't tell.

We modeled the tool after a pattern we'd already used elsewhere in-house: a static scan generates candidates, then a second pass checks each one against real test coverage before it's allowed anywhere near a "safe to delete" label. Before we wrote a line of implementation, we sent the design to a second AI model, from a different vendor, specifically to argue with our own reasoning. It came back with thirteen real problems. The sharpest one: our plan for figuring out whether a Supabase function was still live checked for a config file. That config file turned out to be missing on nine of fifty functions we know for a fact are running in production right now. If we'd shipped that check, it would have been wrong about a live production system roughly one time in five, wearing the exact same confident tone as when it was right.

So we added a fourth category most tools skip: *needs runtime verification, insufficient evidence*. When the scanner genuinely can't tell, it says so instead of guessing.

## Running it for real

We pointed the finished tool at one package (our CLI) and let it work. Six functions came back tagged "safe to delete." Four more got flagged as possible duplicates worth a second look.

Then we did something a lot of automated cleanup tools skip: we didn't trust the "safe" label at face value. We had a second, more careful pass re-check every single candidate by hand, searching the *entire* codebase (not just the one package the scanner looked at) and confirming none of it was secretly part of a public interface other code depends on.

Half the "safe to delete" list didn't survive that check. `compareCandidates` was one of the two false alarms. So was a validation function guarding our private registry install path, which would have quietly removed a security check if we'd trusted the scanner's first answer.

Both false alarms failed for the *same* underlying reason, and it wasn't a coincidence. Our test-coverage check was reading results from the CLI package's official test command, and that command deliberately only counts one style of test file. Both of the functions in question were tested by the *other* style, the one that command doesn't count. The functions were fully tested. Our tool just wasn't looking in the right place to notice. We fixed the coverage check, added a regression test that reproduces exactly this trap, and wrote down why in the tool's own documentation so nobody rediscovers this the hard way.

The three functions that survived every check really were dead: two quota-display helpers nothing had called in about seven months, superseded by a rewrite that inlined the same logic elsewhere, and a one-line color-lookup wrapper that every real caller had already learned to skip. Ninety-eight lines, gone, verified safe from three separate directions before a single line was deleted.

## What this actually proves

This first pass was small on purpose. Ninety-eight lines out of a codebase with a couple thousand test files isn't going to show up in a build-time chart, and pretending otherwise would be the kind of overclaiming we'd rather not do. What it *does* prove is that the safety net holds under a real test, not just a hypothetical one. The tool caught genuinely dead code. It also almost shipped two false positives, and the verification pass caught both before they became a real regression. That's why we built a scanner that proposes and a separate pass that verifies, instead of one script that just deletes: the interesting failures don't show up until you run it against a real, messy codebase with conventions the tool has never seen before.

The Docker fix is still ahead of us, tracked as its own piece of work with its own review. The dead-code tool keeps running, one package at a time, each pass teaching it more about our own codebase's quirks. Put the two together and you get a more honest answer than "the codebase got bigger" ever was.

---

## Key Takeaways

- **The obvious explanation was only part of the story.** Rising Docker compute looked like a codebase-growth problem; the bigger driver turned out to be containers with no resource ceiling competing for the same host machine, tracked as a separate fix.
- **A dead-code scanner needs a fourth answer besides "delete it" and "keep it."** Ours added "I can't tell yet" as an explicit, first-class category, after an adversarial design review found real cases where a confident answer would have been wrong.
- **"Safe to delete" from a tool is a candidate, not a verdict.** A second, independent verification pass against the full codebase caught two false positives in this run's very first outing, one of them a security-relevant validation check.
- **Both false positives traced back to one root cause**: a test-coverage check blind to half our test-file conventions. The tool now defends against it with a regression test.
- **The real cleanup was small on purpose**: 3 functions, 98 lines, verified from three directions before deletion. Small and verifiably safe beats large and merely plausible.
