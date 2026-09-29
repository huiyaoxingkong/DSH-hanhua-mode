// ---------- 「汉化工作台」自装（常驻设置页；0.1.6 起没有模型动态装载工具了） ----------
// 背景：0.1.6-alpha.2 退役了 cordis_define/cordis_run/cordis_stop/cordis_undefine，
// tool.view.cordis 的渲染位随 cordis_run 卡片一起消失；但动态插件机制本体仍在
// （host 服务 dynamicCordisRunner 公开 define/run/stop/undefine，见 cordis-host-runner）。
// 因此由本插件在 host 平面自装：host 半 = 同级 engine/host.js，client 半 = 同级 engine/client.js；
// client 半只注册常驻的 settings.section（设置页「汉化工作台」）。
// 铁律：不把 dynamicCordisRunner 写进 export const inject —— inject 里缺服务会让整个插件停用，
// 7 个 hanhua_* 工具会一起消失；这里只在工具被调用时用 ctx.get 检查，缺失即早退。
const WORKBENCH_SERVICE = 'dynamicCordisRunner'
const WORKBENCH_NAME = '汉化工作台'
const WORKBENCH_PURPOSE = '设置页工作台面板'
const WORKBENCH_ID_PREFIX = 'hanhu'   // define 要求 /^[a-z]{3,6}$/
const WORKBENCH_RUN_WAIT_MS = 3000    // run 可能挂起等用户批准：不能无限 await
const WORKBENCH_ENGINE_FILES = { host: 'host.js', client: 'client.js' }

// file:///D:/a/index.js → D:/a/（同时处理盘符、UNC \\server\share 与 %20 转义）
const fileUrlToPath = (u) => {
  let s = String(u)
  if (!s.startsWith('file:')) return s
  s = s.slice('file:'.length)
  if (s.startsWith('//')) {
    s = s.slice(2)
    const i = s.indexOf('/')
    const host = i < 0 ? s : s.slice(0, i)
    const rest = i < 0 ? '' : s.slice(i)
    s = (host === '' || host === 'localhost') ? rest : '//' + host + rest
  }
  s = s.replace(/^\/([A-Za-z]:)/, '$1')
  try { return decodeURIComponent(s) } catch (e) { return s }
}

// 本文件所在目录（安装后即 <预设根>/plugins/hanhua/）
const pluginDir = (() => {
  try { return fileUrlToPath(new URL('./', import.meta.url).href) } catch (e) { return '' }
})()
// 引擎主体（core.js）里的 iconv 候选清单靠它找到「插件自带」的 node_modules：
// 桌面版内核打包在 app.asar 里，子进程 require 不到其中的模块，所以必须自带并显式指路。
pluginDirOverride = pluginDir

// 引擎源码目录：默认同级 engine/（预设自包含）；可用 .hanhua-config.json 的 workbenchEnginePath 覆盖
const workbenchEngineDir = () => {
  const override = (config && typeof config.workbenchEnginePath === 'string') ? config.workbenchEnginePath.trim() : ''
  if (override) return override
  return pluginDir ? joinPath(pluginDir, 'engine') : 'engine'
}
const byteLengthOf = (s) => { try { return Buffer.byteLength(String(s), 'utf8') } catch (e) { return String(s).length } }

// 读引擎源码：优先走注入的 fs 服务；失败退到 node:fs（预设插件运行在 host 进程里，绝对路径可读）
const readEngineText = async (p) => {
  try { return await readText(p) } catch (first) {
    try {
      const fsp = await import('node:fs/promises')
      return await fsp.readFile(p, 'utf8')
    } catch (second) { throw new Error(msg(first)) }
  }
}
const probeEngineFile = async (p) => {
  try {
    const info = await fs.stat(await fs.resolve(p))
    if (info && info.type) return { path: p, exists: true, type: info.type, bytes: typeof info.size === 'number' ? info.size : null }
  } catch (e) { /* 落到 node 兜底 */ }
  try {
    const fsp = await import('node:fs/promises')
    const st = await fsp.stat(p)
    return { path: p, exists: true, type: st.isDirectory() ? 'directory' : 'file', bytes: typeof st.size === 'number' ? st.size : null }
  } catch (e) { return { path: p, exists: false, error: msg(e) } }
}

const WORKBENCH_NO_SERVICE = '当前内核没有 dynamicCordisRunner 服务，无法装载「汉化工作台」动态包：'
  + '请确认 web composition 挂载了 @deepseek-ai/dsh-cordis-host-runner（0.1.6-alpha.2 里它属于可选插入行），'
  + '且当前会话跑在带浏览器 UI 的 dsh web 下。静态 hanhua_* 工具不受影响，可照常使用。'

const workbenchRunner = () => {
  let runner = null
  try { runner = svc(WORKBENCH_SERVICE) } catch (e) { runner = null }
  if (runner && typeof runner.define === 'function' && typeof runner.run === 'function' && typeof runner.stop === 'function') return runner
  return null
}

// Agent.id 即 SessionId（define 的 sessionId 与 run/stop 的所有者都是它）。
// 优先本轮工具调用的 exec.agent；没有就退到 agents.currentInitiator()。
const agentOfExec = (exec) => {
  try {
    const a = (exec || lastExec) && (exec || lastExec).agent
    if (a && typeof a.id === 'string' && a.id) return a
  } catch (err) { /* ignore */ }
  try {
    const agents = svc('agents')
    const current = agents && typeof agents.currentInitiator === 'function' ? agents.currentInitiator() : null
    if (current && typeof current.id === 'string' && current.id) return current
  } catch (err) { /* ignore */ }
  return null
}

const isWorkbenchRow = (row) => {
  if (!row) return false
  if (String(row.pluginId || '').startsWith(WORKBENCH_ID_PREFIX + '-')) return true
  return Array.isArray(row.packages) && row.packages.some((p) => p && p.name === WORKBENCH_NAME)
}
// 本会话里已有的「汉化工作台」定义（snapshot 按 sessionId 过滤；进程重启后不会有旧记录）
const workbenchRows = (runner, agent) => {
  let rows = []
  try { rows = runner.snapshot(agent) } catch (e) { rows = [] }
  return (Array.isArray(rows) ? rows : []).filter(isWorkbenchRow)
}
// 可复用的版本：currentPackageId 优先，否则最后一个已定义版本 —— 两者都能用 mode:'run' 启动
// （mode:'update' 只在换版本时才需要，这里刻意不用，避免每次 install 都堆一个新版本）。
const workbenchReuseTarget = (rows) => {
  for (let i = rows.length - 1; i >= 0; i -= 1) {
    const row = rows[i]
    const packages = Array.isArray(row.packages) ? row.packages : []
    const packageId = row.currentPackageId || (packages.length ? packages[packages.length - 1].packageId : null)
    if (packageId) return { pluginId: row.pluginId, packageId }
  }
  return null
}

// run 在有 client 半时会 emit cordis/request-run 后等用户批准（host runner README：无超时）。
// 这里 race 兜住：超时就返回「等待批准」，并把 promise 的 then/catch 接住，绝不产生 unhandled rejection。
const awaitWithTimeout = (promise, ms) => {
  if (typeof setTimeout !== 'function') return promise.then((value) => ({ value }), (error) => ({ error }))
  return new Promise((resolve) => {
    let settled = false
    const timer = setTimeout(() => { if (!settled) { settled = true; resolve({ timedOut: true }) } }, ms)
    const finish = (out) => { if (!settled) { settled = true; clearTimeout(timer); resolve(out) } }
    promise.then((value) => finish({ value }), (error) => finish({ error }))
    if (timer && typeof timer.unref === 'function') timer.unref()
  })
}
// 只挑标量：run 的响应里可能有 fiber 之类的循环引用对象，不能整体 JSON 化
const runStatusOf = (run) => {
  if (!run || typeof run !== 'object') return null
  return {
    ok: run.ok !== false,
    status: run.status || null,
    reason: run.reason || null,
    message: run.message || null,
    pluginRunId: run.pluginRunId || null,
    packageId: run.packageId || null,
  }
}

async function workbenchStatus() {
  await loadMeta()
  const dir = workbenchEngineDir()
  const override = !!(config && typeof config.workbenchEnginePath === 'string' && config.workbenchEnginePath.trim())
  const host = await probeEngineFile(joinPath(dir, WORKBENCH_ENGINE_FILES.host))
  const client = await probeEngineFile(joinPath(dir, WORKBENCH_ENGINE_FILES.client))
  const runner = workbenchRunner()
  const agent = agentOfExec(null)
  const hints = []
  if (!runner) hints.push(WORKBENCH_NO_SERVICE)
  for (const probe of [host, client]) if (!probe.exists) hints.push('引擎源码缺失：' + probe.path + (probe.error ? '（' + probe.error + '）' : ''))
  const status = {
    action: 'status',
    service: { name: WORKBENCH_SERVICE, available: !!runner },
    engine: {
      dir,
      pathSource: override ? 'workbenchEnginePath（.hanhua-config.json 覆盖）' : '插件同级 engine/（由 import.meta.url 推导）',
      pluginDir: pluginDir || null,
      host,
      client,
    },
    sessionId: agent ? agent.id : null,
    definitions: [],
    workbench: [],
    ready: false,
    hints,
  }
  if (runner) {
    if (!agent) hints.push('取不到当前 Agent/会话（exec.agent 与 agents.currentInitiator 都没有），无法查询本会话的动态定义。')
    else {
      let allRows = []
      try { allRows = runner.snapshot(agent) || [] } catch (e) { status.snapshotError = msg(e) }
      status.definitions = (Array.isArray(allRows) ? allRows : []).map((row) => ({
        pluginId: row.pluginId,
        currentPackageId: row.currentPackageId || null,
        nextPackageId: row.nextPackageId || null,
        packages: (Array.isArray(row.packages) ? row.packages : []).map((p) => ({
          packageId: p.packageId, name: p.name, hasHostHalf: !!p.hasHostHalf, hasClientHalf: !!p.hasClientHalf,
        })),
        // activeRun.fiber 是 Cordis Fiber（循环引用），只挑标量字段
        activeRun: row.activeRun ? {
          pluginRunId: row.activeRun.pluginRunId,
          packageId: row.activeRun.packageId,
          handlers: Array.isArray(row.activeRun.handlers) ? row.activeRun.handlers.slice(0, 40) : [],
          renderFailure: row.activeRun.renderFailure
            ? { slot: row.activeRun.renderFailure.slot || null, message: row.activeRun.renderFailure.message || null }
            : null,
        } : null,
        latestRun: row.latestRun ? {
          status: row.latestRun.status || null,
          mode: row.latestRun.mode || null,
          requiresApproval: !!row.latestRun.requiresApproval,
          error: (row.latestRun.error && row.latestRun.error.message) ? row.latestRun.error.message : null,
        } : null,
      }))
      status.workbench = status.definitions.filter((d) => isWorkbenchRow(d))
      status.ready = status.workbench.some((d) => !!d.currentPackageId) && host.exists && client.exists
      if (!status.definitions.length) hints.push('本会话还没有任何动态定义：执行 hanhua_workbench action=install 装载「汉化工作台」。')
      else if (!status.workbench.length) hints.push('本会话有动态定义，但没有「汉化工作台」：执行 action=install 装载。')
      else if (!status.ready) hints.push('已有「汉化工作台」定义，但当前没有成功运行的版本：执行 action=install 重新装载，并按提示到 Cordis 面板批准。')
      else hints.push('就绪：设置页里应能看到「汉化工作台」；若看不到，请刷新浏览器页面后重新 install。')
    }
  }
  return status
}

async function workbenchInstall(exec) {
  await loadMeta()
  const runner = workbenchRunner()
  if (!runner) throw new Error(WORKBENCH_NO_SERVICE)
  const agent = agentOfExec(exec)
  if (!agent) {
    throw new Error('装载「汉化工作台」需要当前会话的 Agent（SessionId）：'
      + "请通过工具调用（exec.agent）触发，或确认 agents.currentInitiator() 可用。")
  }
  const dir = workbenchEngineDir()
  const hostPath = joinPath(dir, WORKBENCH_ENGINE_FILES.host)
  const clientPath = joinPath(dir, WORKBENCH_ENGINE_FILES.client)
  let hostCode, clientCode
  try { hostCode = await readEngineText(hostPath) } catch (e) {
    throw new Error('读不到 host 半 ' + hostPath + '：' + msg(e) + '。请确认 preset/plugins/hanhua/engine/ 已随预设一起安装（或设置 workbenchEnginePath）。')
  }
  try { clientCode = await readEngineText(clientPath) } catch (e) {
    throw new Error('读不到 client 半 ' + clientPath + '：' + msg(e) + '。请确认 preset/plugins/hanhua/engine/ 已随预设一起安装（或设置 workbenchEnginePath）。')
  }

  // 同一会话已有工作台定义时复用（浏览器刷新后重新 run 即可；反复 install 不会堆出一串 hanhu-N）
  const reuse = workbenchReuseTarget(workbenchRows(runner, agent))
  let receipt = null
  let pluginId, packageId
  if (reuse) {
    pluginId = reuse.pluginId
    packageId = reuse.packageId
  } else {
    // define 会 precheck 两半源码（语法不过就抛错，不会留下半成品定义）
    receipt = runner.define({
      sessionId: agent.id,
      plugin: { kind: 'new', idPrefix: WORKBENCH_ID_PREFIX },
      name: WORKBENCH_NAME,
      purpose: WORKBENCH_PURPOSE,
      code: { host: hostCode, client: clientCode },
    })
    pluginId = receipt.pluginId
    packageId = receipt.packageId
  }

  const outcome = await awaitWithTimeout(
    Promise.resolve().then(() => runner.run(agent, pluginId, packageId, 'run')),
    WORKBENCH_RUN_WAIT_MS,
  )
  const run = outcome.timedOut ? null : (outcome.value || null)
  const runError = outcome.error ? msg(outcome.error) : null
  const state = runStatusOf(run)
  const awaiting = !!outcome.timedOut || (!!state && state.status === 'awaiting-approval')
  const pendingAlready = !!state && state.reason === 'transition-in-flight'
  const ok = !runError && !pendingAlready && (!!outcome.timedOut || (!!state && state.ok))
  const hints = []
  if (runError) hints.push('runner.run 抛错：' + runError)
  if (awaiting) hints.push('定义已创建并发出装载请求，正在等待批准：请在浏览器里打开 Cordis 面板点「批准」，随后 设置 →「汉化工作台」出现面板。')
  if (pendingAlready) hints.push('该定义已有一个待批准的装载请求：直接到 Cordis 面板点「批准」即可，无需重复 install。')
  if (ok && !awaiting) hints.push('宿主半已在 host 平面启动；若浏览器半还没加载，请在 Cordis 面板批准，或刷新页面后重新 install。')
  hints.push('定义是进程内状态：DSH 重启后需要重新执行 install。')
  return {
    action: 'install',
    ok,
    reused: !!reuse,
    pluginId,
    packageId,
    receipt,
    run: state,
    timedOut: !!outcome.timedOut,
    engine: {
      dir,
      host: { path: hostPath, bytes: byteLengthOf(hostCode) },
      client: { path: clientPath, bytes: byteLengthOf(clientCode) },
    },
    hints,
  }
}

async function workbenchStop(exec) {
  await loadMeta()
  const runner = workbenchRunner()
  if (!runner) throw new Error(WORKBENCH_NO_SERVICE)
  const agent = agentOfExec(exec)
  if (!agent) throw new Error('停止「汉化工作台」需要当前会话的 Agent（SessionId）。')
  const rows = workbenchRows(runner, agent)
  if (!rows.length) {
    return { action: 'stop', ok: true, stopped: [], message: '本会话没有「汉化工作台」动态定义（定义只在进程内存在，重启后本来就没有）。' }
  }
  const stopped = []
  for (const row of rows) {
    let result
    try { result = await runner.stop(agent, row.pluginId) } catch (e) { result = { ok: false, reason: 'error', message: msg(e) } }
    stopped.push({ pluginId: row.pluginId, ok: !!(result && result.ok), reason: (result && result.reason) || null, message: (result && result.message) || null })
  }
  return {
    action: 'stop',
    ok: stopped.every((s) => s.ok),
    stopped,
    message: 'stop 停掉运行中的实例，定义仍留在进程内；浏览器面板会随 cordis/dynamic-retract 卸载。',
  }
}

async function workbenchAction(args, exec) {
  const action = String((args && args.action) || 'status')
  if (action === 'status') return workbenchStatus()
  if (action === 'install') return workbenchInstall(exec)
  if (action === 'stop') return workbenchStop(exec)
  throw new Error('未知 action: ' + action + '（可用：status / install / stop）')
}

// ---------- 工具注册（静态注册，走 ctx.tools） ----------
// 工具清单在 tools.js 的 TOOL_SPECS（两个信封共用同一份定义，避免再出现两半漂移）。
// execute 的第二参数固定是 exec（工具调用上下文），需要它的工具（如 hanhua_workbench）才用。
const out = () => ({ schema: { type: 'string' }, render: (_a, v) => [{ type: 'text', text: typeof v === 'string' ? v : JSON.stringify(v, null, 2) }] })
const registerTool = (spec) => ctx.effect(() => ctx.tools.register({
  name: spec.name,
  description: spec.description,
  parameters: { type: 'object', properties: spec.properties || {}, required: spec.required || [], additionalProperties: false },
  output: out(),
  execute: async (args, exec) => JSON.stringify(await withExec(exec, () => spec.run(args || {}, exec))),
}))

for (const spec of TOOL_SPECS) registerTool(spec)

registerTool({
  name: 'hanhua_workbench',
  description: '装载/查看/停止「汉化工作台」浏览器面板（常驻 设置 →「汉化工作台」）。0.1.6-alpha.2 起 cordis_define/cordis_run 等模型工具已退役，本工具由预设插件在 host 平面直接调用 dynamicCordisRunner 自装动态包：action=install 读取同级 engine/{host.js,client.js} 并 define+run（首次需到 Cordis 面板点「批准」）；action=status 查看服务是否可用、引擎源码路径与字节数、本会话已有定义与运行状态；action=stop 停止运行中的实例。定义是进程内状态，DSH 重启后需重新 install。详见 docs/WORKBENCH-0.1.6.md。',
  properties: { action: { type: 'string', enum: ['status', 'install', 'stop'], description: 'status（默认）查看状态；install 装载/重新装载面板；stop 停止运行中的实例' } },
  required: [],
  run: async (args, exec) => workbenchAction(args || {}, exec),
})

// ---------- 提示片段：汉化工作流指南 ----------
// order 说明：0.1.6-alpha.2 起 systemPrompt 改用统一编号的档位表
// （SECTION_ORDERS：persona 0 / plan 500 / 工具指南 1000–3100 / TOOLS_SDK 5000 /
//  persona 后缀 10200）。旧版的「工具指南 100–199」约定已失效：order:115 会掉到
//  persona 之后、全部第一方工具指南之前。这里落在 MCP_SERVERS(3100) 与
//  TOOLS_SDK(5000) 之间，紧跟既有工具指南、且在 SDK 段之前。
ctx.effect(() => ctx.systemPrompt.section({
  name: 'tool:hanhua',
  order: 3200,
  text: GUIDE_LINES.join('\n'),
}))
