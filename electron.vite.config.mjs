import { resolve } from 'node:path'
import { defineConfig } from 'electron-vite'
import react from '@vitejs/plugin-react'

// Runtime "dependencies" (better-sqlite3, chokidar, zod) are externalised
// automatically by electron-vite and shipped in node_modules by electron-builder.
export default defineConfig({
  main: {},
  preload: {},
  renderer: {
    plugins: [react()],
    resolve: { alias: { '@shared': resolve('src/shared') } }
  }
})
