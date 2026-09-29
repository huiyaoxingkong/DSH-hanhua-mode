# 汉化工作台（常驻设置页）· 0.1.6-alpha.2 装载与使用

> 一句话：在「汉化模式」会话里执行 `hanhua_workbench action=install` → 到 Cordis 面板点「**仅允许此版本**」→
> 打开 **设置 →「汉化工作台」**。

相关文档：[客户端半/动态插件兼容性审计](CLIENT-COMPAT-0.1.6-alpha.2.md)（为什么旧路径失效、为什么选方案 B）、
[适配修复报告](UPGRADE-0.1.6-alpha.2.md)、[独立验证报告](VERIFY-0.1.6-alpha.2.md)。

---

## 1. 为什么工作台要「自己装」（背景）

| 能力 | 0.1.1-rc.2 | 0.1.6-alpha.2 | 结论 |
| --- | --- | --- | --- |
| `cordis_define` / `cordis_run` / `cordis_stop` / `cordis_undefine` | 模型工具，可启动动态包 | **已整体退役**（`tool-cordis` 只剩只读 inspect） | 模型不能再启动动态包 |
| `tool.view.cordis`（key=`self`）会话流快捷面板 | 挂在 `cordis_run` 卡片上 | 卡片不再存在 ⇒ 没有渲染位（注册静默挂起） | **实效失效**，v9 client 半已删除 |
| `settings.section`（设置页分节） | 常驻 | 契约**逐字未变** | ✅ 仍可用，「汉化工作台」主面板 |
| 动态插件机制本体 | 有 | **仍有**：host 服务 `dynamicCordisRunner` 公开 `define` / `run` / `stop` / `undefine` | 走「程序调用」这条路仍通 |
| 动态 client 半源码契约 | `return { apply(ctx) {...} }` 字符串 | **逐字未变**（`React`/`styles`/`host`/`ctx.get('slots')` 都还在） | client 半不用重写 |

所以本仓库采用**方案 B（最小改动）**：由预设自己的本地插件
（`preset/plugins/hanhua/index.js`，host 平面）直接调用 `dynamicCordisRunner.define()` + `run()`，
把 `engine/host.js` + `engine/client.js` 装成一个动态包；client 半只注册**常驻的设置页分节**。
不再依赖任何模型工具。

因此现在的形态是：

- ✅ **常驻设置页**：`设置 →「汉化工作台」`（`settings.section`，`id=hanhua-workbench`，`order=50`）；
- ❌ 会话流里的「快捷面板」不再存在（v9 起已从 `engine/client.js` 删除，见 §8）。

---

## 2. 前置条件

1. 内核为 **DSH 0.1.6-alpha.2**（桌面封装 1.0.5 随包）或同代内核，并且运行在**带浏览器 UI** 的形态下
   （桌面版 / `dsh web`）——动态包的 client 半只能由浏览器页面装载。
2. web composition 挂载了这三个包：`@deepseek-ai/dsh-cordis-host-runner`（host 侧 registry + `dynamicCordisRunner`）、
   `@deepseek-ai/dsh-cordis-client-runner`（页面侧装载）、`@deepseek-ai/dsh-client-ui-cordis`（Cordis 面板）。
   官方 web-app 组合默认挂载；其中 host runner 在示例组合里是**可选插入行**，缺失时 §6 的 `status` 会直接报出来。
3. 「汉化模式」预设已安装，且 `plugins/hanhua/engine/{host.js,client.js}` **随预设一起存在**（v12 起预设自包含，见 §7）。
4. 自检命令：`hanhua_workbench action=status`（见 §6）。

---

## 3. 装载步骤（首次）

1. 在「汉化模式」会话里让模型执行：

   ```
   hanhua_workbench action=install
   ```

   （也可以直接说「装载汉化工作台」/「打开汉化工作台面板」。）

2. 看工具返回：`"status": "awaiting-approval"` 表示**已创建定义并发出装载请求，正在等你在浏览器里批准**。
   返回里的 `hints` 会给出同样的中文提示；`pluginId` / `packageId` 形如 `hanhu-1` / `pkg-1`。

3. 打开 **侧边栏底部的 Cordis 面板入口**（`sidebar.footer.action`，角标数字 = 运行中 + 待确认），
   在「汉化工作台」那一行点：

   - **「仅允许此版本」** —— 只批准这一个包版本（默认够用）；
   - **「允许此插件的后续版本」** —— 以后换版本也不再询问（推荐，见 §5）。

4. 页面装载完成后：**设置 →「汉化工作台」** 出现面板。

5. 面板里可用：`扫描 / 解析 / 翻译 / 导出 / 一键全流程`、翻译配置（root、API 接口、API Key、模型、目标语言、
   RGSS/krkr 编码、API 每批条数、iconv 路径）、词典/术语表增删、译文预览（含 QA 提示数）。

> 批准是**框架级**的：同一个 DSH 进程里任何标签页都可以应答这次请求，第一个应答生效。

---

## 4. 三个 action

| action | 作用 | 关键返回 |
| --- | --- | --- |
| `status`（默认） | 自检：服务是否可用、引擎源码路径/字节数、本会话已有定义与运行状态 | `service.available`、`engine.{dir,pathSource,host,client}`、`definitions[]`、`workbench[]`、`ready`、`hints[]` |
| `install` | 读引擎两半源码 → `define` → `run`（复用已有定义时不 define） | `ok`、`reused`、`pluginId`、`packageId`、`receipt`、`run.{status,reason}`、`timedOut`、`engine`、`hints[]` |
| `stop` | 停止运行中的实例（定义保留） | `ok`、`stopped[]`（每个 pluginId 的 `ok/reason/message`） |

### install 到底做了什么

```
读 preset/plugins/hanhua/engine/host.js + client.js
  ├─ 本会话已有「汉化工作台」定义 → 复用：runner.run(agent, pluginId, packageId, 'run')
  └─ 没有                        → runner.define({ sessionId: agent.id, plugin:{kind:'new', idPrefix:'hanhu'},
                                                  name:'汉化工作台', purpose:'设置页工作台面板',
                                                  code:{ host, client } })  → runner.run(...)
```

- `define` 会先**编译检查（precheck）两半源码**：语法不过就直接抛错，不会留下半成品定义。
  引擎源码损坏时 install 返回的报错就是来自这一步。
- `run` 在 0.1.6 里**立即返回** `{ok:true, status:'awaiting-approval'}`（请求已挂起，等人批准；不阻塞工具调用）。
  工具另外加了 **3 秒保险**（`Promise.race`）：万一未来的内核改成「在 `run` 里等批准」，
  工具会在 3 秒后返回「等待批准」而不是卡死本轮调用；`timedOut: true` 只表示走了这条保险分支，
  **不代表请求失败**。超时后的 promise 也被 `then/catch` 接住，不会产生 unhandled rejection。

---

## 5. 生命周期：什么会丢、怎么办

| 事件 | 结果 | 处理 |
| --- | --- | --- |
| **关闭 DSH / 重启进程** | 动态定义消失（定义是**进程内状态**） | 重新 `action=install` |
| **浏览器页面刷新 / 新开标签页** | 本页不再装载 client 半 ⇒ 设置页里没有「汉化工作台」 | 重新 `action=install`（**复用同一个定义，已批准过通常不再弹批准**，页面会自动装回） |
| **新建另一个会话** | 定义按会话隔离：新会话里看不到旧定义 | 在新会话里 `install`（会新建 `hanhu-N`） |
| `action=stop` | 停掉运行中的实例，定义仍在 | 再 `install` 即可重新装载 |
| 在 DSH 运行期间改了 `engine/*.js` | 复用已有定义 ⇒ 面板跑的还是**旧源码** | 重启 DSH（定义清空）后再 `install`，或先 stop 再重启 |

**复用规则（v12 的刻意设计）**：同一会话里若已有「汉化工作台」定义，`install` 直接对**既有版本**
执行 `run(mode:'run')`，不再 `define` 新包 —— 否则每点一次 install 就会多出一个 `hanhu-2`、`hanhu-3`，
Cordis 面板里会出现一串同名行。0.1.6 的 host runner 会记住「这个包版本已被批准」
（`approvedClientPackages`），因此**同一个包版本第二次 run 不需要再点批准**，页面收到请求后会自动装载
（client runner 的 `open()`：`requiresApproval === false` 时立即 orchestrate）。
选「允许此插件的后续版本」则连换版本也不用再批准。

---

## 6. 排错（先跑 `hanhua_workbench action=status`）

| status 里的现象 | 含义 | 处理 |
| --- | --- | --- |
| `service.available: false` | 当前内核没有 `dynamicCordisRunner` 服务 | web composition 未挂载 `@deepseek-ai/dsh-cordis-host-runner`（0.1.6 里它是可选行）；或在无浏览器的 headless 形态下。**静态 `hanhua_*` 工具不受影响** |
| `engine.host.exists: false` / `client.exists: false` | 引擎源码不在预设里 | 预设安装时漏了 `plugins/hanhua/engine/`；重新安装预设，或按 §7 用 `workbenchEnginePath` 指到仓库 `engine/` |
| `sessionId: null` + hint | 取不到当前 Agent（SessionId） | 正常从会话里调用工具（走 `exec.agent`）；`define`/`run` 都以 `Agent.id` 作为会话标识 |
| `ready: false`，且 `workbench[].currentPackageId: null` | 定义在，但没有成功跑起来的版本 | `install` 重新装载，并按提示到 Cordis 面板批准 |
| `run.status: "awaiting-approval"` 一直不变 | 没人批准 | 到 Cordis 面板点「仅允许此版本」；**没有浏览器页面连着时永远等不到**（host runner 的挂起请求无超时，只能取消本轮） |
| `run.reason: "transition-in-flight"` | 已有一个待批准的请求 | 别重复 install，直接去 Cordis 面板批准 |
| `latestRun.error` / `activeRun.renderFailure` | host 半加载失败 / React 渲染崩了 | 看错误文本：多为引擎源码或内核服务变化；`renderFailure.slot` 指出是哪个 slot |
| 面板按钮点了报错 | `host.call('workbench.*')` 失败 | status 里看 `activeRun.handlers` 是否含 `workbench.*`；没有就是 host 半没跑起来 |
| `pathSource` 显示覆盖 | 用了 `workbenchEnginePath` | 见 §7 |

`status` 只输出**标量投影**：`activeRun.fiber`（Cordis Fiber，含循环引用）不会进入工具结果，避免 JSON 化失败。

---

## 7. 引擎源码是两份、必须同源

| 位置 | 角色 |
| --- | --- |
| `engine/host.js`、`engine/client.js` | **源码成品**（GitHub 仓库也发布这两份；动态包的 host/client 半） |
| `preset/plugins/hanhua/engine/host.js`、`.../client.js` | **预设自包含分发副本**，`hanhua_workbench` 实际读取的文件 |

```powershell
# 改完 engine/ 后同步（复制，不要手抄）
Copy-Item engine\host.js   preset\plugins\hanhua\engine\host.js   -Force
Copy-Item engine\client.js preset\plugins\hanhua\engine\client.js -Force

# 校验两份一致
Get-FileHash engine\host.js, preset\plugins\hanhua\engine\host.js, engine\client.js, preset\plugins\hanhua\engine\client.js -Algorithm SHA256
```

- 只改 `engine/` **不会**影响已安装的预设副本；要重新复制到预设目录，并且（如果定义已存在）重启 DSH 后重新 `install`。
- **可选覆盖**：在项目根目录的 `.hanhua-config.json` 里加
  `"workbenchEnginePath": "D:/path/to/engine"`（填**目录**，不是文件）。
  设置后 `status.engine.pathSource` 会显示为覆盖来源；默认走「插件同级 `engine/`（由 `import.meta.url` 推导）」，
  Windows 的 `file:///D:/...` 会被正确转成 `D:/...`（含 `%20`、UNC 处理）。
- 该键只是 `.hanhua-config.json` 里的一个普通字段（`hanhua_config` 的 `get` 会照常显示它，无需改动任何工具 schema）。

---

## 8. 面板与静态工具：两套状态、一套元文件

| | 静态工具 | 浏览器面板 |
| --- | --- | --- |
| 入口 | 模型调用 `hanhua_scan` / `hanhua_parse` / … | 设置页按钮，走 `host.call('workbench.*')` |
| 代码 | `preset/plugins/hanhua/index.js` 里的引擎 | 动态包 host 半 `plugins/hanhua/engine/host.js` |
| 进程内状态 | 各自一份（内存里的 `state`/`config`/`glossary`） | 各自一份 |
| 元文件 | **共用**项目根目录的 `.hanhua-config.json`、`.hanhua-glossary.json`、`.hanhua-cache.json`、`.hanhua-parsed.json`、`.hanhua-translated.json` | 同左 |

- 两边都从同一批 `.hanhua-*.json` 读写：工具里配置的 `root`/`apiUrl`/`model` 等，面板刷新时能读到；
  两边**各自在内存里缓存一份并整体回写**，所以同时用两边改配置/词典会互相覆盖（后写者赢）。
  建议同一时间只从一边改配置与词典。
- 面板**不替代**静态工具：模型侧的 scan→parse→translate→qa→export 全流程照常可用，
  面板适合人工点按与查看译文预览。

### 作用域与副作用（已实测）

- 预设插件挂在**会话（agent）作用域**下（`agent-loop` 用 `createScope(loopCtx, agent)` 建 `agent.ctx`，
  预设行挂在它之下）⇒ 8 个 `hanhua_*` 工具**只对该会话可见**。
- 动态包的 host 半挂在 host runner 的 root 上下文（`cordis-dynamic` 组）。**本仓库 v12 起，动态半不再注册模型工具**
  （`engine/host.js` 末尾的 `harness.registerTool` 循环已停用并注明原因）：它的职责只剩 `workbench.*` RPC，
  因此装载工作台**不会**再让同进程的其他会话看到 7 个 `hanhua_*` 工具（这是旧版 `cordis_run` 时代的副作用，
  已被主动消除）。模型侧的工具始终由预设插件在 agent 层提供，共 8 个。
- 因此：装载工作台前后，`ctx.tools.schemas()`（全局层）都不含 `hanhua_*`；`ctx.tools.schemas(agentScope)` 始终 8 个。

---

## 9. 与 0.1.1-rc.2 时代的差别（速查）

| 项 | 旧版 | 现在（0.1.6-alpha.2 + 本仓库 v12/v9） |
| --- | --- | --- |
| 谁启动动态包 | 模型调 `cordis_define` + `cordis_run` | **预设插件**在 host 平面调 `dynamicCordisRunner.define/run`（工具 `hanhua_workbench`） |
| 用户动作 | 在 Cordis 面板点「运行/批准」 | 一样：点「仅允许此版本 / 允许此插件的后续版本」 |
| 设置页面板 | ✅ | ✅（契约未变） |
| 会话流快捷面板 | ✅（挂在 `cordis_run` 卡片） | ❌ 已删除（没有渲染位） |
| 定义存活 | 进程内 | 进程内（重启消失） |
| RPC | `host.call('workbench.*')` | 完全相同 |

---

## 10. 本次自证（可复现）

```powershell
<安装目录>\runtime\node.exe tests\.verify\probe-workbench.mjs
```

探针用**真机安装的** `@deepseek-ai/dsh-cordis-host-runner`（host 平面真服务）组装最小 Cordis 运行时，
把预设插件挂在 **agent 作用域**（与 `agent-loop` 的真实挂载关系一致），跑通 **36 项**检查，覆盖：

`status`（服务/路径/字节数/无定义）→ `install`（真实 `define`，即真实 `precheckCode` 编译两半源码）→
`awaiting-approval`（`run` 立即返回、未超时）→ 重复 `install` 复用定义并回报 `transition-in-flight` →
`runHostHalf`（`engine/host.js` 在真实 `node:vm` 沙箱里激活，11 个 `workbench.*` handler 注册成功）→
`getClientCode` + 按 evaluator 的闭包形态执行 `engine/client.js`（只 inject/注册 `settings.section`，
组件渲染出 `div.hb-root`，代码里已无 `tool.view.cordis`）→ 模拟页面批准 `resolveRequestRun` →
`status.ready=true` → `invoke('workbench.state')` 面板 RPC 通、未知方法报 `method-not-found` →
`stop`（RPC 立即失效、全局层工具注销）→ 再次 `install`（复用同一定义、**不再需要批准**、没有堆出 `hanhu-2`）。

其余三项回归（必须全绿）：

```powershell
node tests\harness.mjs                    # 19/19（含新增的 hanhua_workbench 注册与 schema 投影）
node tests\mount-check.mjs                # 组合文件 27 行 / 0 行会挂载失败
node tests\build-composition.mjs --check   # OK
```

---

## 11. 已知限制 / 未验证项

- **快捷面板不会再回来**：`tool.view.cordis` 的渲染位依赖已退役的 `cordis_run` 卡片；除非改造成
  「安装式 `dsh.client` 客户端插件」（审计里的方案 A，需重做 RPC 通道），否则会话流里不会出现面板。
- **批准需要浏览器页面在线**：headless / ACP 场景下带 client 半的 run 请求会一直挂起
  （host runner 明确「无超时」），只能取消本轮；这类场景请用静态 `hanhua_*` 工具。
- **定义不跨进程、不跨会话**：每个会话各自 `install`，每次重启都要重新装载。
- **全局层不再出现 `hanhua_*` 工具**：v12 起动态半只提供 `workbench.*` RPC，不再注册模型工具（见 §8），
  旧版 `cordis_run` 时代「装载后其他会话也看得到 7 个工具」的副作用已消除。
- **本次未能实测**：真实桌面 GUI 里「点批准 → 面板出现」的完整链路（含 `slots.register` 的实际渲染与
  浏览器 guard）。§10 的探针复刻了内核 client runner 的求值形态（闭包字符串 + `React`/`styles`/`host`
  注入 + 假 `slots`）并验证了注册项与组件渲染，但**没有真实浏览器**参与；这一段仍需用户在应用里确认。
- 面板与工具的**并发写元文件**没有加锁（见 §8），按建议错开使用即可。
