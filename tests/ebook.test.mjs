/**
 * 电子书文本层单测（engine/src/ebook.js）
 * 用法：node tests/ebook.test.mjs
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { findContainerOpf, parseOpf, resolveHref, parseHtmlTextNodes, applyHtmlTextNodes, escapeHtmlText, decodeEntities, looksTranslatable, isEbookExt } from '../engine/src/ebook.js'

const CONTAINER = `<?xml version="1.0"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles>
</container>`

const OPF = `<?xml version="1.0" encoding="utf-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="bookid">
  <manifest>
    <item id="ch1" href="ch1.xhtml" media-type="application/xhtml+xml"/>
    <item id="ch2" href="text/ch2.xhtml" media-type="application/xhtml+xml"/>
    <item id="css" href="style.css" media-type="text/css"/>
    <item id="cover" href="cover.jpg" media-type="image/jpeg"/>
  </manifest>
  <spine toc="ncx"><itemref idref="ch1"/><itemref idref="ch2"/></spine>
</package>`

const HTML = `<?xml version="1.0" encoding="utf-8"?>
<html xmlns="http://www.w3.org/1999/xhtml"><head><title>Prologue</title>
<style>p { color: red; }</style><script>var x = "not text";</script></head>
<body><h1>Prologue</h1>
<p>Aldermoor was quiet &amp; still.</p>
<p>Only <b>one</b> hammer broke it.</p>
<p>   </p>
<p>42</p>
</body></html>`

test('container.xml → opf 路径', () => {
  assert.equal(findContainerOpf(CONTAINER), 'OEBPS/content.opf')
  assert.equal(findContainerOpf('<container/>'), null)
})

test('opf：manifest 与 spine 阅读顺序', () => {
  const opf = parseOpf(OPF)
  assert.equal(opf.version, '3.0')
  assert.equal(opf.spine.length, 2)
  assert.deepEqual(opf.spine.map((s) => s.href), ['ch1.xhtml', 'text/ch2.xhtml'])
  assert.equal(opf.manifest.css.mediaType, 'text/css')
})

test('spine href 相对 opf 目录解析', () => {
  assert.equal(resolveHref('OEBPS/content.opf', 'ch1.xhtml'), 'OEBPS/ch1.xhtml')
  assert.equal(resolveHref('OEBPS/content.opf', 'text/ch2.xhtml'), 'OEBPS/text/ch2.xhtml')
  assert.equal(resolveHref('OEBPS/text/content.opf', '../img/a.png'), 'OEBPS/img/a.png')
})

test('XHTML 文本节点：跳过 script/style，实体解码，空白与纯数字被判为不可译', () => {
  const nodes = parseHtmlTextNodes(HTML)
  const texts = nodes.map((n) => n.text)
  assert.ok(texts.includes('Prologue'))
  assert.ok(texts.includes('Aldermoor was quiet & still.'), JSON.stringify(texts))
  assert.ok(texts.some((t) => t.includes('one')), '内联标签之间的文本要抽出来')
  assert.ok(!texts.some((t) => t.includes('not text')), 'script 内容不能被当成正文')
  assert.ok(!texts.some((t) => t.includes('color: red')), 'style 内容不能被当成正文')
  assert.ok(!looksTranslatable('42'))
  assert.ok(!looksTranslatable('   '))
  assert.ok(looksTranslatable('勇者'))
})

test('文本节点回写：只替换指定节点，并做 HTML 转义', () => {
  const nodes = parseHtmlTextNodes(HTML)
  const target = nodes.find((n) => n.text === 'Aldermoor was quiet & still.')
  const out = applyHtmlTextNodes(HTML, [{ ref: target.ref, target: '奥尔德穆尔一片寂静 <安静>' }])
  assert.ok(out.includes('奥尔德穆尔一片寂静 &lt;安静&gt;'))
  assert.ok(out.includes('Only <b>one</b> hammer broke it.'), '其它节点不受影响')
  assert.ok(out.includes('<script>var x = "not text";</script>'), 'script 原样保留')
  assert.ok(out.includes('<title>Prologue</title>'))
})

test('无补丁时回写等于原文', () => {
  assert.equal(applyHtmlTextNodes(HTML, []), HTML)
  assert.equal(applyHtmlTextNodes(HTML, [{ ref: { from: 0, to: 0 }, target: '' }]), HTML)
})

test('实体工具', () => {
  assert.equal(decodeEntities('a &amp; b &lt;c&gt; &#65; &#x42;'), 'a & b <c> A B')
  assert.equal(escapeHtmlText('a & b <c>'), 'a &amp; b &lt;c&gt;')
})

test('扩展名分类', () => {
  for (const e of ['epub', 'pdf', 'html', 'xhtml']) assert.ok(isEbookExt(e), e)
  assert.ok(!isEbookExt('txt'))
})
