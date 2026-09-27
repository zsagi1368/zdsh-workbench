import { defineConfig } from 'tsdown'

// Runtime-provided modules stay external in BOTH halves: @deepseek-ai/* is
// supplied by the DSH web profile, react by the host page's shared React.
const sharedExternal = [/^react($|[./])/, /^react-dom($|[./])/, /^@deepseek-ai\//]

// Loader registration id — the host boot graph derives each client row's id
// from package.json "name" (zDSH-main packages/client/modules: graphRow rows
// keyed by the located manifest name), and the module system throws if the
// executed bundle registers under any other id. Keep this string exactly in
// sync with package.json "name" when the package identity ever changes.
// (Factory-form vendor bundle, PluginCenter tsdown.config.ts precedent.)
const loaderBanner =
  'window.__ModuleLoader__.load({\n' +
  '  id: "zdsh-workbench",\n' +
  '  factory: (require) => {\n' +
  '    var module = { exports: {} };\n' +
  '    var exports = module.exports;\n'
const loaderFooter = '\n    return module.exports;\n  }\n});'

export default defineConfig([
  {
    entry: { index: 'src/index.ts' },
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
    entry: { client: 'src/client/index.ts' },
    outDir: 'lib',
    // Factory form: the bundle executes inside `factory(require)` where the
    // host module table answers require() calls for external ids (cjs, same
    // as PluginCenter's client half).
    format: 'cjs',
    platform: 'browser',
    outExtensions: () => ({ js: '.js' }),
    clean: false,
    external: sharedExternal,
    // Browser imports cannot resolve bare specifiers from node_modules;
    // everything the host page does not provide must be INLINED.
    noExternal: [/^@xterm\//],
    dts: false,
    banner: { js: loaderBanner },
    footer: { js: loaderFooter },
  },
])
