// 探针 B：直接按插件生成的**子进程脚本 + argv 布局**跑 node，验证
//   ① iconvLoad(argIndex) 的下标与实际 process.argv 顺序一致；
//   ② 候选清单可解析时 exitCode=0（不再 code=3 静默失败）；
//   ③ 候选清单全不可解析时确实 exitCode=3（负控）；
//   ④ 错误下标会导致 JSON.parse 抛异常（exitCode=1），与 0 不同 —— 说明下标必须精确；
//   ⑤ 「cwd=游戏目录 + 裸 require('iconv-lite')」在无 NODE_PATH 时 code=3，
//      加 NODE_PATH 后成功 —— 说明 iconvEnv() 的必要性。
// 子进程用 spawnSync + stdio:'inherit'（沙箱允许），stdout 不捕获。
import { spawnSync } from 'node:child_process'
import { readFileSync, writeFileSync, mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { createRequire } from 'node:module'

const NODE = process.execPath
const V = 'D:/Games/汉化模式/DSH-hanhua-mode/tests/.verify'
const WORK = join(V, 'iconv-probe')
rmSync(WORK, { recursive: true, force: true })
mkdirSync(WORK, { recursive: true })

const MODS = 'D:/Agent-windows/DeepSeekHarness/data/.dsh/profiles/node_modules'
const DSH_HOME = 'D:/Agent-windows/DeepSeekHarness/data/.dsh'
const requireFromProfiles = createRequire(MODS + '/_resolver.js')
const iconv = requireFromProfiles('iconv-lite')
console.log('探针侧 iconv-lite =', requireFromProfiles.resolve('iconv-lite'))

// ── 与插件完全一致的脚本片段（逐字复制自 preset/plugins/hanhua/index.js 与 engine/host.js）──
const iconvLoad = (argIndex) => 'let i=null;for(const s of JSON.parse(process.argv[' + argIndex + '])){try{i=require(s);break}catch(e){}}if(!i){process.exitCode=3;}'
const SCRIPT_BATCH = 'const fs=require("fs");' + iconvLoad(3)
  + 'else{const items=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));const frames=[];for(const it of items){const b=i.encode(it.t,it.e);const h=Buffer.alloc(4);h.writeUInt32LE(b.length);frames.push(h,b);}fs.writeFileSync(process.argv[2],Buffer.concat(frames));}'
const SCRIPT_BATCH_BADIDX = 'const fs=require("fs");' + iconvLoad(2)
  + 'else{const items=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));fs.writeFileSync(process.argv[2],"x");}'
const SCRIPT_LEGACY = 'const fs=require("fs");const pt=require("path");' + iconvLoad(4)
  + 'else{try{fs.mkdirSync(pt.dirname(process.argv[1]),{recursive:true});fs.writeFileSync(process.argv[1],i.encode(Buffer.from(process.argv[2],"base64").toString("utf8"),process.argv[3]));}catch(e){process.exitCode=2;}}'

const CAND_FULL = JSON.stringify([
  DSH_HOME + '/profiles/node_modules/iconv-lite',
  DSH_HOME + '/profiles/web/node_modules/iconv-lite',
  'iconv-lite',
])
const CAND_NONE = JSON.stringify(['no-such-module-a', 'no-such-module-b'])

const ITEMS = [
  { t: '你好，旅人。', e: 'shift_jis' },
  { t: '这是一条注释。', e: 'gbk' },
  { t: '欢迎来到村子。', e: 'shift_jis' },
]

const results = []
function run(label, args, opts, expect) {
  const r = spawnSync(NODE, args, { stdio: 'inherit', windowsHide: true, ...opts })
  const status = r.error ? 'ERR:' + r.error.code : r.status
  const ok = status === expect
  results.push({ label, status, expect, ok })
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${label}  status=${status} 期望=${expect}`)
  return status
}

// ── S1: iconvBatch 形状（argv = [node, in, out, candidates]，下标 3）──
const inFile = join(WORK, 'in.json')
const outFile = join(WORK, 'out.bin')
writeFileSync(inFile, JSON.stringify(ITEMS), 'utf8')
run('S1 iconvBatch 形状 iconvLoad(3) + 完整候选', ['-e', SCRIPT_BATCH, inFile, outFile, CAND_FULL], { cwd: WORK }, 0)
const bin = readFileSync(outFile)
let p = 0
let framesOk = true
const decoded = []
for (const it of ITEMS) {
  const len = (bin[p] | (bin[p + 1] << 8) | (bin[p + 2] << 16) | (bin[p + 3] << 24)) >>> 0
  p += 4
  const got = bin.subarray(p, p + len)
  p += len
  const want = iconv.encode(it.t, it.e)
  decoded.push({ t: it.t, e: it.e, len, bytesEq: Buffer.compare(Buffer.from(got), Buffer.from(want)) === 0, hex: Buffer.from(got).toString('hex') })
  if (!decoded[decoded.length - 1].bytesEq) framesOk = false
}
console.log('     帧解码 =', JSON.stringify(decoded, null, 0))
results.push({ label: 'S1b 帧内容与 iconv-lite 编码结果逐字节相等', status: framesOk, expect: true, ok: framesOk })
console.log(`[${framesOk ? 'PASS' : 'FAIL'}] S1b 帧内容与 iconv-lite 编码结果逐字节相等`)
console.log('     out.bin 总长 =', bin.length)

// ── S2: writeTextLegacy 形状（argv = [node, out, b64, enc, candidates]，下标 4）──
const legacyOut = join(WORK, 'legacy.ks')
const text = '[title name="レガシー"]\r\nこんにちは、世界。\r\n'
run('S2 writeTextLegacy 形状 iconvLoad(4) + 完整候选', ['-e', SCRIPT_LEGACY, legacyOut, Buffer.from(text, 'utf8').toString('base64'), 'shift_jis', CAND_FULL], { cwd: WORK }, 0)
const legacyBuf = readFileSync(legacyOut)
const wantLegacy = iconv.encode(text, 'shift_jis')
const legacyEq = Buffer.compare(legacyBuf, Buffer.from(wantLegacy)) === 0
results.push({ label: 'S2b legacy 文件字节 == iconv-lite shift_jis 编码', status: legacyEq, expect: true, ok: legacyEq })
console.log(`[${legacyEq ? 'PASS' : 'FAIL'}] S2b legacy 文件字节 == iconv-lite shift_jis 编码（len=${legacyBuf.length}）`)

// ── S3: 负控 —— 候选全不可解析 → 必须 code=3 ──
run('S3 负控 候选全不可解析 → code=3', ['-e', SCRIPT_BATCH, inFile, join(WORK, 'out3.bin'), CAND_NONE], { cwd: WORK }, 3)

// ── S4: 错误下标（iconvLoad(2) 配 iconvBatch 布局）→ JSON.parse 抛异常 code=1 ──
const s4 = run('S4 错误下标 iconvLoad(2) → 非 0 且非 3（JSON.parse 抛异常）', ['-e', SCRIPT_BATCH_BADIDX, inFile, join(WORK, 'out4.bin'), CAND_FULL], { cwd: WORK }, 1)

// ── S5: cwd=游戏目录 + 裸 'iconv-lite'，无 NODE_PATH → code=3（旧写法的失败模式）──
run('S5 裸候选 + 无 NODE_PATH（cwd 无 node_modules）→ code=3', ['-e', SCRIPT_BATCH, inFile, join(WORK, 'out5.bin'), JSON.stringify(['iconv-lite'])], { cwd: WORK, env: { ...process.env, NODE_PATH: '' } }, 3)

// ── S6: 同上但按 iconvEnv() 设置 NODE_PATH → code=0 ──
run('S6 裸候选 + NODE_PATH=profiles/node_modules → code=0', ['-e', SCRIPT_BATCH, inFile, join(WORK, 'out6.bin'), JSON.stringify(['iconv-lite'])], { cwd: WORK, env: { ...process.env, NODE_PATH: DSH_HOME + '/profiles/node_modules;' + DSH_HOME + '/profiles/web/node_modules' } }, 0)

const failed = results.filter((r) => !r.ok)
console.log(`\n===== 探针 B 结果：${results.length - failed.length}/${results.length} 通过 =====`)
process.exit(failed.length === 0 ? 0 : 1)
