// 探针 I：.bak「写一次即固定」新语义的判别性测试
// 场景（正是新注释描述的多轮/分批翻译）：
//   第 1 轮只翻译**一部分**条目并导出 → 文件被改写，生成 .bak（= 最初原文）
//   第 2 轮翻译**其余**条目并再次导出 → 文件再次被改写
//   ⇒ 关键断言：.bak 仍必须是**最初原文**（若沿用「每次导出都覆盖 .bak」，此时 .bak 会变成第 1 轮的半成品）
// 另附：已存在陈旧 .bak 时的行为（设计取舍取证）
import { spawnSync } from 'node:child_process'
import { mkdirSync, rmSync, cpSync, readFileSync, writeFileSync } from 'node:fs'
import { join, dirname, resolve as pathResolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const MODS = 'D:/Agent-windows/DeepSeekHarness/data/.dsh/profiles/node_modules'
const imp = (s) => import(pathToFileURL(join(MODS, s)).href)
const HERE = dirname(fileURLToPath(import.meta.url))
const WORK = pathResolve(HERE, 'work-bak')
const PROJECT = join(WORK, 'project')
const FIXTURES = 'D:/Games/汉化模式/test-fixtures'
const PLUGIN = argOfPlugin()

function argOfPlugin() {
  const i = process.argv.indexOf('--plugin')
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : 'D:/Agent-windows/DeepSeekHarness/data/.dsh/.agent-presets/hanhua/plugins/hanhua/index.js'
}

rmSync(WORK, { recursive: true, force: true })
mkdirSync(PROJECT, { recursive: true })
cpSync(FIXTURES, PROJECT, { recursive: true })

const { Context } = await imp('@deepseek-ai/cordis/lib/index.js')
const { LocalFileSystem } = await imp('@deepseek-ai/dsh-fs-local/lib/index.js')
const { SandboxPolicyService } = await imp('@deepseek-ai/dsh-sandbox-policy/lib/index.js')
const { SystemPrompt } = await imp('@deepseek-ai/dsh-system-prompt/lib/index.js')
const { ToolRuntime } = await imp('@deepseek-ai/dsh-tools/lib/index.js')
const { WebRuntime } = await imp('@deepseek-ai/dsh-web/lib/index.js')

const shim = { async resolveExecutable() { return process.execPath }, spawn(spec) { const [f, ...a] = spec.argv; const r = spawnSync(f, a, { cwd: spec.cwd, stdio: 'inherit', windowsHide: true }); return { done: Promise.resolve({ exitCode: r.status ?? 1, signal: null }) } } }
const ctx = new Context()
await ctx.plugin({ name: 'v', apply(c) { c.provide('sessionProjections', { register: () => () => {}, stateOf: () => null }); c.provide('subprocess', shim) } })
await ctx.plugin(LocalFileSystem, { cwd: PROJECT })
await ctx.plugin(SandboxPolicyService, { mode: 'workspace-write', workspaceRoot: HERE })
await ctx.plugin(SystemPrompt, {})
await ctx.plugin(WebRuntime, {})
await ctx.plugin(ToolRuntime, {})
await ctx.plugin(await import(pathToFileURL(PLUGIN).href))

const exec = { signal: AbortSignal.timeout(120000), agent: { session: { id: 'bak', header: { cwd: PROJECT } } } }
const call = async (n, a = {}) => JSON.parse(await ctx.tools.get(n).execute(a, exec))
const results = []
const check = (n, ok, d = '') => { results.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${d ? '  — ' + d : ''}`) }

const KS = join(PROJECT, 'game_krkr/scenario/first.ks')
const BAK = KS + '.bak'
const ORIGINAL = readFileSync(KS)

await call('hanhua_scan', { root: PROJECT })
const parse = await call('hanhua_parse', {})
console.log('parse.total =', parse.total)
console.log('ks 预览 =', JSON.stringify((parse.preview || []).filter((p) => String(p.file).includes('first.ks')).slice(0, 4)))

// 让「第一批」条目也能被词典命中，保证第 1 轮确实改写文件
for (const [s, t] of [['Prologue', '序章'], ['Good morning!', '早上好！'], ['Nice to meet you.', '很高兴见到你。'], ['Bye bye.', '再见。']]) {
  try { await call('hanhua_glossary', { action: 'add', source: s, target: t }) } catch {}
}

// ── 第 1 轮：只翻 1 条 ──
console.log('--- 第 1 轮：translate({limit:1}) → export ---')
const tr1 = await call('hanhua_translate', { limit: 1 })
console.log('    第 1 轮已翻条目 =', JSON.stringify((tr1.preview || []).map((p) => [p.id, p.source, p.target])))
const e1 = await call('hanhua_export', { mode: 'inplace' })
const F1 = readFileSync(KS), B1 = readFileSync(BAK)
check('第 1 轮导出成功', e1.ok === e1.total, `ok=${e1.ok}/${e1.total}`)
check('第 1 轮正文已被改写（半成品状态）', Buffer.compare(F1, ORIGINAL) !== 0, `正文 ${ORIGINAL.length} → ${F1.length} 字节`)
check('第 1 轮 .bak == 最初原文', Buffer.compare(B1, ORIGINAL) === 0, `bak=${B1.length}B original=${ORIGINAL.length}B`)

// ── 第 2 轮：翻其余条目，再次导出 ──
console.log('--- 第 2 轮：translate({limit:100}) → export ---')
const tr2 = await call('hanhua_translate', { limit: 100 })
console.log('    第 2 轮已翻条目 =', JSON.stringify((tr2.preview || []).map((p) => [p.id, p.source, p.target])))
const e2 = await call('hanhua_export', { mode: 'inplace' })
const F2 = readFileSync(KS), B2 = readFileSync(BAK)
check('第 2 轮导出成功', e2.ok === e2.total, `ok=${e2.ok}/${e2.total}`)
check('第 2 轮正文再次变化', Buffer.compare(F2, F1) !== 0, `第1轮 ${F1.length}B → 第2轮 ${F2.length}B`)
check('★ 第 2 轮 .bak 仍是最初原文（未被第 1 轮半成品覆盖）', Buffer.compare(B2, ORIGINAL) === 0, `bak==最初原文=${Buffer.compare(B2, ORIGINAL) === 0}`)
check('★ 若沿用旧逻辑，.bak 会等于第 1 轮半成品（此处必须不同）', Buffer.compare(B2, F1) !== 0, `bak==第1轮内容=${Buffer.compare(B2, F1) === 0}`)

// ── 陈旧 .bak 取舍 ──
console.log('--- 陈旧 .bak 场景 ---')
const STALE = Buffer.from('STALE-NOT-THE-ORIGINAL', 'utf8')
writeFileSync(BAK, STALE)
await call('hanhua_export', { mode: 'inplace' })
const B3 = readFileSync(BAK)
check('已存在的陈旧 .bak 不会被刷新（"写一次即固定"的取舍）', Buffer.compare(B3, STALE) === 0, `bak 仍为预置内容=${Buffer.compare(B3, STALE) === 0}`)
console.log('[INFO] 取舍：若 .bak 早于本次汉化轮次（上次汉化遗留），回滚会还原到那份旧内容，而不是本轮导出前的原文。')

const bad = results.filter((r) => !r).length
console.log(`\n===== 探针 I：${results.length - bad}/${results.length} 通过 =====`)
process.exit(bad === 0 ? 0 : 1)
