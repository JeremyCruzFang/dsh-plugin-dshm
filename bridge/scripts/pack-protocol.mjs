// Keep the unpublished local protocol package out of the installed dependency
// graph. Package its unchanged validator, schema data and generated types.
import { build } from 'esbuild'
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const bridge = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const protocol = path.resolve(bridge, '../protocol')
const lib = path.join(bridge, 'lib'), destination = path.join(lib, 'protocol')
await fs.rm(destination, { recursive: true, force: true })
const result = await build({
  absWorkingDir: bridge, entryPoints: [path.join(protocol, 'scripts/contract.mjs')],
  outfile: path.join(destination, 'scripts/contract.mjs'), bundle: true,
  format: 'esm', platform: 'node', target: 'node24', metafile: true,
  banner: { js: "import { createRequire as dshmCreateRequire } from 'node:module'; const require = dshmCreateRequire(import.meta.url);" },
})
await fs.cp(path.join(protocol, 'schema/dmp-v1'), path.join(destination, 'schema/dmp-v1'), { recursive: true })
const types = await fs.readFile(path.join(protocol, 'gen/ts/dmp.ts'), 'utf8')
if (/^export\s+(?:const|let|function|class)\b/m.test(types)) throw new Error('Protocol types now contain runtime declarations; update the packaging step')
await fs.writeFile(path.join(destination, 'dmp.d.ts'), types)
await fs.writeFile(path.join(destination, 'dmp.js'), 'export {};\n')

// The runtime bundle contains MIT dependencies. Keep their exact installed
// license notices with the shipped artifact, including transitive packages.
const packages = new Map()
for (const input of Object.keys(result.metafile.inputs)) {
  const absolute = path.resolve(bridge, input)
  if (!absolute.includes(`${path.sep}node_modules${path.sep}`)) continue
  let directory = path.dirname(absolute)
  while (directory !== path.dirname(directory)) {
    try {
      const manifest = JSON.parse(await fs.readFile(path.join(directory, 'package.json'), 'utf8'))
      packages.set(directory, manifest); break
    } catch (error) { if (error.code !== 'ENOENT') throw error }
    directory = path.dirname(directory)
  }
}
const notices = []
for (const [directory, manifest] of [...packages].sort((a, b) => a[1].name.localeCompare(b[1].name))) {
  const files = (await fs.readdir(directory)).filter(name => /^(?:licen[cs]e|copying)(?:\.|$)/i.test(name)).sort()
  if (!files.length) throw new Error(`Missing bundled dependency license: ${manifest.name}`)
  const contents = await Promise.all(files.map(name => fs.readFile(path.join(directory, name), 'utf8')))
  notices.push(`${manifest.name} ${manifest.version}\n${contents.join('\n')}`)
}
await fs.writeFile(path.join(destination, 'THIRD_PARTY_LICENSES.txt'), notices.join('\n\n---\n\n'))

async function rewrite(directory) {
  for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name)
    if (entry.isDirectory()) { if (file !== destination) await rewrite(file); continue }
    if (!/\.(?:m?js|d\.(?:m?ts))$/.test(entry.name)) continue
    const source = await fs.readFile(file, 'utf8')
    const output = source.replace(/(['"])dshm-protocol\/(contract|types)\1/g, (_match, quote, part) => {
      const target = path.join(destination, part === 'contract' ? 'scripts/contract.mjs' : 'dmp.js')
      const relative = path.relative(path.dirname(file), target).split(path.sep).join('/')
      return `${quote}${relative.startsWith('.') ? relative : `./${relative}`}${quote}`
    })
    if (/['"]dshm-protocol(?:\/[^'"]*)?['"]/.test(output)) throw new Error(`Unhandled protocol import in ${path.relative(lib, file)}`)
    if (source !== output) await fs.writeFile(file, output)
  }
}
await rewrite(lib)
console.log(`Packaged shared DMP runtime, schemas and declarations (${packages.size} dependency license notices).`)
