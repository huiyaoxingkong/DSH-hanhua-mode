// Probe the installed 0.1.6-alpha.2 runtime packages: what each module exports and
// which service name it publishes. Read-only; used to build the integration harness.
const BASE = 'file:///D:/Agent-windows/DeepSeekHarness/data/.dsh/profiles/node_modules/@deepseek-ai/'

const pkgs = [
  'cordis',
  'dsh-fs', 'dsh-fs-local',
  'dsh-sandbox-policy', 'dsh-sandbox', 'dsh-sandbox-local',
  'dsh-subprocess', 'dsh-subprocess-local',
  'dsh-tools', 'dsh-system-prompt',
  'dsh-web', 'dsh-web-fetch-http',
]

for (const p of pkgs) {
  try {
    const m = await import(BASE + p + '/lib/index.js')
    const keys = Object.keys(m).sort()
    const info = keys.map((k) => {
      const v = m[k]
      const kind = typeof v === 'function' ? (v.name || 'fn') : typeof v
      return `${k}:${kind}`
    })
    console.log(`\n=== ${p} ===`)
    console.log(info.join('\n'))
  } catch (e) {
    console.log(`\n=== ${p} === IMPORT FAILED: ${e.message}`)
  }
}
