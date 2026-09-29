/**
 * mediakit.js 契约测试：`node tests/mediakit.test.mjs`
 *
 * 覆盖：zip-write/list/read/extract/replace、EPUB 形态、路径穿越防护、zip64 与加密的错误路径、
 * 7z 与 Python zipfile 的互操作校验、hash、http-json（本机临时 HTTP 服务，不碰外网）、
 * 以及「业务失败也必须写出 out.json 且退出码 0」这条硬约定。
 *
 * 所有临时文件都在 os.tmpdir() 下，跑完删除，不污染仓库。
 */
import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { deflateRawSync, inflateRawSync } from 'node:zlib'

const HERE = dirname(fileURLToPath(import.meta.url))
const KIT = join(HERE, '..', 'engine', 'src', 'scripts', 'mediakit.js')
const SEVEN_ZIP = 'D:\\Program Files\\7-Zip-Zstandard\\7z.exe'
const PYTHON = 'C:\\Users\\lihao\\.dsh\\dsh-runtimes\\dsh-primary-runtime\\dependencies\\python\\python.exe'

let TMP
let HTTP
let DEAD_PORT

before(async () => {
  TMP = mkdtempSync(join(tmpdir(), 'mediakit-test-'))
  HTTP = createServer((req, res) => {
    const chunks = []
    req.on('data', (c) => chunks.push(c))
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8')
      if (req.url === '/echo') {
        let body = null
        try { body = raw ? JSON.parse(raw) : null } catch { body = raw } // 非 JSON 体就回原文
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' })
        res.end(JSON.stringify({
          method: req.method,
          marker: req.headers['x-test'] || null,
          contentType: req.headers['content-type'] || null,
          body
        }))
        return
      }
      res.writeHead(500, { 'Content-Type': 'text/plain' })
      res.end('boom')
    })
  })
  const port = await new Promise((resolve) => HTTP.listen(0, '127.0.0.1', () => resolve(HTTP.address().port)))
  HTTP.port = port
  // 先占一个端口再关掉：用来测「网络异常 → ok:false」这条路径
  const dead = createServer()
  DEAD_PORT = await new Promise((resolve) => dead.listen(0, '127.0.0.1', () => {
    const p = dead.address().port
    dead.close(() => resolve(p))
  }))
})

after(async () => {
  await new Promise((resolve) => HTTP.close(resolve))
  rmSync(TMP, { recursive: true, force: true })
})

// ---------------------------------------------------------------- 测试工具

/** 走真实 CLI：写 in.json → 跑子进程 → 读 out.json（顺便断言「必须有 out.json」和退出码 0）。 */
function call (input, { tag = 'call' } = {}) {
  const dir = mkdtempSync(join(TMP, `${tag}-`))
  const inPath = join(dir, 'in.json')
  const outPath = join(dir, 'out.json')
  writeFileSync(inPath, JSON.stringify(input), 'utf8')
  const r = spawnSync(process.execPath, [KIT, inPath, outPath], { encoding: 'utf8' })
  assert.equal(r.status, 0, `退出码应为 0（业务失败也是 0）：实际 ${r.status}\nstderr=${r.stderr}`)
  assert.ok(existsSync(outPath), `必须写出 out.json\nstderr=${r.stderr}`)
  const raw = readFileSync(outPath, 'utf8')
  let parsed
  assert.doesNotThrow(() => { parsed = JSON.parse(raw) }, 'out.json 必须是纯 JSON（日志不能混进去）')
  parsed.__stderr = r.stderr
  return parsed
}

/**
 * 异步版：测 http-json 时必须用它——被测进程要访问本测试进程里的临时 HTTP 服务，
 * 而 spawnSync 会阻塞事件循环，服务端就永远应答不了（会一路等到超时）。
 */
function callAsync (input, { tag = 'call' } = {}) {
  return new Promise((resolve, reject) => {
    const dir = mkdtempSync(join(TMP, `${tag}-`))
    const inPath = join(dir, 'in.json')
    const outPath = join(dir, 'out.json')
    writeFileSync(inPath, JSON.stringify(input), 'utf8')
    const child = spawn(process.execPath, [KIT, inPath, outPath], { stdio: ['ignore', 'pipe', 'pipe'] })
    let stderr = ''
    child.stdout.on('data', () => {})
    child.stderr.on('data', (d) => { stderr += d.toString('utf8') })
    child.on('error', reject)
    child.on('close', (status) => {
      try {
        assert.equal(status, 0, `退出码应为 0：实际 ${status}\nstderr=${stderr}`)
        assert.ok(existsSync(outPath), `必须写出 out.json\nstderr=${stderr}`)
        const parsed = JSON.parse(readFileSync(outPath, 'utf8'))
        parsed.__stderr = stderr
        resolve(parsed)
      } catch (e) { reject(e) }
    })
  })
}

const ok = (input, opts) => {
  const out = call(input, opts)
  assert.equal(out.ok, true, `期望 ok:true，实际 ${JSON.stringify(out)}\nstderr=${out.__stderr}`)
  return out
}

const err = (input, opts) => {
  const out = call(input, opts)
  assert.equal(out.ok, false, `期望 ok:false，实际 ${JSON.stringify(out)}\nstderr=${out.__stderr}`)
  assert.equal(typeof out.error, 'string')
  assert.ok(out.error.length > 0, 'error 必须是非空字符串')
  return out.error
}

const okAsync = async (input, opts) => {
  const out = await callAsync(input, opts)
  assert.equal(out.ok, true, `期望 ok:true，实际 ${JSON.stringify(out)}\nstderr=${out.__stderr}`)
  return out
}

const errAsync = async (input, opts) => {
  const out = await callAsync(input, opts)
  assert.equal(out.ok, false, `期望 ok:false，实际 ${JSON.stringify(out)}\nstderr=${out.__stderr}`)
  return out.error
}

const b64 = (s) => Buffer.from(s).toString('base64')
const tmpPath = (name) => join(TMP, name)

/** 独立实现的 CRC32（与被测代码不同源，避免自证）。 */
const CRC_TABLE = (() => {
  const t = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1)
    t[n] = c >>> 0
  }
  return t
})()
function crc32 (buf) {
  let c = 0xffffffff
  for (let i = 0; i < buf.length; i++) c = (CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8)) >>> 0
  return (c ^ 0xffffffff) >>> 0
}

/**
 * 测试侧的最小 ZIP 解析器：直接读中央目录 + local header，拿到每条**压缩后的原始字节**。
 * zip-replace「未改动条目字节级不变」这条断言就靠它（zip-list 只给 size/crc，证不了字节）。
 */
function rawEntries (zipPath) {
  const buf = readFileSync(zipPath)
  let eocd = -1
  for (let i = buf.length - 22; i >= 0; i--) if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break }
  assert.ok(eocd >= 0, `测试解析器：未找到 EOCD（${zipPath}）`)
  const count = buf.readUInt16LE(eocd + 10)
  let p = buf.readUInt32LE(eocd + 16)
  const map = new Map()
  for (let i = 0; i < count; i++) {
    assert.equal(buf.readUInt32LE(p), 0x02014b50, '测试解析器：中央目录签名不符')
    const method = buf.readUInt16LE(p + 10)
    const crc = buf.readUInt32LE(p + 16)
    const compSize = buf.readUInt32LE(p + 20)
    const uncompSize = buf.readUInt32LE(p + 24)
    const nameLen = buf.readUInt16LE(p + 28)
    const extraLen = buf.readUInt16LE(p + 30)
    const commentLen = buf.readUInt16LE(p + 32)
    const localOffset = buf.readUInt32LE(p + 42)
    const name = buf.subarray(p + 46, p + 46 + nameLen).toString('utf8')
    assert.equal(buf.readUInt32LE(localOffset), 0x04034b50, `测试解析器：${name} local header 签名不符`)
    const dataAt = localOffset + 30 + buf.readUInt16LE(localOffset + 26) + buf.readUInt16LE(localOffset + 28)
    map.set(name, {
      index: i,
      method,
      crc,
      compSize,
      uncompSize,
      uncompressed: method === 8
        ? inflateRawSync(buf.subarray(dataAt, dataAt + compSize))
        : Buffer.from(buf.subarray(dataAt, dataAt + compSize)),
      payload: Buffer.from(buf.subarray(dataAt, dataAt + compSize))
    })
    p += 46 + nameLen + extraLen + commentLen
  }
  return map
}

/**
 * 测试侧手工打包：用来造 zip-write 会（故意）拒绝的恶意条目名、加密位、以及 zip64 结构。
 * 之所以手写而不是用 zip-write，是为了证明解压侧防护对「外部来源的包」同样有效。
 */
function buildRawZip (entries, { zip64 = false } = {}) {
  const parts = []
  const central = []
  let offset = 0
  for (const e of entries) {
    const nameBuf = Buffer.from(e.name, 'utf8')
    const content = Buffer.from(e.data)
    const method = e.method ?? 8
    const data = method === 8 ? deflateRawSync(content) : content
    const crc = crc32(content)
    const flags = (e.flags ?? 0) | 0x0800
    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt16LE(flags, 6)
    local.writeUInt16LE(method, 8)
    local.writeUInt16LE(0, 10)
    local.writeUInt16LE(0x2821, 12)
    local.writeUInt32LE(crc, 14)
    local.writeUInt32LE(data.length, 18)
    local.writeUInt32LE(content.length, 22)
    local.writeUInt16LE(nameBuf.length, 26)
    local.writeUInt16LE(0, 28)

    const extra = zip64
      ? Buffer.concat([
        (() => { const b = Buffer.alloc(4); b.writeUInt16LE(0x0001, 0); b.writeUInt16LE(24, 2); return b })(),
        (() => { const b = Buffer.alloc(24); b.writeBigUInt64LE(BigInt(content.length), 0); b.writeBigUInt64LE(BigInt(data.length), 8); b.writeBigUInt64LE(BigInt(offset), 16); return b })()
      ])
      : Buffer.alloc(0)

    const rec = Buffer.alloc(46)
    rec.writeUInt32LE(0x02014b50, 0)
    rec.writeUInt16LE(zip64 ? 45 : 20, 4)
    rec.writeUInt16LE(zip64 ? 45 : 20, 6)
    rec.writeUInt16LE(flags, 8)
    rec.writeUInt16LE(method, 10)
    rec.writeUInt16LE(0, 12)
    rec.writeUInt16LE(0x2821, 14)
    rec.writeUInt32LE(crc, 16)
    rec.writeUInt32LE(zip64 ? 0xffffffff : data.length, 20)
    rec.writeUInt32LE(zip64 ? 0xffffffff : content.length, 24)
    rec.writeUInt16LE(nameBuf.length, 28)
    rec.writeUInt16LE(extra.length, 30)
    rec.writeUInt16LE(0, 32)
    rec.writeUInt16LE(0, 34)
    rec.writeUInt16LE(0, 36)
    rec.writeUInt32LE(0, 38)
    rec.writeUInt32LE(zip64 ? 0xffffffff : offset, 42)

    parts.push(local, nameBuf, data)
    central.push(rec, nameBuf, extra)
    offset += 30 + nameBuf.length + data.length
  }

  const cdStart = offset
  const cdParts = Buffer.concat(central)
  parts.push(cdParts)
  offset += cdParts.length

  const eocd = Buffer.alloc(22)
  eocd.writeUInt32LE(0x06054b50, 0)
  eocd.writeUInt16LE(0, 4)
  eocd.writeUInt16LE(0, 6)
  eocd.writeUInt16LE(zip64 ? 0xffff : entries.length, 8)
  eocd.writeUInt16LE(zip64 ? 0xffff : entries.length, 10)
  eocd.writeUInt32LE(zip64 ? 0xffffffff : cdParts.length, 12)
  eocd.writeUInt32LE(zip64 ? 0xffffffff : cdStart, 16)
  eocd.writeUInt16LE(0, 20)

  if (zip64) {
    const z = Buffer.alloc(56)
    z.writeUInt32LE(0x06064b50, 0)
    z.writeBigUInt64LE(44n, 4)
    z.writeUInt16LE(45, 12)
    z.writeUInt16LE(45, 14)
    z.writeUInt32LE(0, 16)
    z.writeUInt32LE(0, 20)
    z.writeBigUInt64LE(BigInt(entries.length), 24)
    z.writeBigUInt64LE(BigInt(entries.length), 32)
    z.writeBigUInt64LE(BigInt(cdParts.length), 40)
    z.writeBigUInt64LE(BigInt(cdStart), 48)
    const loc = Buffer.alloc(20)
    loc.writeUInt32LE(0x07064b50, 0)
    loc.writeUInt32LE(0, 4)
    loc.writeBigUInt64LE(BigInt(offset), 8)
    loc.writeUInt32LE(1, 16)
    parts.push(z, loc)
  }
  parts.push(eocd)
  return Buffer.concat(parts)
}

// ---------------------------------------------------------------- 1. 往返

test('zip-write → zip-list → zip-read 往返（store/deflate 混合、中文名、二进制、空文件）', () => {
  const zip = tmpPath('roundtrip.zip')
  const binary = Buffer.from(Array.from({ length: 256 * 1024 }, (_, i) => (i * 37 + 11) & 0xff))
  const binaryFile = tmpPath('page-01.bin')
  writeFileSync(binaryFile, binary)

  const text = '中文内容\n你好，世界！\r\n\t带制表符与 emoji 🀄'
  const items = [
    { name: 'OEBPS/文本/第一章.xhtml', base64: b64(text) }, // deflate + 非 ASCII 名
    { name: 'images/page-01.bin', fromFile: binaryFile, compress: false }, // store + 二进制
    { name: 'empty.txt', base64: '' }, // 空文件
    { name: 'images/page-02.bin', fromFile: binaryFile } // deflate + 二进制
  ]
  const w = ok({ op: 'zip-write', file: zip, entries: items }, { tag: 'write' })
  assert.equal(w.count, 4)
  assert.ok(w.size > 0)
  assert.ok(existsSync(zip))

  const list = ok({ op: 'zip-list', file: zip }, { tag: 'list' })
  assert.equal(list.count, 4)
  assert.deepEqual(list.entries.map((e) => e.name), items.map((i) => i.name), '顺序必须与 entries 一致')
  assert.deepEqual(list.entries.map((e) => e.index), [0, 1, 2, 3])
  assert.equal(list.entries[0].method, 8, '默认 compress=true → deflate')
  assert.equal(list.entries[1].method, 0, 'compress=false → store')
  assert.equal(list.entries[3].method, 8)
  assert.equal(list.entries[1].size, binary.length)
  assert.equal(list.entries[1].compressedSize, binary.length, 'store 的压缩后大小 == 原大小')
  assert.equal(list.entries[2].size, 0)
  assert.equal(list.entries[1].crc32, crc32(binary), 'CRC32 必须与独立实现一致')
  assert.equal(list.entries[3].crc32, crc32(binary))

  // 逐条读回，内容逐字节相等
  for (const [i, item] of items.entries()) {
    const expect = item.fromFile ? readFileSync(item.fromFile) : Buffer.from(item.base64, 'base64')
    const r = ok({ op: 'zip-read', file: zip, name: item.name }, { tag: 'read' })
    assert.equal(r.size, expect.length, `size 不符：${item.name}`)
    assert.ok(Buffer.from(r.base64, 'base64').equals(expect), `内容不符：${list.entries[i].name}`)
  }

  // 中文名（UTF-8 名字 + bit 11）必须原样回来
  assert.equal(list.entries[0].name, 'OEBPS/文本/第一章.xhtml')
})

// ---------------------------------------------------------------- 2. zip-replace

test('zip-replace 保留顺序与压缩方法，未改动条目字节级不变', () => {
  const base = tmpPath('base.zip')
  const out = tmpPath('patched.zip')
  const src = {
    a: 'AAA 原文 A',
    b: 'BBB 原文 B',
    c: 'CCC 原文 C',
    d: 'DDD 原文 D'
  }
  ok({
    op: 'zip-write',
    file: base,
    entries: [
      { name: 'text/a.txt', base64: b64(src.a) }, // deflate
      { name: 'raw/b.bin', base64: b64(src.b), compress: false }, // store
      { name: 'text/c.txt', base64: b64(src.c) }, // deflate（被替换）
      { name: 'text/d.txt', base64: b64(src.d) } // deflate
    ]
  }, { tag: 'replace-base' })

  const before = rawEntries(base)
  const r = ok({
    op: 'zip-replace',
    file: base,
    outFile: out,
    replacements: [{ name: 'text/c.txt', base64: b64('CCC 译文 C 已替换') }]
  }, { tag: 'replace' })
  assert.equal(r.replaced, 1)
  assert.equal(r.added, 0)
  assert.equal(r.removed, 0)
  assert.ok(existsSync(out))

  const after = rawEntries(out)
  assert.deepEqual([...after.keys()], [...before.keys()], '条目顺序必须完全不变')

  for (const name of ['text/a.txt', 'raw/b.bin', 'text/d.txt']) {
    const x = before.get(name)
    const y = after.get(name)
    assert.equal(y.method, x.method, `${name} 的压缩方法必须保持`)
    assert.equal(y.crc, x.crc, `${name} 的 CRC 必须不变`)
    assert.equal(y.compSize, x.compSize, `${name} 的压缩后大小必须不变`)
    assert.ok(y.payload.equals(x.payload), `${name} 的压缩数据必须字节级不变`)
  }
  assert.equal(after.get('raw/b.bin').method, 0, 'store 条目替换后仍应能保持 store（此处未替换，也要是 0）')

  const c = after.get('text/c.txt')
  assert.equal(c.method, 8, '被替换的 deflate 条目必须仍是 deflate')
  assert.equal(c.uncompressed.toString('utf8'), 'CCC 译文 C 已替换')
  assert.equal(c.crc, crc32(Buffer.from('CCC 译文 C 已替换')))

  const read = ok({ op: 'zip-read', file: out, name: 'text/c.txt' }, { tag: 'replace-read' })
  assert.equal(Buffer.from(read.base64, 'base64').toString('utf8'), 'CCC 译文 C 已替换')

  // remove + add：顺序 = 剩余原条目（保持原相对顺序）+ 新增（按给定顺序）
  const out2 = tmpPath('patched2.zip')
  const r2 = ok({
    op: 'zip-replace',
    file: base,
    outFile: out2,
    replacements: [],
    remove: ['raw/b.bin'],
    add: [
      { name: 'text/e.txt', base64: b64('新增 E') },
      { name: 'text/f.txt', base64: b64('新增 F'), compress: false }
    ]
  }, { tag: 'replace2' })
  assert.equal(r2.removed, 1)
  assert.equal(r2.added, 2)
  const after2 = rawEntries(out2)
  assert.deepEqual([...after2.keys()], ['text/a.txt', 'text/c.txt', 'text/d.txt', 'text/e.txt', 'text/f.txt'])
  assert.equal(after2.get('text/f.txt').method, 0, 'add 的 compress:false 必须生效')

  // 原地替换（outFile === file）也要可用
  ok({ op: 'zip-replace', file: base, outFile: base, replacements: [{ name: 'text/a.txt', base64: b64('原地改') }] }, { tag: 'replace-inplace' })
  const readA = ok({ op: 'zip-read', file: base, name: 'text/a.txt' })
  assert.equal(Buffer.from(readA.base64, 'base64').toString('utf8'), '原地改')
  assert.deepEqual([...rawEntries(base).keys()], [...before.keys()])
})

// ---------------------------------------------------------------- 3. EPUB 形态

test('EPUB 形态：mimetype 必须是第一条且 store', () => {
  const epub = tmpPath('book.epub')
  ok({
    op: 'zip-write',
    file: epub,
    entries: [
      // EPUB OCF 要求：mimetype 第一条、不压缩、无 extra 字段
      { name: 'mimetype', base64: b64('application/epub+zip'), compress: false },
      { name: 'META-INF/container.xml', base64: b64('<?xml version="1.0"?><container version="1.0"><rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>') },
      { name: 'OEBPS/content.opf', base64: b64('<?xml version="1.0"?><package xmlns="http://www.idpf.org/2007/opf" version="3.0"><metadata/><manifest/><spine/></package>') },
      { name: 'OEBPS/ch1.xhtml', base64: b64('<?xml version="1.0"?><html xmlns="http://www.w3.org/1999/xhtml"><body><p>第一章 中文正文</p></body></html>') }
    ]
  }, { tag: 'epub-write' })

  const list = ok({ op: 'zip-list', file: epub }, { tag: 'epub-list' })
  assert.equal(list.entries[0].name, 'mimetype')
  assert.equal(list.entries[0].index, 0)
  assert.equal(list.entries[0].method, 0, 'mimetype 必须 store')
  assert.equal(list.entries[0].compressedSize, list.entries[0].size)
  assert.deepEqual(list.entries.map((e) => e.name), ['mimetype', 'META-INF/container.xml', 'OEBPS/content.opf', 'OEBPS/ch1.xhtml'])

  // mimetype 必须是文件的最开头（EPUB 阅读器会直接读前 38 字节判断）
  const head = readFileSync(epub).subarray(0, 38)
  assert.equal(head.subarray(30, 38).toString('utf8'), 'mimetype')

  const r = ok({ op: 'zip-read', file: epub, name: 'mimetype' }, { tag: 'epub-read' })
  assert.equal(Buffer.from(r.base64, 'base64').toString('utf8'), 'application/epub+zip')

  // EPUB 修补：换掉一章正文，其余条目保持原样
  const epub2 = tmpPath('book2.epub')
  const p = ok({
    op: 'zip-replace',
    file: epub,
    outFile: epub2,
    replacements: [{ name: 'OEBPS/ch1.xhtml', base64: b64('<?xml version="1.0"?><html><body><p>第一章 译文</p></body></html>') }]
  }, { tag: 'epub-patch' })
  assert.equal(p.replaced, 1)
  const list2 = ok({ op: 'zip-list', file: epub2 })
  assert.equal(list2.entries[0].name, 'mimetype')
  assert.equal(list2.entries[0].method, 0)
  assert.equal(list2.entries[0].crc32, list.entries[0].crc32)
})

// ---------------------------------------------------------------- 4. 路径穿越

test('zip-extract 路径穿越防护（拒绝危险名，且一个文件都不落盘）', () => {
  // zip-write 自己就要拒绝危险条目名
  const e1 = err({ op: 'zip-write', file: tmpPath('evil.zip'), entries: [{ name: '../evil.txt', base64: b64('pwned') }] }, { tag: 'evilwrite' })
  assert.match(e1, /\.\./)
  assert.equal(existsSync(tmpPath('evil.txt')), false, '不能写出 ../evil.txt')

  for (const name of ['/abs.txt', 'C:/abs.txt', 'a/b:c.txt', 'x\\..\\..\\y.txt']) {
    err({ op: 'zip-write', file: tmpPath('evil2.zip'), entries: [{ name, base64: b64('pwned') }] }, { tag: 'evilwrite2' })
  }

  // 外部来源的恶意包：解压必须整体拒绝，且不留下任何文件
  const evil = tmpPath('evil-from-outside.zip')
  writeFileSync(evil, buildRawZip([
    { name: 'good.txt', data: 'ok' },
    { name: '../escaped.txt', data: 'pwned' },
    { name: 'C:/abs.txt', data: 'pwned' }
  ]))
  const outDir = tmpPath('evil-out')
  const e2 = err({ op: 'zip-extract', file: evil, outDir }, { tag: 'evilextract' })
  assert.match(e2, /\.\.|穿越|已拒绝/)
  assert.equal(existsSync(join(TMP, 'escaped.txt')), false, '不能越出 outDir')
  assert.ok(!existsSync(outDir) || readdirSync(outDir).length === 0, '校验不通过时不应落盘任何文件')

  // 单独一条 ../ 也不能漏
  const evil2 = tmpPath('evil2.zip')
  writeFileSync(evil2, buildRawZip([{ name: 'sub/../../escaped2.txt', data: 'pwned' }]))
  err({ op: 'zip-extract', file: evil2, outDir: tmpPath('evil-out2') }, { tag: 'evilextract2' })
  assert.equal(existsSync(join(TMP, 'escaped2.txt')), false)

  // 反斜杠在解压时归一化为目录分隔符（而不是被当成文件名）
  const bs = tmpPath('backslash.zip')
  writeFileSync(bs, buildRawZip([{ name: 'sub\\ok.txt', data: '归一化' }]))
  const okDir = tmpPath('bs-out')
  const r = ok({ op: 'zip-extract', file: bs, outDir: okDir }, { tag: 'bsextract' })
  assert.equal(r.files.length, 1)
  assert.equal(r.files[0].name, 'sub\\ok.txt')
  assert.ok(existsSync(join(okDir, 'sub', 'ok.txt')), '子目录应由归一化后的名字创建')
  assert.equal(readFileSync(join(okDir, 'sub', 'ok.txt'), 'utf8'), '归一化')

  // 正常包的解压 + names 过滤
  const zip = tmpPath('roundtrip.zip')
  const outDir2 = tmpPath('normal-out')
  const all = ok({ op: 'zip-extract', file: zip, outDir: outDir2 }, { tag: 'extract-all' })
  assert.equal(all.files.length, 4)
  assert.ok(all.files.every((f) => f.path.startsWith(outDir2)))
  assert.equal(readFileSync(join(outDir2, 'empty.txt'), 'utf8'), '')
  const only = ok({ op: 'zip-extract', file: zip, outDir: tmpPath('normal-out2'), names: ['empty.txt'] }, { tag: 'extract-some' })
  assert.deepEqual(only.files.map((f) => f.name), ['empty.txt'])
})

// ---------------------------------------------------------------- 5. 互操作

test('互操作：7z 校验 + Python zipfile 读取', () => {
  const zip = tmpPath('roundtrip.zip')
  const list = ok({ op: 'zip-list', file: zip })
  const expect = new Map(list.entries.map((e) => [e.name, {
    size: e.size,
    crc: e.crc32,
    method: e.method,
    sha256: (() => {
      const r = ok({ op: 'zip-read', file: zip, name: e.name })
      return createHash('sha256').update(Buffer.from(r.base64, 'base64')).digest('hex')
    })()
  }]))

  if (existsSync(SEVEN_ZIP)) {
    const t = spawnSync(SEVEN_ZIP, ['t', zip], { encoding: 'utf8' })
    assert.equal(t.status, 0, `7z t 必须通过：${t.stdout}\n${t.stderr}`)
    assert.match(t.stdout, /Everything is Ok|全部正确/i)

    // 反向：7z 打出来的包，我们要能读（名字/大小/内容一致）
    const foreignSrc = tmpPath('foreign.txt')
    const foreignText = '七zip 打出来的包也要能读\n'
    writeFileSync(foreignSrc, foreignText, 'utf8')
    const foreign = tmpPath('from-7z.zip')
    const a = spawnSync(SEVEN_ZIP, ['a', '-tzip', '-mx=5', foreign, foreignSrc], { encoding: 'utf8' })
    assert.equal(a.status, 0, `7z a 失败：${a.stdout}\n${a.stderr}`)
    const fl = ok({ op: 'zip-list', file: foreign }, { tag: 'ext-list' })
    assert.equal(fl.count, 1)
    assert.equal(fl.entries[0].name, 'foreign.txt')
    assert.equal(fl.entries[0].size, Buffer.byteLength(foreignText))
    const fr = ok({ op: 'zip-read', file: foreign, name: 'foreign.txt' }, { tag: 'ext-read' })
    assert.equal(Buffer.from(fr.base64, 'base64').toString('utf8'), foreignText)
  } else {
    console.log('# 跳过 7z 校验（未找到 7z.exe）')
  }

  if (existsSync(PYTHON)) {
    const script = [
      'import json,sys,zipfile,hashlib',
      "sys.stdout.reconfigure(encoding='utf-8')",
      'z=zipfile.ZipFile(sys.argv[1])',
      'bad=z.testzip()',
      'out={"bad":bad,"entries":[{"name":i.filename,"size":i.file_size,"crc":i.CRC,',
      '  "method":i.compress_type,"sha256":hashlib.sha256(z.read(i)).hexdigest()} for i in z.infolist()]}',
      'print(json.dumps(out,ensure_ascii=False))'
    ].join('\n')
    const p = spawnSync(PYTHON, ['-c', script, zip], { encoding: 'utf8' })
    assert.equal(p.status, 0, `python 读取失败：${p.stderr}`)
    const data = JSON.parse(p.stdout)
    assert.equal(data.bad, null, 'python zipfile.testzip() 必须无损坏条目')
    assert.equal(data.entries.length, expect.size)
    for (const e of data.entries) {
      const want = expect.get(e.name)
      assert.ok(want, `python 读到的条目名不在预期内：${e.name}`)
      assert.equal(e.size, want.size, `${e.name} 大小不符`)
      assert.equal(e.crc, want.crc, `${e.name} CRC 不符`)
      assert.equal(e.method, want.method, `${e.name} 压缩方法不符`)
      assert.equal(e.sha256, want.sha256, `${e.name} 内容 sha256 不符`)
    }
    // 中文文件名在 Python 侧也必须是原文（UTF-8 名 + bit 11 生效）
    assert.ok(data.entries.some((e) => e.name === 'OEBPS/文本/第一章.xhtml'))
  } else {
    console.log('# 跳过 Python 校验（未找到 python.exe）')
  }
})

// ---------------------------------------------------------------- 6. zip64 / 加密 / 方法

test('ZIP 读取边界：zip64 EOCD、加密、未知压缩方法都给出明确错误', () => {
  // zip64：中央目录字段置满 0xFFFFFFFF，靠 zip64 扩展字段与 zip64 EOCD 还原
  const z64 = tmpPath('zip64.zip')
  writeFileSync(z64, buildRawZip([
    { name: 'zip64/中文.txt', data: '六十四个位也不怕' },
    { name: 'zip64/b.bin', data: 'B', method: 0 }
  ], { zip64: true }))
  const list = ok({ op: 'zip-list', file: z64 }, { tag: 'zip64' })
  assert.equal(list.count, 2)
  assert.deepEqual(list.entries.map((e) => e.name), ['zip64/中文.txt', 'zip64/b.bin'])
  assert.equal(list.entries[0].size, Buffer.from('六十四个位也不怕').length, 'zip64 扩展字段里的 size 必须被采用')
  assert.equal(list.entries[1].method, 0)
  const read = ok({ op: 'zip-read', file: z64, name: 'zip64/中文.txt' })
  assert.equal(Buffer.from(read.base64, 'base64').toString('utf8'), '六十四个位也不怕')

  // 加密：bit 0 置位 → 明确报错，而不是吐出垃圾
  const enc = tmpPath('encrypted.zip')
  writeFileSync(enc, buildRawZip([{ name: 'secret.txt', data: 'x', flags: 0x0001 }]))
  const e1 = err({ op: 'zip-list', file: enc }, { tag: 'enc' })
  assert.match(e1, /加密/)
  err({ op: 'zip-read', file: enc, name: 'secret.txt' }, { tag: 'enc2' })

  // 未知压缩方法（bzip2=12）→ 明确报错
  const bz = tmpPath('bzip2.zip')
  writeFileSync(bz, buildRawZip([{ name: 'b.txt', data: 'x', method: 12 }]))
  const e3 = err({ op: 'zip-read', file: bz, name: 'b.txt' }, { tag: 'method' })
  assert.match(e3, /不支持的压缩方法/)

  // 损坏的包（不是 zip）也要 ok:false，而不是崩
  const junk = tmpPath('junk.zip')
  writeFileSync(junk, Buffer.from('这不是一个 zip 文件，只是一段中文文本'))
  assert.match(err({ op: 'zip-list', file: junk }, { tag: 'junk' }), /EOCD|ZIP/)

  // 追加一个条目后，原条目仍要能正确解压（偏移被改写的回归）
  const out = tmpPath('zip64-patched.zip')
  ok({ op: 'zip-replace', file: z64, outFile: out, replacements: [], add: [{ name: 'new.txt', base64: b64('新') }] }, { tag: 'zip64-patch' })
  assert.equal(Buffer.from(ok({ op: 'zip-read', file: out, name: 'zip64/中文.txt' }).base64, 'base64').toString('utf8'), '六十四个位也不怕')
})

test('local header 带 data descriptor（bit 3、size=0）也必须能读', () => {
  // 手工把 local header 的 crc/size 抹成 0 并置 bit 3：真实大小只在中央目录（和 data descriptor）里。
  // 读取器一旦相信 local header，这里就会读出 0 字节或直接解压失败。
  const dd = tmpPath('data-descriptor.zip')
  const buf = buildRawZip([{ name: 'dd/中.txt', data: '描述符条目正文' }, { name: 'dd/b.bin', data: 'B', method: 0 }])
  buf.writeUInt16LE(buf.readUInt16LE(6) | 0x0008, 6)
  buf.writeUInt32LE(0, 14)
  buf.writeUInt32LE(0, 18)
  buf.writeUInt32LE(0, 22)
  // 第二条的 local header 紧跟其后
  const second = 30 + Buffer.byteLength('dd/中.txt') + deflateRawSync(Buffer.from('描述符条目正文')).length
  buf.writeUInt16LE(buf.readUInt16LE(second + 6) | 0x0008, second + 6)
  buf.writeUInt32LE(0, second + 14)
  buf.writeUInt32LE(0, second + 18)
  buf.writeUInt32LE(0, second + 22)
  writeFileSync(dd, buf)

  const list = ok({ op: 'zip-list', file: dd }, { tag: 'dd-list' })
  assert.deepEqual(list.entries.map((e) => [e.name, e.size]), [['dd/中.txt', Buffer.byteLength('描述符条目正文')], ['dd/b.bin', 1]])
  const r = ok({ op: 'zip-read', file: dd, name: 'dd/中.txt' }, { tag: 'dd-read' })
  assert.equal(Buffer.from(r.base64, 'base64').toString('utf8'), '描述符条目正文')
  const ex = ok({ op: 'zip-extract', file: dd, outDir: tmpPath('dd-out') }, { tag: 'dd-extract' })
  assert.equal(ex.files.length, 2)
  // 重写时要清掉 bit 3（我们写真实 size），产物仍需 7z 认可
  const fixed = tmpPath('dd-fixed.zip')
  ok({ op: 'zip-replace', file: dd, outFile: fixed, replacements: [{ name: 'dd/b.bin', base64: b64('C') }] }, { tag: 'dd-replace' })
  assert.equal(readFileSync(fixed).readUInt16LE(6) & 0x0008, 0, '写出的包不应再带 data descriptor 标志')
  if (existsSync(SEVEN_ZIP)) assert.equal(spawnSync(SEVEN_ZIP, ['t', fixed], { encoding: 'utf8' }).status, 0)
})

// ---------------------------------------------------------------- 7. hash / http

test('hash：存在的文件给 sha256，不存在的给 null', () => {
  const f = tmpPath('hash-me.txt')
  writeFileSync(f, 'Hello 汉化\n')
  const h = ok({
    op: 'hash',
    files: [f, tmpPath('nope.txt'), KIT]
  }, { tag: 'hash' })
  assert.equal(h.hashes[f], createHash('sha256').update(readFileSync(f)).digest('hex'))
  assert.equal(h.hashes[tmpPath('nope.txt')], null, '读不到的文件必须是 null，而不是整体失败')
  assert.match(h.hashes[KIT], /^[0-9a-f]{64}$/)
})

test('http-json：POST 对象体自动 JSON、4xx/5xx 不算失败、网络异常才 ok:false', async () => {
  const url = `http://127.0.0.1:${HTTP.port}/echo`
  const payload = { text: '需要翻译的句子', n: 2, nested: { 中文: true } }
  const r = await okAsync({
    op: 'http-json',
    url,
    method: 'POST',
    headers: { 'X-Test': 'mediakit' },
    body: payload,
    timeoutMs: 15000
  }, { tag: 'http' })
  assert.equal(r.status, 200)
  assert.equal(typeof r.ms, 'number')
  assert.ok(r.ms >= 0)
  assert.deepEqual(r.json.body, payload, 'body 对象必须被 JSON.stringify 后原样到达服务端')
  assert.equal(r.json.marker, 'mediakit')
  assert.equal(r.json.method, 'POST')
  assert.match(r.json.contentType, /application\/json/, '对象体要自动带 Content-Type')
  assert.equal(typeof r.text, 'string')
  assert.ok(r.text.length > 0 && r.text.length <= 200000)

  // 字符串体：不是对象，本工具不自动加 Content-Type（fetch 自己可能补 text/plain，都算符合契约）
  const r2 = await okAsync({ op: 'http-json', url, method: 'POST', body: 'raw-string-body' }, { tag: 'http2' })
  assert.ok(r2.json.contentType === null || /^text\/plain/.test(r2.json.contentType), `字符串体不该被塞成 JSON：${r2.json.contentType}`)
  assert.equal(r2.json.body, 'raw-string-body')

  // headers 里显式给了 Content-Type，就以调用方为准
  const r3 = await okAsync({
    op: 'http-json',
    url,
    method: 'POST',
    headers: { 'Content-Type': 'application/xml' },
    body: { a: 1 }
  }, { tag: 'http3' })
  assert.match(r3.json.contentType, /^application\/xml/)

  // 5xx：返回 ok:true + 真实 status，由调用方判断
  const boom = await okAsync({ op: 'http-json', url: `http://127.0.0.1:${HTTP.port}/boom`, method: 'POST', body: { a: 1 } }, { tag: 'http-boom' })
  assert.equal(boom.status, 500)
  assert.equal(boom.json, undefined, '非 JSON 响应不应给出 json 字段')
  assert.equal(boom.text, 'boom')
  assert.ok(boom.text.length <= 200000)

  // 网络异常 → ok:false
  const dead = err({ op: 'http-json', url: `http://127.0.0.1:${DEAD_PORT}/x`, method: 'GET', timeoutMs: 3000 }, { tag: 'http-dead' })
  assert.match(dead, /网络请求失败|请求超时|ECONNREFUSED/i)

  // GET 带 body 是调用方的错，要明确报错
  assert.match(err({ op: 'http-json', url, method: 'GET', body: { a: 1 } }, { tag: 'http-get-body' }), /GET/)
  assert.match(err({ op: 'http-json', url: 'ftp://x/y' }, { tag: 'http-badurl' }), /url/)
})

// ---------------------------------------------------------------- 8. 错误路径 + probe

test('每个 op 的错误路径都写出 ok:false 的 out.json（退出码仍是 0）', () => {
  const missing = tmpPath('not-here.zip')
  assert.match(err({ op: 'zip-list', file: missing }, { tag: 'e1' }), /ENOENT/)
  assert.match(err({ op: 'zip-read', file: missing, name: 'a.txt' }, { tag: 'e2' }), /ENOENT/)
  assert.match(err({ op: 'zip-extract', file: missing, outDir: tmpPath('x') }, { tag: 'e3' }), /ENOENT/)
  assert.match(err({ op: 'zip-replace', file: missing, outFile: tmpPath('y.zip'), replacements: [] }, { tag: 'e4' }), /ENOENT/)

  const zip = tmpPath('roundtrip.zip')
  assert.match(err({ op: 'zip-read', file: zip, name: '不存在.txt' }, { tag: 'e5' }), /不存在条目/)
  assert.match(err({ op: 'zip-replace', file: zip, outFile: tmpPath('y2.zip'), replacements: [{ name: '不存在.txt', base64: '' }] }, { tag: 'e6' }), /替换目标不存在/)
  assert.match(err({ op: 'zip-write', file: tmpPath('y3.zip'), entries: [{ name: 'ok.txt', fromFile: missing }] }, { tag: 'e7' }), /不可读/)
  assert.match(err({ op: 'zip-list' }, { tag: 'e8' }), /file/)
  assert.match(err({ op: 'zip-list', file: 'relative.zip' }, { tag: 'e9' }), /绝对路径/)
  assert.match(err({ op: 'hash', files: 'not-an-array' }, { tag: 'e10' }), /files/)
  assert.match(err({ op: '不存在的操作' }, { tag: 'e11' }), /未知的 op/)
  assert.match(err({ op: 'zip-write', file: tmpPath('y4.zip'), entries: [{ name: '' }] }, { tag: 'e12' }), /条目名/)
})

test('probe：报告 node 版本与 zlib/fetch 能力', () => {
  const p = ok({ op: 'probe' }, { tag: 'probe' })
  assert.match(p.node, /^v\d+\./)
  assert.equal(p.zlib, true)
  assert.equal(p.fetch, true)
})
