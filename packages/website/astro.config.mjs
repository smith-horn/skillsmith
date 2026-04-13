import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
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

  // TypeScript configuration
  typescript: {
    strict: true,
  },

  // Vite configuration for API proxy in development
  vite: {
    plugins: [tailwindcss()],
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
