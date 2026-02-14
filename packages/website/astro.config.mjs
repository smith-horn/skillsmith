import { defineConfig } from 'astro/config'
import sitemap from '@astrojs/sitemap'
import vercel from '@astrojs/vercel'
import tailwindcss from '@tailwindcss/vite'

// https://astro.build/config
export default defineConfig({
  site: 'https://www.skillsmith.app',

  integrations: [
    sitemap({
      serialize(item) {
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
  image: {
    domains: [
      'picsum.photos',
      'api.skillsmith.app',
      'avatars.githubusercontent.com',
      'res.cloudinary.com',
    ],
    remotePatterns: [
      {
        protocol: 'https',
        hostname: '**.picsum.photos',
      },
      {
        protocol: 'https',
        hostname: 'avatars.githubusercontent.com',
      },
      {
        protocol: 'https',
        hostname: 'res.cloudinary.com',
        pathname: '/diqcbcmaq/**',
      },
    ],
  },

  // Prefetch configuration for better navigation
  prefetch: {
    prefetchAll: true,
    defaultStrategy: 'viewport',
  },
})
