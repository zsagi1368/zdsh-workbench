import { defineConfig } from 'tsdown'

export default defineConfig([
  {
    entry: { index: 'src/host/index.ts' },
    outDir: 'lib',
    format: 'esm',
    platform: 'node',
    // The manifest (package.json exports, dsh.plugin.json) names ./lib/index.js
    // and ./lib/client.js; keep the plain .js extension ESM already implies.
    outExtensions: () => ({ js: '.js' }),
    // The build script's rmSync owns lib/ cleanup and tsc emits lib/types/
    // BEFORE bundling; tsdown's own clean would wipe those declarations.
    clean: false,
    dts: false,
  },
  {
    entry: { client: 'src/client/index.tsx' },
    outDir: 'lib',
    format: 'esm',
    platform: 'browser',
    outExtensions: () => ({ js: '.js' }),
    clean: false,
    dts: false,
  },
])
