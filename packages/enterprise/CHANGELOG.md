# Changelog

All notable changes to `@smith-horn/enterprise` are documented here.

## [Unreleased]

- **Bump**: `@skillsmith/core` dep range to `^0.5.8` — pulls in SMI-4563 native SQLite driver auto-install via `optionalDependencies`. Enterprise package's own version unchanged; downstream installs will now resolve `core@0.5.8` with native better-sqlite3 by default instead of WASM fallback.
