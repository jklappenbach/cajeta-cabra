import react from '@vitejs/plugin-react'
import { defineConfig } from 'vitest/config'

// Built output is served by `cabra host --web web/dist` from the host's
// own port (spec §10.1), so asset URLs are relative. In dev, Vite
// serves the page and proxies /ws to a running host.
export default defineConfig({
  base: './',
  plugins: [react()],
  server: {
    proxy: {
      '/ws': { target: 'ws://127.0.0.1:8850', ws: true },
    },
  },
  test: {
    include: ['src/**/*.test.ts'],
  },
})
