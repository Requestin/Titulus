/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        bg: 'oklch(var(--bg) / <alpha-value>)',
        surface: 'oklch(var(--surface) / <alpha-value>)',
        'surface-2': 'oklch(var(--surface-2) / <alpha-value>)',
        border: 'oklch(var(--border) / <alpha-value>)',
        overlay: 'oklch(var(--overlay) / <alpha-value>)',
        ink: 'oklch(var(--ink) / <alpha-value>)',
        'ink-muted': 'oklch(var(--ink-muted) / <alpha-value>)',
        'ink-faint': 'oklch(var(--ink-faint) / <alpha-value>)',
        primary: 'oklch(var(--primary) / <alpha-value>)',
        'primary-ink': 'oklch(var(--primary-ink) / <alpha-value>)',
        ring: 'oklch(var(--ring) / <alpha-value>)',
        live: 'oklch(var(--live) / <alpha-value>)',
        success: 'oklch(var(--success) / <alpha-value>)',
        warning: 'oklch(var(--warning) / <alpha-value>)',
        danger: 'oklch(var(--danger) / <alpha-value>)',
        info: 'oklch(var(--info) / <alpha-value>)',
      },
      fontFamily: {
        sans: ['Inter Variable', 'system-ui', 'sans-serif'],
        mono: ['ui-monospace', 'SF Mono', 'Menlo', 'monospace'],
      },
      zIndex: {
        dropdown: '30',
        sticky: '20',
        scrim: '40',
        modal: '50',
        toast: '60',
        tooltip: '70',
      },
    },
  },
  plugins: [],
};
