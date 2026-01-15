/** @type {import('tailwindcss').Config} */
export default {
  content: ['./src/**/*.{astro,html,js,jsx,md,mdx,svelte,ts,tsx,vue}'],
  darkMode: 'class',

  theme: {
    extend: {
      // Skillsmith brand colors (Bold & Confident, Claude-aligned)
      colors: {
        // Dark foundation
        bg: {
          primary: '#0D0D0F',
          secondary: '#18181B',
          tertiary: '#27272A',
        },
        // Coral accent (primary brand color)
        coral: {
          DEFAULT: '#E07A5F',
          dark: '#D4694E',
          light: '#F09080',
        },
        // Supporting accents
        sage: '#81B29A',
        amber: '#F4A261',
      },

      // Typography - Satoshi + JetBrains Mono
      fontFamily: {
        sans: ['Satoshi', 'system-ui', '-apple-system', 'sans-serif'],
        mono: ['JetBrains Mono', 'Menlo', 'monospace'],
      },

      // Box shadows (warm glow aesthetic)
      boxShadow: {
        'glow': '0 0 40px rgba(224, 122, 95, 0.15)',
        'cta': '0 8px 32px rgba(224, 122, 95, 0.25)',
      },

      // Animations
      animation: {
        'fade-up': 'fadeUp 0.8s cubic-bezier(0.4, 0, 0.2, 1) forwards',
        'float': 'float 20s ease-in-out infinite',
      },
      keyframes: {
        fadeUp: {
          '0%': { opacity: '0', transform: 'translateY(24px)' },
          '100%': { opacity: '1', transform: 'translateY(0)' },
        },
        float: {
          '0%, 100%': { transform: 'translate(0, 0)' },
          '50%': { transform: 'translate(30px, -20px)' },
        },
      },
    },
  },

  plugins: [],
};
