import { defineConfig } from 'vite';
import { resolve } from 'path';
import dts from 'vite-plugin-dts';

export default defineConfig({
  plugins: [
    dts({
      rollupTypes: true,
      outDir: 'dist',
    }),
  ],
  build: {
    lib: {
      entry: {
        node: resolve(__dirname, 'src/index.node.ts'),
        browser: resolve(__dirname, 'src/index.browser.ts'),
      },
      formats: ['es', 'cjs'],
      fileName: (format, entryName) => {
        const ext = format === 'es' ? 'mjs' : 'cjs';
        return `${entryName}.${ext}`;
      },
    },
    rolldownOptions: {
      external: ['eventsource', 'crypto', 'module'],
    },
  },
  test: {
    globals: true,
    environment: 'node',
  },
});
