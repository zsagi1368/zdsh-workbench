import { defineConfig } from 'tsdown'

// Runtime-provided modules stay external in BOTH halves: @deepseek-ai/* is
// supplied by the DSH web profile, react by the host page's shared React.
const sharedExternal = [/^react($|[./])/, /^react-dom($|[./])/, /^@deepseek-ai\//]

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
    external: sharedExternal,
    dts: false,
  },
  {
    entry: { client: 'src/client/index.tsx' },
    outDir: 'lib',
    format: 'esm',
    platform: 'browser',
    outExtensions: () => ({ js: '.js' }),
    clean: false,
    external: sharedExternal,
    // Browser imports cannot resolve bare specifiers from node_modules;
    // everything the host page does not provide must be INLINED.
    noExternal: [/^@xterm\//],
    dts: false,
  },
])
