import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  // Discover the lazy PDF renderer before opening a document. Otherwise Vite
  // can rebuild its dependency cache and reload a page with an open profile.
  optimizeDeps: { include: ['pdfjs-dist/legacy/build/pdf.mjs'] },
})
