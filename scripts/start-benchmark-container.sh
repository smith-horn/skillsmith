#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."

# Remove stale container if exists
docker rm -f evoskill-benchmark-harness-dev-1 2>/dev/null || true

# Start container with overridden entrypoint + dataset volume
DEV_PORT=3811 docker compose --profile dev up -d

# Install deps (do NOT suppress stderr — surface errors)
docker exec evoskill-benchmark-harness-dev-1 npm install

# Fallback: remove nested posthog-node if override didn't hoist it
docker exec evoskill-benchmark-harness-dev-1 bash -c \
  'test -d /app/packages/core/node_modules/posthog-node && rm -rf /app/packages/core/node_modules/posthog-node || true'

# Build only benchmark-relevant packages
docker exec evoskill-benchmark-harness-dev-1 npm run build --workspace=@skillsmith/core
docker exec evoskill-benchmark-harness-dev-1 npm run build --workspace=@skillsmith/cli

echo "Container ready. Run benchmarks with:"
echo "  docker exec evoskill-benchmark-harness-dev-1 node /app/packages/cli/dist/src/index.js benchmark evoskill --help"
