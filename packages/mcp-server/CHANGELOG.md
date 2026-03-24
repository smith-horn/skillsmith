# Changelog

All notable changes to `@skillsmith/mcp-server` are documented here.

## v0.4.3

- **Co-install recommendations**: `get_skill` responses now include an `also_installed` array — skills frequently installed alongside this one, surfaced once ≥5 co-installs are observed. Also shown on skill detail pages at [www.skillsmith.app/skills](https://www.skillsmith.app/skills).
- **Repository and homepage links**: `search` and `get_skill` responses now include `repository_url` and `homepage_url` when declared by the skill author.
- **Compatibility tags**: Skills can declare `compatibility` frontmatter (LLMs, IDEs, platforms). Tags surface in search results and skill detail pages.

## v0.4.0

- **Quota-based throttling**: `skill_suggest` now counts against your monthly API quota instead of an undocumented per-session rate limit. Community (1,000/mo), Individual (10,000/mo), Team (100,000/mo), Enterprise (unlimited). See [www.skillsmith.app/pricing](https://www.skillsmith.app/pricing).
- **Graceful license degradation**: If the enterprise license check is unavailable, `skill_suggest` falls back to community-tier defaults rather than returning a hard error.

## v0.3.18

- **Async Initialization**: Server initializes asynchronously for faster startup
- **WASM Fallback**: Automatic fallback to sql.js when native SQLite unavailable
- **Robust Context Loading**: Graceful handling of initialization edge cases
