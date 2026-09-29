// 探针 F：插件注册契约（7 个 hanhua_* 工具 / 6 个 inject 服务 / output.schema = {type:'string'}）
import { spawnSync } from 'node:child_process'
import { pathToFileURL } from 'node:url'
import { join, resolve as pathResolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const MODS = 'D:/Agent-windows/DeepSeekHarness/data/.dsh/profiles/node_modules'
const imp = (s) => import(pathToFileURL(join(MODS, s)).href)
const HERE = dirname(fileURLToPath(import.meta.url))
const argOf = (n, d) => { const i = process.argv.indexOf(n); return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : d }
const PLUGIN_PATH = argOf('--plugin', 'D:/Agent-windows/DeepSeekHarness/data/.dsh/.agent-presets/hanhua/plugins/hanhua/index.js')

const { Context } = await imp('@deepseek-ai/cordis/lib/index.js')
const { LocalFileSystem } = await imp('@deepseek-ai/dsh-fs-local/lib/index.js')
const { SandboxPolicyService } = await imp('@deepseek-ai/dsh-sandbox-policy/lib/index.js')
const { SystemPrompt } = await imp('@deepseek-ai/dsh-system-prompt/lib/index.js')
const { ToolRuntime } = await imp('@deepseek-ai/dsh-tools/lib/index.js')
const { WebRuntime } = await imp('@deepseek-ai/dsh-web/lib/index.js')

const shim = {
  async resolveExecutable() { return process.execPath },
  spawn(spec) { const [f, ...a] = spec.argv; const r = spawnSync(f, a, { cwd: spec.cwd, stdio: 'inherit', windowsHide: true }); return { done: Promise.resolve({ exitCode: r.status ?? 1, signal: null }) } },
}
const ctx = new Context()
await ctx.plugin({ name: 'verify', apply(c) { c.provide('sessionProjections', { register: () => () => {}, stateOf: () => null }); c.provide('subprocess', shim) } })
await ctx.plugin(LocalFileSystem, { cwd: pathResolve(HERE) })
await ctx.plugin(SandboxPolicyService, { mode: 'workspace-write', workspaceRoot: pathResolve(HERE, '..', '..') })
await ctx.plugin(SystemPrompt, {})
await ctx.plugin(WebRuntime, {})
await ctx.plugin(ToolRuntime, {})

const mod = await import(pathToFileURL(PLUGIN_PATH).href)
await ctx.plugin(mod)

const results = []
const check = (n, ok, d = '') => { results.push({ n, ok: !!ok }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${d ? '  — ' + d : ''}`) }

// v12 起新增第 8 个工具 hanhua_workbench（自装「汉化工作台」动态包）——
// 期望清单同步扩充，断言强度不变（逐个核 name/inject/schema）。
const EXPECT_TOOLS = ['hanhua_scan', 'hanhua_parse', 'hanhua_translate', 'hanhua_qa', 'hanhua_glossary', 'hanhua_export', 'hanhua_config', 'hanhua_workbench']
const EXPECT_INJECT = ['tools', 'systemPrompt', 'fs', 'web', 'sandboxPolicy', 'subprocess']

check('name = hanhua-engine', mod.name === 'hanhua-engine', String(mod.name))
check('inject 恰好 6 个服务名', Array.isArray(mod.inject) && mod.inject.length === 6, `[${(mod.inject || []).join(',')}]`)
check('inject 名单与期望完全一致', JSON.stringify([...(mod.inject || [])].sort()) === JSON.stringify([...EXPECT_INJECT].sort()), `实际=[${(mod.inject || []).join(',')}]`)
check('apply 是函数', typeof mod.apply === 'function', typeof mod.apply)

for (const t of EXPECT_TOOLS) {
  const def = ctx.tools.get(t)
  const schema = def && def.output && def.output.schema
  check(`${t} 已注册且 output.schema.type='string'`, !!def && schema && schema.type === 'string', `output.schema=${JSON.stringify(schema)}`)
}
const hanhuaSchemas = ctx.tools.schemas().filter((s) => String(s.name).startsWith('hanhua_'))
check('模型可见的 hanhua_* schema = 8', hanhuaSchemas.length === 8, `实际=${hanhuaSchemas.length} 名称=[${hanhuaSchemas.map((s) => s.name).join(',')}]`)
const badParams = hanhuaSchemas.filter((s) => !s.parameters || s.parameters.type !== 'object' || s.parameters.additionalProperties !== false)
check('8 个工具 parameters 都是 object + additionalProperties:false', badParams.length === 0, badParams.map((s) => s.name).join(',') || '全部合规')

const failed = results.filter((r) => !r.ok)
console.log(`\n===== 探针 F：${results.length - failed.length}/${results.length} 通过 =====`)
process.exit(failed.length === 0 ? 0 : 1)
