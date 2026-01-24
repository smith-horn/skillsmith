import { defineConfig } from 'astro/config'
import sitemap from '@astrojs/sitemap'
import vercel from '@astrojs/vercel'

// https://astro.build/config
export default defineConfig({
  site: 'https://skillsmith.app',

  integrations: [sitemap()],

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
  image: {
    domains: ['picsum.photos', 'api.skillsmith.app'],
    remotePatterns: [
      {
        protocol: 'https',
        hostname: '**.picsum.photos',
      },
    ],
  },

  // Prefetch configuration for better navigation
  prefetch: {
    prefetchAll: true,
    defaultStrategy: 'viewport',
  },
})
