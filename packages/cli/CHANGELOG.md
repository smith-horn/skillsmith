# Changelog — @skillsmith/cli

All notable changes to this package are documented here.

Format follows [Keep a Changelog](https://keepachangelog.com/en/1.0.0/).

## [0.5.0] - 2026-03-06

### Added

- `skillsmith create <name>` command (alias: `sklx create`) — scaffold a new Claude Code skill directly into `~/.claude/skills/<name>/` without installing a separate skill-builder skill (SMI-3083)
  - Interactive prompts: description, author, skill type (basic/intermediate/advanced), behavioral classification (autonomous/guided/interactive/configurable), scripts directory opt-in
  - Fully non-interactive via `--description`, `--author`, `--category`, `--type`, `--behavior`, `--scripts` flags
  - `--dry-run` flag previews scaffold output without writing files
  - `--yes` auto-confirms overwrite when skill directory already exists
  - Scaffolds: `SKILL.md` (with Behavioral Classification section), `README.md`, `CHANGELOG.md`, `.gitignore`, `resources/`, optional `scripts/`
  - Publishing checklist printed on completion, aligned with v1.1.0 publish gate requirements
- `validateSkillName()` utility extracted to `src/utils/skill-name.ts` — shared by `create` and `author init` for consistent registry-safe name validation
- `CHANGELOG_MD_TEMPLATE` added to `src/templates/` and exported from `src/templates/index.ts`
- `{{behavioralClassification}}` placeholder added to `SKILL_MD_TEMPLATE` — `author init` passes `''`; `create` fills in the Behavioral Classification section

### Changed

- `skillsmith author init` now uses the shared `validateSkillName()` (stricter: lowercase + hyphens only, consistent with registry slug format)

## [0.4.3] - 2026-02-14

### Fixed

- Bump `@skillsmith/core` pin to `0.4.15` to match workspace version

## [0.4.2] - 2026-02-13

### Fixed

- Version bump (0.4.1 was already taken on npm registry)

## [0.4.1] - 2026-02-13

### Fixed

- Publish `@skillsmith/core@0.4.11` with credential storage exports

## [0.4.0] - 2026-02-10

### Added

- `skillsmith login` / `skillsmith logout` / `skillsmith whoami` commands (SMI-2710–2717)
- `--description`, `--author`, `--category`, `--yes` non-interactive flags for `skillsmith author init` (SMI-1473)

## [0.3.8] - 2026-01-28

### Changed

- Migrated to `createDatabaseAsync` + deprecated schema sync exports (SMI-2721 Wave 2)
- Updated `@skillsmith/core` to `0.4.10`
