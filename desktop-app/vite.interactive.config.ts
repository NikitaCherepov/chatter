import { defineConfig } from 'vite';
import * as path from 'node:path';

// Compiler and React ship locally; no CDN or runtime package installs.
export default defineConfig({
  build: {
    outDir: 'dist/interactive', emptyOutDir: true, minify: true,
    lib: { entry: path.resolve(__dirname, 'src/interactive/runtime.tsx'), name: 'ChatterInteractive', formats: ['iife'], fileName: () => 'runtime.js' },
    rollupOptions: { output: { inlineDynamicImports: true } },
  },
  define: { 'process.env.NODE_ENV': JSON.stringify('production') },
});
