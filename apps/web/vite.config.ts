import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import path from 'node:path'

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      '@': path.resolve(import.meta.dirname, './src'),
      // Compile the workspace core as source, not as a prebundled dep.
      '@recall/core': path.resolve(import.meta.dirname, '../../packages/core/src/index.ts'),
    },
  },
  // sqlite-wasm ships its own .wasm loader; pre-bundling breaks it.
  optimizeDeps: { exclude: ['@sqlite.org/sqlite-wasm'] },
})
