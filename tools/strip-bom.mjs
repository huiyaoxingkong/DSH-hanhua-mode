// 清理：本次会话里被 PowerShell Set-Content -Encoding UTF8 写入的 UTF-8 BOM
// （winocr.ps1 必须保留 BOM，其它文件都不该有）
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO = resolve(HERE, '..')
const SKIP_DIRS = new Set(['node_modules', '.git', '.tools', '.hanhua-tmp', '.work', '.work-v2'])
const KEEP_BOM = new Set(['winocr.ps1'])
const TEXT_EXT = new Set(['.js', '.mjs', '.json', '.yml', '.yaml', '.md', '.py', '.ps1', '.txt', '.gitignore', '.gitattributes'])
const touched = []
const walk = (dir) => {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.isDirectory()) { if (!SKIP_DIRS.has(e.name)) walk(join(dir, e.name)); continue }
    if (KEEP_BOM.has(e.name)) continue
    const ext = e.name.includes('.') ? e.name.slice(e.name.lastIndexOf('.')) : e.name
    if (!TEXT_EXT.has(ext) && e.name !== '.gitignore' && e.name !== '.gitattributes') continue
    const p = join(dir, e.name)
    const buf = readFileSync(p)
    if (buf.length >= 3 && buf[0] === 0xEF && buf[1] === 0xBB && buf[2] === 0xBF) {
      writeFileSync(p, buf.subarray(3))
      touched.push(p.slice(REPO.length + 1))
    }
  }
}
walk(REPO)
console.log('去 BOM 文件数:', touched.length)
for (const t of touched) console.log('  ' + t)
