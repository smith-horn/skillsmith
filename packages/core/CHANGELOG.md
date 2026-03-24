# Changelog

All notable changes to `@skillsmith/core` are documented here.

## v0.4.15

- **Co-install recommendations**: `CoInstallRepository` and `AlsoInstalledSkill` types for tracking skills frequently installed together.
- **Compatibility tags**: Skills can declare compatibility frontmatter (LLMs, IDEs, platforms).
- **Repository and homepage links**: New `repository_url` and `homepage_url` fields on skill records.
- **Database migration v9**: SCHEMA_VERSION 9 with migrations for co-install and compatibility features.

## v0.4.7

- **Multi-language support**: Analyze TypeScript, JavaScript, Python, Go, Rust, and Java codebases with improved dependency management.
