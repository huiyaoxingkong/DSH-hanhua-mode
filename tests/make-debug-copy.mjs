// 生成一个「错误信息带堆栈」的调试副本，便于定位插件内部被吞掉的异常。
// 仅供诊断使用，不改动仓库正本。
import { readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const src = join(HERE, '..', 'preset', 'plugins', 'hanhua', 'index.js')
const dst = join(HERE, '.debug-plugin.mjs')

const original = `const msg = (e) => (e && e.message) ? String(e.message) : String(e)`
const patched = `const msg = (e) => { const m = (e && e.message) ? String(e.message) : String(e); return m + '\\n[stack] ' + String((e && e.stack) || e).split('\\n').slice(0, 8).join('\\n[stack] ') }`

let text = await readFile(src, 'utf8')
if (!text.includes(original)) throw new Error('未找到 msg() 定义，插件源码可能已改动')
text = text.replace(original, patched)
await writeFile(dst, text, 'utf8')
console.log('wrote', dst)
