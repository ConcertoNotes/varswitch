# VarSwitch

VarSwitch 是一个面向 Claude Code、Claude Desktop、Codex CLI、Grok CLI、Gemini CLI 和 API 用户的桌面配置管理工具。它通过可视化界面集中管理 API Key / Token、Base URL、模型、编辑器设置、多套应用配置、Skills、Prompts 预设、MCP Server、本机历史会话、Codex 插件市场与移动端控制能力，并提供托盘快速切换、本地代理故障转移、`varswitch://` 深链导入与多设备数据同步。

当前应用版本：`3.2.7`。

## 主要功能

### 1. Claude Code 配置管理

- **多配置管理**：创建、编辑、删除多套 Claude Code/API 配置。
- **供应商预设**：内置 11 个供应商预设（Anthropic 官方、DeepSeek、Kimi、智谱 GLM、MiniMax、阿里云百炼、火山方舟 Coding Plan、百度千帆、美团 LongCat、SiliconFlow、OpenRouter），也支持自定义。
- **配置字段**：支持配置名称、Token/API Key、Base URL、可选模型 ID。
- **角色模型映射**：每套配置可选填 Sonnet / Opus / Haiku 三个角色模型，分别写入 `ANTHROPIC_DEFAULT_SONNET_MODEL` / `ANTHROPIC_DEFAULT_OPUS_MODEL` / `ANTHROPIC_DEFAULT_HAIKU_MODEL`，留空则不设置并清理旧值。
- **OpenAI 兼容供应商**：「API 格式」选择 OpenAI Chat Completions 时，`ANTHROPIC_BASE_URL` 指向本地协议转换代理（`127.0.0.1:25789`），由代理在 Anthropic 与 OpenAI 协议之间双向翻译（含流式响应与工具调用），可直接接入仅提供 OpenAI 接口的上游；该模式需保持 VarSwitch 运行。
- **导入当前配置**：从当前系统环境变量、Claude 设置或编辑器设置中导入已有配置。
- **一键切换**：点击配置卡片的切换按钮后，同步写入：
  - 系统环境变量：`ANTHROPIC_AUTH_TOKEN` / `ANTHROPIC_AUTH_KEY`、`ANTHROPIC_BASE_URL`，以及角色模型映射变量
  - 兼容旧变量：读取并清理/兼容 `ANTHROPIC_API_KEY`
  - Claude 配置：`~/.claude/settings.json` 的 `env`
  - 支持的编辑器 `settings.json` 中的 `claudeCode.environmentVariables`
- **实时状态检查**：首页展示系统环境变量、Claude 设置、各编辑器设置是否与当前配置同步。
- **切换进度与取消**：切换过程中显示系统环境变量、编辑器、Claude 等步骤进度，并支持取消切换。
- **手动同步**：当前有活动配置时，可使用 `Sync Now` 重新写入当前配置。
- **接口测速**：添加/编辑配置时可对 Base URL 做连通性和延迟测试。
- **余额查询**：配置卡片直接显示 API Key 的剩余余额，支持 DeepSeek、Kimi（月之暗面）、SiliconFlow、OpenRouter 官方接口以及 NewAPI / one-api 系中转站的通用计费接口；悬停可查看总额度、已用、充值/赠送明细，可点击刷新，结果本地缓存（10 分钟内不重复自动查询）。Claude / Codex / Grok / Gemini / OpenCode 五个配置列表均支持。
  - 中转站把令牌设为「不限额度」时，其计费接口会返回 1e8 这类占位上限（one-api 源码中 `UnlimitedQuota` 即固定返回 `100000000`），直接相减会得出「余额 $99,999,971」的假数字，因此这种情况只展示真实的已用金额。
  - **站点访问令牌**：想看中转站账户里真正剩多少钱，可点击余额行的钥匙图标，填入站点后台「个人设置」生成的系统访问令牌（不是 `sk-` 开头的 API Key）。令牌按站点域名保存，同一中转站的多套配置共用一份；new-api 站点还需填写数字用户 ID（写入 `New-Api-User` 请求头），one-api 站点留空即可。配置后余额改为读取 `/api/user/self` 的账户额度，并按站点 `/api/status` 返回的 `quota_per_unit` 换算金额。
  - 令牌与 API Key 同等对待：以私有权限原子写入数据目录的 `site_balance_tokens.json`，界面只回显打码值，日志不记录。令牌查询失败时会退回计费接口，数值标黄并在悬停提示中给出站点返回的原始错误。
  - 查询在后台线程执行并限制并发，不会阻塞界面；识别不出计费接口的站点显示「不支持」，Key 失效则显示具体的 HTTP 错误。
- **拖拽排序**：配置卡片提供拖拽手柄，可调整列表顺序并自动保存；Codex、Grok、Gemini 配置列表同样支持。

### 2. Claude Desktop 第三方 API

- **独立配置列表**：在 `Claude Desktop` 页面维护专用供应商，也可以从 Claude Code 配置复制导入；导入后两边独立管理，后续编辑互不影响。
- **三种连接模式**：Official 恢复 Claude 官方连接；Direct 将 Anthropic Messages 上游直接写入 Claude Desktop；Gateway 由 VarSwitch 在本机转换并转发 Anthropic Messages 或 OpenAI Chat Completions 上游。
- **角色模型映射**：可分别配置默认、Sonnet、Opus、Haiku 上游模型；Claude Desktop 请求稳定的 Claude 角色模型名称，本地 Gateway 再映射到供应商模型。
- **独立高可用状态**：Gateway 使用独立于 Claude Code 的主上游、备用池、熔断器和健康统计，互不覆盖运行状态。
- **本地鉴权**：Gateway 使用 VarSwitch 随机生成并持久化的本地路由凭据，不使用 `PROXY_MANAGED`，也不会把本地路由凭据转发给第三方上游。
- **事务写入**：启用或同步配置时保留 Claude Desktop 文件中的未知字段和其他 Profile；任一文件写入失败会恢复全部相关文件及原活动状态。
- **平台限制**：Windows 和 macOS 支持写入并启用 Claude Desktop 3P Profile；Linux 可保存供应商，但不支持启用 3P Profile。

### 3. 本地代理故障转移

针对经本地协议转换代理的 OpenAI 兼容配置，提供高可用能力：

- **备用上游池**：在其他 OpenAI 兼容格式的配置中勾选「加入代理故障转移池」，即可作为备用上游。
- **自动故障转移**：请求候选顺序为当前激活配置加池内配置（按列表顺序）。在尚未向客户端返回任何数据前，连接失败/超时、5xx、429 会自动换下一个候选重试；4xx 视为配置问题直接返回；流式响应一旦开始转发不再切换。
- **熔断器**：单个上游连续失败 3 次后熔断 60 秒，期间跳过该上游；到期进入半开状态放行一个探测请求，成功则恢复，失败则重新熔断。
- **代理健康面板**：激活配置走本地代理时，Claude 页显示代理运行状态、主/备上游、失败与总请求数、自动转移次数、最近错误，并支持一键重置熔断器。

### 4. 编辑器同步

VarSwitch 会自动检测并同步下列编辑器的 Claude Code 设置：

- VS Code
- VS Code Insiders
- Cursor
- Windsurf
- Trae
- VSCodium

在「Settings / 设置」中可以为每个编辑器手动指定 `settings.json` 路径；也可以填写用户配置目录，应用会自动补全为 `settings.json`。

### 5. Codex CLI 配置管理

- **Codex 独立配置列表**：在 `Codex CLI` 页面维护 Codex 专用配置。
- **配置字段**：配置名称、API Key、Base URL、模型、Provider、写入方式。
- **Provider 预设**：内置 13 个 Provider 预设（OpenAI 官方、DeepSeek、Kimi、智谱 GLM、MiniMax、SiliconFlow、OpenRouter、阿里云百炼、火山方舟 Coding Plan、百度千帆、美团 LongCat、Groq、心流 iFlow），也支持自定义。
- **两种写入方式**：
  - 默认写入：写入 `~/.codex/auth.json` 和 `~/.codex/config.toml`
  - 官方账号/API 额度模式：只写入 `~/.codex/config.toml`，不改动 `auth.json`
- **Codex 当前状态**：读取并展示 Codex 当前 API Key、Base URL、模型、Provider 等状态。
- **Codex 诊断**：检查 `~/.codex/config.toml`、`~/.codex/auth.json` 是否存在，是否包含模型、Provider、Base URL、API Key，并给出修复建议。
- **Codex 运行时备份**：可一键备份 `config.toml` 和 `auth.json`。
- **手动同步**：当前有活动 Codex 配置时，可使用 `Sync Now` 重新写入。

### 6. Grok CLI 与 Gemini CLI 配置管理

- **Grok 独立配置列表**：内置 4 个 xAI 预设（Official、Grok Fast、Grok 4.5、Grok Build），也支持自定义。切换时写入 `~/.grok/config.toml`（把默认模型指向 VarSwitch 托管的模型段，保留文件中的其他内容），并同步 `XAI_API_KEY` / `XAI_BASE_URL`、`GROK_API_KEY` / `GROK_BASE_URL` 等系统环境变量。
- **Gemini 独立配置列表**：切换时写入 `~/.gemini/settings.json`（认证方式与模型），并同步 `GEMINI_API_KEY`、`GOOGLE_GEMINI_BASE_URL`、`GEMINI_MODEL` 系统环境变量。
- **当前状态**：读取并展示 Grok / Gemini 当前生效的配置来源、Base URL 与模型。

### 7. Codex Toolbox

Codex 页面提供 `Codex Toolbox`，包含三个主要模块。

#### Plugin Market

- 查看当前 Codex 插件市场配置。
- 安装/应用插件市场到 Codex。
- 支持多个来源类型，包括 GitHub、GitCode、本地路径等。
- 保留已有插件市场片段并写回 `~/.codex/config.toml`。
- 检测 OpenAI Codex 内置插件市场。
- 修复 OpenAI bundled 插件市场配置。
- 查看内置插件状态、已启用数量、关键插件启用情况。
- 一键启用关键插件，例如 Computer Use / Chrome 相关插件。

#### Session Sync

- 扫描本机 Codex 会话记录。
- 将本地 Codex 历史会话同步到 VarSwitch。
- 展示已同步会话数量、最后同步时间和会话预览。
- 为移动端控制选择可操作的 Codex 会话。

#### Mobile Control

- 将移动平台消息转发到指定 Codex 会话，实现手机端控制。
- 支持绑定/配置：
  - 飞书 / Lark
  - QQ
  - 微信
- 支持配置平台凭据，如 App ID、App Secret、Bot Token、Account ID、Base URL、User ID、Bot Open ID、Gateway URL。
- 支持扫码绑定 QQ、微信。
- 支持飞书/Lark 机器人创建、注册轮询和已有机器人绑定。
- 支持选择/绑定/解绑 Codex 会话。
- 支持启动/停止平台监听。
- 支持高级控制状态检测、协议事件日志和待审批请求提交。

### 8. 会话管理器

「会话（Sessions）」页面用于管理本机 CLI 历史会话：

- 聚合扫描 Claude Code（`~/.claude/projects`）与 Codex（`~/.codex/sessions`、`~/.codex/archived_sessions`）的会话记录。
- 列表展示会话标题、工作目录与更新时间，按更新时间降序排列。
- 支持按标题、目录或会话 ID 搜索，并按来源（全部 / Claude / Codex）筛选。
- **一键恢复**：Claude 会话在新终端窗口执行 `claude -r <会话ID>`（原工作目录仍存在时先切换过去）；Codex 会话通过 `codex://threads/<ID>` 深链在桌面应用中打开。

### 9. Skills 管理

顶部工具栏的 Skills 入口用于管理 Claude Code 扩展能力：

- 查看已安装的 slash commands 与 skills。
- 新增、编辑、删除本地 Skill/Command。
- 读取 `~/.claude/commands` 与 `~/.claude/skills`。
- 从 `SKILL.md` frontmatter 中解析 description。
- Discover 页浏览技能目录。
- 支持管理技能仓库来源。
- 支持从 GitHub 搜索 skills。
- 支持从 URL 安装 skill。
- **从 ZIP 安装**：选择本地 ZIP 一键安装 Skill，自动定位包内 `SKILL.md`（支持位于根目录、唯一顶层目录或子目录），内置 zip-slip 路径穿越防护；可同时安装到 Claude（`~/.claude/skills/`）与 Codex（`~/.codex/skills/`），同名技能已存在时确认后覆盖。

### 10. Prompts 预设库与编辑

顶部工具栏的 Prompts 入口用于维护多套提示词并跨应用同步：

- **预设库（Presets）**：维护多套提示词预设，每套可勾选生效应用（Claude / Codex / Gemini）。
- **激活即写入**：激活预设时，把内容写入所勾选应用的 live 文件：`~/.claude/CLAUDE.md`、`~/.codex/AGENTS.md`、`~/.gemini/GEMINI.md`。
- **回填保护**：激活新预设前，若检测到 live 文件在上次写入后被手工修改过，会先把这些修改回填到原激活预设，避免手工改动丢失。
- **编辑器（Editor）**：直接读取和保存 `~/.claude/CLAUDE.md`。
- **模板库（Templates）**：可快速插入/替换常用提示词模板，也可将模板一键存为预设。
- 内置模板类别包括：
  - 中文开发者
  - 简洁模式
  - 代码质量
  - 安全优先
  - Full-Stack TypeScript
  - Python
  - Rust
  - React & Next.js
  - 软件架构
  - 数据库设计
  - TDD
  - Claude Code 最佳实践
  - Git 工作流
  - 错误处理
  - Code Review
  - 项目脚手架
  - 重构指南

### 11. MCP Server 跨应用管理

顶部工具栏的 MCP 入口统一管理三个应用的 MCP Server：

- **聚合展示**：汇总 Claude（`~/.claude.json` 的 `mcpServers`）、Codex（`~/.codex/config.toml` 的 `[mcp_servers.<name>]` 段）、Gemini（`~/.gemini/settings.json` 的 `mcpServers`）中的全部 Server。
- **按应用启停**：每个 Server 卡片提供 Claude / Codex / Gemini 应用徽标（chip），点击即可单独启停；在最后一个启用应用中停用会先确认，再从所有应用移除。
- **保留原文件内容**：写回 `~/.codex/config.toml` 时保留其他配置内容，兼容 `env` 内联表与子表两种写法。
- 新增、编辑、删除 MCP Server，可勾选写入的应用。
- 使用 JSON 方式编辑单个 MCP Server 配置。
- 提供 MCP Server 预设列表。
- 支持在 GitHub 搜索 MCP Server。
- 支持打开相关 GitHub 页面。

### 12. 设置、备份与恢复

在 Settings 中可以管理应用行为与路径：

- **Language**：中文 / English。
- **Theme**：Light / Dark。
- **Launch at startup**：开机自启。
- **Silent startup**：启动后静默最小化到系统托盘。
- **Minimize to tray**：关闭窗口时隐藏到托盘而不是退出。
- **Global shortcut**：全局快捷键，在任意界面按组合键显示/隐藏主窗口。默认关闭；在设置中点击输入框并按下组合键即可录制（须包含 Ctrl / Alt / Win），点「清除」关闭。
- **Config directory**：打开 VarSwitch 应用配置目录。
- **数据目录（多设备同步）**：查看当前数据目录，切换到自定义目录或恢复默认，详见下一节。
- **Claude settings**：查看 `~/.claude/settings.json` 路径。
- **Runtime logs**：打开运行日志目录。
- **编辑器路径**：查看自动检测状态，或手动设置各编辑器 `settings.json` 路径。
- **Export Profiles**：导出 Claude 配置列表。
- **Import Profiles**：导入 Claude 配置列表。
- **Auto backup**：切换前自动备份配置。
- **Roll back**：查看并恢复配置备份。
- **配置体检**：一键探测全部配置的 Base URL 是否仍然可用，按严重程度列出结果，只做检测不修改任何配置。判定分五档：
  - `可用`：接口正常响应，并显示延迟。
  - `不可达`：域名解析失败或请求超时，通常意味着中转站已下线。
  - `有问题`：站点明确返回了鉴权错误，并原样透出站点给的原因（如「余额不足，请充值后重试」「API Key 已被禁用」「Invalid token」）——余额不足只需充值，不必删配置。
  - `可疑`：站点返回的是网页而非接口（多为 Cloudflare 等 WAF 拦截），此时 API Key 未必失效，不应据此删除配置。
  - `已跳过`：未填写 API Key 或 Base URL。
  - 探测统一走各站点的模型列表接口（不消耗额度），Anthropic 官方端点自动改用 `x-api-key` 鉴权头以免误判；并发上限 6，整体在后台线程执行，不阻塞界面。

自动备份包含：

- Claude / Codex / Grok / Gemini 四份配置列表备份
- Codex 运行时文件备份：`~/.codex/config.toml`、`~/.codex/auth.json`
- Grok 运行时文件备份：`~/.grok/config.toml`

### 13. 数据可靠性与多设备同步

- **API Key 加密存储**：配置文件里的 API Key、Codex 图片 Key、站点访问令牌不再明文落盘，而是用 AES-256-GCM 加密后写成 `enc:v1:...`。主密钥（32 字节随机）保存在系统凭据库（Windows 凭据管理器 / macOS 钥匙串），从不写入数据目录。
  - **自动迁移**：升级后首次启动会把历史明文就地转成密文，转换前先做一次完整备份；没有明文则跳过。
  - **多设备限制**：主密钥绑定当前设备，因此把数据目录放在网盘上时，**另一台设备解不开这份密文**。此时读取会保留原始密文而不是清空（不会损坏数据），切换该配置则会被拦下并提示「无法在本机解密，请重新填写」，避免把密文当成 Key 写进环境变量。
  - **降级策略**：系统凭据库不可用时自动退回明文存储并记录日志，功能不中断。
- **原子写入**：所有配置类文件（应用数据、`~/.claude/settings.json`、`~/.codex/config.toml` 等）都先写同目录临时文件、再重命名替换，进程崩溃或断电也不会留下写坏的半成品配置。
- **自定义数据目录**：在 Settings 中可把数据目录指向 OneDrive、Dropbox、坚果云、NAS 等同步文件夹，多台设备共享同一套配置数据。
- **智能复制**：切换目录时把现有 `*.json` 配置与 `backups` 目录复制到目标位置，目标已存在同名文件时跳过、绝不覆盖，避免冲掉其他设备同步来的更新数据。
- **指针文件**：指向关系记录在默认数据目录下的 `data_dir_override.txt`；目标目录不可用（如网盘未挂载）时自动回落默认目录，不影响启动。

### 14. Deep Link 一键导入

应用注册 `varswitch://` 协议，支持从网页、文档或聊天中一键导入：

- `varswitch://import/profile?app=<claude|codex|gemini|grok>&payload=<base64url(JSON)>`：导入单条配置，payload 含 `name`、`apiKey`，可选 `baseUrl`、`model` 等字段。
- `varswitch://import/mcp?payload=<base64url(JSON)>`：导入 MCP Server，payload 含 `name`、`config`，可选 `apps` 指定启用的应用。
- `varswitch://v1/import?resource=provider&app=<claude|codex|gemini>&name=...&endpoint=...&apiKey=...&model=...&homepage=...&enabled=true`：兼容 CC Switch v1 Provider Import 查询参数；Claude 还可传 `haikuModel`、`sonnetModel`、`opusModel`。
- **导入前确认**：链接只做解析与校验，随后弹出确认框展示导入内容，API Key 打码显示（仅保留前 6 位与后 4 位），并提示确认链接来源可信，防止钓鱼。
- 旧版 Profile/MCP 深链确认后仅新增；v1 同名时按下一条规则处理；均不自动激活或切换。
- v1 同名配置默认重命名后新增，也可在确认框中明确选择覆盖；无论 `enabled` 为 `true`，导入都不会自动激活或切换。

### 15. 更新、下载站与仓库入口

首页快捷入口包括：

- **Usage Guide**：打开内置使用指南。
- **Check for Updates**：检查应用更新。
- **Download Site**：打开下载站。
- **GitHub Repo**：打开项目仓库。
- **Codex Toolbox**：快速进入 Codex 工具箱。

应用内更新使用 Tauri updater，更新源为：

```text
https://download.varswitch.strova.top/latest.json
```

下载页入口为：

```text
https://download.varswitch.strova.top/
```

### 16. 系统托盘

- 启动后创建系统托盘图标。
- 左键点击托盘图标可恢复主窗口。
- **托盘快速切换**：托盘菜单按应用分为 Claude / Codex / Gemini / Grok / OpenCode 五个子菜单，子菜单标题显示当前激活配置名（如 `Claude · 主力配置`），菜单项列出该应用全部配置并在激活项上打勾，点击即可在后台完成切换。
- 配置增删改、切换或导入后，托盘菜单自动刷新。
- 托盘菜单还包含：
  - 显示主窗口
  - 退出
- 若启用「关闭窗口时最小化到托盘」，点击窗口关闭按钮会隐藏窗口。
- 若启用「静默启动」，应用启动后直接隐藏到托盘。

## 快速使用

### Claude Code 配置切换

1. 打开 VarSwitch。
2. 在 `Claude Code` 页面点击 `+ 添加配置`。
3. 填写配置名称、令牌、Base URL，可选填写模型 ID。
4. 如需确认接口可用，点击 `Test Speed` 测试地址。
5. 保存配置。
6. 在配置列表中点击 `Switch`。
7. 等待系统环境变量、编辑器设置、Claude 设置全部同步完成。
8. 重启终端和编辑器，让新的环境变量生效。

如果本机已经有可用配置，可以点击顶部 `导入当前配置`，从现有系统/Claude/编辑器配置中导入。

### Claude Desktop 第三方 API

1. 打开 VarSwitch，进入 `Claude Desktop` 页面。
2. 点击 `+ 添加配置`，或点击 `从 Claude Code 导入` 后再独立编辑配置。
3. 选择连接模式：
   - `Gateway`：支持 Anthropic Messages 和 OpenAI Chat Completions；本地地址固定为 `http://127.0.0.1:25789/claude-desktop`，使用期间必须保持 VarSwitch 运行。
   - `Direct`：仅支持 Anthropic Messages；切换成功后不需要保持 VarSwitch 运行。
   - `Official`：恢复 Claude 官方连接。
4. 填写供应商 Base URL、API Key，以及默认/Sonnet/Opus/Haiku 模型映射并保存。
5. 在配置卡片上点击 `启用`。
6. 完全退出 Claude Desktop（包括托盘或后台进程）后重新启动，使 3P Profile 生效。

启用或同步不会直接展示本地 Gateway 凭据。不要把第三方 API Key 填成 `PROXY_MANAGED`；Gateway 会使用配置中真实的第三方 Key 请求上游。

### Codex CLI 配置切换

1. 切换到 `Codex CLI` 页面。
2. 点击 `+ 添加配置`。
3. 选择预设或使用自定义 Provider。
4. 填写 API Key、Base URL、模型、Provider。
5. 选择写入方式：
   - 普通 API Key：使用默认写入。
   - 已登录官方账号且希望走 API 额度：选择官方账号/API 额度模式。
6. 保存配置。
7. 在配置列表中点击 `Switch`。
8. 如有异常，点击 `刷新诊断` 查看问题和建议。

### 管理 Claude Code Skills

1. 点击顶部工具栏的 Skills 图标。
2. 在 `Installed` 中查看本地 commands/skills。
3. 点击 `+ Add Skill` 创建新项，或选择已有项编辑。
4. 点击 `从 ZIP 安装` 选择本地 ZIP，勾选安装到 Claude / Codex 后确认。
5. 在 `Discover` 中浏览仓库技能目录。
6. 可使用 GitHub 搜索或 Repos 管理技能来源。

### 管理 Prompts 预设

1. 点击顶部工具栏的 Prompts 图标。
2. 在 Presets 中新建或编辑预设，勾选要生效的应用（Claude / Codex / Gemini）。
3. 激活预设，内容即写入所勾选应用的 live 文件。
4. 在 Editor 中可直接编辑 `~/.claude/CLAUDE.md`。
5. 可切换到 Templates 选择内置模板，或将模板一键存为预设。

### 管理 MCP Server

1. 点击顶部工具栏的 MCP 图标。
2. 在 Installed 中查看聚合自 Claude、Codex、Gemini 的 MCP Server。
3. 点击 `+ Add Server` 添加服务。
4. 填写 Server Name、JSON 配置，并勾选启用到的应用。
5. 保存后写入所选应用的配置文件；也可以直接点击卡片上的应用徽标启停。
6. 可在 Presets 中查看预设或搜索 GitHub。

### 使用 Codex 移动端控制

1. 进入 `Codex CLI` 页面。
2. 点击 `打开 Codex Toolbox`。
3. 在 `Session Sync` 中点击 `Sync Now`，导入本机 Codex 会话。
4. 在 `Mobile Control` 中选择要控制的会话。
5. 选择飞书/Lark、QQ 或微信，并完成平台凭据或扫码绑定。
6. 点击 `Start Platform Link` 启动监听。
7. 在手机端对应平台发送消息，即可转发到绑定的 Codex 会话。

## 配置写入位置

### Claude Code/API

| 位置 | 写入内容 |
| --- | --- |
| 系统环境变量 | `ANTHROPIC_AUTH_TOKEN` / `ANTHROPIC_AUTH_KEY`、`ANTHROPIC_BASE_URL`，选填角色模型映射 `ANTHROPIC_DEFAULT_SONNET_MODEL` / `ANTHROPIC_DEFAULT_OPUS_MODEL` / `ANTHROPIC_DEFAULT_HAIKU_MODEL` |
| Claude 设置 | `~/.claude/settings.json` 的 `env`（含角色模型映射） |
| 编辑器设置 | `claudeCode.environmentVariables`（含角色模型映射） |
| VarSwitch 配置 | 数据目录中的 profiles 数据 |

### Claude Desktop

| 平台/位置 | 写入内容 |
| --- | --- |
| Windows `%LOCALAPPDATA%/Claude/claude_desktop_config.json` | Claude Desktop 部署模式与当前 Profile 引用 |
| Windows `%LOCALAPPDATA%/Claude-3p/claude_desktop_config.json` | Claude Desktop 3P 部署配置 |
| Windows `%LOCALAPPDATA%/Claude-3p/configLibrary/_meta.json` | 3P Profile 元数据与当前 Profile 引用 |
| Windows `%LOCALAPPDATA%/Claude-3p/configLibrary/<VarSwitch Profile ID>.json` | VarSwitch 管理的 Gateway 或 Direct Profile |
| macOS `~/Library/Application Support/Claude/` | Claude Desktop 配置根目录 |
| macOS `~/Library/Application Support/Claude-3p/` | Claude Desktop 3P 配置与 Profile 库根目录 |
| Linux | 仅保存 VarSwitch 供应商；不支持启用 Claude Desktop 3P Profile |
| VarSwitch 数据目录 | 独立加密保存 Claude Desktop suppliers 与本地 Gateway 状态 |

### Codex CLI

| 位置 | 写入内容 |
| --- | --- |
| `~/.codex/auth.json` | `OPENAI_API_KEY`，仅默认写入模式 |
| `~/.codex/config.toml` | `model_provider`、`model`、`chatgpt_base_url`、`model_providers`、`base_url` 等 |
| VarSwitch 配置 | 数据目录中的 Codex profiles 数据 |

### Grok CLI

| 位置 | 写入内容 |
| --- | --- |
| `~/.grok/config.toml` | VarSwitch 托管的 `[model.*]` 段（模型、Base URL、API Key 等）并设为默认模型，保留其他内容 |
| 系统环境变量 | `XAI_API_KEY` / `XAI_BASE_URL`、`GROK_API_KEY` / `GROK_BASE_URL`，选填 `XAI_MODEL` |
| VarSwitch 配置 | 数据目录中的 Grok profiles 数据 |

### Gemini CLI

| 位置 | 写入内容 |
| --- | --- |
| `~/.gemini/settings.json` | 认证方式（`security.auth.selectedType`）与模型（`model.name`） |
| 系统环境变量 | `GEMINI_API_KEY`、`GOOGLE_GEMINI_BASE_URL`、`GEMINI_MODEL` |
| VarSwitch 配置 | 数据目录中的 Gemini profiles 数据 |

### Prompts 预设

| 位置 | 写入内容 |
| --- | --- |
| `~/.claude/CLAUDE.md` | 激活预设且勾选 Claude 时写入；Editor 直接编辑 |
| `~/.codex/AGENTS.md` | 激活预设且勾选 Codex 时写入 |
| `~/.gemini/GEMINI.md` | 激活预设且勾选 Gemini 时写入 |
| VarSwitch 配置 | 数据目录中的 `prompt_presets.json` |

### MCP Server

| 位置 | 写入内容 |
| --- | --- |
| `~/.claude.json` | `mcpServers` 对象 |
| `~/.codex/config.toml` | `[mcp_servers.<name>]` 段，保留文件其他内容 |
| `~/.gemini/settings.json` | `mcpServers` 对象 |

### Skills

| 位置 | 写入内容 |
| --- | --- |
| `~/.claude/skills/<name>/` | 新建或从 ZIP / URL 安装的 Skill |
| `~/.codex/skills/<name>/` | ZIP 安装勾选 Codex 时写入 |

### 数据目录

| 位置 | 写入内容 |
| --- | --- |
| 默认数据目录 | 应用数据（profiles、prompt_presets 等 `*.json` 与 `backups/`），未自定义时使用 |
| `site_balance_tokens.json` | 余额查询用的站点访问令牌，按站点域名存放，私有权限写入 |
| `data_dir_override.txt` | 默认数据目录下的指针文件，内容为自定义数据目录的绝对路径 |
| 自定义数据目录 | 指针文件生效后，上述应用数据改存于该目录 |

## 开发环境要求

- Node.js >= 18
- Rust >= 1.70
- Tauri v2 系统依赖

## 开发

```bash
npm ci
npm run dev
```

`dev.bat` 仅是 Windows 兼容入口；macOS 终端不能运行 `.bat`，请使用 `npm run dev`。
Mac mini 不需要打开 Xcode IDE；安装 Xcode Command Line Tools、Node.js 和 Rust 后即可开发。

## 本地构建

```bash
npm run build
```

`npm run build` 按当前电脑生成原生安装包：Mac 生成 `.app` 与 `.dmg`，Windows 生成 NSIS
`.exe` 安装包。macOS 必须在 Mac 上构建，Windows 必须使用 Windows 编译环境；Xcode IDE
不负责 VarSwitch 的打包，Tauri 会调用 Rust 工具链、macOS 系统工具和 `hdiutil`。
Mac 本地 ad-hoc 包不包含自动更新签名，只适合本机检查和安装测试。

`dev.bat` 和 `build.bat` 只为 Windows 保留，分别转发到 `npm run dev` 与 `npm run build`。
Mac 上请使用 npm 命令，不要运行 `.bat` 文件。

构建产物位于：

```text
src-tauri/target/release/bundle/
```

本地构建只生成当前平台的安装包。正式发布时，GitHub Actions 会自动在云端构建 Windows、
Apple 芯片 Mac 和 Intel Mac，不需要在 Windows 电脑上拉代码。

## CI/CD

推送 `v*` 标签后，会并行构建三个目标：

| 作业 | 安装包 |
| --- | --- |
| Windows x64 | `VarSwitch_<版本>_x64-setup.exe` |
| macOS Apple Silicon | `VarSwitch_<版本>_aarch64.dmg` |
| macOS Intel | `VarSwitch_<版本>_x64.dmg` |

每个作业同时产出更新包与 `.sig` 签名供自动更新使用。macOS 的更新包被显式重命名为
`VarSwitch_<版本>_<架构>.app.tar.gz`，因为 Tauri 默认命名不含架构，两个 macOS
作业会上传同名文件并互相覆盖。

需要在仓库 Settings > Secrets and variables > Actions 中配置：

- `TAURI_SIGNING_PRIVATE_KEY`：`src-tauri/updater.key` 的完整内容，必填
- `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`：私钥设置了密码时填写；无密码时留空

缺少私钥时工作流会直接失败。否则构建仍会成功，但产物没有签名，对应平台会被静默
排除在 `latest.json` 之外，表现为「CI 全绿，用户却收不到更新」。

## 发布流程

平时本地试运行用 `npm run dev`；只想在 Mac 上打一个本地测试包用 `npm run build`。
正式发布则双击仓库根目录的 `build.command`，或在终端执行 `./build.command`，输入版本号：

```bash
./build.command
```

首次使用时确认 Mac mini 的 GitHub SSH 权限可推送 `origin`。脚本会列出当前未提交改动并请你
确认；确认后将这些改动与版本号一起提交。随后运行前端与 Rust 测试并推送标签；GitHub
Actions 随后构建 Windows x64、Apple 芯片 Mac 和 Intel Mac。**不需要切换到 Windows 电脑，也
不需要在那里 git pull。**

等 GitHub Actions 的三平台构建完成后，双击 `deploy.command` 或运行 `./deploy.command`，输入
同一个版本号；脚本会自动下载 Windows 与两种 Mac 安装包、更新下载页和 updater 清单，再部署
到 Vercel：

```bash
./deploy.command
```

两台服务只需首次登录和关联一次：

```bash
gh auth login
npx --yes vercel login
npx --yes vercel link --cwd varswitch-download-site
```

`build.command` 和 `deploy.command` 是简单交互入口；也可以继续直接使用 `npm run release`、
`npm run release:sync` 与 `npm run site:deploy`。

私有仓库的 macOS runner 按 10 倍分钟计费，GitHub Free 的 2000 分钟/月相当于约 200
分钟 macOS 构建时间。工作流已启用 Rust 编译缓存，首次构建较慢，之后会显著缩短。

`sync-mac-release.mjs` 由 `npm run release:sync` 调用，同步完整的三平台发布产物并生成
供自有下载域名使用的 `latest.json`。工作流等待三平台完成后统一生成更新清单，避免并行
构建互相覆盖平台信息。

### macOS 签名与公证

没有 Apple Developer 证书时，发布入口会显式使用临时签名（ad-hoc），检查 App、
DMG 和自动更新包的签名完整性。该版本仍会被 Gatekeeper 拦截，首次使用需按下方说明
手动放行。临时签名不能替代 Apple 公证，也不能保证浏览器下载后直接打开。

若要免去这一步，需要 Apple Developer 账号的 `Developer ID Application` 证书。
Tauri 的 `TAURI_SIGNING_PRIVATE_KEY` 仅用于自动更新包签名，不能代替 Apple 签名或公证。

在 GitHub 仓库 Settings → Secrets and variables → Actions 中配置（Apple 凭据全不配置
时使用临时签名；只配置了一部分则报错，不静默降级）：

| Secret | 内容 |
| --- | --- |
| `APPLE_CERTIFICATE` | 包含私钥的 Developer ID Application `.p12` 文件，转成 base64 |
| `APPLE_CERTIFICATE_PASSWORD` | 导出 `.p12` 时设置的密码 |
| `APPLE_SIGNING_IDENTITY` | 完整证书名称，如 `Developer ID Application: Your Name (TEAMID)` |
| `APPLE_ID` | 公证使用的 Apple ID |
| `APPLE_PASSWORD` | 该 Apple ID 的 app-specific password，不是登录密码 |
| `APPLE_TEAM_ID` | Apple Developer Team ID，与证书一致 |
| `TAURI_SIGNING_PRIVATE_KEY` | Tauri 自动更新私钥 |
| `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` | 更新私钥密码；没有密码时留空 |

获取证书 base64 的示例：

```bash
openssl base64 -A -in certificate.p12 -out certificate-base64.txt
```

提供完整 Apple 凭据后，Tauri CLI 会把证书导入临时钥匙串，启用 Hardened Runtime，
签名 App 并提交 Apple 公证、装订公证票据。无需单独配置 `KEYCHAIN_PASSWORD`。
无证书时会移除空的公证环境变量，避免被 Tauri 误认为已配置凭据。

`scripts/release-build.mjs` 在上传前校验构建出的 App、解压后的自动更新 App，以及
实际挂载 DMG 中的 App：都必须通过严格签名校验。有 Apple 凭据时还必须通过证书
Team ID、公证票据和 Gatekeeper 检查。任一适用检查失败均中止上传，所有平台通过后
才公开草稿 Release。发布说明会明确标注是否经过 Apple 公证。

本地仅验证安装包时，可禁用自动更新产物，无需更新私钥：

```bash
npm run tauri -- build --bundles app,dmg --config '{"bundle":{"createUpdaterArtifacts":false}}'
```

默认使用临时签名；没有 Developer ID 签名及 Apple 公证的本地产物仍需手动放行。
正式构建入口为
`npm run release:build -- build --target aarch64-apple-darwin --bundles app,dmg`
（Intel 使用 `x86_64-apple-darwin`），至少需要 Tauri 更新签名密钥；Apple 凭据可选。

无证书版本（包括历史未公证版本）下载后可能被 Gatekeeper 拦截。“已损坏”也可能由
签名失效或下载不完整导致，不能一概认定文件完好。确认从本项目下载后，将 App 拖入
「应用程序」，在终端先校验签名完整性，通过后只清除这个 App 的隔离标记：

```bash
codesign --verify --deep --strict /Applications/VarSwitch.app && xattr -rd com.apple.quarantine /Applications/VarSwitch.app
```

该命令不会修复无效签名或真实的文件损坏，也不代替正式发布所需的签名、公证。

### macOS 配置切换

- 按 `SHELL` 选择持久化位置：zsh 使用 `${ZDOTDIR:-$HOME}/.zshrc`；bash 同时写入
  `.bashrc` 与实际使用的 login 文件（`.bash_profile` / `.bash_login` / `.profile`）；
  fish 使用 `${XDG_CONFIG_HOME:-$HOME/.config}/fish/config.fish`。
- 对变量值作 Shell 转义，避免 `$`、反引号、引号等字符被展开。清理旧变量时写入
  `unset`，避免旧的继承值再次覆盖配置。用户自己维护的其他配置行和符号链接会保留。
- macOS 同时通过 `launchctl setenv/unsetenv` 更新用户环境，供之后启动的 GUI 应用继承；
  写入失败时不会把进程内状态提前改成成功。
- 切换在后台执行；有注释、尾随逗号的编辑器 JSONC 设置可以读取。文件无法解析时
  会报错并保留原文件。切回默认模型会清除上一配置留下的模型选择。
- 切换失败或取消时由后端恢复环境变量、编辑器/Claude 配置和代理上游，托盘切换也使用
  同一流程。原本不存在的配置文件会删除，恢复失败会明确报告。
- 已运行的终端、CLI 和编辑器无法被外部进程直接修改环境变量。切换后请新开终端，
  并完全退出后重新打开编辑器。代理模式仍需保持 VarSwitch 运行。

## 项目结构

```text
├── public/              # 前端资源
│   ├── index.html       # 主页面
│   ├── app.js           # 应用逻辑
│   ├── app-helpers.js   # 前端辅助函数
│   ├── app.test.js      # 前端测试
│   ├── style.css        # 样式
│   └── app-icon.png     # 应用图标
├── src-tauri/           # Tauri / Rust 后端
│   ├── src/lib.rs       # 核心逻辑：配置读写、环境变量同步、托盘、会话、Codex Toolbox、Skills、Prompts、MCP、Deep Link
│   ├── src/claude_proxy.rs  # 本地协议转换代理：Anthropic/OpenAI 双向翻译、故障转移与熔断
│   ├── src/claude_desktop_provider.rs  # Claude Desktop 供应商、加密存储与 3P Profile 事务投影
│   ├── src/claude_desktop_gateway.rs   # Claude Desktop 本地鉴权、模型映射、转发与独立健康状态
│   ├── src/main.rs      # Tauri 入口
│   ├── Cargo.toml       # Rust 依赖
│   ├── tauri.conf.json  # Tauri 配置
│   └── capabilities/    # Tauri 权限配置
├── .github/workflows/   # CI 构建配置（Windows + macOS 双架构）
├── varswitch-download-site/  # 下载站，含 releases 与 latest.json
├── scripts/             # 跨平台开发、本地构建、版本发布与签名校验入口
├── dev-server.js        # 前端开发静态服务器
├── dev.bat              # Windows 开发脚本
├── build.bat            # Windows 构建脚本
├── sync-mac-release.mjs # 把 CI 构建的三平台产物同步进下载站
└── README.md            # 使用说明
```

## 许可证

MIT
