import { resolve } from 'node:path'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'

// Nutzungsdaten (PostHog): Projektschlüssel und Host kommen beim Bauen aus der Umgebung,
// im Release-Workflow aus den Repository-Variablen. Ohne Schlüssel sendet die App nichts.
const posthog = {
  __POSTHOG_KEY__: JSON.stringify(process.env.POSTHOG_KEY?.trim() ?? ''),
  __POSTHOG_HOST__: JSON.stringify(process.env.POSTHOG_HOST?.trim() ?? '')
}

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    define: posthog,
    resolve: { alias: { '@shared': resolve('src/shared') } },
    build: {
      rollupOptions: {
        input: { index: resolve('src/main/index.ts') }
      }
    }
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    resolve: { alias: { '@shared': resolve('src/shared') } },
    build: {
      rollupOptions: {
        input: {
          ui: resolve('src/preload/ui.ts'),
          engine: resolve('src/preload/engine.ts')
        },
        output: { format: 'cjs', entryFileNames: '[name].js' }
      }
    }
  },
  renderer: {
    resolve: { alias: { '@shared': resolve('src/shared'), '@': resolve('src/renderer/src') } },
    plugins: [react()],
    build: {
      rollupOptions: {
        input: { index: resolve('src/renderer/index.html') }
      }
    }
  }
})
