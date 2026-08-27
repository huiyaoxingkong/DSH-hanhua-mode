// 检查导出的文件内容
const fs = require('fs')
for (const f of [
  'D:/Games/汉化模式/test-fixtures/game_xp/Data/Map001.rxdata',
  'D:/Games/汉化模式/test-fixtures/game_krkr/scenario/first.ks',
  'D:/Games/汉化模式/test-fixtures/game_krkr/scenario/legacy.ks',
]) {
  const b = fs.readFileSync(f)
  console.log('==', f, b.length, 'bytes')
  console.log(Buffer.from(b.subarray(0, 64)).toString('hex'))
}
// 用读取器解析导出的 Map001
const bytes = fs.readFileSync('D:/Games/汉化模式/test-fixtures/game_xp/Data/Map001.rxdata')
const latin1Of = (bb) => { let s = ''; for (let i = 0; i < bb.length; i++) s += String.fromCharCode(bb[i]); return s }
function marshalRead(bytes) {
  let pos = 0
  if (bytes.length >= 2 && bytes[0] === 0x04 && bytes[1] === 0x08) pos = 2
  const nodes = []
  const readByte = () => { if (pos >= bytes.length) throw new Error('Marshal 数据不完整 @' + pos); return bytes[pos++] }
  const readLong = () => {
    let c = readByte()
    if (c >= 128) c -= 256
    if (c === 0) return 0
    if (c > 0) {
      if (c < 5) { let v = 0; for (let k = 0; k < c; k++) v += readByte() << (8 * k); return v }
      return c - 5
    }
    if (c > -5) { let v = 0; for (let k = 0; k < -c; k++) v += readByte() << (8 * k); return -v }
    return c + 5
  }
  const readRaw = (n) => { if (n < 0 || pos + n > bytes.length) throw new Error('Marshal 数据不完整'); const out = bytes.subarray(pos, pos + n); pos += n; return out }
  const readName = () => { const n = readLong(); return latin1Of(readRaw(n)) }
  const readSym = () => { const n = readNode(); if (n && n.t === ':') return n.v; throw new Error('期望 symbol @' + pos) }
  function readNode() {
    const ch = String.fromCharCode(readByte())
    if (ch === '0') return { t: 'nil' }
    if (ch === 'T') return { t: 'true' }
    if (ch === 'F') return { t: 'false' }
    if (ch === 'i') return { t: 'i', v: readLong() }
    if (ch === ':') return { t: ':', v: readName() }
    if (ch === ';') { const idx = readLong(); return nodes[idx] }
    if (ch === 'l') { const sign = readByte() === 0x2B ? 1 : -1; const words = readLong() * 2; return { t: 'l', sign, d: readRaw(words) } }
    if (ch === '"') { const n = readLong(); const node = { t: 's', v: latin1Of(readRaw(n)) }; nodes.push(node); return node }
    if (ch === 'f') { let s = ''; for (;;) { const c = bytes[pos]; if (c === undefined) break; const cc = String.fromCharCode(c); if (!/[0-9+\-eE.]/.test(cc)) break; s += cc; pos++ } return { t: 'f', v: parseFloat(s) } }
    if (ch === '[') { const n = readLong(); const node = { t: 'a', v: [] }; nodes.push(node); for (let i = 0; i < n; i++) node.v.push(readNode()); return node }
    if (ch === '{') { const n = readLong(); const node = { t: 'h', v: [], def: undefined }; nodes.push(node); const count = Math.abs(n); for (let i = 0; i < count; i++) { const k = readNode(); const v = readNode(); node.v.push([k, v]) } if (n < 0) node.def = readNode(); return node }
    if (ch === 'o') { const cname = readSym(); const n = readLong(); const node = { t: 'o', c: cname, iv: {} }; nodes.push(node); for (let i = 0; i < n; i++) { const k = readSym(); const v = readNode(); node.iv[k] = v } return node }
    if (ch === 'u') { const cname = readSym(); const n = readLong(); const node = { t: 'u', c: cname, d: readRaw(n) }; nodes.push(node); return node }
    if (ch === 'U') { const cname = readSym(); const node = { t: 'U', c: cname, v: readNode() }; nodes.push(node); return node }
    if (ch === 'e') { const cname = readSym(); const node = { t: 'x', c: cname, v: readNode() }; nodes.push(node); return node }
    if (ch === 'I') { const inner = readNode(); const n = readLong(); const iv = {}; for (let i = 0; i < n; i++) { const k = readSym(); const v = readNode(); iv[k] = v } if (inner.t === 's') { inner.t = 'sI'; inner.iv = iv; return inner } return { t: 'I', v: inner, iv } }
    if (ch === '@') { const idx = readLong(); return nodes[idx] }
    if (ch === 'S') { const cname = readSym(); const n = readLong(); const node = { t: 'S', c: cname, iv: {} }; nodes.push(node); for (let i = 0; i < n; i++) { const k = readSym(); const v = readNode(); node.iv[k] = v } return node }
    if (ch === 'c' || ch === 'm') return { t: ch, v: readName() }
    throw new Error('不支持的 Marshal 类型: 0x' + bytes[pos - 1].toString(16) + ' @' + (pos - 1))
  }
  return readNode()
}
try {
  const tree = marshalRead(bytes)
  console.log('exported Map001 parse OK:', tree.t, tree.c)
  const ev = tree.iv && tree.iv['@events']
  const ev0 = ev && ev.v[0] && ev.v[0][1]
  console.log('event name node v:', JSON.stringify(ev0 && ev0.iv['@name'] && ev0.iv['@name'].v))
} catch (e) {
  console.log('exported Map001 parse FAILED:', e.message)
  const m = e.message.match(/@(\d+)/)
  if (m) {
    const at = parseInt(m[1], 10)
    console.log('around:', Buffer.from(bytes.subarray(Math.max(0, at - 32), at + 32)).toString('hex'))
  }
}
