// Theme tokens live in src/renderer/src/styles/index.css (dark default, light via data-theme).
// Colours are RGB channels so Tailwind opacity modifiers work (`border-bad/40`).
// Design: near-black canvas + structured layout (14 px cards, 34 px
// controls, uppercase tracked labels), with the Solana purple→green as the one accent.
/** @type {import('tailwindcss').Config} */
const c = (v) => `rgb(var(${v}) / <alpha-value>)`;
module.exports = {
  content: ['./src/renderer/index.html', './src/renderer/src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        bg: { DEFAULT: c('--bg'), card: c('--bg-card'), raised: c('--bg-raised'), hover: c('--bg-hover'), input: c('--bg-input') },
        line: { DEFAULT: 'var(--border)', strong: 'var(--border-strong)' },
        fg: { DEFAULT: c('--text'), dim: c('--text-dim'), muted: c('--text-muted') },
        accent: { DEFAULT: c('--accent'), ink: c('--accent-ink'), soft: 'var(--accent-soft)' },
        sol: { purple: c('--sol-purple'), green: c('--sol-green'), ink: '#0b0d0c' },
        ok: { DEFAULT: c('--green'), soft: 'var(--green-soft)' },
        warn: { DEFAULT: c('--yellow'), soft: 'var(--yellow-soft)' },
        bad: { DEFAULT: c('--red'), soft: 'var(--red-soft)' },
      },
      fontFamily: {
        sans: ['"Outfit Variable"', 'Outfit', '"Segoe UI Variable"', '"Segoe UI"', 'system-ui', 'sans-serif'],
        display: ['Tomorrow', '"Outfit Variable"', 'sans-serif'],
        mono: ['"JetBrains Mono Variable"', '"Cascadia Mono"', 'Consolas', 'ui-monospace', 'monospace'],
      },
      // Type scale (our standard). text-xs (12) and text-sm (14) are on it too.
      // Nothing renders under 10 px; body is never bold.
      fontSize: {
        label: ['10px', { lineHeight: '14px', letterSpacing: '0.08em', fontWeight: '500' }],
        meta: ['12px', { lineHeight: '16px' }],
        body: ['14px', { lineHeight: '20px' }],
        ctl: ['14px', { lineHeight: '20px', fontWeight: '500' }],
        section: ['18px', { lineHeight: '24px', fontWeight: '500' }],
        value: ['20px', { lineHeight: '28px', fontWeight: '500' }],
        title: ['24px', { lineHeight: '32px', fontWeight: '600' }],
        hero: ['36px', { lineHeight: '40px', fontWeight: '600' }],
      },
      borderRadius: { DEFAULT: '10px', lg: '14px', xl: '18px' },
      boxShadow: {
        card: '0 10px 30px rgba(0,0,0,.35)',
        glow: '0 0 0 4px rgb(var(--sol-purple) / .18), 0 8px 28px rgb(var(--sol-purple) / .28)',
        'glow-green': '0 0 0 4px rgb(var(--sol-green) / .14), 0 8px 28px rgb(var(--sol-green) / .22)',
      },
      backgroundImage: {
        sol: 'linear-gradient(135deg, rgb(var(--sol-purple)) 0%, rgb(var(--sol-green)) 100%)',
        'sol-soft': 'linear-gradient(135deg, rgb(var(--sol-purple) / .16) 0%, rgb(var(--sol-green) / .10) 100%)',
      },
      keyframes: {
        spinSlow: { to: { transform: 'rotate(360deg)' } },
        breathe: { '0%,100%': { opacity: '.55', transform: 'scale(1)' }, '50%': { opacity: '1', transform: 'scale(1.04)' } },
      },
      animation: { 'spin-slow': 'spinSlow 6s linear infinite', breathe: 'breathe 2.4s ease-in-out infinite' },
    },
  },
  plugins: [],
};
