// 沙箱边界探针：Node 以不同 stdio 方式 spawn 子进程时的行为
import { spawnSync, spawn } from 'node:child_process'
const node = process.execPath
const CWD = 'D:/Games/汉化模式'
const code = 'console.log("child-ok stdout")'

function t(label, fn) {
  try {
    const r = fn()
    if (r && typeof r.then === 'function') { r.then((v) => console.log(label, '=>', v)).catch((e) => console.log(label, '=> ASYNC-ERR', e.code || e.message)) }
    else console.log(label, '=>', r)
  } catch (e) { console.log(label, '=> THROW', e.code || e.message) }
}

t('spawnSync stdio=inherit', () => { const r = spawnSync(node, ['-e', code], { stdio: 'inherit', cwd: CWD }); return `status=${r.status} error=${r.error ? r.error.code : 'none'}` })
t('spawnSync stdio=pipe   ', () => { const r = spawnSync(node, ['-e', code], { stdio: 'pipe', cwd: CWD }); return `status=${r.status} stdout=${JSON.stringify(String(r.stdout || '').trim())} error=${r.error ? r.error.code : 'none'}` })
t('spawnSync stdio=ignore ', () => { const r = spawnSync(node, ['-e', code], { stdio: 'ignore', cwd: CWD }); return `status=${r.status} error=${r.error ? r.error.code : 'none'}` })

t('spawn stdio=inherit     ', () => new Promise((res) => {
  const c = spawn(node, ['-e', code], { stdio: 'inherit', cwd: CWD })
  c.on('error', (e) => res('error=' + e.code))
  c.on('close', (v) => res('close code=' + v))
}))
t('spawn stdio=pipe        ', () => new Promise((res) => {
  const c = spawn(node, ['-e', code], { stdio: 'pipe', cwd: CWD })
  c.on('error', (e) => res('error=' + e.code))
  c.on('close', (v) => res('close code=' + v))
}))
setTimeout(() => process.exit(0), 3000)
