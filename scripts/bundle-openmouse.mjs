import { build } from 'esbuild'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

await build({
  entryPoints: [path.join(root, 'scripts', 'openmouse-entry.js')],
  bundle: true,
  format: 'esm',
  platform: 'browser',
  target: 'es2022',
  outfile: path.join(root, 'src', 'renderer', 'js', 'vendor', 'openmouse.js'),
  logLevel: 'info',
})

console.log('openmouse.js 已生成')
