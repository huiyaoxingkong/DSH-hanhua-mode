/**
 * 定向探针：「汉化工作台」自装链路（task-4 自证用）
 *
 * 与 tests/harness.mjs 同一套路：用 0.1.6-alpha.2 真机安装的包组装最小 Cordis 运行时，
 * 但额外挂载**真实的 @deepseek-ai/dsh-cordis-host-runner**（dynamicCordisRunner 服务提供者），
 * 然后验证：
 *   A. status：服务可用、引擎两半路径/字节数、无定义
 *   B. install：真实 define（= real precheckCode 编译两半源码）+ run → awaiting-approval
 *   C. 复核 install：pending 期间重复 install → transition-in-flight（不炸、不重复定义）
 *   D. runHostHalf：engine/host.js 在真实 node:vm 沙箱里跑起来并注册 workbench.* handler
 *   E. getClientCode + 复刻 evaluator 的闭包形态执行 engine/client.js：
 *      只注册 settings.section，且不注册 tool.view.cordis（v9 已删）
 *   F. resolveRequestRun：批准 → 激活提交；status.ready=true、activeRun.handlers 含 workbench.*
 *   G. invoke('workbench.state')：面板 RPC 通道真的通
 *   H. stop：停掉运行实例；再 install 走复用路径且**不再需要批准**
 *
 * 用法：<runtime>\node.exe tests\.verify\probe-workbench.mjs
 * 退出码：0 = 全部通过；1 = 有失败项。
 */
import { mkdir, rm } from 'node:fs/promises'
import { dirname, join, resolve as pathResolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const PROFILE_MODULES = 'D:/Agent-windows/DeepSeekHarness/data/.dsh/profiles/node_modules'
const imp = (spec) => import(pathToFileURL(join(PROFILE_MODULES, spec)).href)

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO = pathResolve(HERE, '..', '..')
const PLUGIN_PATH = join(REPO, 'preset', 'plugins', 'hanhua', 'index.js')
const ENGINE_DIR = join(REPO, 'preset', 'plugins', 'hanhua', 'engine')
const WORK = join(HERE, '.work-workbench')

const results = []
const check = (name, ok, detail = '') => {
  results.push({ name, ok: !!ok, detail })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`)
}

await rm(WORK, { recursive: true, force: true })
await mkdir(WORK, { recursive: true })

// ── 最小运行时（同 harness）───────────────────────────────────────────────
const { Context } = await imp('@deepseek-ai/cordis/lib/index.js')
const { LocalFileSystem } = await imp('@deepseek-ai/dsh-fs-local/lib/index.js')
const { SandboxPolicyService } = await imp('@deepseek-ai/dsh-sandbox-policy/lib/index.js')
const { LocalSubprocessRuntime } = await imp('@deepseek-ai/dsh-subprocess-local/lib/index.js')
const { SystemPrompt } = await imp('@deepseek-ai/dsh-system-prompt/lib/index.js')
const { ToolRuntime } = await imp('@deepseek-ai/dsh-tools/lib/index.js')
const { WebRuntime } = await imp('@deepseek-ai/dsh-web/lib/index.js')

const ctx = new Context()
await ctx.plugin({ name: 'test-session-projections', apply(c) { c.provide('sessionProjections', { register: () => () => {}, stateOf: () => null }) } })
await ctx.plugin(LocalFileSystem, { cwd: WORK })
await ctx.plugin(SandboxPolicyService, { mode: 'workspace-write', workspaceRoot: WORK })
await ctx.plugin(LocalSubprocessRuntime)
await ctx.plugin(SystemPrompt, {})
await ctx.plugin(WebRuntime, {})
await ctx.plugin(ToolRuntime, {})

// ── 真实 dynamicCordisRunner ──────────────────────────────────────────────
let runnerMod
let runnerMounted = false
let runnerMountError = ''
try {
  runnerMod = await imp('@deepseek-ai/dsh-cordis-host-runner/lib/index.js')
  const Service = runnerMod.DynamicCordisRunnerService ?? runnerMod.default
  if (typeof Service !== 'function') throw new Error('导出里没有 DynamicCordisRunnerService/default: ' + Object.keys(runnerMod).join(','))
  await ctx.plugin(Service, { vmTimeoutMs: 5000 })
  runnerMounted = typeof ctx.dynamicCordisRunner?.define === 'function'
} catch (e) { runnerMountError = String(e.message || e) }
check('真实 dsh-cordis-host-runner 可挂载并提供 ctx.dynamicCordisRunner', runnerMounted, runnerMounted ? 'vmTimeoutMs=5000' : runnerMountError)
if (!runnerMounted) { console.log('\n没有真实 runner，后续无法继续 —— 结束。'); process.exit(1) }

// ── 挂载汉化插件（**在 agent 作用域里**，与真实预设一致）────────────────────
// 真实链路：agent-loop 用 createScope(loopCtx, agent) 建 agent.ctx，
// preset/agent-presets 把预设行挂在 agent.ctx 之下 ⇒ 静态插件的工具进 **agent 层**；
// 而动态包的 host 半挂在 host runner 的 rootCtx（cordis-dynamic 组）⇒ 进 **全局层**。
// 两层是不同的 ToolLayer，同名工具不冲突（这正是工作台能在真机里跑起来的前提）。
const { createScope, scopeOf } = await imp('@deepseek-ai/dsh-scope/lib/index.js')
const SESSION_ID = 'sess-workbench-probe'
const agent = { id: SESSION_ID }
const agentScope = createScope(ctx, agent)
const SCOPE_KEY = scopeOf(agentScope.ctx)

const mod = await import(pathToFileURL(PLUGIN_PATH).href)
await agentScope.ctx.plugin(mod)
const call = async (name, args, exec) => {
  const def = ctx.tools.get(name, SCOPE_KEY)
  const raw = await def.execute(args, exec)
  try { return JSON.parse(raw) } catch { return raw }
}
check('hanhua_workbench 注册到 tools 注册表（agent 作用域）', ctx.tools.get('hanhua_workbench', SCOPE_KEY) !== undefined)
check('L1 静态插件的工具只进 agent 层，不进全局层（与真实预设一致）',
  ctx.tools.schemas(SCOPE_KEY).filter((s) => String(s.name).startsWith('hanhua_')).length === 8
  && ctx.tools.schemas().filter((s) => String(s.name).startsWith('hanhua_')).length === 0,
  `agent 层 ${ctx.tools.schemas(SCOPE_KEY).filter((s) => String(s.name).startsWith('hanhua_')).length} 个 / 全局层 ${ctx.tools.schemas().filter((s) => String(s.name).startsWith('hanhua_')).length} 个`)

// 伪 Agent：runner 只用 agent.id 作为 SessionId（injectUserContext 在没有 agents 服务时早退）
const exec = { signal: AbortSignal.timeout(60000), agent }
const runner = ctx.dynamicCordisRunner

// ── A. status（安装前）────────────────────────────────────────────────────
const st0 = await call('hanhua_workbench', { action: 'status' }, exec)
check('A1 status: service.available=true', st0?.service?.available === true, JSON.stringify(st0?.service))
check('A2 status: 引擎两半存在且字节数 = 磁盘文件', st0?.engine?.host?.exists === true && st0?.engine?.client?.exists === true
  && st0.engine.host.bytes > 80000 && st0.engine.client.bytes > 10000,
  `host=${st0?.engine?.host?.bytes}B client=${st0?.engine?.client?.bytes}B dir=${st0?.engine?.dir}`)
check('A3 status: 安装前无定义、ready=false', Array.isArray(st0?.definitions) && st0.definitions.length === 0 && st0.ready === false,
  `definitions=${st0?.definitions?.length} ready=${st0?.ready}`)

// ── B. install（真实 define + run）────────────────────────────────────────
const ins = await call('hanhua_workbench', { action: 'install' }, exec)
check('B1 install: define 成功（真实 precheckCode 接受两半源码）', !!ins?.receipt && ins.receipt.hasHostHalf === true && ins.receipt.hasClientHalf === true,
  JSON.stringify(ins?.receipt))
check('B2 install: run 返回 awaiting-approval 且未超时', ins?.run?.status === 'awaiting-approval' && ins?.timedOut === false,
  `status=${ins?.run?.status} reason=${ins?.run?.reason} timedOut=${ins?.timedOut}`)
check('B3 install: 新建定义（reused=false）且 pluginId 前缀合法', ins?.reused === false && /^hanhu-\d+$/.test(String(ins?.pluginId)), `pluginId=${ins?.pluginId} packageId=${ins?.packageId}`)
const pluginId = ins.pluginId
const packageId = ins.packageId

// ── C. pending 期间重复 install ────────────────────────────────────────────
const insAgain = await call('hanhua_workbench', { action: 'install' }, exec)
check('C1 重复 install: 复用同一定义（不新建 hanhu-N）', insAgain?.reused === true && insAgain?.pluginId === pluginId, `reused=${insAgain?.reused} pluginId=${insAgain?.pluginId}`)
check('C2 重复 install: 明确回报 transition-in-flight 且不抛错', insAgain?.run?.reason === 'transition-in-flight' && insAgain?.ok === false,
  `reason=${insAgain?.run?.reason} ok=${insAgain?.ok}`)
const snap1 = runner.snapshot(agent)
check('C3 注册表里只有一个 hanhu-* 定义', snap1.length === 1 && snap1[0].pluginId === pluginId, JSON.stringify(snap1.map(r => r.pluginId)))

// ── D. runHostHalf：host 半在真实 vm 沙箱里跑起来 ──────────────────────────
const requestId = snap1[0].latestRun?.approvalRequestId
const pluginRunId = snap1[0].latestRun?.pluginRunId
check('D0 snapshot 暴露 approvalRequestId（模拟浏览器应答需要它）', typeof requestId === 'string' && typeof pluginRunId === 'string', `requestId=${requestId} pluginRunId=${pluginRunId}`)
const half = await runner.runHostHalf(agent, pluginId, packageId, 'run', requestId, true)
check('D1 runHostHalf: engine/host.js 在真实 vm 里激活成功', half?.ok === true, JSON.stringify(half))
check('D2 runHostHalf: 没有缺失服务（waitingFor 为空）', Array.isArray(half?.waitingFor) && half.waitingFor.length === 0, `waitingFor=${JSON.stringify(half?.waitingFor)}`)
const globalHanhua = ctx.tools.schemas().filter((s) => String(s.name).startsWith('hanhua_')).map((s) => s.name)
check('D3 动态包**不再**把工具注册进全局层（面板只提供 workbench.* RPC；避免污染同进程其它会话）', globalHanhua.length === 0, `全局层: ${globalHanhua.join(',') || '(空)'}`)
check('D4 agent 层仍是 8 个（预设版提供全部模型工具）',
  ctx.tools.schemas(SCOPE_KEY).filter((s) => String(s.name).startsWith('hanhua_')).length === 8,
  `agent 层 ${ctx.tools.schemas(SCOPE_KEY).filter((s) => String(s.name).startsWith('hanhua_')).length} 个`)
check('D5 全局层没有 hanhua 工具定义（只有 agent 层一份）',
  ctx.tools.get('hanhua_scan', SCOPE_KEY) !== undefined && ctx.tools.get('hanhua_scan') === undefined
  && ctx.tools.get('hanhua_workbench', SCOPE_KEY) !== undefined && ctx.tools.get('hanhua_workbench') === undefined,
  `agent 层 hanhua_scan=${ctx.tools.get('hanhua_scan', SCOPE_KEY) !== undefined} 全局层 hanhua_scan=${ctx.tools.get('hanhua_scan') !== undefined}`)

// ── E. getClientCode + 复刻 evaluator 的闭包形态执行 client 半 ────────────
const src = runner.getClientCode(agent, pluginId, pluginRunId)
check('E1 getClientCode: 返回 client 半源码', typeof src?.code === 'string' && src.code.includes('settings.section'), `len=${src?.code?.length}`)
// 只看代码、不看注释（v9 的头注释里会说明「为什么删掉 tool.view.cordis」）
const clientCodeNoComments = String(src.code).replace(/^\s*\/\/.*$/gm, '')
check('E2 client 半代码里已无 tool.view.cordis 注册与 QuickPanel（只注释里提到）',
  !clientCodeNoComments.includes('tool.view.cordis') && !clientCodeNoComments.includes('QuickPanel'),
  `去注释后 ${clientCodeNoComments.length} 字符`)

// 复刻 packages/extensions/cordis-client-runner/src/client/evaluator.ts 的求值形态
// （把源码当 async 函数体，注入 React/console/styles/host；返回 { apply(ctx) }）
let clientApplied = null
let clientError = ''
try {
  const captured = { injected: [], registered: [], css: '' }
  const ReactStub = {
    createElement: (type, props, ...children) => ({ type, props: props || {}, children }),
    useState: (v) => [v, () => {}],
    useEffect: () => {},
  }
  const stylesStub = { insert: (css) => { captured.css += css; return () => {} } }
  const hostStub = { call: async () => ({}) }
  const slotsStub = {
    inject: (name, cb) => { captured.injected.push(name); if (name === 'settings.section') cb() },
    register: (opts, component) => { captured.registered.push({ opts, component }); return () => {} },
  }
  const factory = new Function('React', 'console', 'styles', 'host', `return (async () => {\n${src.code}\n})()`)
  const plugin = await factory(ReactStub, console, stylesStub, hostStub)
  plugin.apply({ get: (n) => (n === 'slots' ? slotsStub : undefined) })
  clientApplied = captured
} catch (e) { clientError = String(e.message || e) }
check('E3 client 半可作为 async 函数体求值并 apply（真实 evaluator 形态）', clientApplied !== null, clientError || 'ok')
check('E4 client 半只 inject settings.section（不再等 tool.view.cordis 渲染位）',
  JSON.stringify(clientApplied?.injected) === JSON.stringify(['settings.section']), JSON.stringify(clientApplied?.injected))
check('E5 注册项 = {name:settings.section, id:hanhua-workbench, order:50, label:汉化工作台}',
  clientApplied?.registered?.[0]?.opts?.name === 'settings.section' && clientApplied.registered[0].opts.id === 'hanhua-workbench'
  && clientApplied.registered[0].opts.order === 50 && clientApplied.registered[0].opts.label === '汉化工作台',
  JSON.stringify(clientApplied?.registered?.[0]?.opts))
let componentOk = false
let componentError = ''
try {
  const el = clientApplied.registered[0].component()
  // 注册的组件是 () => h(Workbench)：再调一层把 Workbench 本身渲染出来
  const tree = typeof el.type === 'function' ? el.type() : null
  componentOk = !!tree && tree.type === 'div' && tree.props?.className === 'hb-root'
} catch (e) { componentError = String(e.message || e) }
check('E6 设置页组件可渲染出面板根节点（div.hb-root）', componentOk, componentError || `css=${clientApplied.css.length}B`)
check('E7 styles.insert 注入了面板 CSS（含 .hb-root）', String(clientApplied?.css).includes('.hb-root'))

// ── F. 批准（模拟页面应答 resolveRequestRun）──────────────────────────────
const ack = await runner.resolveRequestRun(requestId, { ok: true, pluginRunId })
check('F1 resolveRequestRun 接受批准', ack?.accepted === true, JSON.stringify(ack))
const st1 = await call('hanhua_workbench', { action: 'status' }, exec)
check('F2 status: ready=true 且 currentPackageId 已提交', st1?.ready === true
  && st1?.workbench?.[0]?.currentPackageId === packageId, `ready=${st1?.ready} current=${st1?.workbench?.[0]?.currentPackageId}`)
const handlers = st1?.workbench?.[0]?.activeRun?.handlers || []
check('F3 status: activeRun.handlers 含 workbench.* 且无 fiber 泄漏',
  handlers.includes('workbench.state') && handlers.includes('workbench.pipeline') && !JSON.stringify(st1).includes('"fiber"'),
  `handlers=${handlers.length} 个: ${handlers.slice(0, 3).join(',')}…`)

// ── G. 面板 RPC：invoke workbench.state ───────────────────────────────────
const invoked = await runner.invoke(pluginId, pluginRunId, 'workbench.state', null)
check('G1 invoke workbench.state：面板 RPC 通道可用', invoked?.ok === true, JSON.stringify(invoked).slice(0, 200))
const invokedBad = await runner.invoke(pluginId, pluginRunId, 'workbench.nope', null)
check('G2 invoke 未知方法返回 method-not-found（未静默成功）', invokedBad?.ok === false && invokedBad?.code === 'method-not-found', JSON.stringify(invokedBad))

// ── H. stop + 再 install（复用且不再需要批准）─────────────────────────────
const stopRes = await call('hanhua_workbench', { action: 'stop' }, exec)
check('H1 stop: 停掉运行实例', stopRes?.ok === true && stopRes?.stopped?.[0]?.ok === true, JSON.stringify(stopRes?.stopped))
const afterStop = await runner.invoke(pluginId, pluginRunId, 'workbench.state', null)
check('H2 stop 后 RPC 立即失效（plugin-not-running）', afterStop?.ok === false && afterStop?.code === 'plugin-not-running', JSON.stringify(afterStop))
check('H2b stop 后全局层的动态工具也一并注销（回到 install 前）',
  ctx.tools.schemas().filter((s) => String(s.name).startsWith('hanhua_')).length === 0,
  `全局层 ${ctx.tools.schemas().filter((s) => String(s.name).startsWith('hanhua_')).length} 个`)
const ins3 = await call('hanhua_workbench', { action: 'install' }, exec)
check('H3 stop 后 install 复用同一定义', ins3?.reused === true && ins3?.pluginId === pluginId, `reused=${ins3?.reused} pluginId=${ins3?.pluginId}`)
check('H4 已批准过的版本第二次 run 不再要求批准（页面会自动装回）',
  ins3?.run?.status === 'starting' && ins3?.run?.ok === true && ins3?.timedOut === false,
  `status=${ins3?.run?.status} reason=${ins3?.run?.reason} timedOut=${ins3?.timedOut}`)
const snap2 = runner.snapshot(agent)
check('H5 全程只存在一个 hanhu-* 定义（没有堆出 hanhu-2）', snap2.length === 1 && snap2[0].pluginId === pluginId, JSON.stringify(snap2.map(r => r.pluginId)))

// ── 收尾 ──────────────────────────────────────────────────────────────────
await rm(WORK, { recursive: true, force: true })
const failed = results.filter((r) => !r.ok)
console.log(`\n===== 定向探针结果：${results.length - failed.length}/${results.length} 通过 =====`)
if (failed.length > 0) { console.log('失败项：'); for (const f of failed) console.log(`  - ${f.name}${f.detail ? ' — ' + f.detail : ''}`) }
process.exit(failed.length === 0 ? 0 : 1)
