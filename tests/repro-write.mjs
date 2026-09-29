// 定位 hanhua_export 在 0.1.6-alpha.2 下的写回失败（"Cannot read properties of undefined (reading 'includes')"）。
// 直接对真实 fs / sandboxPolicy 服务做最小复现，打印完整堆栈。
import { mkdir, rm, writeFile, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const MODS = 'D:/Agent-windows/DeepSeekHarness/data/.dsh/profiles/node_modules'
const imp = (s) => import(pathToFileURL(join(MODS, s)).href)

const { Context } = await imp('@deepseek-ai/cordis/lib/index.js')
const { LocalFileSystem } = await imp('@deepseek-ai/dsh-fs-local/lib/index.js')
const { SandboxPolicyService } = await imp('@deepseek-ai/dsh-sandbox-policy/lib/index.js')
const { LocalSubprocessRuntime } = await imp('@deepseek-ai/dsh-subprocess-local/lib/index.js')

const WORK = 'D:/Games/汉化模式/DSH-hanhua-mode/tests/.repro'
await rm(WORK, { recursive: true, force: true })
await mkdir(join(WORK, 'sub'), { recursive: true })
const file = join(WORK, 'sub', 'a.txt')
await writeFile(file, 'Hello world\n', 'utf8')

const ctx = new Context()
await ctx.plugin({
  name: 'test-session-projections',
  apply(c) { c.provide('sessionProjections', { register: () => () => {}, stateOf: () => null }) },
})
await ctx.plugin(LocalFileSystem, { cwd: WORK })
await ctx.plugin(SandboxPolicyService, { mode: 'workspace-write', workspaceRoot: WORK })
await ctx.plugin(LocalSubprocessRuntime)

const attempt = async (label, fn) => {
  try {
    const r = await fn()
    console.log(`OK   ${label} ->`, JSON.stringify(r))
  } catch (e) {
    console.log(`FAIL ${label} -> ${e && e.message}`)
    console.log(String((e && e.stack) || e).split('\n').slice(0, 12).map((l) => '       ' + l).join('\n'))
  }
}

const t = await ctx.fs.resolve(file)
console.log('resolved target type:', t && t.constructor && t.constructor.name)
const session = { id: 'harness', header: { cwd: WORK } }
let policy
try { policy = ctx.sandboxPolicy.resolve({ session }) } catch (e) { console.log('resolve(policy) threw:', e.message) }
console.log('policy =', JSON.stringify(policy))

await attempt('writeText(t, text)                [2 args]', () => ctx.fs.writeText(t, 'Hello world 2\n'))
await attempt('writeText(t, text, undefined, undefined)  [4 args]', () => ctx.fs.writeText(t, 'Hello world 3\n', undefined, undefined))
await attempt('writeText(t, text, undefined, undefined, policy) [5 args]', () => ctx.fs.writeText(t, 'Hello world 4\n', undefined, undefined, policy))
await attempt('writeText(t, text, {}, undefined, policy) [expected={}]', () => ctx.fs.writeText(t, 'Hello world 5\n', {}, undefined, policy))
await attempt('resolve(相对路径) + writeText', async () => {
  const rel = await ctx.fs.resolve('sub/a.txt')
  return ctx.fs.writeText(rel, 'Hello world 6\n', undefined, undefined, policy)
})

console.log('\nfinal file content:', JSON.stringify(await readFile(file, 'utf8')))
await rm(WORK, { recursive: true, force: true })
