import { readFile } from 'node:fs/promises'
import { basename, dirname, resolve } from 'node:path'
import { transform } from 'lightningcss'
import { defineConfig } from 'tsdown'

const ID = 'dsh-full-remote'
const CSS_PREFIX = '\0dsh-full-remote-css:'
const CSS_SUFFIX = '.mjs'
const EXTERNALS = [
  'react',
  'react/jsx-runtime',
  'react-dom',
  '@deepseek-ai/cordis',
  '@deepseek-ai/dsh-client-runtime/client',
  '@deepseek-ai/dsh-client-ui-slots',
]

export default defineConfig([
  {
    name: ID,
    entry: { index: 'src/index.ts' },
    outDir: 'lib',
    format: 'esm',
    platform: 'node',
    target: 'es2024',
    fixedExtension: false,
    clean: false,
    sourcemap: true,
    dts: true,
    deps: { neverBundle: ['@deepseek-ai/schemastery'] },
  },
  {
    name: `${ID}/client`,
    entry: { client: 'src/client/index.ts' },
    outDir: 'lib',
    format: 'cjs',
    platform: 'browser',
    target: 'es2022',
    clean: false,
    sourcemap: true,
    deps: {
      neverBundle: EXTERNALS,
      alwaysBundle: id => (EXTERNALS.includes(id) ? undefined : true),
    },
    define: {
      'process.env.NODE_ENV': JSON.stringify(process.env.NODE_ENV ?? 'production'),
    },
    plugins: [{
      name: 'dsh-full-remote-css-modules',
      resolveId(source, importer) {
        if (!source.endsWith('.module.css')) return null
        return CSS_PREFIX + resolve(dirname(importer ?? ''), source) + CSS_SUFFIX
      },
      async load(id) {
        if (!id.startsWith(CSS_PREFIX)) return null
        const file = id.slice(CSS_PREFIX.length, -CSS_SUFFIX.length)
        this.addWatchFile(file)
        const result = transform({
          filename: file,
          code: await readFile(file),
          cssModules: { pattern: '[hash]_[local]' },
          minify: true,
        })
        const classes = Object.fromEntries(
          Object.entries(result.exports ?? {}).map(([local, value]) => [local, value.name]),
        )
        const tagId = `${ID}/${basename(file)}`
        return [
          `const css=${JSON.stringify(result.code.toString())};`,
          `const tagId=${JSON.stringify(tagId)};`,
          'if(typeof document!=="undefined"&&!document.querySelector(`style[data-plugin-css="${tagId}"]`)){',
          'const tag=document.createElement("style");tag.dataset.plugin=' + JSON.stringify(ID) + ';',
          'tag.dataset.pluginCss=tagId;tag.textContent=css;document.head.appendChild(tag);}',
          `export default ${JSON.stringify(classes)};`,
        ].join('\n')
      },
    }],
    outputOptions: {
      entryFileNames: 'client.js',
      banner: `window.__ModuleLoader__.load({ id: ${JSON.stringify(ID)}, factory: (require) => {`,
      footer: 'return module.exports; } });',
      intro: 'var module = { exports: {} }; var exports = module.exports;',
    },
  },
])
