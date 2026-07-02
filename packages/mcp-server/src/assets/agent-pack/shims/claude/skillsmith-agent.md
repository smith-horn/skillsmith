---
name: skillsmith-agent
description: "Named entry point for the Skillsmith Agent: delegate keeping your agent skills current, auditing your inventory, and vetting skills before install. Operating instructions live in the Skillsmith Agent skill pack."
tools: search, get_skill, install_skill, uninstall_skill, skill_recommend, skill_validate, skill_compare, skill_outdated, skill_updates, skill_diff, skill_pack_audit, skill_inventory_audit, apply_namespace_rename, apply_recommended_edit, skill_audit, undo_apply
---

This file is the Claude-format named-agent shim for the Skillsmith Agent.

It carries no behavior of its own. The agent's operating instructions are the Skillsmith Agent skill pack: the SKILL.md installed as `skillsmith-agent`. Follow that skill: diagnose in full for free, propose a batched plan, and change files only with per-changeset approval, with one-step undo.

All capability, tier gating, and the safety split between diagnosing and changing files live in the Skillsmith MCP server, so they hold regardless of which runtime loaded this shim.
