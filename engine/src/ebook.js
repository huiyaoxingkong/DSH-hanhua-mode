// ═══════════════════════════════════════════════════════════════════════════
// 电子书文本层（纯函数，无 host 服务依赖，可单独单测）
//
// EPUB 是 ZIP 容器：opf 清单 + spine 阅读顺序 + 若干 XHTML 正文文件。
// 这里只做「文本层」的事：定位 opf、按 spine 排出正文顺序、抽取/回写 XHTML 文本节点。
// 真正的解包/打包由 media.js 调 mediakit.js（zlib + 中央目录）完成。
// ═══════════════════════════════════════════════════════════════════════════

const EBOOK_EXTS = ['epub', 'pdf', 'html', 'htm', 'xhtml', 'xht']
const isEbookExt = (ext) => EBOOK_EXTS.indexOf(String(ext || '').toLowerCase()) >= 0

const decodeEntities = (s) => String(s)
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
  .replace(/&quot;/g, '"').replace(/&apos;/g, "'")
  .replace(/&#(\d+);/g, (_m, d) => String.fromCodePoint(Number(d)))
  .replace(/&#x([0-9a-fA-F]+);/g, (_m, h) => String.fromCodePoint(parseInt(h, 16)))
  .replace(/&nbsp;/g, '\u00a0')
  .replace(/&amp;/g, '&')

const escapeHtmlText = (s) => String(s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/\u00a0/g, '&nbsp;')

// ── container.xml → opf 路径
const findContainerOpf = (containerXml) => {
  const m = String(containerXml || '').match(/<rootfile[^>]*full-path\s*=\s*"([^"]+)"/i)
    || String(containerXml || '').match(/<rootfile[^>]*full-path\s*=\s*'([^']+)'/i)
  return m ? m[1] : null
}

// ── opf 解析：manifest + spine（只看属性，够用且对命名空间鲁棒）
const parseOpf = (opfXml) => {
  const xml = String(opfXml || '')
  const manifest = {}
  const items = xml.match(/<item\b[^>]*>/gi) || []
  for (const it of items) {
    const id = (it.match(/\bid\s*=\s*"([^"]*)"/i) || it.match(/\bid\s*=\s*'([^']*)'/i) || [])[1]
    const href = (it.match(/\bhref\s*=\s*"([^"]*)"/i) || it.match(/\bhref\s*=\s*'([^']*)'/i) || [])[1]
    const mediaType = (it.match(/\bmedia-type\s*=\s*"([^"]*)"/i) || it.match(/\bmedia-type\s*=\s*'([^']*)'/i) || [])[1]
    const properties = (it.match(/\bproperties\s*=\s*"([^"]*)"/i) || [])[1] || ''
    if (id && href) manifest[id] = { id, href, mediaType: mediaType || '', properties }
  }
  const spine = []
  const refs = xml.match(/<itemref\b[^>]*>/gi) || []
  for (const r of refs) {
    if (/\blinear\s*=\s*"no"/i.test(r)) continue
    const idref = (r.match(/\bidref\s*=\s*"([^"]*)"/i) || r.match(/\bidref\s*=\s*'([^']*)'/i) || [])[1]
    if (idref && manifest[idref]) spine.push(manifest[idref])
  }
  return { version: (xml.match(/<package[^>]*version\s*=\s*"([^"]*)"/i) || [])[1] || '2.0', manifest, spine }
}

// zip 内相对路径归一化（opf 里的 href 相对 opf 所在目录）
const resolveHref = (opfPath, href) => {
  const stash = String(opfPath || '').split('/').slice(0, -1)
  const parts = String(href || '').split('/')
  for (const p of parts) {
    if (p === '' || p === '.') continue
    if (p === '..') stash.pop()
    else stash.push(p)
  }
  return stash.join('/')
}

// ── XHTML 文本节点抽取：返回 { index, text, ref:{from,to}, tag, inHead }
const HTML_SKIP_TAGS = new Set(['script', 'style', 'svg', 'math'])
const parseHtmlTextNodes = (html) => {
  const s = String(html || '')
  const nodes = []
  const stack = []
  let i = 0
  let idx = 0
  let textStart = -1
  const flush = (end) => {
    if (textStart < 0) return
    const from = textStart
    const raw = s.slice(from, end)
    textStart = -1
    if (!raw.trim()) return
    // script/style/svg/math 内部的文本不是正文（栈里只要出现过就整段跳过）
    for (const t of stack) if (HTML_SKIP_TAGS.has(t)) return
    const decoded = decodeEntities(raw)
    if (!decoded.trim()) return
    const top = stack.length ? stack[stack.length - 1] : ''
    nodes.push({
      index: idx++,
      text: decoded,
      ref: { kind: 'htmlchars', from, to: end },
      tag: top,
      inHead: stack.indexOf('head') >= 0,
    })
  }
  while (i < s.length) {
    const lt = s.indexOf('<', i)
    if (lt < 0) { if (textStart < 0) textStart = i; break }
    if (textStart < 0) textStart = i
    flush(lt)
    // 注释 / CDATA / 声明
    if (s.startsWith('<!--', lt)) { const e = s.indexOf('-->', lt); i = e < 0 ? s.length : e + 3; continue }
    if (s.startsWith('<![CDATA[', lt)) { const e = s.indexOf(']]>', lt); i = e < 0 ? s.length : e + 3; continue }
    const gt = s.indexOf('>', lt)
    if (gt < 0) break
    const tagText = s.slice(lt + 1, gt)
    const close = tagText.startsWith('/')
    const name = (tagText.replace(/^\//, '').match(/^[A-Za-z0-9:_-]+/) || [''])[0].toLowerCase()
    const selfClose = /\/\s*$/.test(tagText)
    if (close) {
      const at = stack.lastIndexOf(name)
      if (at >= 0) stack.length = at
    } else if (name && !selfClose && !HTML_SKIP_TAGS.has(name)) {
      stack.push(name)
    } else if (name && !selfClose) {
      stack.push(name) // script/style 也入栈，让 flush 时被判为跳过
    }
    i = gt + 1
    textStart = i
  }
  return nodes
}

// 回写：按 offset 倒序替换，附带 HTML 转义；只替换给了 target 的节点
const applyHtmlTextNodes = (html, patches) => {
  let out = String(html || '')
  const sorted = patches.slice().sort((a, b) => b.ref.from - a.ref.from)
  for (const p of sorted) {
    out = out.slice(0, p.ref.from) + escapeHtmlText(p.target) + out.slice(p.ref.to)
  }
  return out
}

// 文本节点里的「非正文」过滤：纯符号/纯数字/过短且无字母
const looksTranslatable = (text) => /[A-Za-z\u00c0-\u024f\u0400-\u04ff\u3040-\u30ff\u4e00-\u9fff\uac00-\ud7af]/.test(String(text || ''))

// EPUB 里应当翻译的非正文媒体类型（封面样式等）
const isContentMediaType = (mt) => /xhtml|html|xml/i.test(String(mt || '')) && !/ncx|opf/i.test(String(mt || ''))

export {
  EBOOK_EXTS, isEbookExt, decodeEntities, escapeHtmlText, findContainerOpf, parseOpf, resolveHref,
  parseHtmlTextNodes, applyHtmlTextNodes, looksTranslatable, isContentMediaType,
}
