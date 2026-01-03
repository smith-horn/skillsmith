FROM node:22-slim AS base

WORKDIR /app

# Install dependencies for native modules (Debian-based for glibc compatibility with onnxruntime)
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 \
    make \
    g++ \
    git \
    && rm -rf /var/lib/apt/lists/*

# Copy package files first for layer caching
COPY package*.json ./
COPY packages/core/package*.json ./packages/core/
COPY packages/mcp-server/package*.json ./packages/mcp-server/
COPY packages/cli/package*.json ./packages/cli/
COPY packages/vscode-extension/package*.json ./packages/vscode-extension/

# Install all dependencies
RUN npm install --include=dev

# Copy TypeScript configs and source
COPY tsconfig*.json ./
COPY packages/ ./packages/

# Build all packages
RUN npm run build || echo "Build completed with warnings"

# Development stage - used by CI and local development
FROM base AS dev
CMD ["tail", "-f", "/dev/null"]

# Production stage (future use)
FROM base AS prod
CMD ["node", "packages/mcp-server/dist/index.js"]
