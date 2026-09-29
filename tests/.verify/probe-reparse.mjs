// 探针 G：导出后再解析一遍已写回的产物 —— 验证 Marshal/编码回写没有破坏结构
// （用同一插件的 parse 作为「Marshal 流是否仍可读」的判据；读不动的流会进 errors）
import { spawnSync } from 'node:child_process'
import { pathToFileURL } from 'node:url'
import { join, dirname, resolve as pathResolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const MODS = 'D:/Agent-windows/DeepSeekHarness/data/.dsh/profiles/node_modules'
const imp = (s) => import(pathToFileURL(join(MODS, s)).href)
const HERE = dirname(fileURLToPath(import.meta.url))
const PROJECT = pathResolve(HERE, 'work-subst', 'project')
const PLUGIN_PATH = 'D:/Agent-windows/DeepSeekHarness/data/.dsh/.agent-presets/hanhua/plugins/hanhua/index.js'

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
await ctx.plugin(SandboxPolicyService, { mode: 'workspace-write', workspaceRoot: pathResolve(HERE) })
await ctx.plugin(SystemPrompt, {})
await ctx.plugin(WebRuntime, {})
await ctx.plugin(ToolRuntime, {})
await ctx.plugin(await import(pathToFileURL(PLUGIN_PATH).href))

const exec = { signal: AbortSignal.timeout(120000), agent: { session: { id: 'reparse', header: { cwd: PROJECT } } } }
const call = async (n, a = {}) => JSON.parse(await ctx.tools.get(n).execute(a, exec))

const scan = await call('hanhua_scan', { root: PROJECT })
const parse = await call('hanhua_parse', {})
console.log('scan.total =', scan.total)
console.log('parse.total =', parse.total, ' errors =', JSON.stringify(parse.errors))
console.log('perFile =', JSON.stringify(parse.perFile))

const EXPECT = { 'game_krkr/scenario/first.ks': 4, 'game_krkr/scenario/legacy.ks': 3, 'game_xp/Data/Map001.rxdata': 8, 'game_xp/Data/Map002.rxdata': 8, 'game_xp/Data/System.rxdata': 8 }
const results = []
const check = (n, ok, d = '') => { results.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${d ? '  — ' + d : ''}`) }
check('回写后再解析 0 错误（Marshal/编码流仍可读）', (parse.errors || []).length === 0, JSON.stringify(parse.errors))
for (const [f, n] of Object.entries(EXPECT)) {
  check(`${f} 条目数仍为 ${n}`, parse.perFile[f] === n, `实测=${parse.perFile[f]}`)
}
const bad = results.filter((r) => !r).length
console.log(`\n===== 探针 G：${results.length - bad}/${results.length} 通过 =====`)
process.exit(bad === 0 ? 0 : 1)
