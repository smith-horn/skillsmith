import { defineConfig } from 'astro/config';
import sitemap from '@astrojs/sitemap';

// https://astro.build/config
export default defineConfig({
  site: 'https://skillsmith.app',

  integrations: [
    sitemap(),
  ],

  // Build output configuration
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
});
