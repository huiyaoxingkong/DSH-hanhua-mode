/**
 * 生成物一致性 + 动态包信封测试。
 *
 *  1) tools/build-engine.mjs --check：engine/host.js 与 preset/plugins/hanhua/index.js
 *     必须等于 engine/src/ 的派生结果（防止再出现「两半漂移」）。
 *  2) 动态包（engine/host.js）在 vm 沙箱里以 async 函数体求值时：
 *     · 返回 { apply }，apply(ctx) 不抛；
 *     · 用沙箱全局 harness 注册 10 个工具契约（defineTool）与全部 workbench.* RPC（handle）；
 *     · 不在全局 tools 注册表里注册工具（刻意行为，避免污染同进程其它会话）。
 *
 * 用法：node tests/build-check.mjs
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { dirname, join, resolve as pathResolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO = pathResolve(HERE, '..')
const NODE = process.execPath

test('生成物与 engine/src/ 一致（build-engine --check）', () => {
  const out = execFileSync(NODE, [join(REPO, 'tools', 'build-engine.mjs'), '--check'], { encoding: 'utf8' })
  assert.ok(/OK\s+两个信封产物都与 engine\/src\/ 一致/.test(out), out)
})

// 找出「真正的服务访问」：忽略行注释、块注释与字符串字面量里的同名文本
const serviceCallOffenders = (text, label) => {
  const offenders = []
  const lines = text.split('\n')
  let inBlock = false
  lines.forEach((line, i) => {
    const trimmed = line.trim()
    if (inBlock) { if (trimmed.includes('*/')) inBlock = false; return }
    if (trimmed.startsWith('/*')) { if (!trimmed.includes('*/')) inBlock = true; return }
    if (trimmed.startsWith('//') || trimmed.startsWith('*')) return
    const re = /ctx\.(fs|web|subprocess|sandboxPolicy)\b/g
    let m
    while ((m = re.exec(line)) !== null) {
      const before = line.slice(0, m.index)
      const quotes = (before.match(/(^|[^\\])['"`]/g) || []).length
      if (quotes % 2 === 1) continue   // 落在字符串字面量里
      offenders.push(label + ':' + (i + 1) + ' ' + trimmed.slice(0, 90))
      break
    }
  })
  return offenders
}

test('生成物不含漏改的服务调用（ctx.fs / ctx.web 等）', () => {
  const files = ['core.js', 'media.js', 'ocr.js']
  const offenders = []
  for (const name of files) offenders.push(...serviceCallOffenders(readFileSync(join(REPO, 'engine', 'src', name), 'utf8'), name))
  assert.equal(offenders.length, 0, offenders.join('\n'))
})

test('动态包：vm 求值得到 apply，注册工具契约与 workbench RPC', async () => {
  const src = readFileSync(join(REPO, 'engine', 'host.js'), 'utf8')
  const defineToolCalls = []
  const handles = new Map()
  const harness = {
    defineTool(options) { defineToolCalls.push(options); return { __tool: options.name } },
    registerTool() { throw new Error('动态包不应注册到全局工具表') },
    handle(name, fn) { handles.set(name, fn); return () => {} },
  }
  const fakeFs = {
    resolve: async (p) => ({ displayPath: String(p), targetKey: String(p) }),
    processPath: (t) => t.displayPath,
    readText: async () => '',
    writeText: async () => ({ ok: true }),
    readBytes: async () => new Uint8Array(0),
    stat: async () => undefined,
    listDir: async () => [],
  }
  const ctx = {
    get: (name) => (name === 'fs' ? fakeFs : undefined),
    fs: fakeFs,
  }
  // 沙箱形态：代码是 async 函数体，harness 是 vm 里的全局
  const factory = new Function('harness', '"use strict";return (async () => {\n' + src + '\n})()')
  const pkg = await factory(harness)
  assert.equal(typeof pkg.apply, 'function')
  pkg.apply(ctx)

  const names = defineToolCalls.map((t) => t.name)
  const expected = ['hanhua_scan', 'hanhua_parse', 'hanhua_ocr', 'hanhua_translate', 'hanhua_qa', 'hanhua_glossary', 'hanhua_export', 'hanhua_media', 'hanhua_usage', 'hanhua_config']
  assert.deepEqual(names.slice().sort(), expected.slice().sort(), '动态包的工具契约应与 TOOL_SPECS 一致')

  for (const t of defineToolCalls) {
    assert.equal(typeof t.execute, 'function', t.name + ' 缺少 execute')
    assert.equal(t.parameters.type, 'object')
    assert.ok(t.output && typeof t.output.render === 'function', t.name + ' 缺少 output.render')
  }

  const rpc = ['workbench.state', 'workbench.config.get', 'workbench.config.set', 'workbench.glossary.list', 'workbench.glossary.add', 'workbench.glossary.remove', 'workbench.scan', 'workbench.parse', 'workbench.ocr', 'workbench.translate', 'workbench.export', 'workbench.usage', 'workbench.pipeline']
  for (const name of rpc) assert.ok(handles.has(name), '缺少 RPC: ' + name)

  const state = await handles.get('workbench.state')()
  assert.equal(typeof state.entries, 'number')
  assert.ok(state.summary && typeof state.summary.scanned === 'number')
  const usage = await handles.get('workbench.usage')()
  assert.ok(usage && usage.usage && typeof usage.usage.totalTokens === 'number')
})

test('静态插件与动态包共用同一份引擎正文（避免漂移）', () => {
  const staticSrc = readFileSync(join(REPO, 'preset', 'plugins', 'hanhua', 'index.js'), 'utf8')
  const dynamicSrc = readFileSync(join(REPO, 'engine', 'host.js'), 'utf8')
  const ocr = readFileSync(join(REPO, 'engine', 'src', 'ocr.js'), 'utf8')
  const marker = 'async function ocrAction(args, exec) {'
  assert.ok(ocr.includes(marker), 'ocr.js 里应有 ocrAction')
  // 同一份正文必须同时出现在两个信封里（缩进不同：静态 2 空格 / 动态 4 空格）
  assert.ok(staticSrc.includes('  ' + marker), '静态产物应包含同一份 ocrAction')
  assert.ok(dynamicSrc.includes('    ' + marker), '动态产物应包含同一份 ocrAction')
  assert.ok(staticSrc.includes("name: 'hanhua_ocr'"), '静态产物应注册 hanhua_ocr')
  assert.ok(!staticSrc.includes('ctx.tools.register({\n    name,\n'), '静态产物不应再内联旧的 registerTool 形态')
})
