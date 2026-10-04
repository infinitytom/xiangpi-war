import { defineConfig } from 'vite';
import { viteSingleFile } from 'vite-plugin-singlefile';

// npm run build        → dist/（普通多文件，部署用）
// npm run build:single → dist-single/index.html（单文件，方便直接发给平板打开）
export default defineConfig(({ mode }) => ({
  base: './',
  define: { __BUILD_ID__: JSON.stringify(process.env.BUILD_ID || String(Date.now())) },
  server: { host: true },
  plugins: mode === 'single' ? [viteSingleFile()] : [],
  build: { outDir: mode === 'single' ? 'dist-single' : 'dist', target: 'es2020', chunkSizeWarningLimit: 4000 },
}));
