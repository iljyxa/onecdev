import { defineConfig } from 'vite';
import { aliases, nodeExternal, thirdPartyLicensesPlugin } from './vite.shared';

export default defineConfig({
  plugins: [thirdPartyLicensesPlugin('node', 'dist')],
  resolve: {
    alias: aliases,
    conditions: ['node', 'require'],
    mainFields: ['module', 'jsnext:main', 'jsnext', 'main'],
  },
  build: {
    target: 'node18',
    outDir: 'dist',
    emptyOutDir: false,
    sourcemap: true,
    lib: {
      entry: {
        extension: 'src/extension.ts',
        'cli/onec-tools': 'src/cli/onec-tools.ts',
      },
      formats: ['cjs'],
    },
    rollupOptions: {
      external: nodeExternal,
      output: {
        entryFileNames: '[name].js',
        chunkFileNames: 'chunks/[name].js',
        assetFileNames: 'assets/[name][extname]',
        exports: 'named',
      },
    },
  },
});
