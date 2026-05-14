/** @type {import('tailwindcss').Config} */
module.exports = {
  content: ['./src/**/*.{js,ts,jsx,tsx,mdx}'],
  theme: {
    extend: {
      colors: {
        buff: {
          primary: '#1a1a2e',
          secondary: '#16213e',
          accent: '#0f3460',
          highlight: '#e94560',
          green: '#00d084',
          red: '#e94560',
          gold: '#ffd93d',
        },
      },
    },
  },
  plugins: [],
};
