import { defineConfig } from 'tsup'

export default defineConfig({
  entry: {
    index: 'sdk/src/index.ts',
    'client/index': 'sdk/src/client/index.ts',
    'server/index': 'sdk/src/server/index.ts',
    'channel/index': 'sdk/src/channel/index.ts',
    'channel/client/index': 'sdk/src/channel/client/index.ts',
    'channel/server/index': 'sdk/src/channel/server/index.ts',
  },
  format: 'esm',
  dts: true,
  sourcemap: true,
  clean: true,
  outDir: 'dist',
  external: ['xrpl', 'mppx'],
})
