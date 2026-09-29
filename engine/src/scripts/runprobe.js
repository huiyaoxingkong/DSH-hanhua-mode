/**
 * runprobe —— 在子进程里执行一个外部可执行文件并把 stdout/stderr 落到**普通文件**。
 *
 * 为什么需要它：DSH 沙箱下用管道捕获子进程输出会 EPERM（named pipe 不可用），
 * 而 skill/能力探测（ffmpeg -version、python -c、tesseract --version）需要读出文本。
 * 这里在 node 子进程内部用 spawnSync + **文件描述符**重定向（不是管道），
 * 因此两层沙箱都能用。
 *
 * 契约：node runprobe.js <in.json> <stdout.txt> <meta.json>
 *   in.json: { "exe": "<绝对路径或 PATH 里的名字>", "args": [...], "timeoutMs": n }
 *   stdout.txt: 子进程的 stdout + stderr（合并，截断到 200000 字符）
 *   meta.json: { ok: true, code, error }
 */
'use strict'

const fs = require('node:fs')
const cp = require('node:child_process')

const OUT_LIMIT = 200000

function main () {
  const inPath = process.argv[2]
  const stdoutPath = process.argv[3]
  const metaPath = process.argv[4]
  const meta = { ok: true, code: -1, error: null }
  try {
    const req = JSON.parse(fs.readFileSync(inPath, 'utf8'))
    const timeoutMs = Number(req.timeoutMs) > 0 ? Number(req.timeoutMs) : 60000
    let fd = null
    try {
      fd = fs.openSync(stdoutPath, 'w')
      const res = cp.spawnSync(req.exe, Array.isArray(req.args) ? req.args : [], {
        stdio: ['ignore', fd, fd],
        timeout: timeoutMs,
        windowsHide: true,
      })
      meta.code = res.status === null ? -1 : res.status
      if (res.error) meta.error = String(res.error.message || res.error)
    } finally {
      if (fd !== null) { try { fs.closeSync(fd) } catch (e) {} }
      // 超大输出截断，避免把 100MB 的日志搬回 host
      try {
        const st = fs.statSync(stdoutPath)
        if (st.size > OUT_LIMIT) {
          const fh = fs.openSync(stdoutPath, 'r')
          const buf = Buffer.alloc(OUT_LIMIT)
          fs.readSync(fh, buf, 0, OUT_LIMIT, 0)
          fs.closeSync(fh)
          fs.writeFileSync(stdoutPath, buf)
        }
      } catch (e) {}
    }
  } catch (e) {
    meta.ok = false
    meta.error = String((e && e.message) || e)
  }
  fs.writeFileSync(metaPath, JSON.stringify(meta), 'utf8')
}

main()
