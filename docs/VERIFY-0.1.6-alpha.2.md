# 独立验证报告：汉化模式 0.1.6-alpha.2 适配修复

- 验证对象：`DSH-hanhua-mode`（仓库 `D:\Games\汉化模式\DSH-hanhua-mode`，已安装副本 `D:\Agent-windows\DeepSeekHarness\data\.dsh\.agent-presets\hanhua\`）
- 目标内核：DSH 桌面封装 1.0.5 随包内核 **0.1.6-alpha.2**（`D:\Agent-windows\DeepSeekHarness\core`）
- 验证者：teammate `verifier`（独立验证，未采信任何结论摘要，全部命令自行重跑）
- 运行时：`D:\Agent-windows\DeepSeekHarness\runtime\node.exe`（**v24.16.0**）
- 验证时间：本轮修复后（仓库文件 mtime 2026/9/29 13:48 与 19:25）
- 写作范围：本文件 + `tests\.verify\` 下的临时脚本/输出（**未修改** `preset/`、`engine/`、`tests/` 任何既有文件）

> ### ⚠️ 产物在验证期间发生过变更（必读）
>
> 本轮验证**先**针对 `preset/plugins/hanhua/index.js` = `61562CE7…`（19:25:01 版，下称 **rev A**）完成；
> 验证进行中 lead 仍在修改并重新安装该文件（其间一度出现 **repo 与已安装副本不一致**：repo `54C0EAB2…` / installed `EBB76DA9…`），
> 随后统一为 **rev C** = `54C0EAB24362E33AD744FDE098A5BD91B6D9F611508256AB7CE593E43C40EEC0`（19:40:50）。
>
> 我因此把**全部探针在 rev C 上完整重跑了一遍**，并针对 rev C 新增的「`.bak` 写一次即固定」语义补了判别性测试（探针 I）。
> **结论：rev C 上 88 条断言全部通过，与 rev A 结论一致。** 复核记录见 **§10**。
> 报告正文默认描述 **rev C**；`agent.cordis.yml` 与 `preset.yml` 全程未变（哈希见 §3.4）。
>
> 提示 lead：由于产物在此次验证期间仍在变化，**最终交付前请冻结一次并再跑一遍 §8 的命令清单**（全部脚本化，约 2 分钟）。

---

## 0. 结论速览

| 编号 | 检查项 | 结果 |
|---|---|---|
| 1 | 修复前组合文件挂载失败 / 修复后 0 失败 | ✅ 通过 |
| 2 | 6 个预设健康状态 | ✅ 通过（且对 base 取值做了鲁棒性矩阵） |
| 3 | 真实 0.1.6 服务端到端 harness | ⚠️ 18/19，唯一失败项 = 沙箱 `spawn EPERM`（非代码缺陷）；见 §3.3 |
| 4 | 仓库/已安装副本哈希一致、`preset.yml` 未动 | ✅ 通过 |
| 5a | 组合文件对抗性检查 | ✅ 通过（12/12） |
| 5b | 插件注册契约（7 工具 / 6 服务 / `output.schema`） | ✅ 通过（13/13） |
| 5c | 两个 spawn 调用点带 `cwd`、两半一致、`iconvLoad` 下标 | ✅ 通过 |
| 5d | `iconvBatch` 定向覆盖（新增加） | ✅ 通过（探针 B 8/8 + 探针 C 28/28，其中 iconvBatch 专项 6 条） |
| 5e | 回归排查 | ✅ 未发现回归；发现 4 项非阻塞性问题（§6） |
| 5f | `.bak` 多轮导出（rev C 新增语义） | ✅ 通过（7/7，含判别性断言） |

**自建探针在最终版 rev C 上合计 88 条断言通过 / 0 条因产品缺陷失败**（另有 8 条「预期失败」用于记录 `DSH_HOME` 未设置时的降级行为，见 §5.7）。

**独立结论：本轮修复真实、必要且充分到「预设能在 0.1.6-alpha.2 下挂载并跑通全流程」的程度。**
三条修复线索全部被独立复现，其中的关键项（`prefix` 必填、`cwd` 必填）我用真实内核代码直接触发了修复前的报错原文。
但**「用户双击新建一个汉化模式会话能正常起来」这一步本会话无法直接验证**，只能由用户在真实 GUI 里新建会话确认（§7.1）；
另外**在线翻译 API 兜底在新内核下依然不可用**（§6 F4 / §7.3-1，已在源码层证实）。

---

## 1. 验证环境与方法

### 1.1 运行时与关键路径

```
node  : D:\Agent-windows\DeepSeekHarness\runtime\node.exe  → v24.16.0
内核  : D:\Agent-windows\DeepSeekHarness\core
服务实现 : D:\Agent-windows\DeepSeekHarness\data\.dsh\profiles\node_modules\@deepseek-ai\*
旧内核快照: D:\Agent-windows\deepseek_harness\.tmp-core-old-0.1.1-rc.2
DSH_HOME : D:\Agent-windows\DeepSeekHarness\data\.dsh   （实测本会话进程已存在该环境变量）
```

### 1.2 沙箱边界与「提权重试」未能执行（须明确记录）

任务书要求：harness 命令若因 `spawn EPERM` 失败，就在同一轮用 `sandbox_permissions=danger-full-access` 重试一次。

**本会话的实际约束（运行时上下文明确声明）：**
> `Approval prompts are disabled in this session: actions that require approval are rejected automatically — do not request sandbox escalation (do not set sandbox_permissions).`
> `You are a delegated subagent: your permission scope was fixed when you were started and cannot be widened from inside this session.`

因此**我没有执行 danger-full-access 重试**（会被自动拒绝，且规则明确禁止）。作为替代，我采用了两条互相印证的路径，覆盖同一批代码：

1. **边界取证**（探针 A/`probe-spawn.mjs`）：证明 `EPERM` 是沙箱对「Node 以管道方式 spawn 子进程」的限制，而不是插件缺陷；
2. **替身服务法**（探针 C/`harness-subst.mjs`）：把 `subprocess` 服务替换为 `spawnSync(stdio:'inherit')`，其余 `fs / sandboxPolicy / systemPrompt / tools / web` **全部是真实 0.1.6 实现**，从而让插件的 `writeBytes` / `writeTextLegacy` / `iconvBatch` 真实代码路径全部执行并落盘。

> 沙箱边界实测（`tests\.verify\probe-spawn.mjs`，原始输出）：
> ```
> spawnSync stdio=inherit => status=0 error=none
> spawnSync stdio=pipe    => status=null stdout="" error=EPERM
> spawnSync stdio=ignore  => status=0 error=none
> spawn stdio=pipe         => ASYNC-ERR EPERM
> spawn stdio=inherit      => close code=0
> ```

而 `dsh-subprocess-local` 的 runner **无论请求什么 stdio 都会建立管道 fd**，所以真实服务在沙箱内必然 EPERM：

```js
// data\.dsh\profiles\node_modules\@deepseek-ai\dsh-subprocess-local\lib\runner-launch-DGV26RBf.js:1380
function runnerStdio(spec, ipc, stdinCarrier = "pipe") {
	const targetStdio = [
		spec.stdio.stdin === "ignore" ? "ignore" : "pipe",     // ← 插件传 inherit，仍取 "pipe"
		spec.stdio.stdout === "inherit" ? "inherit" : "pipe",
		spec.stdio.stderr === "inherit" ? "inherit" : "pipe"
	];
```

**这一条必须写进残余风险：真实 `ctx.subprocess.spawn` 调用链在本会话内一次也没有成功执行过（只走到 EPERM）。**
它在真实桌面应用（无沙箱）里的行为，我只能用「真实内核的校验逻辑 + 替身 spawn 的插件代码路径」两侧夹逼来判定，不能算作直接实测。

### 1.3 原始输出留存

所有命令输出已 `Tee-Object` 存到 `DSH-hanhua-mode\tests\.verify\*.txt`，本报告引用均来自这些文件。

---

## 2. 逐项检查表

| # | 检查项 | 命令 | 期望 | 实测 | 结论 |
|---|---|---|---|---|---|
| 1a | 修复前组合文件 | `node tests/mount-check.mjs preset/agent.cordis.yml.before-v12` | 失败（有行挂不上） | `检查 24 行；2 行会挂载失败`，exit=1 | ✅ 符合 |
| 1b | 仓库组合文件 | `node tests/mount-check.mjs` | 0 失败 | `检查 27 行；0 行会挂载失败`，exit=0 | ✅ 通过 |
| 1c | 已安装副本 | `node tests/mount-check.mjs <installed>\agent.cordis.yml` | 0 失败 | `检查 27 行；0 行会挂载失败`，exit=0 | ✅ 通过 |
| 2 | 预设健康 | `$env:DSH_HOME=…; node tests/preset-health.mjs` | 6 个预设 healthy | `[healthy] standard/ptc/minimal/cordis/liangshen/hanhua` | ✅ 通过 |
| 2b | base 鲁棒性矩阵 | `node tests/.verify/probe-base.mjs` | `core/apps/cli[/lib]` 下 healthy | 2/5 个 base 下 standard+hanhua 同时 healthy；另 3 个 base 下**随包 standard 也一起 BROKEN** | ✅ 通过（见 §3.2） |
| 3 | 真实 0.1.6 端到端 | `node tests/harness.mjs --plugin <installed index.js>` | 全绿 | `18/19 通过`；唯一失败 = 4 个文件 `write: spawn EPERM` | ⚠️ 沙箱边界 |
| 4a | 副本哈希一致 | `Get-FileHash -Algorithm SHA256` | 4 文件 SAME | 4/4 `SAME`（含 yml、index.js、preset.yml、package.json） | ✅ 通过 |
| 4b | `preset.yml` 未动 | `git status` / `git diff HEAD -- preset/preset.yml` | 无改动 | 未出现在 modified 列表；diff 为空 | ✅ 通过 |
| 4c | `preset.yml` 无 roster `order` | `Select-String 'order'` | 无匹配 | `NO MATCH for 'order' in either preset.yml` | ✅ 通过 |
| 5a | persona/worker-thread/ptc 对抗检查 | `node tests/.verify/probe-static.mjs` | 12 条 | 12/12 PASS | ✅ 通过 |
| 5b | 注册契约 | `node tests/.verify/probe-registry.mjs` | 13 条 | 13/13 PASS | ✅ 通过 |
| 5c | cwd / 两半一致 / `iconvLoad` 下标 | 探针 A + E + D | — | 全部符合，见 §5.3 | ✅ 通过 |
| 5d | `iconvBatch` 定向覆盖 | 探针 B + C | 走通且非 code=3 | 8/8 + 28/28，`iconvBatch` 真实执行 `exitCode=0` 并落盘正确字节 | ✅ 通过 |
| 5e | 回归排查 | 探针 C' + G | 无回归 | 无回归；4 项非阻塞发现（§6） | ✅ 通过 |

---

## 3. 原始输出摘录

### 3.1 检查项 1 —— 修复前确实挂不上（两处硬失败）

```
> node tests\mount-check.mjs preset\agent.cordis.yml.before-v12
=== preset/agent.cordis.yml.before-v12 ===
FAIL  row "persona": config 校验失败 (@deepseek-ai/dsh-persona)
        - $.prefix missing required value (at prefix)
FAIL  row "workflow-worker-thread": 导入失败 @deepseek-ai/dsh-workflow-worker-thread — The requested module '@deepseek-ai/dsh-llm' does not provide an export named 'assertNever'

===== 检查 24 行；2 行会挂载失败 =====
[exit=1]
```
**失败行与原因**：① `persona` 行 —— 0.1.6 的 persona 插件 schema 把必填键从 `text` 改成 `prefix`，旧写法直接校验失败（这会让**整份预设**挂载失败）；② `workflow-worker-thread` 行 —— 其依赖的 `@deepseek-ai/dsh-llm` 不再导出 `assertNever`，`import` 即抛。

```
> node tests\mount-check.mjs
=== D:\Games\汉化模式\DSH-hanhua-mode\preset\agent.cordis.yml ===
===== 检查 27 行；0 行会挂载失败 =====
[exit=0]

> node tests\mount-check.mjs "D:\...\.agent-presets\hanhua\agent.cordis.yml"
=== D:\Agent-windows\DeepSeekHarness\data\.dsh\.agent-presets\hanhua\agent.cordis.yml ===
===== 检查 27 行；0 行会挂载失败 =====
[exit=0]
```

### 3.2 检查项 2 —— 6 个预设健康 + base 鲁棒性

```
> $env:DSH_HOME='D:\Agent-windows\DeepSeekHarness\data\.dsh'; node tests\preset-health.mjs
SHIPPED_PRESET_ROOT = D:\Agent-windows\DeepSeekHarness\core\packages\preset\agent-presets\presets\
user root           = D:\Agent-windows\DeepSeekHarness\data\.dsh\.agent-presets
...
===== 采用基准 D:/Agent-windows/DeepSeekHarness/core/apps/cli =====
[healthy] standard
[healthy] ptc
[healthy] minimal
[healthy] cordis
[healthy] liangshen
[healthy] hanhua

===== 逐 root 明细（harnessBase=core/apps/cli）=====
root system …\presets\ -> 4 个: standard, ptc, minimal, cordis
root user   …\.agent-presets -> 2 个: liangshen, hanhua
[exit=0]
```

`preset-health.mjs` 会自动挑选「随包 standard 健康」的 base，因此我额外做了 base 矩阵（探针 H），避免把结论建立在脚本的自动选择上：

```
base=D:/Agent-windows/DeepSeekHarness/core/apps/cli/       standard: healthy   hanhua: healthy
base=D:/Agent-windows/DeepSeekHarness/core/apps/cli/lib/   standard: healthy   hanhua: healthy
base=D:/Agent-windows/DeepSeekHarness/core/                standard: BROKEN(23 行)  hanhua: BROKEN(23 行)
base=D:/Agent-windows/DeepSeekHarness/data/.dsh/profiles/web/  standard: BROKEN(workflow-ptc)  hanhua: BROKEN(workflow-ptc)
base=D:/Agent-windows/DeepSeekHarness/data/.dsh/profiles/      standard: BROKEN(workflow-ptc)  hanhua: BROKEN(workflow-ptc)
```

`harnessBase` 就是应用自己的 `ctx.baseUrl`（源码：`agent-presets/src/index.ts:169-180`，`this.harnessBase = baseUrl`），
而桌面封装的启动入口可从 `logs\core.log` 调用栈确认为
`file:///D:/Agent-windows/DeepSeekHarness/core/apps/cli/lib/bin.js`：

```
logs\core.log:400: at async runCli (file:///D:/Agent-windows/DeepSeekHarness/core/apps/cli/lib/bin.js:146:4)
```

即在两个可信的 base 取值（`core/apps/cli/` 与 `core/apps/cli/lib/`）下 hanhua 都 healthy。
另外 3 个 base 下**随包 `standard` 也一起 BROKEN** —— 如果应用真用这些 base，整个应用都起不来，与用户「应用能跑、只是汉化模式不行」的现象矛盾。**结论：健康判定是稳健的，且 workflow-ptc 解析失败不是 hanhua 独有问题。**

### 3.3 检查项 3 —— 真实 0.1.6 服务端到端（18/19）

```
> node tests\harness.mjs --plugin "D:\...\.agent-presets\hanhua\plugins\hanhua\index.js" --work tests\.verify\work --keep
PASS  运行时装配：fs/sandboxPolicy/subprocess/systemPrompt/tools/web  — 真实 0.1.6-alpha.2 服务实现
PASS  插件模块导出 name/inject/apply  — name=hanhua-engine inject=[tools,systemPrompt,fs,web,sandboxPolicy,subprocess]
PASS  插件挂载（ctx.plugin）无异常
PASS  7 个 hanhua_* 工具注册到 tools 注册表  — 已注册 7 个
PASS  工具 schema 可投影给模型  — 模型可见 7 个 hanhua schema
PASS  systemPrompt 片段注册 + 组装渲染
PASS  提示词包含汉化工具指南片段  — 含 hanhua_scan 指南
PASS  hanhua_scan 返回文件清单  — total=4
parsed game_krkr/scenario/first.ks: 4 entries
parsed game_krkr/scenario/legacy.ks: 3 entries
parsed game_xp/Data/Map001.rxdata: 8 entries
parsed game_xp/Data/System.rxdata: 8 entries
PASS  hanhua_parse 提取条目  — total=23 errors=0
PASS  hanhua_glossary 写入词典  — total=65
PASS  hanhua_translate 完成（无 API Key 时走词典/缓存）  — total=23 methods={"glossary":13,"skip":3,"passthrough":7}
PASS  hanhua_qa 返回质检结果  — total=23 issues=5
      · export: {"total":4,"ok":0,"results":[{"file":"game_krkr/scenario/first.ks","ok":false,"error":"write: spawn EPERM"}, …]}
PASS  hanhua_export inplace 执行  — total=4 ok=0
FAIL  全部文件导出成功，且每个 .bak 等于原始字节  — … err=write: spawn EPERM（4 个文件）
PASS  UTF-16LE 的 .ks 导出后保持 BOM/编码与 KAG 结构
PASS  Shift-JIS 的 legacy.ks 导出后保持原编码（iconv-lite 可用）
PASS  game_xp/Data/Map001.rxdata 保持 Marshal 结构…
PASS  game_xp/Data/System.rxdata 保持 Marshal 结构…

===== 结果：18/19 通过 =====
[exit=1]
```

**注意**：该命令用的是 `--work tests\.verify\work`（我自己的临时目录），不是默认的 `tests\.work` —— 目的是不覆盖 lead 之前跑出的 `tests\.work` 证据。除工作目录外参数与测试意图完全一致。

导出失败全部是同一原因，且**是写盘前失败**：`state.translated` 已生成、4 个文件的原始字节未被触碰。

### 3.4 检查项 4 —— 哈希与 `preset.yml`

> 下表的 `index.js` 行是 **rev A**（19:25）时的实测；rev C 的复核见 §10.2，结论同为 4/4 `SAME`，且 `preset.yml` 前后哈希一致。

```
[SAME] agent.cordis.yml
    repo: 4856DD2F017D0B480CE365D663B3C04B252E994624245315CF04D05F80F81DA9
    inst: 4856DD2F017D0B480CE365D663B3C04B252E994624245315CF04D05F80F81DA9
[SAME] plugins/hanhua/index.js
    repo: 61562CE781AEDE4474E27BD05E3434874F83BBE0F9771FF43792772F5E804B8A
    inst: 61562CE781AEDE4474E27BD05E3434874F83BBE0F9771FF43792772F5E804B8A
[SAME] preset.yml
    repo: FCAEE870323E2FA5C8B0E6DACE61F46E69103B893775AA687FB369A0994698CF
    inst: FCAEE870323E2FA5C8B0E6DACE61F46E69103B893775AA687FB369A0994698CF
[SAME] plugins/hanhua/package.json
    repo: 765F83B854D485014D645FB90563F546E3E0B6C3981084675C34F87EC1BC517E
    inst: 765F83B854D485014D645FB90563F546E3E0B6C3981084675C34F87EC1BC517E

########## preset.yml 是否含 order ##########
NO MATCH for 'order' in either preset.yml
```

`preset.yml` 原文（保持原样，仅 `name` + `description`）：
```yaml
name: 汉化模式
description: 游戏汉化专家模式：扫描解析、词典优先翻译（可选在线 API 兜底）、QA 质检与安全导出的一体化引擎，支持 JSON/CSV/PO/INI/YAML/RenPy 与 RPG Maker MV/MZ。
```
git 侧（`git -c safe.directory=… status --porcelain`）：`preset/preset.yml` **不在** modified 列表；`git diff HEAD -- preset/preset.yml` 为空。

### 3.5 修复 ② 的额外取证：组合文件确实由随包 standard 派生

把已安装组合文件与随包 `standard\agent.cordis.yml` 逐行比较，**仅 9 行差异**，全部是「persona 覆写 + 汉化插件行」：

```
差异行数: 9  ("<=" = 仅随包 standard 有; "=>" = 仅 hanhua 有)
=>|     suffix: 工作目录 {{cwd}} 是游戏汉化项目根目录。先用 hanhua_scan/hanhua_parse 摸清文本，再动 hanhua_export 写回。
=>|       你是「汉化模式」游戏本地化专家 Agent，由 {{model}} 驱动。核心流程：…
=>| 
=>| # ── 汉化引擎（本地插件包） ─────────────────────────────
=>| # 消费 host 的 tools/systemPrompt/fs/web/sandboxPolicy/subprocess 服务，不提供任何服务，无需 isolate realm。
=>| - id: hanhua-engine
=>|   name: ./plugins/hanhua/index.js
<=|     suffix: Your working directory is {{cwd}}.
<=|       You are a coding agent powered by the {{model}} model.

standard: 266 行 ; hanhua: 271 行
```

即：组合文件 = 随包 standard（26 行可挂载行）+ persona 覆写 + `hanhua-engine` 行（共 27 行）。
`workflow-worker-thread` 行在 0.1.6 的 standard 里已被 `workflow-ptc` 取代，派生后自然消失。

---

## 4. 新增覆盖：`iconvBatch` 定向测试（任务书 5d）

默认夹具（`test-fixtures`）的 RGSS 字符串是全 ASCII，`exportRgssFile` 里
`legacy = pending.filter(编码 ∉ {utf-8, latin1, utf-16le, utf-16be})` 恒为空，**`iconvBatch` 永远不会被调用**。
我因此自建了 Shift-JIS 的 RGSS 夹具（`tests\.verify\make-sjis-fixtures.mjs` → `Map002.rxdata`），
并且**用一个踩坑记录换来了一个可用夹具**：

> 第一次我把文件命名成 `Sjis.rxdata`，解析出 **0 条** —— `extractRgss` 只对 `/^Map\d{3}\./i` 的文件名走地图分支
> （`preset/plugins/hanhua/index.js:582`）。改名 `Map002.rxdata` 后解析出 8 条。
> 这不是缺陷，是使用约束：**RPG Maker 的地图文件必须叫 `MapNNN.*` 才会被汉化引擎识别**。

### 4.1 探针 B：子进程脚本 + argv 布局的直接验证（8/8）

脚本与候选清单**逐字复制**自插件源码，用 `spawnSync(stdio:'inherit')` 直接跑 `node -e <script> …`：

```
探针侧 iconv-lite = D:\...\core\node_modules\raw-body\node_modules\iconv-lite\lib\index.js
[PASS] S1 iconvBatch 形状 iconvLoad(3) + 完整候选  status=0 期望=0
     帧解码 = [{"t":"你好，旅人。","e":"shift_jis","len":11,"bytesEq":true,"hex":"3f8d44814397b7906c8142"},
               {"t":"这是一条注释。","e":"gbk","len":14,"bytesEq":true,"hex":"d5e2cac7d2bbccf5d7a2cacda1a3"},
               {"t":"欢迎来到村子。","e":"shift_jis","len":13,"bytesEq":true,"hex":"3f8c7d9788939e91ba8e718142"}]
[PASS] S1b 帧内容与 iconv-lite 编码结果逐字节相等
     out.bin 总长 = 50
[PASS] S2 writeTextLegacy 形状 iconvLoad(4) + 完整候选  status=0 期望=0
[PASS] S2b legacy 文件字节 == iconv-lite shift_jis 编码（len=45）
[PASS] S3 负控 候选全不可解析 → code=3  status=3 期望=3
[PASS] S4 错误下标 iconvLoad(2) → 非 0 且非 3（JSON.parse 抛异常）  status=1 期望=1
[PASS] S5 裸候选 + 无 NODE_PATH（cwd 无 node_modules）→ code=3  status=3 期望=3
[PASS] S6 裸候选 + NODE_PATH=profiles/node_modules → code=0  status=0 期望=0

===== 探针 B 结果：8/8 通过 =====
```

关键结论：
- **`iconvBatch` 的批量路径不再 code=3**：候选清单可解析时退出码 0，且 4 字节长度帧 + 编码字节与 iconv-lite 输出逐字节相等。
- S3 是负控（证明 code=3 仍然会在真的找不到 iconv 时出现，不是被吞掉）；S5 复现了「裸 `require('iconv-lite')` + cwd 无 node_modules」的旧失败模式（code=3）；S6 证明 `iconvEnv()` 的 `NODE_PATH` 确实能救回它。

### 4.2 探针 C：让插件**真实代码**跑完整流程（28/28）

`subprocess` 换成 `spawnSync` 替身，其余服务全部真实；夹具 = 默认 4 个 + 自建 Shift-JIS `Map002.rxdata`。

```
PASS  hanhua_scan 发现 5 个文件（含 Shift-JIS 的 Map002.rxdata）
parsed game_xp/Data/Map002.rxdata: 8 entries          ← Shift-JIS 串被正确解码
PASS  hanhua_translate 完成  — total=31 methods={"glossary":20,"skip":3,"passthrough":8}
--- 开始 hanhua_export（应触发 iconvBatch + writeTextLegacy）---
      · spawn cwd=…\work-subst\project args=3 exit=0      ← iconvBatch（in/out/candidates）
      · spawn cwd=…\work-subst\project args=4 exit=0      ← writeTextLegacy（out/b64/enc/candidates）
      export = {"total":5,"ok":5, …}
PASS  hanhua_export 全部成功  — total=5 ok=5
PASS  5 个文件的 .bak 都等于导出前原始字节  — 全部 bak==原字节=true
PASS  Map002.rxdata 含 iconv(shift_jis) 编码后的词典译文 @name  — 期望字节 88a23f93494850 出现=true
PASS  Map002.rxdata 原文日文串已被替换（不再是原字节）  — 原字节仍存在=false
PASS  legacy.ks 被 writeTextLegacy 改写（字节已变）  — len 73 → 66
PASS  legacy.ks 含 iconv(shift_jis) 编码后的词典译文  — 期望字节 3f8d44814390a28a458142 出现=true
PASS  legacy.ks 仍是合法 shift_jis（无 U+FFFD，KAG 结构保持）
PASS  每一次 subprocess.spawn 都带非空 cwd  — 11/11
PASS  每次 spawn 的 cwd 都等于项目根目录
PASS  iconvBatch 被真实执行（argv 含 .hanhua-iconv.in.json）  — 次数=1
PASS  iconvBatch spawn exitCode = 0（iconv-lite 装载成功，未 code=3）
PASS  iconvBatch 第 3 个参数（下标 3）= 候选清单 JSON
PASS  iconvBatch argv 长度=3（in/out/candidates）  — len=3
PASS  writeTextLegacy 被真实执行（4 参数，末参数=候选清单）  — 次数=1 exitCodes=0
PASS  writeTextLegacy 全部 exitCode = 0

===== 探针 C 结果：28/28 通过 =====
spawn 次数 = 11  → tests/.verify/spawn-log.json
```

原始 spawn 日志（`tests\.verify\spawn-log.json` 摘录）证明 `cwd` 与候选清单同时正确：

```json
{ "hasCwd": true, "cwd": "D:\\Games\\汉化模式\\DSH-hanhua-mode\\tests\\.verify\\work-subst\\project",
  "argvAfterEval": ["D:\\…\\project\\.hanhua-iconv.in.json", "D:\\…\\project\\.hanhua-iconv.bin",
                    "[\"D:\\\\Agent-windows\\\\DeepSeekHarness\\\\data\\\\.dsh/profiles/node_modules/iconv-lite\", …]"],
  "exitCode": 0, "graceMs": 60000 }
```

### 4.3 探针 G：回写产物再解析（结构未破坏）

```
scan.total = 5
parse.total = 31  errors = []
perFile = {"game_krkr/scenario/first.ks":4,"game_krkr/scenario/legacy.ks":3,"game_xp/Data/Map001.rxdata":8,"game_xp/Data/Map002.rxdata":8,"game_xp/Data/System.rxdata":8}
PASS  回写后再解析 0 错误（Marshal/编码流仍可读）
PASS  5 个文件条目数全部与导出前一致
===== 探针 G：6/6 通过 =====
```

---

## 5. 对抗性检查明细（任务书 5a–5e）

### 5a 组合文件（探针 E，12/12）

```
PASS  persona 行只出现一次  — 次数=1
PASS  persona 行使用 prefix 键  — prefix 长度=262
PASS  persona 行存在 suffix 键  — suffix 长度=77
PASS  persona 行不存在 text 键  — 键=suffix,prefix
PASS  persona prefix 含「汉化模式」标识
PASS  对照 before-v12：persona 用 text 且无 prefix  — 键=text
PASS  组合文件不含 workflow-worker-thread 行  — 命中=0
PASS  组合文件不含 workflow-worker-thread 文本
PASS  组合文件含 workflow-ptc 行  — 次数=1 name=@deepseek-ai/dsh-workflow-ptc
PASS  workflow-ptc 指向 @deepseek-ai/dsh-workflow-ptc
PASS  组合文件含 hanhua-engine 行（挂载本地插件）  — name=./plugins/hanhua/index.js
```
（第 12 条见 5c）

### 5b 注册契约（探针 F，13/13）

```
PASS  name = hanhua-engine
PASS  inject 恰好 6 个服务名  — [tools,systemPrompt,fs,web,sandboxPolicy,subprocess]
PASS  inject 名单与期望完全一致
PASS  hanhua_scan  已注册且 output.schema.type='string'  — output.schema={"type":"string"}
PASS  hanhua_parse / hanhua_translate / hanhua_qa / hanhua_glossary / hanhua_export / hanhua_config （同上）
PASS  模型可见的 hanhua_* schema = 7  — [hanhua_scan,…,hanhua_config]
PASS  7 个工具 parameters 都是 object + additionalProperties:false
```

### 5c `cwd` / 两半一致 / `iconvLoad` 下标

**(1) 缺 `cwd` 确实会在 0.1.6 抛错，且旧内核容忍**（探针 A，真实内核实现，未 spawn 成功即可判定）：

```
resolveExecutable("node") = D:\Agent-windows\DeepSeekHarness\runtime\node.EXE

===== 0.1.6-alpha.2：不传 cwd =====
[new/no-cwd] spawn() 同步抛错 => TypeError: Cannot read properties of undefined (reading 'includes')  (0ms)
===== 0.1.6-alpha.2：传 cwd（插件现在的做法）=====
[new/with-cwd] spawn() 同步抛错 => Error: spawn EPERM  (12ms)
===== 0.1.1-rc.2（旧内核）：不传 cwd =====
[old/no-cwd] spawn() 同步抛错 => Error: spawn EPERM
```

**结论**：新版把 `cwd` 交给了 `validateNoNullByte("options.cwd", spec.cwd)`（`runner-launch-DGV26RBf.js:1504-1516`），
`undefined.includes` 即上表的 TypeError —— 与插件注释里的报错原文**完全一致，可确认为真实原因**；
旧内核是 `spawn(program, args, { cwd: spec.cwd })`（旧快照 `subprocess-local/lib/index.js:797-798`），`cwd: undefined` 由 Node 兜底，所以旧版不需要 `cwd`。
→ **`cwd` 修复是新内核下的必要修复。**
（本会话无法让 spawn 真正成功，`with-cwd` 只走到 EPERM，见 §1.2。）

**(2) 两个 spawn 调用点都带 `cwd`，两半代码一致**（探针 E）：

```
PASS  preset 插件 2 个 spawn 调用点都带 cwd  — spawn=2 cwd=2
PASS  engine/host.js 2 个 spawn 调用点都带 cwd  — spawn=2 cwd=2
PASS  两半都能定位到子进程辅助代码块  — plugin=88 行 host=92 行
PASS  两半子进程辅助代码（去注释、去 ctx. 访问写法）行集合完全一致  — plugin=79 行 host=79 行
[NOTE] 声明顺序：内容相同但声明顺序不同——host 把 nodeSpawn 放在 ICONV_CANDIDATES 之前；
       两者都是 function/const 声明且仅在调用期引用，无 TDZ 问题，运行期已实测通过
PASS  关键行两半一致：{ argv: [node, '-e', script].concat(args), cwd: spawnCwd(), … }
PASS  关键行两半一致：const iconvLoad = (argIndex) => …
PASS  关键行两半一致：const script = 'const fs=require("fs");const pt=require("path");' + iconvLoad(4)
PASS  关键行两半一致：'const fs=require("fs");' + iconvLoad(3)
PASS  关键行两半一致：JSON.stringify(ICONV_CANDIDATES())], cwd: spawnCwd(),
```

**(3) `iconvLoad` 下标推演（先推演、后实测）**

Node 对 `-e` 的 argv 布局是 `[node, ...用户参数]`（**没有脚本路径**），实测：

```
> node -e "console.log(JSON.stringify(process.argv))" a b c d
["D:\\Agent-windows\\DeepSeekHarness\\runtime\\node.exe","a","b","c","d"]
```

推演：

| 调用点 | `spec.argv` | `process.argv` | 候选清单应取 | 源码写的 | 判定 |
|---|---|---|---|---|---|
| `writeTextLegacy` | `[node,'-e',script, outPath, b64, enc, cands]` | `[node, outPath, b64, enc, cands]` | 下标 **4** | `iconvLoad(4)` | ✅ 一致 |
| `iconvBatch` | `[node,'-e',script, in, out, cands]` | `[node, in, out, cands]` | 下标 **3** | `iconvLoad(3)` | ✅ 一致 |

同一张表也解释了节点脚本里的 `process.argv[1]/[2]/[3]` 为什么分别对应 `outPath/b64/encoding`（S1/S2 实测 status=0，S4 用错误下标得到 status=1，反证下标必须精确）。

**(4) section order 实测位置**（探针 D，6/6）：

```
内核自带档位：MCP_SERVERS = 3100 ; TOOLS_SDK = 5000 ; TOOL_PWSH = 1010 ; DEPLOYMENT_PERSONA_PREFIX = 0

===== assemble() 后的 section 排序 =====
    0  harness:identity
    1  deployment:persona-prefix
    2  probe:old-order-115          ← 对照：旧值 115
    3  probe:first-party-guide      ← 第一方工具指南（order=1000）
    4  tool:hanhua                  ← 插件（order=3200）
    5  deployment:persona-suffix    ← order=10200

[PASS] 插件 section 名 = tool:hanhua
[PASS] 3200 在所有第一方工具指南(≤3100)之后
[PASS] 3200 在 TOOLS_SDK(5000) 之前
[PASS] 3200 在 persona 后缀(10200) 之前
[PASS] 旧值 115 会排在第一方工具指南(1000)之前（说明旧值确实错位）
[PASS] 渲染出的提示词含汉化指南
===== 探针 D：6/6 通过 =====
```

内核 0.1.6-alpha.2 的档位表（`dsh-system-prompt/lib/index.js:10-44`）：
`TOOL_*` 1000–3000、`MCP_SERVERS` 3100、`TOOLS_SDK` 5000、`DELIVERABLE_FILE_REFERENCES` 9000 …
→ `3200` 落在「第一方工具指南之后、TOOLS SDK 之前」，**位置正确**；`115` 确实会掉到最前。

### 5d

见 §4。

### 5e 回归排查

| 排查点 | 命令/探针 | 结果 |
|---|---|---|
| 写回内容是否被改变语义 | 探针 C + G | ✅ 5 个文件全部成功、重解析 0 错误、条目数不变；UTF-16LE BOM/KAG 结构、Marshal `04 08` 头、Shift-JIS 编码均保持 |
| `.bak` 是否等于原字节 | 探针 C | ✅ 5/5 `bak==原字节=true`（含 Shift-JIS 与 Marshal 文件） |
| 失败路径是否留下半成品 | 探针 C'（无 DSH_HOME） | ✅ 安全的失败模式：`Map002.rxdata` 在 iconvBatch 抛错时**未改动、也未生成 .bak**；`legacy.ks` 的 .bak 已建但正文未动 |
| `DSH_HOME` 未设置时的候选清单 | 探针 C' | ⚠️ 见下 |
| 两半是否漂移 | 探针 E | ✅ 79 行代码集合完全一致 |

`DSH_HOME` 未设置时（探针 C'，`Remove-Item Env:DSH_HOME`）：

```
      · spawn cwd=… args=4 exit=3      ← writeTextLegacy：iconv 装载失败
      · spawn cwd=… args=3 exit=3      ← iconvBatch：iconv 装载失败
      export = {"total":5,"ok":3,"results":[
        {"file":"game_krkr/scenario/legacy.ks","ok":false,"error":"write: node 子进程失败 code=3"},
        {"file":"game_xp/Data/Map002.rxdata","ok":false,"error":"iconv 批量编码失败 code=3"}, …]}
FAIL  hanhua_export 全部成功  — total=5 ok=3
```
候选清单退化为 `["iconv-lite"]`（日志实测）。
**判定：这是明确的降级告警，不是静默失败** —— 错误进 `results[].error`、文件不被破坏。
且真实环境里 `DSH_HOME` 是存在的（本会话进程 `DSH_HOME=D:\Agent-windows\DeepSeekHarness\data\.dsh`，插件与该进程同环境），
再加上 `hanhua_config iconvPath` 的显式兜底，此风险为**低**。

---

## 6. 发现的不一致 / 异常（均非阻塞，无一是本轮修复引入的回归）

| # | 发现 | 证据 | 严重度 | 建议 |
|---|---|---|---|---|
| F1 | `iconvBatch` 会把两个临时文件留在**游戏根目录**且不清理：`.hanhua-iconv.in.json`（209B）、`.hanhua-iconv.bin`（70B） | 导出后 `Get-ChildItem -Force …project` 实测仍存在 | 低 | 导出收尾时删除，或改放到 `.hanhua-out/`、系统临时目录 |
| F2 | Shift-JIS 游戏写回中文会被 iconv 替换成 `?`（0x3f）：目标串用**源编码**编码，而 shift_jis 无法表示简体中文 | 探针 B 帧 hex `3f8d44814397b7906c8142`；探针 C `legacy.ks` 解出 `"?好，世界。"` | 中（**产品局限，非本轮引入**） | 明确文档化：JP 游戏（shift_jis）只能保留日文假名/符号；中文汉化应走 GBK 编码的游戏或设置 `rgssEncoding/krkrEncoding` |
| F3 | `DSH_HOME` 未设置时 GBK/Shift-JIS 回写失败 | 探针 C'（`code=3`） | 低 | 已有显式报错 + `iconvPath` 兜底；可考虑再加进程 `execPath` 相对路径候选 |
| F4 | **在线翻译 API 兜底仍不可用**：插件按 POST 调用，而 0.1.6 的 fetch 只支持 URL/GET | `WebFetchRequest { readonly url: string }`（`dsh-web/lib/types/types.d.ts:59-61`）；provider 里 `method: "GET"` 硬编码（`dsh-web-fetch-http/lib/index.js:162,196`） | 中（既有局限，本轮未声称修复） | 需要另找 HTTP 通道（如自建 provider / 本地代理）才能实现 API 兜底 |
| F5 | 仓库 `tests/harness.mjs` 的断言「Marshal 长度不缩水」是启发式：合法翻译会让字符串变短 | 探针 C 实测 `Map001.rxdata` 545 → 544 字节（`"Welcome to the Village."` → `"Welcome to the 村庄."` 少 1 字节） | 提示 | 建议改断言为「`04 08` 头 + 能重新解析」而不是长度单调 |
| F6 | `spawnCwd()` 在 `state.root` 未设置时返回相对路径 `'.'` | `preset/plugins/hanhua/index.js:172-175` | 极低（`export` 必然先有 root） | 可留作已知边界 |

**对任务书背景事实的核对**：三条修复线索与我的实测**完全一致**，无需修正。
唯一需要澄清的是「已安装组合文件由新版随包标准预设派生」——我把它从「陈述」升级为**证据**：与 `standard\agent.cordis.yml` 仅 9 行差异（§3.5）。

---

## 7. 未能验证 / 残余风险

### 7.1 真实桌面应用内「新建汉化模式会话」的挂载 —— **只能由用户确认**（最高残余风险）

我能证明到的最远处：真实内核的 `mount-check`（逐行解析 + Config 校验）0 失败、真实 `discoverPresets` 报 healthy、
以及用真实服务把插件真挂起来跑通全流程。**但「GUI 里选汉化模式 → 会话真的起来 → 工具在提示里出现」这一步没有实测**，
因为那需要用户在自己的界面里新建会话（我不能也不应代替用户开新会话）。

风险已经缩到很小，理由是：
- `harnessBase` 的两个可信取值（`core/apps/cli/`、`core/apps/cli/lib/`）下 hanhua 都 healthy，且**随包 standard 同样 healthy**（自洽）；
- 组合文件仅比随包 standard 多出 persona 覆写与一行本地插件；
- 插件本身用真实服务挂载、注册 7 工具、渲染提示词全部通过。

**用户侧确认方法**（30 秒）：在 GUI 新建会话 → 选「汉化模式」→ 看左侧工具列表里是否有 7 个 `hanhua_*`；
若有，则本修复闭环。

### 7.2 真实 `ctx.subprocess.spawn` 全链路未被真实执行

受沙箱限制（§1.2），真实的 `LocalSubprocessRuntime.spawn` 一次都没能成功拉起子进程。
我用「真实内核校验逻辑 + 替身 spawn 的插件代码路径」两侧夹逼替代。
**未被直接覆盖的是 DSH runner 自身的封装行为**（Windows Job 对象、`runnerStdio`、`handle.done` 的 exitCode 归一化）——
不过 `handle.done` 的形状我是按 `spawnSync().status` 对齐的，且 `nodeSpawn` 只消费 `done.exitCode`。

### 7.3 其它残余风险

1. **在线 API 兜底不可用**（F4，已源码证实）—— 翻译质量依赖词典/缓存，未配置 API 时大量条目为 `passthrough`（本次实测 `methods={"glossary":20,"skip":3,"passthrough":8}`）。
2. **组合文件依赖 `workflow-ptc` 行**：若该包在用户环境的解析基准下不可用，则**随包 standard 也一起挂不上**（§3.2）。这不是 hanhua 的问题，但会成为「所有模式都不可用」的连带故障，值得向用户提示。
3. **JP 游戏（shift_jis）中文写回失真**（F2）。
4. **临时文件残留**（F1）。
5. `mount-check.mjs` 是「行名解析 + Config 校验」的复刻，不是 Cordis Loader 本体；真实 loader 还做 realm/isolate 校验等，本报告未覆盖那部分（`preset-health.mjs` 走的是真实 discovery，算是部分补位）。

---

## 8. 复现命令清单

```powershell
$node = 'D:\Agent-windows\DeepSeekHarness\runtime\node.exe'
$repo = 'D:\Games\汉化模式\DSH-hanhua-mode'
$inst = 'D:\Agent-windows\DeepSeekHarness\data\.dsh\.agent-presets\hanhua'
$env:DSH_HOME = 'D:\Agent-windows\DeepSeekHarness\data\.dsh'
Set-Location $repo

# 1) 挂载检查
& $node tests\mount-check.mjs preset\agent.cordis.yml.before-v12     # 期望 exit=1，2 行失败
& $node tests\mount-check.mjs                                        # 期望 27 行 0 失败
& $node tests\mount-check.mjs "$inst\agent.cordis.yml"               # 期望 27 行 0 失败

# 2) 预设健康（+ base 鲁棒性矩阵）
& $node tests\preset-health.mjs
& $node tests\.verify\probe-base.mjs

# 3) 真实 0.1.6 端到端（唯一失败项应为沙箱 spawn EPERM）
& $node tests\harness.mjs --plugin "$inst\plugins\hanhua\index.js" --work "$repo\tests\.verify\work" --keep

# 4) 哈希一致性
Get-FileHash "$repo\preset\agent.cordis.yml","$inst\agent.cordis.yml" -Algorithm SHA256
Get-FileHash "$repo\preset\plugins\hanhua\index.js","$inst\plugins\hanhua\index.js" -Algorithm SHA256

# 5) 自建探针
& $node tests\.verify\probe-spawn.mjs      # 沙箱边界
& $node tests\.verify\probe-cwd.mjs        # 缺 cwd 在新版抛 TypeError、旧版不抛
& $node tests\.verify\make-sjis-fixtures.mjs
& $node tests\.verify\probe-iconv.mjs      # iconv 子进程脚本 + argv 下标（8/8）
& $node tests\.verify\probe-static.mjs     # 组合文件 + 两半一致（20/20）
& $node tests\.verify\probe-registry.mjs --plugin "$inst\plugins\hanhua\index.js"   # 13/13
& $node tests\.verify\probe-order.mjs      --plugin "$inst\plugins\hanhua\index.js"  # 6/6
& $node tests\.verify\harness-subst.mjs    --plugin "$inst\plugins\hanhua\index.js"  # 28/28（含 iconvBatch）
& $node tests\.verify\probe-reparse.mjs                                             # 6/6
& $node tests\.verify\probe-backup-twice.mjs --plugin "$inst\plugins\hanhua\index.js" # 7/7（.bak 写一次即固定）

# 先固定「被验证的版本」：记录哈希，供事后核对
Get-FileHash "$repo\preset\plugins\hanhua\index.js","$inst\plugins\hanhua\index.js" -Algorithm SHA256
# 本报告最终复核版本（rev C）：54C0EAB24362E33AD744FDE098A5BD91B6D9F611508256AB7CE593E43C40EEC0

# 5e) DSH_HOME 未设置时的降级（预期：3/5 成功、2 个 legacy 文件显式 code=3 且不损坏）
Remove-Item Env:DSH_HOME
& $node tests\.verify\harness-subst.mjs --plugin "$inst\plugins\hanhua\index.js" --work "$repo\tests\.verify\work-nodsh"
```

---

## 9. 独立结论

1. **「0.1.6-alpha.2 下汉化模式不可用」是真的，且本轮修复确实解决了它。**
   - 修复前：`mount-check` 在 `persona`（`$.prefix missing required value`）与 `workflow-worker-thread`（`assertNever` 导出缺失）两行硬失败 —— 任一行失败都足以让整份预设挂不上，与用户现象吻合。
   - 修复后：仓库与**已安装副本**均 `27 行 0 失败`，真实 `discoverPresets` 报 healthy，真实 0.1.6 服务下插件能挂载、注册 7 个工具、组装系统提示词，并跑通 scan→parse→glossary→translate→qa→export 全流程（导出部分用替身 spawn 实测落盘 5/5、`.bak` 逐字节等于原文件）。
   - 三项具体修复都被独立复现其**必要性**：`prefix` 是 0.1.6 的必填键；`cwd` 在 0.1.6 会因 `validateNoNullByte(undefined)` 抛 `Cannot read properties of undefined (reading 'includes')` 而旧内核不会（我用真实内核代码复现了这条报错原文）；`iconvLoad` 的两个下标与实际 `process.argv` 布局精确一致，`iconvBatch` 批量路径由 code=3 静默失败变为 exitCode=0 且字节正确。

2. **修复引入的回归：我没有找到。** 两半实现代码集合一致（79 行），`.bak` 逐字节等于原字节，回写后文件结构（Marshal `04 08`、UTF-16LE BOM、Shift-JIS）可再解析，失败的失败模式是显式报错 + 不改动文件。

3. **必须交给用户/lead 的两件事**：① 在真实 GUI 新建「汉化模式」会话做最终确认（§7.1）；② 真实的 `ctx.subprocess.spawn` 全链路在非沙箱环境下的确认（§7.2）—— 本会话因**审批被禁用、子代理权限固定**，无法按任务书要求做 `danger-full-access` 重试，这一点请按「未验证」而非「已验证」处理。

4. **不影响「能否用」，但影响「好不好用」的既有局限**（**本轮修复未声称覆盖**）：在线 API 兜底因 `web.fetch` 只支持 GET 而不可用；shift_jis 游戏写中文会变成 `?`；导出会在游戏根目录留下两个 `.hanhua-iconv.*` 临时文件。

---

## 10. 复核记录：验证期间产物变更，rev C 全量重跑

### 10.1 时间线（均为本机时间）

| 时间 | 事件 | `index.js` 哈希 |
|---|---|---|
| 19:25:01 | **rev A** —— 我完成主体验证时的版本（repo = installed） | `61562CE7…` |
| 19:29–19:33 | lead 继续改 `tests/harness.mjs`、README、docs、打 `release/…v1.2.0.zip` | — |
| 19:39:46 | 已安装副本被重写 | `EBB76DA9…` |
| 19:40:50 | 仓库 `index.js` 再次被重写（新增「`.bak` 写一次即固定」） | `54C0EAB2…` |
| 19:41:13 | 我发现 repo 与 installed **不一致**（`54C0EAB2…` vs `EBB76DA9…`） | — |
| 19:41:33 起 | 已安装副本被同步，repo 与 installed 恢复一致 | 两侧均 `54C0EAB2…` |

发现差异时我立即做了两次相隔 20 秒的哈希采样确认文件正在被写入，随后**在 rev C 上重跑了全部探针**，并针对新增语义补写了探针 I。

### 10.2 rev C 全量重跑结果

| 探针 / 命令 | rev A 结果 | **rev C 结果** |
|---|---|---|
| `mount-check` 仓库 / 已安装 | 27 行 0 失败 | ✅ 27 行 0 失败（两侧） |
| 探针 E `probe-static`（组合文件 + 两半一致） | 20/20 | ✅ **20/20** |
| 探针 F `probe-registry`（7 工具 / 6 服务 / schema） | 13/13 | ✅ **13/13** |
| 探针 D `probe-order`（section 3200 位置） | 6/6 | ✅ **6/6** |
| 探针 A `probe-cwd`（缺 cwd 报错） | 3/3 符合 | ✅ 3/3 符合（报错原文一致） |
| 探针 B `probe-iconv`（iconv 脚本 + argv 下标） | 8/8 | ✅ **8/8** |
| 探针 C `harness-subst`（含 `iconvBatch` 真实路径） | 28/28 | ✅ **28/28** |
| 探针 G `probe-reparse`（回写后再解析） | 6/6 | ✅ **6/6** |
| 探针 I `probe-backup-twice`（新增） | — | ✅ **7/7**（见 10.3） |
| 哈希一致性（4 文件） | 4/4 SAME | ✅ 4/4 SAME（`agent.cordis.yml` `4856DD2F…`、`index.js` `54C0EAB2…`、`preset.yml` `FCAEE870…`、`package.json` `765F83B8…`；`preset.yml` 与 `engine/host.js` 之外无其它变化） |
| `preset.yml` 未被改动 | ✅ | ✅（哈希仍为 `FCAEE870…`，与 rev A 完全相同） |

§6 的 F1（`.hanhua-iconv.*` 残留）与 F2（shift_jis 目标变 `?`）在 rev C 重跑中**同样复现**（残留文件 209B + 70B；`Map002.rxdata` 510B、`legacy.ks` 66B 含 `3f` 替换字节）。

### 10.3 探针 I：`.bak`「写一次即固定」的判别性验证（rev C，7/7）

场景取自新注释描述的多轮/分批翻译：**第 1 轮只翻 1 条并导出**（文件进入半成品状态、生成 `.bak`），
**第 2 轮翻其余条目并再次导出**（文件再次被改写）。如果是「每次导出都覆盖 `.bak`」，此时 `.bak` 会变成第 1 轮的半成品。

```
parse.total = 23
--- 第 1 轮：translate({limit:1}) → export ---
    第 1 轮已翻条目 = [["game_krkr/scenario/first.ks#line2.name","Prologue","序章"]]
PASS  第 1 轮导出成功  — ok=1/1
PASS  第 1 轮正文已被改写（半成品状态）  — 正文 240 → 228 字节
PASS  第 1 轮 .bak == 最初原文  — bak=240B original=240B
--- 第 2 轮：translate({limit:100}) → export ---
    第 2 轮已翻条目 = [ … first.ks#line3 … "早上好！ The 任务 begins now." … 共 14 条 ]
PASS  第 2 轮导出成功  — ok=4/4
PASS  第 2 轮正文再次变化  — 第1轮 228B → 第2轮 174B
PASS  ★ 第 2 轮 .bak 仍是最初原文（未被第 1 轮半成品覆盖）  — bak==最初原文=true
PASS  ★ 若沿用旧逻辑，.bak 会等于第 1 轮半成品（此处必须不同）  — bak==第1轮内容=false
PASS  已存在的陈旧 .bak 不会被刷新（"写一次即固定"的取舍）  — bak 仍为预置内容=true
[INFO] 取舍：若 .bak 早于本次汉化轮次（上次汉化遗留），回滚会还原到那份旧内容，而不是本轮导出前的原文。

===== 探针 I：7/7 通过 =====
```

**结论**：新语义按设计生效，并且**回滚点确实是「最初原文」**；代价是**陈旧 `.bak` 不会被刷新**（已作为已知取舍记录，建议在文档中向用户说明「开始新汉化前先删掉旧 `.bak`」）。

补充观察（非缺陷，属于既有安全护栏）：第 2 轮若在「文件已是第 1 轮译文」的状态下直接导出，插件会因
`inner !== e.source` 而**跳过该行的替换**（防止把已改写的文本当原文再替换一次）——
这也是我的第一版探针断言写错的原因，特此记录以免误判为「导出没生效」。

### 10.4 对最终结论的影响

**没有改变。** rev C 上 §2 的全部检查项与 88 条断言全部通过；两半实现仍然一致、`iconvBatch` 仍然走通、`.bak` 语义经判别性测试确认。
唯一新增的**流程性要求**是：**最终交付前请冻结产物并再跑一次 §8 清单**——本次验证期间产物至少变更了 3 次，其中一次出现了 repo 与已安装副本不一致的窗口。
