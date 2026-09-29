# 「汉化模式」适配 DSH 0.1.6-alpha.2（桌面封装 1.0.5）修复报告

> 日期：2026-09-29　适用内核：`dsh 0.1.6-alpha.2`（tag `dsh-v0.1.6-alpha.2`，commit `ddefc45`）
> 旧内核基线：`dsh 0.1.1-rc.2`（本预设 2026-08-27 编写时的内核）
> 相关文档：[主机 API 兼容性审计](COMPAT-0.1.6-alpha.2.md) · [客户端半/动态插件审计](CLIENT-COMPAT-0.1.6-alpha.2.md) · [独立验证报告](VERIFY-0.1.6-alpha.2.md)

---

## 1. 症状

桌面封装升级到 1.0.5（随包内核由 `0.1.1-rc.2` 换成 `0.1.6-alpha.2`）后，「汉化模式」预设不可用：
新建会话选择该预设时，整份预设**挂载失败回滚**（工具与 persona 都不生效），且导出（写回）即使能跑到也会失败。

---

## 2. 根因

### A 类 · 挂载级失败（一行坏 → 整份预设失败）

| # | 根因 | 证据 |
| --- | --- | --- |
| **A1** | **persona 行配置键改名**：0.1.6 的 `@deepseek-ai/dsh-persona` 把必填配置从 `text` 改成 `prefix`（另加可选 `suffix`）。组合文件仍写 `text:` → schemastery 抛 `$.prefix missing required value` → 该行 fiber 不建立 → `mountPreset` 抛 `N row(s) did not activate` → 整棵子树回滚。 | 新：`core/packages/preset/persona/src/index.ts:36,41,50-51`；旧：`.tmp-core-old-0.1.1-rc.2/packages/preset/persona/src/index.ts:40,49`。实测 `Config({ text })` → `$.prefix missing required value`。 |
| **A2** | **`workflow-worker-thread` 行在新内核下 import 失败**：该行指向 `@deepseek-ai/dsh-workflow-worker-thread`（本机仍是 `0.1.1-rc.2` 版本），其 `import { assertNever } from '@deepseek-ai/dsh-llm'` 在 0.1.6 的 `dsh-llm` 里已不存在 → 该行挂载即抛错。新版随包标准预设已改用 `@deepseek-ai/dsh-workflow-ptc`。 | `tests/mount-check.mjs` 实测：`row "workflow-worker-thread": 导入失败 … does not provide an export named 'assertNever'`。 |

> 为什么「一行坏」等于「预设废掉」：单行 config 校验失败只记日志，但该行没有 fiber；挂载后的可用性审计把「无 fiber 的启用行」记为 `never started`，`mountPreset` 只要拿到非空诊断就抛错并回滚整份预设（`core/packages/preset/agent-presets/src/mount.ts:303-326,394-397`）。

### B 类 · 运行级失败（预设能挂载，但功能坏）

| # | 根因 | 证据 / 影响 |
| --- | --- | --- |
| **B1** | **`ctx.subprocess.spawn` 缺 `cwd`**：0.1.6 的 `LocalSubprocessRuntime.spawn()` 先调 `targetEnvironment(spec)`，其中 `validateNoNullByte('options.cwd', spec.cwd)` 对 `undefined` 调 `value.includes('\0')` → `TypeError: Cannot read properties of undefined (reading 'includes')`。旧实现（0.1.1-rc.2）容忍缺省并回落到 `process.cwd()`。 | 新：`subprocess-local/src/index.ts:179-181` → `runner-launch.ts:300-306,291-293`。影响 `hanhua_export` 的全部写回（二进制 Marshal、legacy 编码、UTF-16 文本）。 |
| **B2** | **提示片段 `order` 语义整体上移**：0.1.6 改用中央档位表（`HARNESS_IDENTITY=-1000`、`DEPLOYMENT_PERSONA_PREFIX=0`、`PLAN_POLICY=500`、工具指南 `1000–3100`、`TOOLS_SDK=5000`、`DEPLOYMENT_PERSONA_SUFFIX=10200`）。插件原来的 `order: 115`（旧约定「工具指南 100–199」）会掉到 persona 之后、全部第一方工具指南之前。 | 新：`core/packages/core/system-prompt/src/index.ts:125-160`。片段仍渲染，但位置错误（工具指南应先于 SDK/后缀段）。 |
| **B3** | **iconv-lite 解析依赖子进程 cwd**：`node -e` 的 `require()` 从 cwd 逐级向上找 `node_modules`，而子进程 cwd 是游戏目录（通常没有 `node_modules`），旧的单点 `require('iconv-lite')` 以 `code=3` 静默失败 → GBK/Shift-JIS legacy 回写整条链路失效。 | 实测：`game_krkr/scenario/legacy.ks`（Shift-JIS）导出报 `write: node 子进程失败 code=3`。本机 `iconv-lite` 其实装在 `%DSH_HOME%\profiles\node_modules`。 |

---

## 3. 修复内容

### 3.1 组合文件：改为由新版随包标准预设派生

`preset/agent.cordis.yml` 不再手改旧组合，而是由 `packages/preset/agent-presets/presets/standard/agent.cordis.yml`（0.1.6 随包标准）派生：

- persona 行改为 `suffix:` + `prefix:`（汉化 persona 正文放在 `prefix`，工作目录提示放 `suffix`）；
- 随新版对齐全部行：`command-goal`、`workflow-ptc`（替换 `workflow-worker-thread`）、`tool-ralph disabled: true`、`tool-web fetch: true`、`present`、`tool-plugin-manager(disabled)`、`tool-subagent.modelSelectionSettings`；
- 末尾保留本地行 `- id: hanhua-engine / name: ./plugins/hanhua/index.js`；
- `preset.yml` 不变（用户预设不带 roster `order`）。

生成器：`tests/build-composition.mjs`（`--check` 可做一致性门禁）。

### 3.2 插件（静态预设半 `preset/plugins/hanhua/index.js` 与动态半 `engine/host.js` 同步）

| 修复 | 说明 |
| --- | --- |
| `subprocess.spawn` 补 `cwd` | 新增 `spawnCwd()`（项目根，缺省 `.`），两个调用点全部传入；`SubprocessSpawnSpec.cwd` 在新旧两版都是必填字符串，因此该改动对旧内核同样安全。 |
| 提示片段 `order: 115 → 3200` | 落在 `MCP_SERVERS(3100)` 与 `TOOLS_SDK(5000)` 之间：紧跟既有工具指南、早于 SDK 段。 |
| iconv 解析加固 | 新增 `ICONV_CANDIDATES()`（`config.iconvPath` → `%DSH_HOME%/profiles{,/web}/node_modules/iconv-lite` → 全局 `iconv-lite`）与 `iconvEnv()`（把候选 `node_modules` 目录并入子进程 `NODE_PATH`）；子进程按清单逐个尝试，全部失败才 `code=3`。`writeTextLegacy` 与 `iconvBatch` 两条路径都改。 |

### 3.3 插件行为修复（实机跑真实项目时暴露）

| 修复 | 说明 |
| --- | --- |
| **`hanhua_translate` 支持分批推进** | 原来 `limit` 上限 5000 且每次都从 `state.entries` 的**头部**切片、`state.translated` 每次被**覆盖**，于是 5000 条之后的条目永远翻不到、export 也只能写回最后一批。现在：`limit` 是「每批条数」（默认 500，上限 20000 = `MAX_ENTRIES`），默认只处理**尚未翻译**的条目，译文**累计**保存（同 id 覆盖），返回值新增 `progress{processed,pendingBefore,remaining,translatedTotal,entryTotal}`；`ids` 定向重译仍可用；重新 parse 后会剔除已不存在条目的旧译文；全部翻完后再次调用返回 no-op（`remaining=0` + `note`），不报错。 |
| **`.bak` 写一次即固定** | 原来每次导出都覆盖 `.bak`，多轮导出（分批翻译/追加翻译）会把它漂移成上一轮的半成品，最终丢掉原文回滚点。现在 `.bak` 只在**不存在**时创建，始终是「汉化前的原文」。 |
| **扫描跳过 Ren'Py 的 `tl/` 目录** | `game/tl/<lang>/*.rpy` 是官方译文参考（也是本工程汉化缓存的来源），就地翻译会破坏它。现在 `SKIP_DIRS` 含 `tl`；需要对它操作时把文件显式传给 `hanhua_parse`/`hanhua_export`。实测同一工程扫描结果由 133 个文件回到 67 个（与预期一致）。 |

### 3.4 安装

已安装副本（应用实际读取的位置）已与仓库副本同步，SHA256 完全一致：

- `D:\Agent-windows\DeepSeekHarness\data\.dsh\.agent-presets\hanhua\agent.cordis.yml`
- `D:\Agent-windows\DeepSeekHarness\data\.dsh\.agent-presets\hanhua\plugins\hanhua\index.js`

---

## 4. 验证

工具（全部可复现，运行时用 `D:\Agent-windows\DeepSeekHarness\runtime\node.exe`）：

| 检查 | 命令 | 结果 |
| --- | --- | --- |
| 挂载级检查（复刻 Loader 的行解析 + Config 校验） | `node tests/mount-check.mjs preset/agent.cordis.yml.before-v12` | **FAIL（复现缺陷）**：`persona` → `$.prefix missing required value`；`workflow-worker-thread` → 导入失败 `assertNever` |
| 同上（修复后） | `node tests/mount-check.mjs` | **27 行全部可挂载，0 失败** |
| 真实 discovery 健康检查（Web 预设选择器口径） | `$env:DSH_HOME=…; node tests/preset-health.mjs` | `standard/ptc/minimal/cordis/liangshen/hanhua` **6/6 healthy** |
| 真实运行时时集成测试（0.1.6 已构建服务：fs / sandboxPolicy / subprocess / systemPrompt / tools / web） | `node tests/harness.mjs` | **19/19 通过**：7 个工具注册并可投影；scan 4 文件 → parse 23 条 → glossary 65 条 → translate（词典 13 / 跳过 3 / 直通 7）→ QA 23 条 → export 4/4 文件成功；每个 `.bak` 与原字节完全一致；UTF-16LE 的 `.ks` 保留 BOM 与 KAG 结构且写入译文；Shift-JIS 的 `.ks` 保持原编码；`.rxdata` 保持 `04 08` Marshal 头且长度不缩水 |
| 安装一致性 | `Get-FileHash` | 已安装副本 == 仓库副本（组合文件 `4856DD2F…`、插件 `61562CE7…`） |

> 说明：`tests/harness.mjs` 在受限沙箱下需要一次性提权（`danger-full-access`）运行，因为 DSH subprocess 服务要拉起带管道的托管子进程，受限模式会以 `spawn EPERM` 拒绝；这与插件代码无关（详见独立验证报告）。

### 4.1 真实项目实机验证（Birth Story 测试副本）

命令：`node tests/real-project-run.mjs --limit 5000`（对 `…\汉化测试\birthstory-v1.1.3-win\game`，其 `tl/` 目录被正确跳过）

| 阶段 | 结果 |
| --- | --- |
| scan | 67 个文件（修复前会连 `tl/` 一起扫成 133 个） |
| parse | **9565 条**（`truncated=false`，`errors=0`）—— 与预期语料规模一致 |
| translate | 两轮跑完全部条目：cache **8996** + glossary **7** + skip **108** + passthrough **454** ⇒ 累计 **9565/9565**，`remaining=0` |
| qa | 9565 条，问题 300 条（上限） |
| export | **66/66 文件成功**，写入约 **5.9 万汉字**；占位符（`{color=…}{/color}{w=60}{nw}` 等）集合逐文件比对**无变化** |
| 备份网 | **66/66 个 `.bak` 与 `pristine-snapshot` 原始英文文件逐字节相同**（含修好的 5 个此前已被多轮导出漂移的备份） |
| 收敛性 | 再次运行同一流程：`remaining=0`、仅 1 个文件 +9 汉字、`.bak` 不再变动 ⇒ 幂等 |
| 交付状态 | 66 个游戏脚本中 **64 个含中文**；未含中文的 2 个（`set_default_language_at_startup.rpy` 66 B、`system_splashscreen.rpy` 773 B）本身无可译文本 |

剩余 454 条 `passthrough` 是**原文本身已是中文**（此前几轮已写入）或中英混排、缓存未命中的条目，不是漏译；再次运行不会产生新的变更。

---

## 5. 尚未修复 / 已知限制

1. **在线翻译 API 兜底仍不可用（升级前就存在，不属于 0.1.6 回归）**：`ctx.web.fetch` 的 `WebFetchRequest` 只有 `url`，新旧内核的 HTTP provider 都硬编码 `GET`，插件传入的 `method/headers/body` 被丢弃；且 0.1.6 起 provider 新增「非公网 IP 直接拒绝」。因此 `hanhua_translate` 的在线兜底实际不会成功（工具会如实返回 `lastError`，词典/缓存路径不受影响）。若要恢复，需要改走 `subprocess` + `node fetch` 之类的通道。
2. **「汉化工作台」面板不能由模型启动**：0.1.6 已退役 `cordis_define/cordis_run/cordis_stop/cordis_undefine`（`tool-cordis` 只剩只读 inspect 工具），而 `tool.view.cordis` 的渲染位挂在 `cordis_run` 卡片上。动态插件机制本体仍在（host 服务 `define`/`run` 可用），迁移建议见 [客户端半审计 §4](CLIENT-COMPAT-0.1.6-alpha.2.md)。宿主半的 7 个工具不受影响。
3. **真实桌面会话内的挂载**只能由用户新建会话确认（本机无法替他创建会话）。

---

## 6. 用户验收步骤

1. 重启 DeepSeek Harness（预设目录已更新；应用在**新建会话**时读取预设即可，无需重建内核）。
2. 新建会话 → 预设选择「**汉化模式**」→ 首轮应能直接看到 7 个 `hanhua_*` 工具，persona 为汉化专家提示。
3. 冒烟：
   ```
   hanhua_config action=get
   hanhua_scan root=<游戏目录>
   hanhua_parse
   hanhua_translate limit=5000     ← 命中缓存/词典；返回 progress.remaining，>0 就再调一次
   hanhua_qa
   hanhua_export mode=inplace     ← 自动生成 <file>.bak（已存在则不覆盖）
   ```
4. 若导出后要回滚：用同目录下的 `.bak` 覆盖回去即可（本轮验证已确认 `.bak` 与 pristine 原始文件逐字节相同），或直接跑：
   ```powershell
   node tests\real-project-rollback.mjs --root "<游戏目录>"
   ```
5. 浏览器「汉化工作台」面板：见 [工作台安装说明](WORKBENCH-0.1.6.md)（需要用户在 Cordis 面板点一次「批准」，且进程重启后需重新装载）。
