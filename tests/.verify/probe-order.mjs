// 探针 D：systemPrompt section order 的实测位置
// 0.1.6-alpha.2 用统一编号表（TOOL_* 1000–3100 / MCP_SERVERS 3100 / TOOLS_SDK 5000），
// 插件现在注册 order:3200。这里实测注册后的排序位置，并模拟旧值 115 的位置作为对照。
import { spawnSync } from 'node:child_process'
import { pathToFileURL } from 'node:url'
import { dirname, join, resolve as pathResolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const PROFILE_MODULES = 'D:/Agent-windows/DeepSeekHarness/data/.dsh/profiles/node_modules'
const imp = (s) => import(pathToFileURL(join(PROFILE_MODULES, s)).href)
const HERE = dirname(fileURLToPath(import.meta.url))
const argOf = (n, d) => { const i = process.argv.indexOf(n); return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : d }
const PLUGIN_PATH = argOf('--plugin', 'D:/Agent-windows/DeepSeekHarness/data/.dsh/.agent-presets/hanhua/plugins/hanhua/index.js')

const { Context } = await imp('@deepseek-ai/cordis/lib/index.js')
const { LocalFileSystem } = await imp('@deepseek-ai/dsh-fs-local/lib/index.js')
const { SandboxPolicyService } = await imp('@deepseek-ai/dsh-sandbox-policy/lib/index.js')
const { SystemPrompt, renderPrompt } = await imp('@deepseek-ai/dsh-system-prompt/lib/index.js')
const { ToolRuntime } = await imp('@deepseek-ai/dsh-tools/lib/index.js')
const { WebRuntime } = await imp('@deepseek-ai/dsh-web/lib/index.js')

const shim = {
  async resolveExecutable() { return process.execPath },
  spawn(spec) {
    const [file, ...args] = spec.argv
    const r = spawnSync(file, args, { cwd: spec.cwd, stdio: 'inherit', windowsHide: true })
    return { done: Promise.resolve({ exitCode: r.status ?? 1, signal: null }) }
  },
}
const ctx = new Context()
await ctx.plugin({ name: 'verify', apply(c) { c.provide('sessionProjections', { register: () => () => {}, stateOf: () => null }); c.provide('subprocess', shim) } })
await ctx.plugin(LocalFileSystem, { cwd: pathResolve(HERE) })
await ctx.plugin(SandboxPolicyService, { mode: 'workspace-write', workspaceRoot: pathResolve(HERE, '..', '..') })
await ctx.plugin(SystemPrompt, {})
await ctx.plugin(WebRuntime, {})
await ctx.plugin(ToolRuntime, {})

console.log('内核自带档位：MCP_SERVERS =', ctx.systemPrompt.getSectionOrder('MCP_SERVERS'))
console.log('内核自带档位：TOOLS_SDK   =', ctx.systemPrompt.getSectionOrder('TOOLS_SDK'))
console.log('内核自带档位：TOOL_PWSH   =', ctx.systemPrompt.getSectionOrder('TOOL_PWSH'))
console.log('内核自带档位：DEPLOYMENT_PERSONA_PREFIX =', ctx.systemPrompt.getSectionOrder('DEPLOYMENT_PERSONA_PREFIX'))

// 对照：如果把 order 写成旧值 115 会落在哪
ctx.systemPrompt.section({ name: 'probe:old-order-115', order: 115, text: 'OLD-115' })
ctx.systemPrompt.section({ name: 'probe:first-party-guide', order: 1000, text: 'FIRST-PARTY-1000' })

const mod = await import(pathToFileURL(PLUGIN_PATH).href)
await ctx.plugin(mod)

const a = await ctx.systemPrompt.assemble({})
const rows = a.sections.map((s, i) => ({ i, name: s.name, order: s.order }))
console.log('\n===== assemble() 后的 section 排序 =====')
for (const r of rows) console.log(`  ${String(r.i).padStart(3)}  order=${String(r.order).padStart(6)}  ${r.name}`)

const hanhua = rows.find((r) => r.name === 'tool:hanhua')
const firstGuide = rows.find((r) => r.name === 'probe:first-party-guide')
const old115 = rows.find((r) => r.name === 'probe:old-order-115')
const checks = [
  ['插件 section 名 = tool:hanhua', hanhua !== undefined],
  // 注意：assemble() 投影里不带 order 字段，只能用相对位置断言
  ['3200 在所有第一方工具指南(≤3100)之后', hanhua && firstGuide && hanhua.i > firstGuide.i],
  ['3200 在 TOOLS_SDK(5000) 之前', hanhua && rows.filter((r) => r.order === 5000).every((r) => hanhua.i < r.i)],
  ['3200 在 persona 后缀(10200) 之前', hanhua && rows.filter((r) => r.name === 'deployment:persona-suffix').every((r) => hanhua.i < r.i)],
  ['旧值 115 会排在第一方工具指南(1000)之前（说明旧值确实错位）', old115 && firstGuide && old115.i < firstGuide.i],
  ['渲染出的提示词含汉化指南', renderPrompt(a).includes('hanhua_scan')],
]
console.log('')
let bad = 0
for (const [n, ok] of checks) { if (!ok) bad++; console.log(`[${ok ? 'PASS' : 'FAIL'}] ${n}`) }
console.log(`\n===== 探针 D：${checks.length - bad}/${checks.length} 通过 =====`)
process.exit(bad === 0 ? 0 : 1)
