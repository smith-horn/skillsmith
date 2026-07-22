# Analysis Commands

`analysis` is not a v3 CLI verb — running it errors out and suggests `analyze`, but **v3's `analyze` is a different product surface (code/diff analysis, not swarm performance)**. Do not lexically map `analysis`→`analyze`. These docs describe analysis-shaped workflows built from real v3 surfaces instead: bottleneck/report/metrics work lives under `performance`, token-usage work lives under `hooks` (`hooks token-optimize`, `hooks model-stats`).

## Available Commands

- [bottleneck-detect](./bottleneck-detect.md) — `performance bottleneck`
- [token-usage](./token-usage.md) — `hooks token-optimize` / `hooks model-stats`
- [token-efficiency](./token-efficiency.md)
- [performance-report](./performance-report.md) — `performance metrics`
