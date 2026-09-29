// 定向夹具：RPG Maker XP 风格 .rxdata，字符串节点为 **Shift-JIS 字节**，
// 用于强制 hanhua_export 走 iconvBatch（RGSS Marshal 的 legacy 编码分支）——
// 默认夹具全 ASCII，永远走不到该分支。
import { createRequire } from 'node:module'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const require = createRequire('D:/Agent-windows/DeepSeekHarness/data/.dsh/profiles/node_modules/')
const iconv = require('iconv-lite')
console.log('iconv-lite =', require.resolve('iconv-lite'))

const HERE = dirname(fileURLToPath(import.meta.url))
const OUT = join(HERE, 'fixtures-sjis')

// ---- 简化 Ruby Marshal 写入器（仅夹具生成用，逻辑同 repo fixtures/make-fixtures.js）----
function wLong(v, out) {
  if (v === 0) { out.push(0); return }
  if (v > 0 && v < 123) { out.push(v + 5); return }
  if (v < 0 && v > -124) { out.push(v - 5); return }
  if (v >= 0 && v < 0x40000000) { out.push(4); for (let k = 0; k < 4; k++) out.push((v >>> (8 * k)) & 0xFF); return }
  throw new Error('int too big ' + v)
}
const s2b = (s) => Buffer.from(s, 'latin1')
function wSym(s, out) { const b = s2b(s); wLong(b.length, out); for (const x of b) out.push(x) }
function wStr(s, out) { out.push(0x22); const b = s2b(s); wLong(b.length, out); for (const x of b) out.push(x) }
function wInt(v, out) { out.push(0x69); wLong(v, out) }
function wIvars(iv, out) {
  const keys = Object.keys(iv)
  wLong(keys.length, out)
  for (const k of keys) { out.push(0x3A); wSym(k, out); wNode(iv[k], out) }
}
function wNode(n, out) {
  switch (n.t) {
    case 'i': wInt(n.v, out); break
    case 's': wStr(n.v, out); break
    case ':': out.push(0x3A); wSym(n.v, out); break
    case 'a': { out.push(0x5B); wLong(n.v.length, out); for (const x of n.v) wNode(x, out); break }
    case 'h': { out.push(0x7B); wLong(n.v.length, out); for (const [k, v] of n.v) { wNode(k, out); wNode(v, out) } break }
    case 'o': { out.push(0x6F); out.push(0x3A); wSym(n.c, out); wIvars(n.iv, out); break }
  }
}
/** 把 JS 字符串按 Shift-JIS 编码成 Marshal 字符串节点（node.v 为 latin1 字节串）。 */
const sj = (text) => ({ t: 's', v: Buffer.from(iconv.encode(text, 'shift_jis')).toString('latin1') })

const SOURCES = {
  name: 'アレンのHP',
  line1a: '勇者アレン',
  line1b: 'ようこそ、村へ。',
  line2: 'こんにちは、旅人よ。',
  comment: 'これはコメント。',
}
const TARGETS = {
  name: '阿伦的HP',
  line1a: '勇者阿伦',
  line1b: '欢迎来到村子。',
  line2: '你好，旅人。',
  comment: '这是一条注释。',
}

const cmd = (code, params) => ({
  t: 'o', c: 'RPG::EventCommand', iv: {
    '@code': { t: 'i', v: code }, '@indent': { t: 'i', v: 0 },
    '@parameters': { t: 'a', v: params.map((p) => (typeof p === 'number' ? { t: 'i', v: p } : Array.isArray(p) ? { t: 'a', v: p.map((s) => (typeof s === 'string' ? sj(s) : { t: 'i', v: s })) } : sj(p))) },
  },
})
const page = {
  t: 'o', c: 'RPG::Event::Page', iv: {
    '@condition': { t: 'o', c: 'RPG::Event::Page::Condition', iv: {} },
    '@list': { t: 'a', v: [cmd(101, [[SOURCES.line1a, SOURCES.line1b]]), cmd(401, [SOURCES.line2]), cmd(102, [['Yes', 'No'], 0]), cmd(402, [0, 'When Yes']), cmd(408, [SOURCES.comment])] },
  },
}
const ev = { t: 'o', c: 'RPG::Event', iv: { '@name': sj(SOURCES.name), '@pages': { t: 'a', v: [page] } } }
const map = { t: 'o', c: 'RPG::Map', iv: { '@events': { t: 'h', v: [[{ t: 'i', v: 1 }, ev]] } } }
const bytes = [0x04, 0x08]
wNode(map, bytes)

mkdirSync(join(OUT, 'game_xp', 'Data'), { recursive: true })
// 必须叫 MapNNN.* —— extractRgss 只对 /^Map\d{3}\./ 走地图分支（实测 Sjis.rxdata 解析出 0 条）
const file = join(OUT, 'game_xp', 'Data', 'Map002.rxdata')
writeFileSync(file, Buffer.from(bytes))
writeFileSync(join(OUT, 'strings.json'), JSON.stringify({ SOURCES, TARGETS }, null, 2), 'utf8')
console.log('written:', file, bytes.length, 'bytes')
console.log('sources:', JSON.stringify(SOURCES, null, 1))
