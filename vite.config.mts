import { cocosPanel, cocosPanelConfig } from '@cocos-fe/vite-plugin-cocos-panel';
import vue from '@vitejs/plugin-vue';
import { nodeExternals } from 'rollup-plugin-node-externals';
import { defineConfig } from 'vite';

export default defineConfig(({ mode }) => {
  const isDev = mode === 'development';

  return {
    build: {
      outDir: 'dist',
      emptyOutDir: true,
      target: 'es2022',
      minify: false,
      sourcemap: isDev ? 'inline' : false,
      cssCodeSplit: true,
      lib: {
        entry: {
          main: './src/main/index.ts',
          'scene-script': './src/main/scene-script.ts',
          board: './src/panel/board.ts',
          chat: './src/panel/chat.ts',
          status: './src/panel/status.ts',
          panel: './src/panel/index.ts',
          'cocos-tools': './src/agent/cocos-tools.ts',
        },
        formats: ['cjs'],
        fileName: (_format, entryName) => `${entryName}.js`,
      },
      rollupOptions: {
        external: ['electron'],
      },
    },
    plugins: [
      vue({
        template: {
          compilerOptions: {
            isCustomElement: (tag) => tag.startsWith('ui-'),
          },
        },
      }),
      nodeExternals({
        builtins: true,
        deps: false,
        devDeps: false,
        peerDeps: false,
        optDeps: false,
      }),
      cocosPanelConfig(),
      cocosPanel({ autoReload: isDev, port: 8091 }),
    ],
  };
});
