// 验证 A1：新版 dsh-persona 的 Config 是否拒绝旧的 `text:` 配置，并确认本地副本的挂载口径。
import { pathToFileURL } from 'node:url'
import { join } from 'node:path'

const MODS = 'D:/Agent-windows/DeepSeekHarness/data/.dsh/profiles/node_modules'
const imp = (s) => import(pathToFileURL(join(MODS, s)).href)

const persona = await imp('@deepseek-ai/dsh-persona/lib/index.js')
console.log('persona exports:', Object.keys(persona).join(', '))
const { Config } = persona

const tryResolve = (label, value) => {
  try {
    const out = Config(value)
    console.log(`OK   ${label} ->`, JSON.stringify(out))
  } catch (e) {
    console.log(`FAIL ${label} -> ${e && e.message}`)
  }
}

tryResolve('旧写法 { text: "你是汉化模式…" }', { text: '你是汉化模式…' })
tryResolve('新写法 { prefix: "你是汉化模式…" }', { prefix: '你是汉化模式…' })
tryResolve('新写法 { prefix, suffix }', { prefix: '你是汉化模式…', suffix: '工作目录 {{cwd}}' })
