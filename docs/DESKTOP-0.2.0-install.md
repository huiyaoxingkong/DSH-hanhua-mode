# 安装到 DSH 桌面版（0.2.0-rc.2）：为什么之前跑不起来

> 适用：官方 **DeepSeek Harness 桌面版**（Electron，`app.asar` 内置内核 `0.2.0-rc.2`，
> `DSH_HOME=C:\Users\lihao\.dsh`，`DSH_PROFILE=desktop`）。
> 安装脚本：[`tools/install-hanhua-desktop.mjs`](../../tools/install-hanhua-desktop.mjs)
> 校验脚本：[`tools/validate-declaration.mjs`](../../tools/validate-declaration.mjs)

## 1. 运行失败的两个原因

### A. 预设机制换代：目录式预设已被废弃

0.1.x 时代用户预设是目录 `$DSH_HOME/.agent-presets/<id>/{preset.yml, agent.cordis.yml}`。
0.2.0-rc.2 的内核把预设改成了**声明式注册表**：

- 包名换代：`@deepseek-ai/dsh-agent-presets` → `@deepseek-ai/dsh-agent-preset-registry`；
- 预设是 profile 组合里的一个 `@deepseek-ai/dsh-agent-preset` 行，
  Config 为 `{ id（必填）, plugins（必填）, name?, description?, order? }`；
- 内核文档原文（`dsh-agent-preset/skills/editing-cordis-compositions/SKILL.md` §"Migrate a legacy preset"）：
  **"Before declaration rows, a user preset was a directory `$DSH_HOME/.agent-presets/<id>/` … Nothing reads that directory any more."**

因此把旧目录（或旧安装）放进新桌面版**不会被读取**，「汉化模式」自然不会出现在预设列表里。

### B. 内核整体打包在 `app.asar` 内 → 插件的 iconv 依赖不可达

桌面版把整个内核放在 `resources/app.asar`（12,410 个文件、347 MB、**不含 iconv-lite**）。
插件历史上通过 node 子进程 `require('iconv-lite')` 做 GBK/Shift-JIS 回写：普通 node 子进程
**无法 require asar 内的模块**，于是回写以 `node 子进程失败 code=3` 失败（0.1.6 包装版里
它恰好能从 `profiles/*/node_modules` 找到，桌面版没有这个目录）。

附带修掉一个会让「自带依赖」也失效的缺陷：`import.meta.url`（`file:///D:/…`）直接 `slice(5)`
会得到 `///D:/…`（三斜杠），`require`/`stat` 都不认；现已剥掉盘符前的全部斜杠。

## 2. 本轮的适配与安装

| 改动 | 说明 |
| --- | --- |
| 插件自带 iconv-lite | 安装时把 `iconv-lite` + `safer-buffer` 复制到 `<插件目录>/node_modules/`；候选清单新增「插件自带」并在首次 legacy 写回时自动写入 `config.iconvPath`（动态半也受益） |
| 平台兼容的 `file:///` 路径转换 | 修掉三斜杠 bug（否则自带依赖同样 code=3） |
| 预设声明由桌面版随包 standard 派生 | 桌面版模板：`@deepseek-ai/dsh-web-app/presets/standard.patch.yml`（146 行）→ `preset-hanhua`（persona 换汉化文案 + 追加 `hanhua-engine` 行，`name` 用 `file:///…` 引用插件） |
| 安装进 profile patch | `$DSH_HOME/profiles/desktop/cordis.patch.yml` 追加带标记的 `insert` 块（原文件备份 `.hanhua-backup`） |
| bundle 形式同时产出 | `<home>/hanhua/{package.json,cordis.patch.yml}`，以后可用官方 `plugin_manager action=install_bundle` 安装 |

## 3. 验证结果（真实 0.2.0-rc.2 内核）

用 asar 读取器（[`tools/asar-read.mjs`](../../tools/asar-read.mjs)）把内核解到
`D:\Games\汉化模式\.kernel-0.2.0\node_modules`，再跑仓库自带的校验：

| 检查 | 结果 |
| --- | --- |
| 声明可挂载（逐行解析 + 每行 Config 校验，33 行） | **全部通过** |
| 插件真机集成（真实 0.2.0 服务：fs / sandboxPolicy / subprocess / systemPrompt / tools / web） | **19/19 通过**（含 Shift-JIS 与 UTF-16LE 回写、`.bak` 逐字节等于原文） |
| `dynamicCordisRunner` 服务是否仍在（工作台自装路径） | **仍在**（`dsh-cordis-host-runner`） |
| 提示段落档位（`order: 3200`） | 0.2.0 的 `SECTION_ORDERS` 仍是 `MCP_SERVERS:3100` / `TOOLS_SDK:5000`，位置正确 |

## 4. 使用与回滚

重启桌面版 → 新建会话 → 选「汉化模式」。回滚：

```powershell
Copy-Item "$env:USERPROFILE\.dsh\profiles\desktop\cordis.patch.yml.hanhua-backup" "$env:USERPROFILE\.dsh\profiles\desktop\cordis.patch.yml" -Force
Remove-Item "$env:USERPROFILE\.dsh\hanhua" -Recurse -Force
```

## 5. 仍未解决 / 只能由用户确认

- **在线翻译 API 兜底**：0.2.0 的 `WebFetchRequest` 仍然只有 `url`、provider 硬编码 GET，插件发出的 POST 主体不会被发送（词典/缓存路径不受影响）。
- **工作台面板的浏览器端**：host 侧链路（`dynamicCordisRunner` define/run、`workbench.*` RPC）已具备，但「点批准 → 设置页出现面板」需要在应用里确认。
- `agent.cordis.yml` 这套目录式产物保留在仓库里仅为兼容旧内核，桌面版不再使用。
