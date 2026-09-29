/**
 * 打发布包：release/DSH-hanhua-mode-preset-v<version>.zip
 *
 * 内容 = 可直接复制为预设目录的 `preset/`（含自带的 node_modules/iconv-lite）
 *        + LICENSE + README + 使用手册 + v2 功能文档。
 *
 * 用法：node tools/build-release.mjs [--out <目录>]
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { deflateRawSync } from 'node:zlib'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO = resolve(HERE, '..')
const argv = process.argv.slice(2)
const argOf = (n, d) => { const i = argv.indexOf(n); return i >= 0 && argv[i + 1] ? argv[i + 1] : d }
const OUT_DIR = resolve(argOf('--out', join(REPO, 'release')))

const pkg = JSON.parse(readFileSync(join(REPO, 'preset', 'plugins', 'hanhua', 'package.json'), 'utf8'))
const VERSION = pkg.version || '0.0.0'
const OUT = join(OUT_DIR, `DSH-hanhua-mode-preset-v${VERSION}.zip`)

// ── 最小 ZIP 写入器（store/deflate + CRC32 + UTF-8 名）
const CRC_TABLE = (() => {
  const t = new Uint32Array(256)
  for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1); t[n] = c >>> 0 }
  return t
})()
const crc32 = (buf) => { let c = 0xffffffff; for (let i = 0; i < buf.length; i++) c = (CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8)) >>> 0; return (c ^ 0xffffffff) >>> 0 }

function buildZip(entries) {
  const locals = []
  const central = []
  let offset = 0
  for (const e of entries) {
    const nameBuf = Buffer.from(e.name.replace(/\\/g, '/'), 'utf8')
    const data = e.data
    const compressed = e.store ? data : deflateRawSync(data, { level: 9 })
    const method = e.store ? 0 : 8
    const crc = crc32(data)
    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt16LE(0x0800, 6)          // UTF-8 名字
    local.writeUInt16LE(method, 8)
    local.writeUInt16LE(0, 10); local.writeUInt16LE(0, 12)   // 时间/日期（固定值，保证可复现）
    local.writeUInt32LE(crc, 14)
    local.writeUInt32LE(compressed.length, 18)
    local.writeUInt32LE(data.length, 22)
    local.writeUInt16LE(nameBuf.length, 26)
    local.writeUInt16LE(0, 28)
    locals.push(local, nameBuf, compressed)
    const cen = Buffer.alloc(46)
    cen.writeUInt32LE(0x02014b50, 0)
    cen.writeUInt16LE(20, 4); cen.writeUInt16LE(20, 6)
    cen.writeUInt16LE(0x0800, 8)
    cen.writeUInt16LE(method, 10)
    cen.writeUInt16LE(0, 12); cen.writeUInt16LE(0, 14)
    cen.writeUInt32LE(crc, 16)
    cen.writeUInt32LE(compressed.length, 20)
    cen.writeUInt32LE(data.length, 24)
    cen.writeUInt16LE(nameBuf.length, 28)
    cen.writeUInt16LE(0, 30); cen.writeUInt16LE(0, 32)
    cen.writeUInt16LE(0, 34); cen.writeUInt16LE(0, 36)
    cen.writeUInt32LE(0, 38)
    cen.writeUInt32LE(offset, 42)
    central.push(cen, nameBuf)
    offset += local.length + nameBuf.length + compressed.length
  }
  const centralBuf = Buffer.concat(central)
  const eocd = Buffer.alloc(22)
  eocd.writeUInt32LE(0x06054b50, 0)
  eocd.writeUInt16LE(entries.length, 8)
  eocd.writeUInt16LE(entries.length, 10)
  eocd.writeUInt32LE(centralBuf.length, 12)
  eocd.writeUInt32LE(offset, 16)
  return Buffer.concat([...locals, centralBuf, eocd])
}

// ── 收集文件
const entries = []
const add = (abs, name, store) => entries.push({ name, data: readFileSync(abs), store: !!store })
const walk = (dir, prefix) => {
  for (const name of readdirSync(dir).sort()) {
    const abs = join(dir, name)
    const st = statSync(abs)
    if (st.isDirectory()) walk(abs, prefix + name + '/')
    else add(abs, prefix + name)
  }
}

// preset/ 整棵树（含 plugins/hanhua/node_modules/iconv-lite）
walk(join(REPO, 'preset'), 'preset/')
for (const f of ['LICENSE', 'README.md', join('docs', '使用手册.md'), join('docs', 'V2-多媒体与OCR.md'), join('docs', 'DESKTOP-0.2.0-install.md'), join('docs', 'WORKBENCH-0.1.6.md')]) {
  const abs = join(REPO, f)
  if (existsSync(abs)) add(abs, relative(REPO, abs).replace(/\\/g, '/'))
}
add(join(REPO, 'preset', 'plugins', 'hanhua', 'package.json'), 'preset/plugins/hanhua/package.json')
entries.push({
  name: 'INSTALL.md',
  store: false,
  data: Buffer.from(`# 安装（v${VERSION}）\n\n## 桌面版（0.2.0-rc.2）\n\n把本包解压出的 \`preset/plugins/hanhua/\` 整个目录复制到 \`<DSH_HOME>/hanhua/plugins/hanhua/\`，\n或用仓库里的安装脚本（推荐，会同时写预设声明并校验）：\n\n\`\`\`powershell\nnode tools\\install-hanhua-desktop.mjs --home <DSH_HOME>\nnode tools\\validate-declaration.mjs "<DSH_HOME>\\hanhua\\cordis.patch.yml"\n\`\`\`\n\n重启 DSH 后，新建会话的预设列表里会出现「汉化模式」。\n\n## 旧内核（0.1.6-alpha.2）目录式预设\n\n把本包的 \`preset/\` 目录复制为 \`<DSH_HOME>/.agent-presets/hanhua/\`，新建会话选择「汉化模式」。\n`, 'utf8'),
})

mkdirSync(OUT_DIR, { recursive: true })
const zip = buildZip(entries)
writeFileSync(OUT, zip)
const size = (zip.length / 1024).toFixed(1)
console.log(`wrote ${OUT}（${entries.length} 个条目，${size} KB，版本 ${VERSION}）`)
