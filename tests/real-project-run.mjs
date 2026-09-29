/**
 * 真实项目实机验证：用**已安装的**「汉化模式」插件，在 DSH 0.1.6-alpha.2 的真实服务实现上
 * 对 Birth Story 测试副本执行 scan → parse → translate（缓存/词典）→ qa → export inplace。
 *
 * 安全保证：
 *  - 只用用户明确同意用于测试的副本目录；
 *  - export 走插件自身的 inplace 逻辑，逐文件生成 `<file>.bak`；
 *  - 本脚本另外统计每个文件导出前后的字节数与中文增量，并在结束打印可回滚命令
 *    （tests/real-project-rollback.mjs 可一键从 .bak 还原）。
 *
 * 用法：<runtime>\node.exe tests\real-project-run.mjs [--root <游戏根目录>] [--limit N] [--dry]
 */
import { createHash } from 'node:crypto'
import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO = join(HERE, '..')
const PROFILE_MODULES = 'D:/Agent-windows/DeepSeekHarness/data/.dsh/profiles/node_modules'
const imp = (s) => import(pathToFileURL(join(PROFILE_MODULES, s)).href)

const argv = process.argv.slice(2)
const argOf = (n, d) => { const i = argv.indexOf(n); return i >= 0 && argv[i + 1] ? argv[i + 1] : d }
const ROOT = argOf('--root', 'D:/Games/Birth Story 1.1.3 (Windows)/汉化测试/birthstory-v1.1.3-win/game')
const PRISTINE = argOf('--pristine', 'D:/Games/Birth Story 1.1.3 (Windows)/汉化测试/pristine-snapshot/game')
const LIMIT = Number(argOf('--limit', '5000')) || 5000
const DRY = argv.includes('--dry')
const INSTALLED_PLUGIN = 'D:/Agent-windows/DeepSeekHarness/data/.dsh/.agent-presets/hanhua/plugins/hanhua/index.js'

const { Context } = await imp('@deepseek-ai/cordis/lib/index.js')
const { LocalFileSystem } = await imp('@deepseek-ai/dsh-fs-local/lib/index.js')
const { SandboxPolicyService } = await imp('@deepseek-ai/dsh-sandbox-policy/lib/index.js')
const { LocalSubprocessRuntime } = await imp('@deepseek-ai/dsh-subprocess-local/lib/index.js')
const { SystemPrompt } = await imp('@deepseek-ai/dsh-system-prompt/lib/index.js')
const { ToolRuntime } = await imp('@deepseek-ai/dsh-tools/lib/index.js')
const { WebRuntime } = await imp('@deepseek-ai/dsh-web/lib/index.js')

const ctx = new Context()
await ctx.plugin({ name: 'test-session-projections', apply(c) { c.provide('sessionProjections', { register: () => () => {}, stateOf: () => null }) } })
await ctx.plugin(LocalFileSystem, { cwd: ROOT })
await ctx.plugin(SandboxPolicyService, { mode: 'workspace-write', workspaceRoot: ROOT })
await ctx.plugin(LocalSubprocessRuntime)
await ctx.plugin(SystemPrompt, {})
await ctx.plugin(WebRuntime, {})
await ctx.plugin(ToolRuntime, {})

const mod = await import(pathToFileURL(INSTALLED_PLUGIN).href)
await ctx.plugin(mod)

const exec = { signal: AbortSignal.timeout(1800000), agent: { session: { id: 'real-run', header: { cwd: ROOT } } } }
const call = async (name, args = {}) => {
  const def = ctx.tools.get(name)
  if (def === undefined) throw new Error(`工具未注册: ${name}（插件未挂载？）`)
  const raw = await def.execute(args, exec)
  try { return JSON.parse(raw) } catch { return raw }
}

const sha = (b) => createHash('sha256').update(b).digest('hex').slice(0, 12)
const cjk = (s) => (s.match(/[\u4e00-\u9fff]/g) || []).length

console.log(`root = ${ROOT}`)
console.log(`plugin = ${INSTALLED_PLUGIN}`)
console.log(`dry = ${DRY}\n`)

// 0) 导出前快照（.rpy 清单 + 哈希 + 中文字数）
const before = new Map()
const collect = async (dir) => {
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const p = join(dir, e.name)
    if (e.isDirectory()) { if (!e.name.startsWith('.') && e.name !== 'tl') await collect(p); continue }
    if (!e.name.endsWith('.rpy')) continue
    const buf = await readFile(p)
    const text = buf.toString('utf8')
    before.set(p, { hash: sha(buf), size: buf.length, cjk: cjk(text), text, buf })
  }
}
await collect(ROOT)
console.log(`导出前：${before.size} 个 .rpy，含中文的文件 ${[...before.values()].filter((v) => v.cjk > 0).length} 个`)

// 1b) 备份网：确保每个将要改写的文件都有 .bak，且 .bak 等于 pristine 原始版本。
//     这样即使多轮导出，回滚点始终是「汉化前的原文」。
let bakSeeded = 0
if (existsSync(PRISTINE)) {
  for (const p of before.keys()) {
    const rel = p.slice(ROOT.length + 1)
    const pristinePath = join(PRISTINE, rel)
    if (!existsSync(pristinePath)) continue
    const pristine = await readFile(pristinePath)
    const bak = p + '.bak'
    if (existsSync(bak) && sha(await readFile(bak)) === sha(pristine)) continue
    await writeFile(bak, pristine)
    bakSeeded++
  }
  console.log(`备份网：用 pristine 快照补齐/校正 ${bakSeeded} 个 .bak`)
} else {
  console.log(`备份网：未找到 pristine 快照（${PRISTINE}），沿用插件自身的 .bak 行为`)
}

// 1c) scan / parse / glossary / translate（分批推进到全部条目）
const cfg = await call('hanhua_config', { action: 'get' })
console.log(`config: ${JSON.stringify(cfg.config)}`)

const scan = await call('hanhua_scan', { root: ROOT })
console.log(`scan  : total=${scan.total}`)

const parse = await call('hanhua_parse', {})
console.log(`parse : total=${parse.total} files=${parse.files} truncated=${parse.truncated} errors=${(parse.errors || []).length}`)
if ((parse.errors || []).length) console.log('        errors:', JSON.stringify(parse.errors.slice(0, 5)))

let last = null
for (let round = 1; round <= 10; round++) {
  last = await call('hanhua_translate', { limit: LIMIT })
  const p = last.progress || {}
  console.log(`translate[${round}]: ${JSON.stringify(last.summary.methods)} processed=${p.processed} remaining=${p.remaining} 累计=${p.translatedTotal}/${p.entryTotal}`)
  if (!p.remaining) break
  if (!p.processed) break
}
if (last && last.summary && last.summary.lastError) console.log(`        lastError: ${last.summary.lastError}`)

const qa = await call('hanhua_qa', {})
console.log(`qa    : total=${qa.total} issues=${(qa.issues || []).length}`)

if (DRY) {
  console.log('\n--dry：不执行导出。')
  process.exit(0)
}

// 2) export inplace
const exp = await call('hanhua_export', { mode: 'inplace' })
console.log(`export: total=${exp.total} ok=${exp.ok}`)
const failed = (exp.results || []).filter((r) => !r.ok)
if (failed.length) console.log('        失败文件:', JSON.stringify(failed.slice(0, 10)))

// 3) 导出后核对
let changed = 0
let bakOk = 0
let bakBad = []
let placeholderIssues = []
let cjkGain = 0
const PLACEHOLDER = /\{[a-zA-Z]+(=[^}]*)?\}|\{[a-zA-Z]+\}/g
for (const [p, b] of before) {
  if (!existsSync(p)) continue
  const after = await readFile(p)
  const bak = p + '.bak'
  const hasBak = existsSync(bak)
  const rel = p.slice(ROOT.length + 1)
  const pristinePath = join(PRISTINE, rel)
  const expected = existsSync(pristinePath) ? await readFile(pristinePath) : b.buf
  if (hasBak) {
    const bakBuf = await readFile(bak)
    if (sha(bakBuf) === sha(expected)) bakOk++
    else bakBad.push(rel)
  }
  if (sha(after) !== b.hash) {
    changed++
    const afterText = after.toString('utf8')
    cjkGain += cjk(afterText) - b.cjk
    const a = (b.text.match(PLACEHOLDER) || []).sort().join('|')
    const c = (afterText.match(PLACEHOLDER) || []).sort().join('|')
    if (a !== c) placeholderIssues.push(rel + ' (占位符集合变化)')
  }
}
console.log(`\n导出后：变更 ${changed} 个文件；.bak 校验（== pristine 原始）通过 ${bakOk} 个${bakBad.length ? '，异常 ' + bakBad.length + ' 个: ' + bakBad.slice(0, 5).join(', ') : ''}`)
console.log(`中文合计增加约 ${cjkGain} 字；占位符异常：${placeholderIssues.length === 0 ? '无' : placeholderIssues.slice(0, 10).join(', ')}`)
console.log(`\n回滚命令：node tests/real-project-rollback.mjs --root "${ROOT}"`)
process.exit(placeholderIssues.length === 0 && bakBad.length === 0 ? 0 : 1)
