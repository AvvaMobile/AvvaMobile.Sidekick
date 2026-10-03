import { resolve } from 'node:path';
import { defineConfig, externalizeDepsPlugin } from 'electron-vite';

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: { input: { index: resolve(__dirname, 'src/main/index.ts') } },
    },
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
        input: { shell: resolve(__dirname, 'src/preload/shell.ts'), relay: resolve(__dirname, 'src/preload/relay.ts') },
        output: { format: 'cjs', entryFileNames: '[name].js' },
      },
    },
  },
  renderer: {
    root: resolve(__dirname, 'src/renderer'),
    esbuild: { jsx: 'automatic' },
    build: {
      rollupOptions: {
        input: {
          shell: resolve(__dirname, 'src/renderer/shell/index.html'),
          relay: resolve(__dirname, 'src/renderer/relay/index.html'),
        },
      },
    },
  },
});
