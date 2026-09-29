/**
 * mediakit —— 汉化引擎的零依赖底层能力（漫画 CBZ/ZIP、EPUB、PDF 容器、在线翻译/视觉 OCR 的 HTTP 通道）。
 *
 * 契约：`node mediakit.js <in.json> <out.json>`
 *   - 入参/出参都是 UTF-8 JSON，入参里的路径一律是绝对路径；
 *   - 无论业务成败都写出 out.json：成功 `{ok:true,...}`，失败 `{ok:false,error:"<消息>"}`；
 *   - 退出码 0 = out.json 已写出（业务失败也是 0），只有 out.json 本身写不出去才非 0；
 *   - 日志一律写 stderr，绝不污染 out.json。
 *
 * 为什么做成 CLI 而不是模块：引擎（host.js）跑在内核插件沙箱里，不能 require 第三方包，
 * 也不该把 ZIP 二进制解析塞进被内核校验的插件源码。把重活交给子进程里这个零依赖脚本，
 * 边界清楚、可单独测试。
 *
 * 模块形态：本文件所在目录及其上层都没有 package.json，因此按 CommonJS 加载。
 * 只使用 node: 内置模块，禁止任何第三方依赖。
 */
'use strict'

const fs = require('node:fs')
const path = require('node:path')
const zlib = require('node:zlib')
const crypto = require('node:crypto')
const http = require('node:http')
const https = require('node:https')

// 单条目上限：ZIP 里的一个条目解压后超过它就报错，避免 zip 炸弹式的一次性内存占用。
const MAX_ENTRY_BYTES = 512 * 1024 * 1024
// http-json 最多攒这么多字符再解析（返回给调用方的 text 另外截断到 200000）。
const MAX_BODY_CHARS = 8 * 1024 * 1024
const TEXT_LIMIT = 200000
const EMPTY = Buffer.alloc(0)
const UTF8_STRICT = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true })

const SIG_LOCAL = 0x04034b50
const SIG_CENTRAL = 0x02014b50
const SIG_EOCD = 0x06054b50
const SIG_ZIP64_EOCD = 0x06064b50
const SIG_ZIP64_LOCATOR = 0x07064b50
const U16_MAX = 0xffff
const U32_MAX = 0xffffffff

const msgOf = (e) => ((e && e.message) ? String(e.message) : String(e))
/** 业务错误：只把 message 写进 out.json，不往 stderr 打堆栈（调用方看得懂就够了）。 */
const fail = (msg) => {
  const e = new Error(msg)
  e.expected = true
  return e
}
const logWarn = (msg) => process.stderr.write(`[mediakit] ${msg}\n`)

// ---------------------------------------------------------------- CRC32 / 时间

// 查表法 CRC32（多项式 0xEDB88320），ZIP 条目校验用；自行实现以免依赖。
const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1)
    table[n] = c >>> 0
  }
  return table
})()

/** 可增量：crc32(chunk, crc32(prevChunk)) —— 流式校验时用。 */
function crc32 (buf, prev = 0) {
  let c = (prev ^ 0xffffffff) >>> 0
  for (let i = 0; i < buf.length; i++) c = (CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8)) >>> 0
  return (c ^ 0xffffffff) >>> 0
}

/** DOS 时间戳（本地时区，与常见打包器一致）。 */
function dosDateTime (d = new Date()) {
  const year = Math.max(1980, Math.min(2107, d.getFullYear()))
  const time = (d.getHours() << 11) | (d.getMinutes() << 5) | (Math.floor(d.getSeconds() / 2) & 0x1f)
  const date = ((year - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate()
  return { time: time & 0xffff, date: date & 0xffff }
}

// ---------------------------------------------------------------- 低层 IO

function readRange (fd, pos, len) {
  const buf = Buffer.allocUnsafe(len)
  let got = 0
  while (got < len) {
    const n = fs.readSync(fd, buf, got, len - got, pos + got)
    if (n <= 0) throw fail(`读取失败：文件在偏移 ${pos + got} 处意外结束`)
    got += n
  }
  return buf
}

function writeAll (fd, buf) {
  let off = 0
  while (off < buf.length) {
    const n = fs.writeSync(fd, buf, off, buf.length - off)
    if (n <= 0) throw fail('写入失败：磁盘未接收数据')
    off += n
  }
}

/** 分块读文件算 sha256：避免为几十 MB 的包一次性分配整块内存。 */
function sha256File (file) {
  const fd = fs.openSync(file, 'r')
  try {
    const hash = crypto.createHash('sha256')
    const buf = Buffer.allocUnsafe(1024 * 1024)
    for (;;) {
      const n = fs.readSync(fd, buf, 0, buf.length, null)
      if (n <= 0) break
      hash.update(buf.subarray(0, n))
    }
    return hash.digest('hex')
  } finally {
    fs.closeSync(fd)
  }
}

function readFileCapped (file, what) {
  let st
  try {
    st = fs.statSync(file)
  } catch (e) {
    throw fail(`${what} 不可读：${file} — ${msgOf(e)}`)
  }
  if (!st.isFile()) throw fail(`${what} 不是普通文件：${file}`)
  if (st.size > MAX_ENTRY_BYTES) throw fail(`${what} 过大（${st.size} 字节 > ${MAX_ENTRY_BYTES}）：${file}`)
  return fs.readFileSync(file)
}

const requireAbsPath = (value, field) => {
  if (typeof value !== 'string' || value === '') throw fail(`缺少必填字段 ${field}（需绝对路径字符串）`)
  if (!path.isAbsolute(value)) throw fail(`${field} 必须是绝对路径：${value}`)
  return value
}

// ---------------------------------------------------------------- ZIP 条目名

/** 读取侧：bit 11 置位按 UTF-8；否则先试严格 UTF-8，非法才回落 latin1（老打包器的 CP437 近似）。 */
function decodeZipName (raw, flags) {
  if (flags & 0x0800) return raw.toString('utf8')
  try {
    return UTF8_STRICT.decode(raw)
  } catch {
    return raw.toString('latin1')
  }
}

/** 写入侧：非 ASCII 名字按 UTF-8 存并置 bit 11，中文名才能被各家工具正确识别。 */
function encodeZipName (name) {
  const buf = Buffer.from(name, 'utf8')
  let ascii = true
  for (const b of buf) if (b >= 0x80) { ascii = false; break }
  return { buf, utf8: !ascii }
}

/**
 * 写入侧条目名校验：统一分隔符为 `/`，并拒绝会写出危险条目名（绝对路径、`..`、`:`、NUL）的名字。
 * 这与解压侧防护对称：本工具产出的包，自己也能安全解开。
 */
function normalizeWriteName (raw) {
  if (typeof raw !== 'string' || raw === '') throw fail('条目名不能为空')
  const name = raw.replace(/\\/g, '/')
  if (name.includes('\0')) throw fail('条目名含 NUL 字节，已拒绝')
  if (name.startsWith('/') || /^[a-zA-Z]:/.test(name)) throw fail(`条目名是绝对路径，已拒绝：${raw}`)
  if (name.includes(':')) throw fail(`条目名含 ":"，已拒绝：${raw}`)
  for (const seg of name.split('/')) if (seg === '..') throw fail(`条目名含 ".."，已拒绝：${raw}`)
  return name
}

/**
 * 解压侧路径防护：把条目名归一化成 outDir 内的相对路径。
 * 拒绝 `..`、绝对路径、盘符、`:`、NUL —— 这些正是 zip-slip 逃逸目录的手段。
 */
function safeRelativeName (raw) {
  const name = String(raw).replace(/\\/g, '/')
  if (name.includes('\0')) throw fail(`条目名含 NUL 字节，已拒绝：${raw}`)
  if (name.startsWith('/') || /^[a-zA-Z]:/.test(name)) throw fail(`条目名是绝对路径，已拒绝：${raw}`)
  const parts = []
  for (const seg of name.split('/')) {
    if (seg === '' || seg === '.') continue
    if (seg === '..') throw fail(`条目名含 ".."（目录穿越），已拒绝：${raw}`)
    if (seg.includes(':')) throw fail(`条目名含 ":"，已拒绝：${raw}`)
    parts.push(seg)
  }
  if (parts.length === 0) throw fail(`条目名为空或仅是目录，已拒绝：${raw}`)
  return parts.join('/')
}

/** 双保险：拼出来的绝对路径必须仍在 outDir 内。 */
function assertInside (root, target) {
  const rel = path.relative(root, target)
  if (rel === '' || rel.startsWith('..') || path.isAbsolute(rel)) {
    throw fail(`目标路径越出解压目录，已拒绝：${target}`)
  }
}

// ---------------------------------------------------------------- ZIP 读

class ZipReader {
  constructor (file) {
    this.file = file
    this.fd = fs.openSync(file, 'r')
    this.size = fs.fstatSync(this.fd).size
    try {
      this.entries = []
      this._readIndex()
    } catch (e) {
      this.close()
      throw e
    }
  }

  close () {
    if (this.fd !== -1) {
      try { fs.closeSync(this.fd) } catch { /* 已关闭 */ }
      this.fd = -1
    }
  }

  _read (pos, len) {
    if (len < 0 || pos < 0 || pos + len > this.size) {
      throw fail(`ZIP 结构异常：越界读取 offset=${pos} len=${len} fileSize=${this.size}`)
    }
    return readRange(this.fd, pos, len)
  }

  /** EOCD →（必要时 zip64 EOCD）→ 中央目录。刻意不读 local header 的 size 字段。 */
  _readIndex () {
    const tailLen = Math.min(this.size, 22 + U16_MAX)
    const tailStart = this.size - tailLen
    const tail = this._read(tailStart, tailLen)

    let at = -1
    for (let i = tailLen - 22; i >= 0; i--) {
      if (tail.readUInt32LE(i) !== SIG_EOCD) continue
      if (i + 22 + tail.readUInt16LE(i + 20) === tailLen) { at = i; break }
      if (at === -1) at = i // 注释长度对不上（尾部有杂字节）也先记下最后一个候选
    }
    if (at === -1) throw fail('不是有效的 ZIP：未找到 EOCD 记录')

    const eocdPos = tailStart + at
    const diskEntries = tail.readUInt16LE(at + 8)
    const totalEntries = tail.readUInt16LE(at + 10)
    let cdSize = tail.readUInt32LE(at + 12)
    let cdOffset = tail.readUInt32LE(at + 16)
    let count = totalEntries

    const needZip64 = totalEntries === U16_MAX || diskEntries === U16_MAX ||
      cdSize === U32_MAX || cdOffset === U32_MAX
    if (needZip64) {
      const z = this._readZip64(eocdPos)
      if (totalEntries === U16_MAX) count = z.totalEntries
      if (cdSize === U32_MAX) cdSize = z.cdSize
      if (cdOffset === U32_MAX) cdOffset = z.cdOffset
    }
    if (cdOffset + cdSize > this.size) throw fail('ZIP 结构异常：中央目录越界')

    const cd = this._read(cdOffset, cdSize)
    this.entries = parseCentralDirectory(cd, count)
  }

  _readZip64 (eocdPos) {
    if (eocdPos < 20) throw fail('ZIP64：EOCD 前缺少 zip64 定位器')
    const loc = this._read(eocdPos - 20, 20)
    if (loc.readUInt32LE(0) !== SIG_ZIP64_LOCATOR) throw fail('ZIP64：定位器签名不符')
    const rec = this._read(Number(loc.readBigUInt64LE(8)), 56)
    if (rec.readUInt32LE(0) !== SIG_ZIP64_EOCD) throw fail('ZIP64：EOCD 记录签名不符')
    return {
      totalEntries: Number(rec.readBigUInt64LE(32)),
      cdSize: Number(rec.readBigUInt64LE(40)),
      cdOffset: Number(rec.readBigUInt64LE(48))
    }
  }

  /** 条目压缩数据的起始偏移：数据起点只信 local header 的 nameLen/extraLen（长度可靠），
   *  size 一律用中央目录的值——有 data descriptor（bit 3）时 local header 的 size 字段可能是 0。 */
  dataOffsetOf (entry) {
    const lh = this._read(entry.localHeaderOffset, 30)
    if (lh.readUInt32LE(0) !== SIG_LOCAL) throw fail(`本地头签名不符：${entry.name}`)
    return entry.localHeaderOffset + 30 + lh.readUInt16LE(26) + lh.readUInt16LE(28)
  }

  /** 只取压缩后的原始字节（zip-replace 原样搬运未改动条目时用，保证字节级不变）。 */
  readRaw (entry) {
    if (entry.compSize > MAX_ENTRY_BYTES) {
      throw fail(`条目过大（压缩后 ${entry.compSize} 字节 > ${MAX_ENTRY_BYTES}）：${entry.name}`)
    }
    return this._read(this.dataOffsetOf(entry), entry.compSize)
  }

  readEntryBuffer (entry) {
    if (entry.method !== 0 && entry.method !== 8) {
      throw fail(`不支持的压缩方法 ${entry.method}（只支持 0=store / 8=deflate）：${entry.name}`)
    }
    if (entry.uncompSize > MAX_ENTRY_BYTES) {
      throw fail(`条目解压后过大（${entry.uncompSize} 字节 > ${MAX_ENTRY_BYTES}）：${entry.name}`)
    }
    const raw = this.readRaw(entry)
    let out
    if (entry.method === 0) {
      if (raw.length !== entry.uncompSize) {
        throw fail(`store 条目长度不符：${entry.name} 期望 ${entry.uncompSize} 实际 ${raw.length}`)
      }
      out = raw
    } else {
      try {
        out = zlib.inflateRawSync(raw, { maxOutputLength: MAX_ENTRY_BYTES })
      } catch (e) {
        throw fail(`解压失败（deflate）：${entry.name} — ${msgOf(e)}`)
      }
      if (out.length !== entry.uncompSize) {
        throw fail(`deflate 条目长度不符：${entry.name} 期望 ${entry.uncompSize} 实际 ${out.length}`)
      }
    }
    if (crc32(out) !== entry.crc) throw fail(`CRC 校验失败：${entry.name}`)
    return out
  }
}

function parseCentralDirectory (cd, count) {
  const entries = []
  let p = 0
  for (let i = 0; i < count; i++) {
    if (p + 46 > cd.length) throw fail(`中央目录损坏：第 ${i} 个条目头被截断`)
    if (cd.readUInt32LE(p) !== SIG_CENTRAL) throw fail(`中央目录损坏：第 ${i} 个条目签名不符`)

    const versionMadeBy = cd.readUInt16LE(p + 4)
    const versionNeeded = cd.readUInt16LE(p + 6)
    const flags = cd.readUInt16LE(p + 8)
    const method = cd.readUInt16LE(p + 10)
    const time = cd.readUInt16LE(p + 12)
    const date = cd.readUInt16LE(p + 14)
    const crc = cd.readUInt32LE(p + 16)
    let compSize = cd.readUInt32LE(p + 20)
    let uncompSize = cd.readUInt32LE(p + 24)
    const nameLen = cd.readUInt16LE(p + 28)
    const extraLen = cd.readUInt16LE(p + 30)
    const commentLen = cd.readUInt16LE(p + 32)
    let diskStart = cd.readUInt16LE(p + 34)
    const intAttr = cd.readUInt16LE(p + 36)
    const extAttr = cd.readUInt32LE(p + 38)
    let localOffset = cd.readUInt32LE(p + 42)
    const nameAt = p + 46
    const rawName = cd.subarray(nameAt, nameAt + nameLen)
    const extraAt = nameAt + nameLen
    const extra = cd.subarray(extraAt, extraAt + extraLen)
    const comment = cd.subarray(extraAt + extraLen, extraAt + extraLen + commentLen)
    p = extraAt + extraLen + commentLen

    // zip64 扩展字段 0x0001：按 uncomp / comp / offset / disk 的固定顺序补齐被置满的字段
    let ep = 0
    while (ep + 4 <= extra.length) {
      const id = extra.readUInt16LE(ep)
      const len = extra.readUInt16LE(ep + 2)
      if (ep + 4 + len > extra.length) break
      if (id === 0x0001) {
        let q = ep + 4
        if (uncompSize === U32_MAX) { uncompSize = Number(extra.readBigUInt64LE(q)); q += 8 }
        if (compSize === U32_MAX) { compSize = Number(extra.readBigUInt64LE(q)); q += 8 }
        if (localOffset === U32_MAX) { localOffset = Number(extra.readBigUInt64LE(q)); q += 8 }
        if (diskStart === U16_MAX) { diskStart = extra.readUInt32LE(q); q += 4 }
      }
      ep += 4 + len
    }

    const name = decodeZipName(rawName, flags)
    if (flags & 0x0001) throw fail(`ZIP 条目已加密（不支持解密）：${name}`)
    if (diskStart !== 0) throw fail(`ZIP 是分卷压缩包（不支持）：${name}`)

    entries.push({
      index: i, name, rawName, flags, method, time, date, crc,
      compSize, uncompSize, localHeaderOffset: localOffset,
      versionMadeBy, versionNeeded, intAttr, extAttr, comment
    })
  }
  return entries
}

// ---------------------------------------------------------------- ZIP 写

function compressByMethod (content, method) {
  if (method === 0) return content
  if (method === 8) return zlib.deflateRawSync(content, { level: 6 })
  throw fail(`不支持的压缩方法 ${method}（只支持 0=store / 8=deflate）`)
}

/** 条目名的原始字节：新条目用 UTF-8 编码结果，从包里读出来的条目沿用原字节（保持名字编码不失真）。 */
const nameBytesOf = (e) => e.nameBuf || e.rawName || EMPTY

/** 条目压缩数据的来源：要么在内存里（新内容），要么是源包里的字节区间（原样搬运，省内存）。 */
const dataLengthOf = (e) => (e.copyFrom ? e.copyFrom.length : e.data.length)

/** 写入前的 zip64 预算检查：宁可明确报错，也不写出坏包。 */
function assertWritableZip32 (entries) {
  if (entries.length > U16_MAX) {
    throw fail(`条目数 ${entries.length} 超过 65535，需要 zip64（当前实现不支持写出 zip64）`)
  }
  let end = 0
  let cdSize = 0
  for (const e of entries) {
    if (e.compSize > U32_MAX || e.uncompSize > U32_MAX) {
      throw fail(`条目 ${e.name} 超过 4GB，需要 zip64（当前实现不支持写出 zip64）`)
    }
    end += 30 + nameBytesOf(e).length + dataLengthOf(e)
    cdSize += 46 + nameBytesOf(e).length + e.comment.length
  }
  if (end + cdSize + 22 > U32_MAX) {
    throw fail('归档总大小超过 4GB，需要 zip64（当前实现不支持写出 zip64）')
  }
}

/** 分块搬运源包里的字节区间：修一个大 CBZ 时不必把整包读进内存。 */
function copyRange (srcFd, srcPos, length, dstFd) {
  const buf = Buffer.allocUnsafe(Math.min(length, 1024 * 1024) || 1)
  let done = 0
  while (done < length) {
    const want = Math.min(buf.length, length - done)
    const n = fs.readSync(srcFd, buf, 0, want, srcPos + done)
    if (n <= 0) throw fail(`读取源 ZIP 失败：偏移 ${srcPos + done} 处意外结束`)
    writeAll(dstFd, buf.subarray(0, n))
    done += n
  }
}

/**
 * 顺序写 ZIP 到临时文件：local header + data 逐条落盘，最后中央目录 + EOCD。
 * entries 数组顺序即输出顺序（EPUB 要求 mimetype 是第一条且 store）。
 * 只写临时文件、不负责改名：zip-replace 需要先关掉源句柄（outFile 可能等于源文件）再改名。
 */
function writeZipTmp (outFile, entries) {
  assertWritableZip32(entries)
  fs.mkdirSync(path.dirname(outFile), { recursive: true })
  const tmp = `${outFile}.mediakit-${process.pid}.tmp`
  const fd = fs.openSync(tmp, 'w')
  let offset = 0
  const placed = []
  try {
    for (const e of entries) {
      const flags = e.flags & ~0x0008 // 我们自己写真实 size，不用 data descriptor
      const nameBuf = nameBytesOf(e)
      const local = Buffer.alloc(30)
      local.writeUInt32LE(SIG_LOCAL, 0)
      local.writeUInt16LE(e.versionNeeded || 20, 4)
      local.writeUInt16LE(flags, 6)
      local.writeUInt16LE(e.method, 8)
      local.writeUInt16LE(e.time, 10)
      local.writeUInt16LE(e.date, 12)
      local.writeUInt32LE(e.crc >>> 0, 14)
      local.writeUInt32LE(e.compSize, 18)
      local.writeUInt32LE(e.uncompSize, 22)
      local.writeUInt16LE(nameBuf.length, 26)
      local.writeUInt16LE(0, 28)
      writeAll(fd, local)
      writeAll(fd, nameBuf)
      if (e.copyFrom) copyRange(e.copyFrom.fd, e.copyFrom.pos, e.copyFrom.length, fd)
      else writeAll(fd, e.data)
      placed.push({ e, flags, nameBuf, offset })
      offset += 30 + nameBuf.length + dataLengthOf(e)
    }

    const cdStart = offset
    for (const { e, flags, nameBuf, offset: localOffset } of placed) {
      const cd = Buffer.alloc(46)
      cd.writeUInt32LE(SIG_CENTRAL, 0)
      cd.writeUInt16LE(e.versionMadeBy || 20, 4)
      cd.writeUInt16LE(e.versionNeeded || 20, 6)
      cd.writeUInt16LE(flags, 8)
      cd.writeUInt16LE(e.method, 10)
      cd.writeUInt16LE(e.time, 12)
      cd.writeUInt16LE(e.date, 14)
      cd.writeUInt32LE(e.crc >>> 0, 16)
      cd.writeUInt32LE(e.compSize, 20)
      cd.writeUInt32LE(e.uncompSize, 24)
      cd.writeUInt16LE(nameBuf.length, 28)
      cd.writeUInt16LE(0, 30)
      cd.writeUInt16LE(e.comment.length, 32)
      cd.writeUInt16LE(0, 34)
      cd.writeUInt16LE(e.intAttr || 0, 36)
      cd.writeUInt32LE(e.extAttr >>> 0, 38)
      cd.writeUInt32LE(localOffset, 42)
      writeAll(fd, cd)
      writeAll(fd, nameBuf)
      writeAll(fd, e.comment)
      offset += cd.length + nameBuf.length + e.comment.length
    }
    const cdSize = offset - cdStart

    const eocd = Buffer.alloc(22)
    eocd.writeUInt32LE(SIG_EOCD, 0)
    eocd.writeUInt16LE(0, 4)
    eocd.writeUInt16LE(0, 6)
    eocd.writeUInt16LE(entries.length, 8)
    eocd.writeUInt16LE(entries.length, 10)
    eocd.writeUInt32LE(cdSize, 12)
    eocd.writeUInt32LE(cdStart, 16)
    eocd.writeUInt16LE(0, 20)
    writeAll(fd, eocd)
    offset += eocd.length
  } catch (e) {
    try { fs.closeSync(fd) } catch { /* 已关 */ }
    try { fs.unlinkSync(tmp) } catch { /* 没写成 */ }
    throw e
  }
  fs.closeSync(fd)
  return { tmp, size: offset, count: entries.length }
}

/** 写完临时文件再改名：中途失败不会留下半个坏包。 */
function writeZipFile (outFile, entries) {
  const r = writeZipTmp(outFile, entries)
  fs.renameSync(r.tmp, outFile)
  return r
}

/** 新条目（zip-write / zip-replace 的 add）——自带元信息，字节按 UTF-8 名 + 可选 deflate。 */
function makeNewEntry (name, content, compress) {
  const { buf: nameBuf, utf8 } = encodeZipName(name)
  const method = compress ? 8 : 0
  const data = compressByMethod(content, method)
  const { time, date } = dosDateTime()
  return {
    name, nameBuf, flags: utf8 ? 0x0800 : 0, method, time, date,
    crc: crc32(content), compSize: data.length, uncompSize: content.length, data,
    versionMadeBy: 20, versionNeeded: 20, intAttr: 0, extAttr: 0, comment: EMPTY
  }
}

function contentOf (spec, what) {
  if (spec.fromFile != null) return readFileCapped(String(spec.fromFile), what)
  if (spec.base64 != null) return Buffer.from(String(spec.base64), 'base64')
  return EMPTY
}

// ---------------------------------------------------------------- op 实现

function opHash (req) {
  if (!Array.isArray(req.files)) throw fail('files 必须是数组')
  const hashes = {}
  for (const file of req.files) {
    const key = String(file)
    try {
      hashes[key] = sha256File(key)
    } catch (e) {
      logWarn(`hash 跳过 ${key}：${msgOf(e)}`)
      hashes[key] = null
    }
  }
  return { hashes }
}

function opZipList (req) {
  const file = requireAbsPath(req.file, 'file')
  const zr = new ZipReader(file)
  try {
    return {
      entries: zr.entries.map((e) => ({
        name: e.name,
        size: e.uncompSize,
        compressedSize: e.compSize,
        method: e.method,
        crc32: e.crc,
        index: e.index
      })),
      count: zr.entries.length
    }
  } finally {
    zr.close()
  }
}

function opZipRead (req) {
  const file = requireAbsPath(req.file, 'file')
  const name = String(req.name)
  const zr = new ZipReader(file)
  try {
    const entry = zr.entries.find((e) => e.name === name)
    if (!entry) throw fail(`ZIP 中不存在条目：${name}`)
    const data = zr.readEntryBuffer(entry)
    return { base64: data.toString('base64'), size: data.length }
  } finally {
    zr.close()
  }
}

function opZipExtract (req) {
  const file = requireAbsPath(req.file, 'file')
  const outDir = requireAbsPath(req.outDir, 'outDir')
  const wanted = Array.isArray(req.names) ? new Set(req.names.map(String)) : null
  const zr = new ZipReader(file)
  try {
    // 先整体校验再落盘：坏包里有一条穿越条目时，一个文件都不写出去。
    const plans = []
    for (const e of zr.entries) {
      if (e.name.endsWith('/')) continue // 目录条目：写文件时自然建目录
      if (wanted && !wanted.has(e.name)) continue
      const rel = safeRelativeName(e.name)
      const target = path.join(outDir, rel)
      assertInside(path.resolve(outDir), path.resolve(target))
      plans.push({ e, target })
    }
    const files = []
    for (const { e, target } of plans) {
      const data = zr.readEntryBuffer(e)
      fs.mkdirSync(path.dirname(target), { recursive: true })
      fs.writeFileSync(target, data)
      files.push({ name: e.name, path: target, size: data.length })
    }
    return { files }
  } finally {
    zr.close()
  }
}

function opZipWrite (req) {
  const file = requireAbsPath(req.file, 'file')
  if (!Array.isArray(req.entries)) throw fail('entries 必须是数组')
  const entries = req.entries.map((it) => {
    if (!it || typeof it !== 'object') throw fail('entries 的元素必须是对象')
    const name = normalizeWriteName(it.name)
    return makeNewEntry(name, contentOf(it, 'entry'), it.compress !== false)
  })
  const r = writeZipFile(file, entries)
  return { size: r.size, count: r.count }
}

function opZipReplace (req) {
  const file = requireAbsPath(req.file, 'file')
  const outFile = requireAbsPath(req.outFile, 'outFile')
  const replacements = req.replacements == null ? [] : req.replacements
  const add = req.add == null ? [] : req.add
  const remove = req.remove == null ? [] : req.remove
  if (!Array.isArray(replacements) || !Array.isArray(add) || !Array.isArray(remove)) {
    throw fail('replacements/add/remove 必须是数组')
  }

  const zr = new ZipReader(file)
  let entries
  let replaced = 0
  let removed = 0
  try {
    const byName = new Map(zr.entries.map((e) => [e.name, e]))
    const repl = new Map()
    for (const r of replacements) {
      if (!r || typeof r !== 'object') throw fail('replacements 的元素必须是对象')
      const name = String(r.name)
      if (!byName.has(name)) throw fail(`替换目标不存在于 ZIP 中：${name}`)
      repl.set(name, r)
    }
    const removeSet = new Set(remove.map(String))

    entries = []
    for (const e of zr.entries) {
      if (removeSet.has(e.name)) { removed++; continue }
      const r = repl.get(e.name)
      if (!r) {
        // 未改动条目：原地引用源包里的压缩字节区间，CRC/时间/名字字节全按原样搬运，
        // 只有 local header 偏移会变（写入时逐块搬运，不把整包读进内存）。
        entries.push({ ...e, copyFrom: { fd: zr.fd, pos: zr.dataOffsetOf(e), length: e.compSize } })
        continue
      }
      // 被替换条目：保持原压缩方法（原来 deflate 仍 deflate，原来 store 仍 store），元信息沿用原条目。
      const content = contentOf(r, 'replacement')
      const data = compressByMethod(content, e.method)
      entries.push({ ...e, data, crc: crc32(content), compSize: data.length, uncompSize: content.length })
      replaced++
    }
  } catch (e) {
    zr.close()
    throw e
  }

  const addNames = new Set()
  for (const a of add) {
    if (!a || typeof a !== 'object') throw fail('add 的元素必须是对象')
    const name = normalizeWriteName(a.name)
    if (addNames.has(name)) throw fail(`add 中有重复条目名：${name}`)
    addNames.add(name)
    if (byNameHas(entries, name)) logWarn(`add 的条目名与已有条目重名（将出现重复条目）：${name}`)
    entries.push(makeNewEntry(name, contentOf(a, 'add'), a.compress !== false))
  }

  let written
  try {
    written = writeZipTmp(outFile, entries) // 这一步还在从源包读字节，源句柄必须留着
  } catch (e) {
    zr.close()
    throw e
  }
  zr.close() // 关掉源句柄再改名：outFile 可能等于 file，Windows 下改名要确保句柄已释放
  fs.renameSync(written.tmp, outFile)
  return { size: written.size, replaced, added: add.length, removed }
}

const byNameHas = (entries, name) => entries.some((e) => e.name === name)

function opProbe () {
  // 如实探测能力，而不是硬编码 true。
  let zlibOk = false
  try {
    const probe = Buffer.from('mediakit probe 中文', 'utf8')
    zlibOk = zlib.inflateRawSync(zlib.deflateRawSync(probe)).equals(probe)
  } catch { zlibOk = false }
  return {
    node: process.version,
    zlib: zlibOk,
    fetch: typeof globalThis.fetch === 'function',
    zip64Read: true,
    zip64Write: false
  }
}

// ---------------------------------------------------------------- HTTP

function httpJsonFallback (url, method, headers, body, timeoutMs) {
  return new Promise((resolve, reject) => {
    let u
    try { u = new URL(url) } catch (e) { reject(fail(`url 非法：${url}`)); return }
    const mod = u.protocol === 'https:' ? https : (u.protocol === 'http:' ? http : null)
    if (!mod) { reject(fail(`不支持的协议：${u.protocol}`)); return }
    const req = mod.request(u, { method, headers }, (res) => {
      const chunks = []
      let len = 0
      res.setEncoding('utf8')
      res.on('data', (c) => {
        if (len < MAX_BODY_CHARS) { chunks.push(c); len += c.length }
      })
      res.on('end', () => resolve({ status: res.statusCode || 0, text: chunks.join('') }))
      res.on('error', reject)
    })
    if (timeoutMs > 0) req.setTimeout(timeoutMs, () => req.destroy(new Error(`请求超时（${timeoutMs}ms）`)))
    req.on('error', reject)
    if (body !== undefined) req.write(body)
    req.end()
  })
}

async function httpRequest (url, method, headers, body, timeoutMs) {
  if (typeof globalThis.fetch === 'function') {
    const init = { method, headers, redirect: 'follow' }
    if (body !== undefined) init.body = body
    if (timeoutMs > 0) init.signal = AbortSignal.timeout(timeoutMs)
    try {
      const res = await fetch(url, init)
      const text = await res.text()
      return { status: res.status, text }
    } catch (e) {
      const cause = e && e.cause && e.cause.message ? `（${e.cause.message}）` : ''
      if (e && (e.name === 'TimeoutError' || e.name === 'AbortError')) throw fail(`请求超时（${timeoutMs}ms）：${url}`)
      throw fail(`网络请求失败：${msgOf(e)}${cause} — ${url}`)
    }
  }
  logWarn('当前 Node 没有全局 fetch，改用 http/https 内置模块')
  return httpJsonFallback(url, method, headers, body, timeoutMs)
}

async function opHttpJson (req) {
  const url = String(req.url || '')
  if (!/^https?:\/\//i.test(url)) throw fail(`url 必须是 http(s) 绝对地址：${url || '(缺失)'}`)
  const headers = {}
  if (req.headers != null) {
    if (typeof req.headers !== 'object' || Array.isArray(req.headers)) throw fail('headers 必须是对象')
    for (const [k, v] of Object.entries(req.headers)) headers[k] = String(v)
  }
  const hasHeader = (n) => Object.keys(headers).some((k) => k.toLowerCase() === n)
  const method = String(req.method || (req.body === undefined && req.bodyBase64 === undefined ? 'GET' : 'POST')).toUpperCase()

  let body
  if (req.bodyBase64 !== undefined) {
    body = Buffer.from(String(req.bodyBase64), 'base64') // 扩展：OCR 直接上传二进制（调用方自己设 Content-Type）
  } else if (req.body !== undefined && req.body !== null) {
    if (typeof req.body === 'string') body = req.body
    else {
      body = JSON.stringify(req.body)
      if (!hasHeader('content-type')) headers['Content-Type'] = 'application/json'
    }
  }
  if (body !== undefined && (method === 'GET' || method === 'HEAD')) {
    throw fail(`${method} 请求不能带 body`)
  }

  // 默认 150s：调用方（media.js httpJson）在不传 timeoutMs 时给的宽限是 180s，
  // 这里必须更早收手，才能把「超时」当成一次干净的 ok:false 返回，而不是被外面掐死。
  const timeoutMs = Number.isFinite(req.timeoutMs) && req.timeoutMs > 0 ? Number(req.timeoutMs) : 150000
  const started = Date.now()
  const res = await httpRequest(url, method, headers, body, timeoutMs)
  const ms = Date.now() - started
  const out = { status: res.status, text: res.text.slice(0, TEXT_LIMIT), ms }
  try {
    out.json = JSON.parse(res.text)
  } catch {
    // 响应不是 JSON：留给调用方看 text/status，4xx/5xx 不算本工具的失败
  }
  return out
}

// ---------------------------------------------------------------- 调度

async function runOp (req) {
  if (!req || typeof req !== 'object' || Array.isArray(req)) throw fail('入参必须是 JSON 对象')
  switch (String(req.op || '')) {
    case 'hash': return opHash(req)
    case 'zip-list': return opZipList(req)
    case 'zip-read': return opZipRead(req)
    case 'zip-extract': return opZipExtract(req)
    case 'zip-write': return opZipWrite(req)
    case 'zip-replace': return opZipReplace(req)
    case 'http-json': return opHttpJson(req)
    case 'probe': return opProbe()
    default: throw fail(`未知的 op：${String(req.op || '(缺失)')}`)
  }
}

const stripBom = (s) => (s.charCodeAt(0) === 0xfeff ? s.slice(1) : s)

async function main () {
  const [inPath, outPath] = process.argv.slice(2)
  if (!inPath || !outPath) {
    process.stderr.write('用法：node mediakit.js <in.json> <out.json>\n')
    return 2
  }

  let out
  try {
    const req = JSON.parse(stripBom(fs.readFileSync(inPath, 'utf8')))
    out = Object.assign({ ok: true }, await runOp(req))
  } catch (e) {
    process.stderr.write(`[mediakit] ${msgOf(e)}\n`)
    if (e && e.stack && !e.expected) process.stderr.write(`${e.stack}\n`)
    out = { ok: false, error: msgOf(e) }
  }

  try {
    fs.mkdirSync(path.dirname(outPath), { recursive: true })
    fs.writeFileSync(outPath, JSON.stringify(out), 'utf8')
    return 0
  } catch (e) {
    process.stderr.write(`[mediakit] 无法写出 ${outPath}：${msgOf(e)}\n`)
    return 1
  }
}

// 同目录下若被当作 ESM 加载也不会走到这里（那是另一个进程形态）；本文件按 CLI 使用。
main().then(
  (code) => { process.exitCode = code },
  (e) => {
    process.stderr.write(`[mediakit] 崩溃：${msgOf(e)}\n${(e && e.stack) || ''}\n`)
    process.exitCode = 1
  }
)
