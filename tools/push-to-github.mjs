/**
 * 通过 GitHub REST API（Git Data API）把当前仓库推送到远端。
 *
 * 为什么不用 `git push`：本机（以及不少网络环境）到 `github.com:443` 不通，
 * 但 `api.github.com:443` 可用。GitHub 的 Git Data API 允许直接上传 blobs、
 * 建 tree、建 commit、更新 ref —— 等价于一次推送。
 *
 * 用法：
 *   node tools/push-to-github.mjs [--owner <owner>] [--repo <repo>] [--branch main]
 *                                 [--message "..." | --message-file <path>] [--dry]
 *
 * 凭据解析顺序（都不会被打印）：
 *   1) 环境变量 GH_TOKEN / GITHUB_TOKEN
 *   2) <仓库>/.tools/gh-token.txt（该目录已被 .gitignore 忽略）
 *   3) `git credential fill`（Windows 凭据管理器 / GCM 里已登录的 GitHub 凭据）
 *
 * 行为：把 **git 跟踪的全部文件**（`git ls-files`）作为一次快照提交到远端分支，
 * 与远端 HEAD 的 tree 比对后只上传变化的 blob；非强制更新 ref（远端有新提交会报错）。
 */
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO = resolve(HERE, '..')
const argv = process.argv.slice(2)
const argOf = (n, d) => { const i = argv.indexOf(n); return i >= 0 && argv[i + 1] ? argv[i + 1] : d }
const DRY = argv.includes('--dry')
const BRANCH = argOf('--branch', 'main')
const REPO_NAME = argOf('--repo', 'DSH-hanhua-mode')
const OWNER = argOf('--owner', '')
const MESSAGE = argOf('--message-file', '')
  ? readFileSync(argOf('--message-file'), 'utf8')
  : argOf('--message', 'chore: sync')

const git = (args) => execFileSync('git', args, { cwd: REPO, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }).trim()

// ── 凭据
function resolveToken() {
  for (const k of ['GH_TOKEN', 'GITHUB_TOKEN']) {
    if (process.env[k]) return process.env[k].trim()
  }
  const f = join(REPO, '.tools', 'gh-token.txt')
  if (existsSync(f)) {
    const t = readFileSync(f, 'utf8').trim()
    if (t) return t
  }
  try {
    const out = execFileSync('git', ['credential', 'fill'], {
      cwd: REPO,
      input: 'protocol=https\nhost=github.com\n\n',
      encoding: 'utf8',
      timeout: 120000,
      env: Object.assign({}, process.env, { GIT_TERMINAL_PROMPT: '0' }),
    })
    const m = /(?:^|\n)password=([^\n]+)/.exec(out)
    if (m) return m[1].trim()
  } catch (e) { /* 落到报错 */ }
  return null
}

const TOKEN = resolveToken()
if (!TOKEN) {
  console.error('未找到 GitHub 凭据：设置 GH_TOKEN/GITHUB_TOKEN、写 <repo>/.tools/gh-token.txt，或先让 git 登录 GitHub。')
  process.exit(2)
}
const H = { 'User-Agent': 'DSH-hanhua-mode-push', Accept: 'application/vnd.github+json', Authorization: 'token ' + TOKEN }

async function api(method, url, body) {
  const res = await fetch(url, { method, headers: Object.assign({}, H, body ? { 'Content-Type': 'application/json' } : {}), body: body ? JSON.stringify(body) : undefined })
  const text = await res.text()
  let json = null
  try { json = JSON.parse(text) } catch (e) {}
  if (res.status >= 400) {
    const m = (json && json.message) ? json.message : String(text).slice(0, 200)
    return { status: res.status, error: m, json }
  }
  return { status: res.status, json }
}

// git blob sha = sha1("blob <len>\0" + content)
const blobSha = (buf) => createHash('sha1').update(Buffer.concat([Buffer.from('blob ' + buf.length + '\0', 'utf8'), buf])).digest('hex')

async function main() {
  const me = await api('GET', 'https://api.github.com/user')
  if (me.status !== 200) { console.error('token 校验失败:', me.error); process.exit(1) }
  const owner = OWNER || me.json.login
  console.log('authenticated as:', me.json.login, '→', owner + '/' + REPO_NAME, '#' + BRANCH)

  const repoInfo = await api('GET', `https://api.github.com/repos/${owner}/${REPO_NAME}`)
  if (repoInfo.status !== 200) { console.error('仓库不存在或无权访问:', repoInfo.error); process.exit(1) }

  // 本地快照 = **HEAD 的 tree**（不是工作区内容）：
  //   · 推送的语义就是「把提交推上去」，未提交的改动不该被带上；
  //   · 直接复用 git 对象库里的 blob（`git cat-file`），避免行尾规范化差异
  //     （工作区是 CRLF、仓库里是 LF 的文件会让 tree sha 对不上）。
  const entries = git(['ls-tree', '-r', '-z', 'HEAD']).split('\0').filter(Boolean).map((entry) => {
    const tab = entry.indexOf('\t')
    const meta = entry.slice(0, tab).split(/ +/)
    return { mode: meta[0].startsWith('100') ? meta[0] : '100644', type: meta[1], sha: meta[2], path: entry.slice(tab + 1) }
  }).filter((e) => e.type === 'blob')
  const files = entries.map((e) => Object.assign({}, e, { buf: execFileSync('git', ['cat-file', 'blob', e.sha], { cwd: REPO, maxBuffer: 256 * 1024 * 1024 }) }))
  const localTree = git(['rev-parse', 'HEAD^{tree}'])
  console.log(`本地：HEAD tree=${localTree.slice(0, 12)}，${files.length} 个 blob`)

  // 远端现状
  let remoteCommit = null
  let remoteTree = null
  const ref = await api('GET', `https://api.github.com/repos/${owner}/${REPO_NAME}/git/ref/heads/${BRANCH}`)
  if (ref.status === 200) {
    remoteCommit = ref.json.object.sha
    const c = await api('GET', `https://api.github.com/repos/${owner}/${REPO_NAME}/git/commits/${remoteCommit}`)
    if (c.status === 200) remoteTree = c.json.tree.sha
    console.log(`远端：${BRANCH}=${remoteCommit.slice(0, 12)} tree=${(remoteTree || '').slice(0, 12)}`)
  } else {
    console.log(`远端：${BRANCH} 不存在（将创建分支）`)
  }
  if (remoteTree === localTree) {
    console.log('远端 tree 与本地 HEAD tree 完全一致 —— 内容已同步，无需推送。')
    return
  }

  // 远端 tree 清单（用于跳过未变化的 blob）
  const existing = new Map()
  if (remoteTree) {
    const t = await api('GET', `https://api.github.com/repos/${owner}/${REPO_NAME}/git/trees/${remoteTree}?recursive=1`)
    if (t.status === 200) for (const e of (t.json.tree || [])) if (e.type === 'blob') existing.set(e.path, e.sha)
  }

  if (DRY) {
    const changed = files.filter((f) => existing.get(f.path) !== f.sha)
    console.log(`[dry] 需要上传 ${changed.length} 个 blob（共 ${files.length} 个文件）`)
    for (const f of changed.slice(0, 20)) console.log('  ' + f.path)
    if (changed.length > 20) console.log(`  … 其余 ${changed.length - 20} 个`)
    return
  }

  // 上传远端还没有的 blob
  const tree = []
  let uploaded = 0
  for (const f of files) {
    let sha = existing.get(f.path)
    if (sha !== f.sha) {
      const r = await api('POST', `https://api.github.com/repos/${owner}/${REPO_NAME}/git/blobs`, { content: f.buf.toString('base64'), encoding: 'base64' })
      if (r.status !== 201) { console.error('blob 上传失败:', f.path, r.error); process.exit(1) }
      sha = r.json.sha
      uploaded++
    }
    tree.push({ path: f.path, mode: f.mode, type: 'blob', sha })
  }
  console.log(`blob：上传 ${uploaded} 个，复用 ${files.length - uploaded} 个`)

  const t = await api('POST', `https://api.github.com/repos/${owner}/${REPO_NAME}/git/trees`, { tree })
  if (t.status !== 201) { console.error('建 tree 失败:', t.error); process.exit(1) }
  if (t.json.sha !== localTree) {
    console.warn(`警告：远端 tree(${t.json.sha.slice(0, 12)}) 与本地 HEAD tree(${localTree.slice(0, 12)}) 不一致（可能因文件模式差异）`)
  } else {
    console.log(`tree 一致 ✅ ${t.json.sha.slice(0, 12)}（与本地 HEAD tree 相同）`)
  }

  const c = await api('POST', `https://api.github.com/repos/${owner}/${REPO_NAME}/git/commits`, {
    message: MESSAGE.replace(/\s+$/, ''),
    tree: t.json.sha,
    parents: remoteCommit ? [remoteCommit] : [],
  })
  if (c.status !== 201) { console.error('建 commit 失败:', c.error); process.exit(1) }
  console.log('commit:', c.json.sha)

  const u = remoteCommit
    ? await api('PATCH', `https://api.github.com/repos/${owner}/${REPO_NAME}/git/refs/heads/${BRANCH}`, { sha: c.json.sha, force: false })
    : await api('POST', `https://api.github.com/repos/${owner}/${REPO_NAME}/git/refs`, { ref: `refs/heads/${BRANCH}`, sha: c.json.sha })
  if (u.status !== 200 && u.status !== 201) { console.error('更新 ref 失败（可能有新提交，需先合并）:', u.error); process.exit(1) }
  console.log('PUSH DONE:', `https://github.com/${owner}/${REPO_NAME}/commit/${c.json.sha}`)
  console.log('提示：本地 HEAD 与远端 commit 的 sha 不同（远端由 API 生成），但 tree 相同 —— 内容一致。')
}

main().catch((e) => { console.error('FAILED:', e && e.message ? e.message : e); process.exit(1) })
