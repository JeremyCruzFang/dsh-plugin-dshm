import { build } from 'esbuild'
await build({
  entryPoints: ['src/projection/client.mjs'], outfile: 'lib/client.js', bundle: true,
  format: 'cjs', platform: 'browser', target: 'es2022', external: ['react', '@deepseek-ai/*'],
  banner: { js: 'window.__ModuleLoader__.load({id:"dsh-plugin-dshm",factory(require){const module={exports:{}};const exports=module.exports;' },
  footer: { js: 'return module.exports;}});' },
})
