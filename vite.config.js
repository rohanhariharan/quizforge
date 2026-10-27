import { defineConfig } from 'vite';

export default defineConfig({
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    watch: { ignored: ['**/src-tauri/**'] },
  },
  optimizeDeps: {
    include: ['jquery', 'mathquill/build/mathquill.min.js', 'mammoth/mammoth.browser.js'],
  },
  build: {
    target: 'safari15',
    outDir: 'dist',
    emptyOutDir: true,
    chunkSizeWarningLimit: 1800,
  },
});
