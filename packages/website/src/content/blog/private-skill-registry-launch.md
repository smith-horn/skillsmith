---
title: "Your Team's Skills Don't Have to Go Public to Get Shared"
description: "Skillsmith's private skill registry is live for Enterprise teams: publish internal skills to your own team's shelf, review each one before it's installable, and keep every detail off the public index."
author: "Skillsmith Team"
date: 2026-08-23
category: "News"
tags: ["private-registry", "enterprise", "product-launch"]
featured: true
draft: false
ogImage: "https://res.cloudinary.com/diqcbcmaq/image/upload/f_auto,q_auto,w_1200,h_630,c_fill/blog/private-registry/01-skills-list-approved"
---

Picture a platform engineer who spends an afternoon writing a Claude skill that walks through her team's exact deploy runbook: which Terraform workspace to touch first, which Slack channel gets the rollback plan, who to page when the database owner is asleep. It's a genuinely useful skill. It's also full of internal service names, channel handles, and a company acronym that means nothing outside her building. Publishing it to Skillsmith's public registry was never an option, so it would have sat on her laptop, shared the old way: a Slack message with a zip file attached, hoping the next person remembered to ask for it.

That gap is closed today. Skillsmith's private skill registry is live for Enterprise teams: your team gets a registry of its own, invisible to anyone outside the company, and every skill that lands in it gets checked by a second person before a single teammate can install it.

Picture a supply closet with a lock on the door. Everyone on the team has a key. Nothing that goes on the shelf is visible to anyone outside your team, and it never reaches the public index. And before a new box lands on the shelf, someone else with a key has to open it and check what's inside first. That's the private registry: a shelf that's yours, gated by a review step that's mandatory, not optional.

Each team gets its own namespace, a short prefix like `acme-corp/`, so a skill published there can never collide with anything on the public index and can't even be seen by anyone outside the company.

Here's what changed on the day-to-day: a team member writes a skill and submits it through Claude. It doesn't go live. It lands on the team admin's dashboard as a pending submission, sitting in a waiting room until someone reviews it.

![The private registry dashboard showing an approved skill listing](https://res.cloudinary.com/diqcbcmaq/image/upload/f_auto,q_auto,w_1200/blog/private-registry/01-skills-list-approved)

An admin reads the description, checks the version, and approves it. Only then does the skill move from submitted to installable. Reject it, and it never reaches a single laptop. Nobody, not even the person who wrote it, can approve their own submission: a second set of eyes is built into the door, not bolted on after the fact.

Once a skill is approved, installing it is one line from a terminal:

```
skillsmith registry install acme-corp/deploy-runbook
```

The skill lands in the same place a public one would, ready to use in Claude Code, with none of the internal detail ever touching a public index.

Your team's skills don't have to choose between staying on one laptop and going fully public anymore. There's a shelf in between now, and it has a lock.

That deploy runbook could be on the shelf today, reviewed once, installed by every teammate who needs it, with nobody messaging the person who wrote it at 2am to ask how the rollback works.
