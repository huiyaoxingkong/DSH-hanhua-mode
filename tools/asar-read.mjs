/**
 * 极简 asar 读取器（Electron asar 格式：8+8 字节头 + JSON 索引 + 拼接的文件数据）。
 * 用于检查 DeepSeek Harness 桌面版 app.asar 内置的内核源码/预设。
 *
 * 用法：
 *   node asar-read.mjs list    <asar> <subpath>            # 列出子路径下的条目
 *   node asar-read.mjs cat     <asar> <path> <outfile>     # 抽取文件到磁盘（推荐）
 *   node asar-read.mjs find    <asar> <regex> [max]        # 按路径正则搜索
 */
import { openSync, readSync, closeSync, writeFileSync } from 'node:fs'

const [cmd, archive, arg, extra] = process.argv.slice(2)
if (!archive) throw new Error('usage: asar-read.mjs <list|cat|find> <asar> <path|regex> [max]')

const fd = openSync(archive, 'r')
// asar 头部：@0=4, @4=payload 大小, @8=字符串长度, @12=JSON 长度, JSON 从偏移 16 开始；
// 文件数据从 8+payload 开始。实测（0.2.0-rc.2 桌面版 app.asar）：
//   04 00 00 00 | 38 C2 33 00 | 34 C2 33 00 | 30 C2 33 00 | {"files":...
const head = Buffer.alloc(20)
readSync(fd, head, 0, 20, null)
const payloadSize = head.readUInt32LE(4)
const jsonLen = head.readUInt32LE(12)
const headerBuf = Buffer.alloc(jsonLen)
readSync(fd, headerBuf, 0, jsonLen, 16)
closeSync(fd)
const dataOffset = 8 + payloadSize
const header = JSON.parse(headerBuf.toString('utf8'))

const walk = (node, prefix, out) => {
  for (const [name, entry] of Object.entries(node.files ?? {})) {
    const path = prefix ? prefix + '/' + name : name
    if (entry.files) walk(entry, path, out)
    else out.push({ path, size: entry.size, offset: Number(entry.offset), unpacked: !!entry.unpacked })
  }
  return out
}
const all = walk(header, '', [])

const readFileEntry = (entry) => {
  const fd2 = openSync(archive, 'r')
  const buf = Buffer.alloc(entry.size)
  readSync(fd2, buf, 0, entry.size, dataOffset + entry.offset)
  closeSync(fd2)
  return buf
}

if (cmd === 'list') {
  const sub = (arg ?? '').replace(/^\/+|\/+$/g, '')
  const rows = all.filter((e) => sub === '' ? true : (e.path === sub || e.path.startsWith(sub + '/')))
  console.log(`entries under "${sub}": ${rows.length}`)
  for (const r of rows.slice(0, 200)) console.log(`  ${r.size.toString().padStart(10)}  ${r.path}${r.unpacked ? '  [unpacked]' : ''}`)
} else if (cmd === 'cat') {
  const entry = all.find((e) => e.path === arg.replace(/^\/+/, ''))
  if (!entry) { console.error('not found: ' + arg); process.exit(1) }
  const buf = readFileEntry(entry)
  if (extra) { writeFileSync(extra, buf); console.log(`wrote ${buf.length} bytes -> ${extra}`) }
  else process.stdout.write(buf)
} else if (cmd === 'extract') {
  // extract <asar> <subpath> <destDir>：把 subpath 子树解到 destDir（去掉 subpath 前缀）
  const sub = arg.replace(/^\/+|\/+$/g, '')
  const dest = extra
  if (!dest) throw new Error('extract needs a destination directory')
  const rows = all.filter((e) => e.path.startsWith(sub + '/'))
  let written = 0
  let skipped = 0
  let bytes = 0
  const { mkdirSync, copyFileSync, existsSync } = await import('node:fs')
  const { dirname, join } = await import('node:path')
  const unpackedRoot = join(dirname(archive), 'app.asar.unpacked')
  for (const e of rows) {
    const rel = e.path.slice(sub.length + 1)
    const target = join(dest, rel)
    mkdirSync(dirname(target), { recursive: true })
    if (e.unpacked) {
      // 内容不在 asar 数据区，而在同目录的 app.asar.unpacked/<path>
      const src = join(unpackedRoot, e.path)
      if (existsSync(src)) { copyFileSync(src, target); written++; bytes += e.size } else skipped++
      continue
    }
    writeFileSync(target, readFileEntry(e))
    written++
    bytes += e.size
  }
  console.log(`extracted ${written} files (${(bytes / 1048576).toFixed(1)} MB), skipped ${skipped} unpacked-missing -> ${dest}`)
} else if (cmd === 'grep') {
  const re = new RegExp(arg)
  const max = Number(extra ?? 40)
  let hits = 0
  for (const e of all) {
    if (e.size > 8 * 1024 * 1024) continue
    if (!/\.(js|json|md|yml|yaml|ts)$/.test(e.path)) continue
    let text
    try { text = readFileEntry(e).toString('utf8') } catch { continue }
    if (text.includes('\0')) continue
    const m = text.match(re)
    if (m) {
      const idx = Math.max(0, text.indexOf(m[0]) - 60)
      console.log(`${e.path}\n    … ${text.slice(idx, idx + 200).replace(/\s+/g, ' ')}`)
      if (++hits >= max) break
    }
  }
  console.log(`grep hits: ${hits}`)
} else {
  const re = new RegExp(arg)
  const max = Number(extra ?? 60)
  const rows = all.filter((e) => re.test(e.path)).slice(0, max)
  console.log(`matches: ${rows.length}`)
  for (const r of rows) console.log(`  ${r.size.toString().padStart(10)}  ${r.path}`)
}
