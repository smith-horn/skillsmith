---
title: "The Parking Garage With No Gate"
description: "We run a dedicated Docker container for every parallel coding-agent session. It worked great until the host machine started drowning. Here are the six things we had to build to make many concurrent containers survivable."
author: "Ryan Smith"
date: 2026-08-15
updated: 2026-08-15
category: "Engineering"
tags: ["docker", "developer-tooling", "engineering-culture", "infrastructure", "agentic-engineering"]
featured: false
draft: false
ogImage: "https://res.cloudinary.com/diqcbcmaq/image/upload/f_auto,q_auto,w_1200,h_630,c_fill/blog/the-parking-garage-with-no-gate/01-hero"
---

<!-- IMAGE: 01-hero
  A wide-format hero graphic with a dark gradient background (deep navy to charcoal),
  consistent with the existing Skillsmith blog aesthetic. Center composition: a
  stylized multi-level parking garage rendered in a flat/geometric style, seen at
  a three-quarter angle. Small glowing rectangular "containers" (like shipping
  containers or server-rack blocks, doubling as "cars") are packed into every
  level with no marked capacity and no barrier arm at the entrance ramp. One
  level near the top shows a newly-added barrier arm / gate with a ticket-booth
  icon, glowing amber, visually distinct from the rest of the still-open garage,
  suggesting a fix in progress. Faint ghosted grid lines in the background evoke
  a circuit board / server topology. Style: flat/geometric, dark, technical.
  Dimensions: 1200x630.
-->
![The Parking Garage With No Gate](https://res.cloudinary.com/diqcbcmaq/image/upload/f_auto,q_auto,w_1200/blog/the-parking-garage-with-no-gate/01-hero)

A few months ago we noticed our Docker containers running hotter than they used to. Fans spinning up on an idle-looking afternoon. Builds that used to take two minutes taking six. The first guess was the obvious one: our codebase got bigger. That was true. The monorepo had absorbed thousands of commits in a matter of months, and bigger codebases cost more to build and test.

But it was only part of the story. The real driver was a decision we'd made on purpose and never finished. Our development workflow spins up a dedicated Docker container per task, because we run many coding-agent sessions in parallel, each on its own isolated git worktree. One session refactors a service while another writes tests for a different package while a third chases a flaky CI job. Isolation per task is a genuinely good pattern. Containers don't step on each other's files, branches, or dependency state.

What we'd built was a parking garage with no posted capacity and no gate. Cars keep pulling in. Nobody ever gets turned away. Every container that enters competes for the exact same slice of host CPU and memory as every other one, unbounded. Three sessions, fine. Six, sluggish. Ten, and the whole machine is a line of cars idling in the aisles, every one of them convinced it's about to find a spot.

The tempting fix is a bigger garage: more RAM, more cores. That treats the symptom. The actual fix is a gate with a real ticket system. Explicit limits, plus the operational tooling that makes many concurrent, isolated containers survivable instead of a free-for-all. Here's what that took, as six principles you can apply directly if your own agent tooling is about to run many concurrent sessions in Docker.

## 1. Post a capacity number, because Docker won't

Docker Compose gives your dev service no resource ceiling by default. No `cpus`, no `mem_limit`, no `deploy.resources.limits` means every container you start is entitled to the entire host. That's the garage with no posted capacity, literally: the constraint doesn't exist until you write it down.

So write it down. Put a numeric ceiling on the compose service definition. And size it with a documented formula, not a hardcoded value. A limit calibrated for a 16-core, 64GB machine will starve a laptop with half the resources and waste half of a bigger workstation. The number itself matters less than the fact that it's derived from the host's real core and RAM count, and that the derivation is written where the next person can find it. Copy the formula between machines, never the value.

## 2. Assign the parking spots

If every dev container defaults to the same port, say 3000 or 3001, only one of them can bind it. The second container to start doesn't degrade gracefully. It fails outright, and in an agent-driven workflow, it fails while nobody is watching.

A fixed port baked into the base compose file is a single parking spot with ten cars aimed at it. The fix is a port allocation scheme that is deterministic per worktree but collision-safe across worktrees: an env var override like `DEV_PORT=<n>`, combined with a bucket-assignment scheme so two worktrees don't land on the same number by coincidence. Deterministic matters because tooling needs to predict where a given worktree's server lives. Collision-safe matters because "pick a random port" trades one intermittent failure for another.

## 3. Don't let two cars share one engine

The nastiest failures came from native modules. If multiple containers bind-mount the same host directory read-write, say a shared `node_modules`, and any of those modules were compiled for the host's architecture instead of the container's, you're in trouble the moment two containers touch that mount concurrently. On a macOS ARM host running Linux containers, the mismatch is guaranteed. It surfaces as a cryptic "invalid ELF header" or a native binding that refuses to load, hours after the action that caused it, in a container that did nothing wrong.

The durable pattern has two halves. Mount shared dependency directories read-only into each container, so no container can corrupt what its siblings depend on. Then seed the native modules, the handful that actually need per-architecture compilation, into separate named volumes per container, outside the shared mount. You get the speed of sharing everything that's safe to share, and isolation for exactly the parts that aren't.

The pattern to avoid is a full dependency reinstall inside every container. It works, but it's slow, and it quietly defeats the reason you shared anything in the first place.

## 4. Know which car is yours before you turn the key

With one container, `docker exec` into "the dev container" is unambiguous. With ten containers across ten worktrees, any script, wrapper, or hook that resolves a container by a loose convention can silently land on the wrong one. This is the failure mode that scared us most, because it produces no error. You run tests against a sibling task's container, they pass against the sibling's code, and you ship a change you never actually tested.

Two rules fixed it. First, container names are generated deterministically from the worktree path and branch at container-creation time, so identity is derived, never assumed. Second, every script that targets a container must fail loudly when it can't resolve the container it was aimed at. A tool that guesses is worse than a tool that stops, because the guess looks exactly like success.

## 5. The garage has to reopen itself

Agents run unattended for long stretches, and long stretches include Docker Desktop restarts, host reboots, and the occasional corrupted native binding from an architecture mismatch. If recovering from any of those requires a human to notice a cryptic error and run a manual rebuild command, your workflow has an availability problem, because the human is asleep and the agent is stuck.

Two mechanisms cover most of it. `restart: unless-stopped` on the compose service brings containers back on their own after a host restart, while still honoring an explicit stop. And an entrypoint-level self-heal step detects broken native bindings on container start and rebuilds them automatically. Every failure that previously read "notice the error, look up the fix, run the rebuild" became "restart the container." Most of the time, nobody even does the restarting.

## 6. Check the ticket still matches the car

When multiple containers and worktrees share one host-side dependency tree, that tree drifts. A branch that added a dependency won't magically trigger a fresh install when you check it out. A branch that removed one leaves the old artifact sitting there. "It was installed at some point" is not evidence that it's correct for what's currently checked out, but it's exactly what an unguarded setup silently assumes.

The fix is an explicit freshness check: hash the lockfile's content, compare it against a sentinel value stamped at the last real install, and warn or block when they diverge. It's a small amount of machinery for a large class of bug, the kind where a test fails against a dependency version that no branch actually specifies, and you spend an hour debugging code that was never wrong.

## What changed when the gate went up

The mechanical wins showed up first. The host stopped thrashing under load, because a container hitting its ceiling slows itself down instead of slowing everyone down. Port failures went to zero. The "invalid ELF header" class of corruption stopped happening, because no container can write into a sibling's dependencies anymore. Restarts and rebinding repairs happen without a human in the loop.

But the bigger win was the one the analogy predicts. A garage with a gate and a ticket system doesn't only control entry. It tells you who's inside, and it lets you reason about capacity instead of discovering it through failure. When the machine slows down now, we can say which containers hold which resources and decide, deliberately, whether to admit another session. Before, the only signal was the whole building groaning.

If your agent tooling is heading toward many concurrent sessions in Docker, the isolation-per-task pattern is worth keeping. Just don't do what we did and build the garage first, then wait for the traffic jam to design the gate. Docker gives you the walls and the spots. The ceiling, the ticket system, and the tow truck are yours to build.

## Key Takeaways

- Set explicit `cpus` and memory limits on your dev compose service, sized by a documented formula from the host's real core and RAM count, never a hardcoded value copied between machines.
- Give each concurrent container a deterministic, collision-safe port via an env override and a bucket-assignment scheme, instead of a fixed port in the base compose file.
- Mount shared dependency directories read-only and seed per-architecture native modules into per-container named volumes; skip the full reinstall-everywhere approach.
- Derive container names deterministically from the worktree path and branch, and make every container-targeting script fail loudly when it can't resolve its intended target.
- Add `restart: unless-stopped` plus an entrypoint self-heal that rebuilds broken native bindings on start, so recovery never waits on a human noticing a cryptic error.
- Guard shared dependency trees with a lockfile content hash checked against a sentinel from the last real install, and warn or block on drift instead of running stale dependencies.
