/**
 * 一键回滚：把 `<file>.rpy.bak` 还原为 `<file>.rpy`（只处理存在 .bak 的文件）。
 * 用法：<runtime>\node.exe tests\real-project-rollback.mjs [--root <游戏根目录>] [--dry]
 */
import { copyFile, readdir, rm } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join } from 'node:path'

const argv = process.argv.slice(2)
const argOf = (n, d) => { const i = argv.indexOf(n); return i >= 0 && argv[i + 1] ? argv[i + 1] : d }
const ROOT = argOf('--root', 'D:/Games/Birth Story 1.1.3 (Windows)/汉化测试/birthstory-v1.1.3-win/game')
const DRY = argv.includes('--dry')

let restored = 0
const walk = async (dir) => {
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const p = join(dir, e.name)
    if (e.isDirectory()) { if (!e.name.startsWith('.') && e.name !== 'tl') await walk(p); continue }
    if (!e.name.endsWith('.rpy.bak')) continue
    const target = p.slice(0, -4)
    console.log(`${DRY ? '[dry] ' : ''}restore ${target}`)
    if (!DRY) {
      await copyFile(p, target)
      await rm(p)
    }
    restored++
    if (restored >= 400) return
  }
}
if (!existsSync(ROOT)) throw new Error(`目录不存在: ${ROOT}`)
await walk(ROOT)
console.log(`\n${DRY ? '将' : '已'}还原 ${restored} 个文件`)
