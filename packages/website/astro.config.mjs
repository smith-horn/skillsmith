import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { copyFileSync, existsSync } from 'node:fs'
import { defineConfig } from 'astro/config'
import sitemap from '@astrojs/sitemap'
import vercel from '@astrojs/vercel'
import tailwindcss from '@tailwindcss/vite'
import { computeFallback, getLastmodFor, loadBlogDates } from './src/lib/sitemap-lastmod.mjs'

// SMI-4184: sitemap lastmod for GSC Discovered-not-indexed.
// Blog dates sourced from frontmatter at config eval; non-blog pages get a
// stable fallback (Google penalizes per-build lastmod churn). Empty dir →
// static fallback, so the config never emits Invalid Date.
const BLOG_DIR = join(dirname(fileURLToPath(import.meta.url)), 'src/content/blog')
const BLOG_DATES = loadBlogDates(BLOG_DIR)
const FALLBACK_LASTMOD = computeFallback(BLOG_DATES)

// https://astro.build/config
export default defineConfig({
  site: 'https://www.skillsmith.app',

  integrations: [
    sitemap({
      serialize(item) {
        // Exclude private/auth/account pages and A/B test variants from sitemap.
        // Use pathname.startsWith() not includes() to avoid false positives (SMI-3077).
        // Also check exact match (no trailing slash) for redirect-only pages like /verify.
        const pathname = new URL(item.url).pathname
        const excluded = [
          '/account/',
          '/auth/',
          '/login/',
          '/signup/',
          '/verify/',
          '/index-v2/',
          '/index-v3/',
        ]
        if (excluded.some((p) => pathname === p.slice(0, -1) || pathname.startsWith(p))) {
          return undefined
        }

        // High-priority pages
        if (item.url === 'https://www.skillsmith.app/') {
          item.priority = 1.0
          item.changefreq = 'weekly'
        } else if (/\/(pricing|docs\/quickstart)\/?$/.test(item.url)) {
          item.priority = 0.9
          item.changefreq = 'monthly'
        } else if (/\/docs\/?/.test(item.url)) {
          item.priority = 0.8
          item.changefreq = 'monthly'
        } else if (/\/blog\/?$/.test(item.url)) {
          item.priority = 0.8
          item.changefreq = 'weekly'
        } else if (/\/blog\//.test(item.url)) {
          item.priority = 0.7
          item.changefreq = 'monthly'
        } else {
          item.priority = 0.5
          item.changefreq = 'monthly'
        }

        item.lastmod = getLastmodFor(pathname, BLOG_DATES, FALLBACK_LASTMOD)

        return item
      },
    }),
  ],

  // Markdown configuration with Shiki syntax highlighting
  markdown: {
    shikiConfig: {
      theme: 'github-dark',
      wrap: true,
    },
  },

  // Vercel adapter for hybrid rendering
  adapter: vercel(),

  // Build output configuration - static with SSR adapter for dynamic routes
  output: 'static',

  // SMI-5892: default compressHTML "jsx" mode applies JSX whitespace
  // semantics to .astro templates — it removes (not collapses) a
  // newline-containing whitespace-only text node at an inline-tag
  // boundary, silently swallowing spaces in hand-wrapped prose
  // (e.g. "Install & Use</a>\ntutorial." -> "Install & Usetutorial.").
  // `true` uses standard HTML-spec whitespace collapsing instead.
  compressHTML: true,

  // TypeScript configuration
  typescript: {
    strict: true,
  },

  // Vite configuration for API proxy in development
  vite: {
    // SMI-5747: worktree node_modules is a symlink back to the main checkout,
    // so Docker's bind mount at /app/node_modules resolves through it and
    // Node canonicalizes module paths to /node_modules/*, splitting Astro's
    // compile-cache key from its lookup key ("No cached compile metadata
    // found"). Keep resolution under the symlinked path Astro actually built
    // the cache under, instead of the realpath.
    resolve: {
      preserveSymlinks: true,
    },
    plugins: [
      tailwindcss(),
      // SMI-5205: publish OpenAPI spec from docs/internal submodule to public/ at build time.
      // Source stays at docs/internal/api/openapi.yaml (single source of truth).
      // Skip silently if the submodule is not initialized (external contributors, CI without submodule).
      {
        name: 'publish-openapi-spec',
        buildStart() {
          const src = join(
            dirname(fileURLToPath(import.meta.url)),
            '../../docs/internal/api/openapi.yaml'
          )
          const dest = join(dirname(fileURLToPath(import.meta.url)), 'public/openapi.yaml')
          if (existsSync(src)) {
            copyFileSync(src, dest)
          }
        },
      },
    ],
    server: {
      proxy: {
        '/api': {
          target: 'https://api.skillsmith.app',
          changeOrigin: true,
          rewrite: (path) => path.replace(/^\/api/, ''),
        },
      },
    },
    define: {
      'import.meta.env.PUBLIC_API_BASE_URL': JSON.stringify(
        process.env.PUBLIC_API_BASE_URL || 'https://api.skillsmith.app'
      ),
    },
  },

  // Image optimization
  // Cloudinary (res.cloudinary.com) intentionally excluded — its CDN handles
  // f_auto format negotiation, q_auto quality, and responsive sizing better
  // than Astro's local image service. Blog images pass through as-is.
  image: {
    domains: ['api.skillsmith.app', 'avatars.githubusercontent.com'],
    remotePatterns: [
      {
        protocol: 'https',
        hostname: 'avatars.githubusercontent.com',
      },
    ],
  },

  // Prefetch configuration for better navigation
  prefetch: {
    prefetchAll: true,
    defaultStrategy: 'viewport',
  },
})
