import type { Config } from 'tailwindcss';

export default {
  content: ['./src/**/*.{ts,tsx,html}'],
  theme: {
    extend: {
      colors: {
        primary: '#4F46E5',
        danger: '#DC2626',
        warning: '#F59E0B',
        success: '#10B981',
      },
    },
  },
  plugins: [],
} satisfies Config;
