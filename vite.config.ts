import { defineConfig } from 'vite';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import dts from 'vite-plugin-dts';

// `npm version` (publish-npm.yml) bumps package.json only, so package.json is
// the single source of the SDK's version. Inlining it here keeps the User-Agent
// from drifting the way it did in #2141.
const pkg = JSON.parse(
  readFileSync(resolve(__dirname, 'package.json'), 'utf-8')
) as { version: string };

export default defineConfig({
  define: {
    __SDK_VERSION__: JSON.stringify(pkg.version),
  },
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
      // 'module' was here for the createRequire() that loaded eventsource; #2246
      // replaced that with a dynamic import(), so nothing imports it any more.
      external: ['eventsource', 'crypto'],
    },
  },
  test: {
    globals: true,
    environment: 'node',
  },
});
