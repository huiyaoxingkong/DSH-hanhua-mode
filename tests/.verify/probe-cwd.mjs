// 探针 A：0.1.6-alpha.2 真实 subprocess 服务对 `cwd` 的要求
// 目的：独立证据证明「缺 cwd 会在新版内核抛错、补 cwd 后能走到 spawn」，
//       且旧内核实现容忍缺省 cwd。
import { pathToFileURL } from 'node:url'
import { join } from 'node:path'

const MODS = 'D:/Agent-windows/DeepSeekHarness/data/.dsh/profiles/node_modules'
const OLD = 'D:/Agent-windows/deepseek_harness/.tmp-core-old-0.1.1-rc.2/packages/subprocess/subprocess-local/lib/index.js'
const imp = (s) => import(pathToFileURL(join(MODS, s)).href)

const { Context } = await imp('@deepseek-ai/cordis/lib/index.js')
const { LocalSubprocessRuntime } = await imp('@deepseek-ai/dsh-subprocess-local/lib/index.js')

const ctx = new Context()
await ctx.plugin(LocalSubprocessRuntime)
const sub = ctx.subprocess
const node = await sub.resolveExecutable('node').catch(() => 'node')
console.log('resolveExecutable("node") =', node)

const spec = (cwd) => ({
  argv: [node, '-e', 'process.exit(0)'],
  ...(cwd === undefined ? {} : { cwd }),
  stdio: { stdin: 'inherit', stdout: 'inherit', stderr: 'inherit' },
  graceMs: 5000,
})

function withTimeout(p, ms, label) {
  return Promise.race([p, new Promise((r) => setTimeout(() => r('__TIMEOUT__(' + label + ')'), ms))])
}

async function trial(label, cwd) {
  const t0 = Date.now()
  try {
    const h = sub.spawn(spec(cwd))
    console.log(`[${label}] spawn() 返回 handle（同步未抛错）`)
    const done = await withTimeout(h.done.then((d) => `exitCode=${d.exitCode} signal=${d.signal}`).catch((e) => 'ASYNC-ERR ' + (e.code || e.message)), 20000, label)
    console.log(`[${label}] done => ${done}  (${Date.now() - t0}ms)`)
  } catch (e) {
    console.log(`[${label}] spawn() 同步抛错 => ${e.constructor.name}: ${e.message}  (${Date.now() - t0}ms)`)
  }
}

console.log('\n===== 0.1.6-alpha.2：不传 cwd =====')
await trial('new/no-cwd', undefined)
console.log('\n===== 0.1.6-alpha.2：传 cwd（插件现在的做法）=====')
await trial('new/with-cwd', 'D:/Games/汉化模式')

// 旧内核（0.1.1-rc.2）对照
try {
  const old = await import(pathToFileURL(OLD).href)
  const oldCtx = new Context()
  await oldCtx.plugin(old.LocalSubprocessRuntime ?? old.default)
  const osub = oldCtx.subprocess
  console.log('\n===== 0.1.1-rc.2（旧内核）：不传 cwd =====')
  try {
    const h = osub.spawn(spec(undefined))
    const done = await withTimeout(h.done.then((d) => `exitCode=${d.exitCode}`).catch((e) => 'ASYNC-ERR ' + (e.code || e.message)), 20000, 'old')
    console.log('[old/no-cwd] spawn() 返回 handle；done => ' + done)
  } catch (e) {
    console.log(`[old/no-cwd] spawn() 同步抛错 => ${e.constructor.name}: ${e.message}`)
  }
} catch (e) {
  console.log('\n[old-kernel] 无法导入旧内核实现：' + (e.message || e))
}
process.exit(0)
