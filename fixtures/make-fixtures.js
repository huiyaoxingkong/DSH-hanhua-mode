// 生成汉化引擎测试夹具：RPG Maker XP 风格 .rxdata（Ruby Marshal）+ krkr .ks（UTF-16LE / Shift-JIS）
const fs = require('fs')
const path = require('path')
const iconv = require('D:/Agent-windows/DeepSeekHarness/core/node_modules/iconv-lite')

// ---- 简化版 Ruby Marshal 写入器（仅夹具生成用）----
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
    case 'a': {
      out.push(0x5B); wLong(n.v.length, out)
      for (const x of n.v) wNode(x, out)
      break
    }
    case 'h': {
      out.push(0x7B); wLong(n.v.length, out)
      for (const [k, v] of n.v) { wNode(k, out); wNode(v, out) }
      break
    }
    case 'o': {
      out.push(0x6F); out.push(0x3A); wSym(n.c, out)
      wIvars(n.iv, out)
      break
    }
  }
}

// ---- 构造 Map001.rxdata ----
const cmd = (code, params) => ({ t: 'o', c: 'RPG::EventCommand', iv: { '@code': { t: 'i', v: code }, '@indent': { t: 'i', v: 0 }, '@parameters': { t: 'a', v: params.map((p) => (typeof p === 'number' ? { t: 'i', v: p } : Array.isArray(p) ? { t: 'a', v: p.map((s) => ({ t: 's', v: s })) } : { t: 's', v: p })) } } })
const page = { t: 'o', c: 'RPG::Event::Page', iv: { '@condition': { t: 'o', c: 'RPG::Event::Page::Condition', iv: {} }, '@list': { t: 'a', v: [cmd(101, [['Hello, adventurer!', 'Welcome to the Village.']]), cmd(401, ['I am the Village Elder.']), cmd(102, [['Yes', 'No'], 0]), cmd(402, [0, 'When Yes']), cmd(408, ['A comment line.'])] } } }
const ev = { t: 'o', c: 'RPG::Event', iv: { '@name': { t: 's', v: 'Old Man' }, '@pages': { t: 'a', v: [page] } } }
const map = { t: 'o', c: 'RPG::Map', iv: { '@events': { t: 'h', v: [[{ t: 'i', v: 1 }, ev]] } } }
const mapBytes = []
mapBytes.push(0x04, 0x08)
wNode(map, mapBytes)

// ---- 构造 System.rxdata（含 terms）----
const words = (name) => ({ t: 'o', c: 'RPG::System::Words', iv: { '@name': { t: 's', v: name } } })
const terms = { t: 'o', c: 'RPG::System::Terms', iv: { '@basic': { t: 'a', v: [{ t: 's', v: 'Level' }, { t: 's', v: 'HP' }] }, '@params': { t: 'a', v: [] }, '@commands': { t: 'a', v: [{ t: 's', v: 'Attack' }, { t: 's', v: 'Guard' }] }, '@messages': { t: 'h', v: [[{ t: ':', v: 'victory' }, words('Victory!')], [{ t: ':', v: 'defeat' }, words('Defeat...')]] } } }
const sys = { t: 'o', c: 'RPG::System', iv: { '@game_title': { t: 's', v: 'Test Adventure' }, '@currency_unit': { t: 's', v: 'Gold' }, '@terms': terms } }
const sysBytes = []
sysBytes.push(0x04, 0x08)
wNode(sys, sysBytes)

// ---- krkr 夹具 ----
const ksText = '; scenario one\r\n[title name="Prologue"]\r\nGood morning! The Quest begins now.\r\n[ch text="Nice to meet you."]\r\nBye bye.\r\n'
const ksUtf16 = Buffer.concat([Buffer.from([0xFF, 0xFE]), Buffer.from(ksText, 'utf16le')])
const legacyText = '[title name="レガシー"]\r\nこんにちは、世界。\r\n[ch text="はじめまして。"]\r\n'
const ksSjis = iconv.encode(legacyText, 'shift_jis')

const root = 'D:/Games/汉化模式/test-fixtures'
const dirs = [root, root + '/game_xp/Data', root + '/game_krkr/scenario']
for (const d of dirs) fs.mkdirSync(d, { recursive: true })
fs.writeFileSync(root + '/game_xp/Data/Map001.rxdata', Buffer.from(mapBytes))
fs.writeFileSync(root + '/game_xp/Data/System.rxdata', Buffer.from(sysBytes))
fs.writeFileSync(root + '/game_krkr/scenario/first.ks', ksUtf16)
fs.writeFileSync(root + '/game_krkr/scenario/legacy.ks', ksSjis)
console.log('fixtures written:')
console.log('  Map001.rxdata', mapBytes.length, 'bytes')
console.log('  System.rxdata', sysBytes.length, 'bytes')
console.log('  first.ks (utf-16le)', ksUtf16.length, 'bytes')
console.log('  legacy.ks (shift_jis)', ksSjis.length, 'bytes')
