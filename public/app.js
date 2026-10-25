const $ = (id) => document.getElementById(id);

// 安全 DOM 写入，避免初始化因缺失节点中断
function setText(id, value) {
  const el = $(id);
  if (el) el.textContent = value;
}
function setHtml(id, value) {
  const el = $(id);
  if (el) el.innerHTML = value;
}
function setPlaceholder(id, value) {
  const el = $(id);
  if (el) el.placeholder = value;
}
function setTitle(id, value) {
  const el = $(id);
  if (el) el.title = value;
}
function on(id, event, handler) {
  const el = $(id);
  if (el) el.addEventListener(event, handler);
  return el;
}

/**
 * 绑定「点击遮罩空白处关闭弹窗」。
 *
 * 只监听 click 会有一个经典缺陷：在输入框里按下鼠标、拖到框外（比如从右往左选中文本）
 * 再松开时，浏览器会把 click 派发到 mousedown / mouseup 两个节点的最近公共祖先，
 * 也就是遮罩本身，于是 event.target === overlay 成立，弹窗被误关闭。
 *
 * 这里要求「按下」和「松开」都发生在遮罩自身，才算一次真正的空白点击。
 */
function bindOverlayDismiss(overlayId, closeFn) {
  const overlay = $(overlayId);
  if (!overlay) return null;
  let pressedOnOverlay = false;

  const markPress = (event) => {
    // 只认鼠标左键 / 触摸 / 笔的主按键
    pressedOnOverlay = event.button === 0 && event.target === overlay;
  };

  overlay.addEventListener("pointerdown", markPress);
  // 老 WebView 没有 pointer 事件时的兜底
  overlay.addEventListener("mousedown", (event) => {
    if (window.PointerEvent) return;
    markPress(event);
  });

  overlay.addEventListener("click", (event) => {
    const shouldClose = pressedOnOverlay && event.target === overlay;
    pressedOnOverlay = false;
    if (shouldClose) closeFn(event);
  });

  return overlay;
}

const tauriApi = window.__TAURI__;
const helpers = window.VarSwitchHelpers || {};

if (!tauriApi?.core?.invoke || !tauriApi?.event?.listen) {
  document.body.innerHTML = `
    <div style="max-width:760px;margin:48px auto;padding:0 20px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI','PingFang SC','Microsoft YaHei',sans-serif;color:#18181B;line-height:1.6;">
      <h1 style="font-size:22px;margin-bottom:8px;">VarSwitch 启动失败</h1>
      <p style="margin-bottom:6px;">未检测到 Tauri 运行时 API（window.__TAURI__）。</p>
      <p style="opacity:.75;">请使用 <code>dev.bat</code> 或 <code>npm run tauri -- dev</code> 启动，而不是直接在浏览器打开 HTML。</p>
    </div>
  `;
  throw new Error("Tauri API unavailable");
}

const invoke = tauriApi.core.invoke;
const { listen } = tauriApi.event;

// B5: 打印调试日志前过滤凭据字段，避免 secret 出现在 devtools console
const SECRET_KEYS = new Set(["appSecret", "app_secret", "botToken", "bot_token", "apiKey", "api_key", "accessKey", "ticket", "authorization"]);
function sanitizeLogText(value) {
  return String(value || "")
    .replace(/([?&](?:access_key|ticket|token|secret|authorization|app_secret|bot_token|api[_-]?key)=)[^&#\s]*/gi, "$1***")
    .replace(/\b(access_key|ticket|token|secret|authorization|app_secret|bot_token|api[_-]?key)\s*[=:]\s*([^\s,&;\]\}"']+)/gi, "$1=***");
}
function sanitizeForLog(value) {
  if (typeof value === "string") return sanitizeLogText(value);
  if (value instanceof Error) return { name: value.name, message: sanitizeLogText(value.message) };
  if (Array.isArray(value)) return value.map((item) => sanitizeForLog(item));
  if (!value || typeof value !== "object") return value;
  const out = {};
  for (const [k, v] of Object.entries(value)) {
    out[k] = SECRET_KEYS.has(k) && typeof v === "string" && v.length > 0 ? "***" : sanitizeForLog(v);
  }
  return out;
}

function mobileDebug(label, payload = {}) {
  console.log(`[mobile-control] ${label}`, sanitizeForLog({
    selectedMobileChannel,
    selectedCodexThreadId,
    ...payload,
  }));
}

function mobileDebugError(label, error, payload = {}) {
  console.error(`[mobile-control] ${label}`, sanitizeForLog({
    selectedMobileChannel,
    selectedCodexThreadId,
    error,
    ...payload,
  }));
}

const LANG_STORAGE_KEY = "varswitch.lang";
// 记录用户是否在设置里手动选过语言;没有手动选择时,进入软件一律默认中文
const LANG_USER_SET_KEY = "varswitch.lang.userSet";
const THEME_STORAGE_KEY = "varswitch.theme";
const APP_REPOSITORY_URL = "https://github.com/ConcertoNotes/variable-switching";
const APP_DOWNLOAD_PAGE_URL = "https://download.varswitch.strova.top/";
// ── cc-switch 式供应商预设 ──────────────────────────────
// 选择预设即自动填入官方地址与默认模型；Base URL 留空时后端回退到各官方端点。
// Codex 的 wire 表示上游协议：responses = OpenAI Responses（官方），chat = OpenAI Chat Completions（DeepSeek 等第三方）。
const CLAUDE_PRESETS = [
  {
    id: "anthropic",
    name: "Anthropic 官方",
    baseUrl: "https://api.anthropic.com",
    model: "",
  },
  {
    id: "deepseek",
    name: "DeepSeek",
    baseUrl: "https://api.deepseek.com/anthropic",
    model: "deepseek-v4-flash",
  },
  {
    id: "kimi",
    name: "Kimi (Moonshot)",
    baseUrl: "https://api.moonshot.cn/anthropic",
    model: "kimi-k2.6",
  },
  {
    id: "zhipu_glm",
    name: "智谱 GLM",
    baseUrl: "https://open.bigmodel.cn/api/anthropic",
    model: "glm-5.1",
  },
  {
    id: "minimax",
    name: "MiniMax",
    baseUrl: "https://api.minimaxi.com/anthropic",
    model: "MiniMax-M2.7",
  },
  // 文档来源：https://help.aliyun.com/zh/model-studio/claude-code （华北2北京 Anthropic 兼容端点与推荐模型）
  {
    id: "aliyun_bailian",
    name: "阿里云百炼 (Qwen)",
    baseUrl: "https://dashscope.aliyuncs.com/apps/anthropic",
    model: "qwen3.7-max",
  },
  // 文档来源：https://www.volcengine.com/article/38136 （方舟 Coding Plan Anthropic 协议端点，模型 ark-code-latest 由控制台调度）
  {
    id: "volcengine_ark",
    name: "火山方舟 Coding Plan",
    baseUrl: "https://ark.cn-beijing.volces.com/api/coding",
    model: "ark-code-latest",
  },
  // 文档来源：https://cloud.baidu.com/doc/qianfan-docs/s/6mh3e6gjp （千帆 Anthropic Claude API 兼容，推荐模型 deepseek-v3.2）
  {
    id: "baidu_qianfan",
    name: "百度千帆",
    baseUrl: "https://qianfan.baidubce.com/anthropic",
    model: "deepseek-v3.2",
  },
  // 文档来源：https://longcat.chat/platform/docs/zh/claude-code （LongCat 开放平台 Anthropic 兼容端点）
  {
    id: "longcat",
    name: "美团 LongCat",
    baseUrl: "https://api.longcat.chat/anthropic",
    model: "LongCat-2.0",
  },
  // 文档来源：https://docs.siliconflow.cn/cn/usercases/use-siliconcloud-in-ClaudeCode （ANTHROPIC_BASE_URL 填根地址）
  {
    id: "siliconflow",
    name: "SiliconFlow",
    baseUrl: "https://api.siliconflow.cn",
    model: "moonshotai/Kimi-K2-Instruct-0905",
  },
  // 文档来源：https://openrouter.ai/docs/cookbook/coding-agents/claude-code-integration （Anthropic Skin，地址不带 /v1；模型留空由网关映射）
  {
    id: "openrouter",
    name: "OpenRouter",
    baseUrl: "https://openrouter.ai/api",
    model: "",
  },
];

const CODEX_PRESETS = [
  {
    id: "openai",
    name: "OpenAI 官方",
    baseUrl: "https://api.openai.com/v1",
    model: "gpt-5.5",
    providerName: "custom",
    wire: "responses",
  },
  {
    id: "deepseek",
    name: "DeepSeek",
    baseUrl: "https://api.deepseek.com",
    model: "deepseek-v4-pro",
    models: ["deepseek-v4-flash", "deepseek-v4-pro"],
    providerName: "deepseek",
    wire: "responses",
  },
  {
    id: "kimi",
    name: "Kimi (Moonshot)",
    baseUrl: "https://api.moonshot.cn/v1",
    model: "kimi-k2.6",
    providerName: "kimi",
    wire: "chat",
  },
  {
    id: "zhipu_glm",
    name: "智谱 GLM",
    baseUrl: "https://open.bigmodel.cn/api/coding/paas/v4",
    model: "glm-5.1",
    providerName: "zhipu_glm",
    wire: "chat",
  },
  {
    id: "minimax",
    name: "MiniMax",
    baseUrl: "https://api.minimaxi.com/v1",
    model: "MiniMax-M2.7",
    providerName: "minimax",
    wire: "chat",
  },
  {
    id: "siliconflow",
    name: "SiliconFlow",
    baseUrl: "https://api.siliconflow.cn/v1",
    model: "Pro/MiniMaxAI/MiniMax-M2.7",
    providerName: "siliconflow",
    wire: "chat",
  },
  {
    id: "openrouter",
    name: "OpenRouter",
    baseUrl: "https://openrouter.ai/api/v1",
    model: "openai/gpt-5.3-codex",
    providerName: "openrouter",
    wire: "chat",
  },
  // 文档来源：https://help.aliyun.com/zh/model-studio/qwen-api-via-openai-chat-completions （华北2北京 DashScope 公共域名 OpenAI 兼容端点）
  {
    id: "aliyun_bailian",
    name: "阿里云百炼 (Qwen)",
    baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
    model: "qwen3.7-max",
    providerName: "aliyun_bailian",
    wire: "chat",
  },
  // 文档来源：https://www.volcengine.com/article/38136 （方舟 Coding Plan OpenAI 协议端点 /api/coding/v3）
  {
    id: "volcengine_ark",
    name: "火山方舟 Coding Plan",
    baseUrl: "https://ark.cn-beijing.volces.com/api/coding/v3",
    model: "ark-code-latest",
    providerName: "volcengine_ark",
    wire: "chat",
  },
  // 文档来源：https://cloud.baidu.com/doc/qianfan/s/Hmh4suq26 （千帆 OpenAI SDK 兼容 base_url /v2；模型推荐见 https://cloud.baidu.com/doc/qianfan-docs/s/6mh3e6gjp）
  {
    id: "baidu_qianfan",
    name: "百度千帆",
    baseUrl: "https://qianfan.baidubce.com/v2",
    model: "deepseek-v3.2",
    providerName: "baidu_qianfan",
    wire: "chat",
  },
  // 文档来源：https://longcat.chat/platform/docs/zh/APIDocs.html （OpenAI 兼容 POST /openai/v1/chat/completions）
  {
    id: "longcat",
    name: "美团 LongCat",
    baseUrl: "https://api.longcat.chat/openai/v1",
    model: "LongCat-2.0",
    providerName: "longcat",
    wire: "chat",
  },
  // 文档来源：https://console.groq.com/docs/openai （OpenAI 兼容端点；gpt-oss-120b 为 Groq 托管主推开源模型）
  {
    id: "groq",
    name: "Groq",
    baseUrl: "https://api.groq.com/openai/v1",
    model: "openai/gpt-oss-120b",
    providerName: "groq",
    wire: "chat",
  },
  // 文档来源：https://platform.iflow.cn/cli/configuration/settings （心流开放平台 OpenAI 兼容端点与示例模型）
  {
    id: "iflow",
    name: "心流 iFlow",
    baseUrl: "https://apis.iflow.cn/v1",
    model: "Qwen3-Coder",
    providerName: "iflow",
    wire: "chat",
  },
];

// Base URL 留空时前端验证 / 后端保存都会回退到官方地址
const OFFICIAL_BASE_URLS = {
  claude: "https://api.anthropic.com",
  codex: "https://api.openai.com/v1",
  grok: "https://api.x.ai/v1",
  gemini: "https://generativelanguage.googleapis.com",
};

const GROK_PRESETS = [
  {
    id: "xai_official",
    name: "xAI Official",
    baseUrl: "https://api.x.ai/v1",
    model: "grok-4",
  },
  {
    id: "xai_fast",
    name: "xAI Grok Fast",
    baseUrl: "https://api.x.ai/v1",
    model: "grok-3-mini",
  },
  // 文档来源：https://docs.x.ai/developers/models （grok-4.5 为 xAI 当前旗舰模型，500k 上下文）
  {
    id: "xai_grok_45",
    name: "xAI Grok 4.5",
    baseUrl: "https://api.x.ai/v1",
    model: "grok-4.5",
  },
  // 文档来源：https://docs.x.ai/developers/models （grok-build-0.1 为 xAI 编码专用模型，256k 上下文）
  {
    id: "xai_grok_build",
    name: "xAI Grok Build (Coding)",
    baseUrl: "https://api.x.ai/v1",
    model: "grok-build-0.1",
  },
];

// OpenCode 预设。providerId 用 models.dev 命名（OpenCode 的 provider 目录直接取自 models.dev）；
// baseUrl 留空表示用该 provider 的官方地址，切换时不会往 opencode.json 写 baseURL 覆盖。
// provider 列表文档：https://opencode.ai/docs/providers/
const OPENCODE_PRESETS = [
  // 文档来源：https://opencode.ai/docs/providers/#anthropic ；模型 id 取自 https://models.dev/ (anthropic)
  {
    id: "anthropic_official",
    name: "Anthropic 官方",
    providerId: "anthropic",
    baseUrl: "",
    model: "claude-sonnet-5",
  },
  // 文档来源：https://opencode.ai/docs/providers/#openai ；模型 id 取自 https://models.dev/ (openai)
  {
    id: "openai_official",
    name: "OpenAI 官方",
    providerId: "openai",
    baseUrl: "",
    model: "gpt-5.6-sol",
  },
  // 文档来源：https://opencode.ai/docs/providers/#deepseek ；官方端点 https://api.deepseek.com
  {
    id: "deepseek_official",
    name: "DeepSeek 官方",
    providerId: "deepseek",
    baseUrl: "",
    model: "deepseek-v4-pro",
  },
  // 文档来源：https://opencode.ai/docs/providers/#moonshot-ai ；官方端点 https://api.moonshot.ai/v1
  {
    id: "moonshot_official",
    name: "Kimi (Moonshot AI)",
    providerId: "moonshotai",
    baseUrl: "",
    model: "kimi-k3",
  },
  // 文档来源：https://opencode.ai/docs/providers/#opencode-zen （OpenCode 官方精选模型网关）
  {
    id: "opencode_zen",
    name: "OpenCode Zen",
    providerId: "opencode",
    baseUrl: "",
    model: "claude-sonnet-4-6",
  },
];

// 名称与描述存 i18n key，取值时用 t() 解析，避免把中文写死在表里。
const UNIVERSAL_PROVIDER_PRESETS = [
  {
    id: "newapi",
    nameKey: "universalPresetNewapiName",
    descriptionKey: "universalPresetNewapiDesc",
    models: { claude: "claude-sonnet-5", codex: "gpt-5.5", grok: "grok-4", gemini: "gemini-2.5-pro" },
    providerName: "custom",
  },
  {
    id: "custom_gateway",
    nameKey: "universalPresetCustom",
    descriptionKey: "universalPresetCustomHint",
    models: { claude: "", codex: "", grok: "", gemini: "" },
    providerName: "custom",
  },
];

const I18N = {
  en: {
    appTitle: "VarSwitch",
    appSubtitle: "Environment Sync Manager",
    importBtn: "Import Current",
    addBtn: "+ Add Config",
    statusTitle: "Claude Status",
    statusHint: "After switching, open a new terminal and fully quit and reopen your editor to apply environment variables.",
    profilesTitle: "Config List",
    activeProfileLabel: "Current active",
    addConfig: "Add Config",
    editConfig: "Edit Config",
    nameLabel: "Config Name",
    tokenLabel: "Token",
    urlLabel: "URL",
    cancel: "Cancel",
    save: "Save",
    switchingTo: "Switching to",
    preparing: "Preparing...",
    switchDone: "Switch complete",
    cancelSwitch: "Cancel Switch",
    stepSystem: "System Env",
    stepEditors: "Editors",
    stepClaude: "Claude",
    progressSystem: "Updating system environment variables...",
    progressEditors: "Updating editor settings...",
    progressClaude: "Updating Claude settings...",
    progressFinalize: "Finalizing switch...",
    progressDone: "Done",
    progressCancelling: "Cancelling...",
    statusSystemEnv: "System Environment",
    statusClaude: "Claude Settings",
    codexPageTab: "Codex",
    codexStatusTitle: "Codex Status",
    codexProfilesTitle: "Codex Config List",
    codexAddConfig: "Add Codex Config",
    codexEditConfig: "Edit Codex Config",
    codexNameLabel: "Config Name",
    codexPresetLabel: "Preset",
    codexPresetCustom: "Custom",
    codexPresetHintDefault: "Choose a preset to fill common Codex provider settings.",
    codexApiKeyLabel: "Codex API Key",
    codexBaseUrlLabel: "Codex Base URL",
    codexModelLabel: "Codex Model",
    codexProviderLabel: "Codex Provider",
    codexImageSectionTitle: "Codex Image Skill",
    codexImageSectionHint: "Optional. Enabling this profile installs a local image-generation Skill and configures its API. Restart Codex after switching.",
    codexImageApiKeyLabel: "Image API Key",
    codexImageBaseUrlLabel: "Image Base URL",
    codexImageSkillReady: "Installed · restart Codex to refresh",
    codexImageSkillNeedsSwitch: "Not installed · enable this profile",
    codexAuthModeLabel: "Write Mode",
    codexAuthModeDefaultTitle: "Default write",
    codexAuthModeDefaultHint: "~/.codex/auth.json + ~/.codex/config.toml",
    codexAuthModeOfficialTitle: "Official account login, API quota",
    codexAuthModeOfficialHint: "Only write ~/.codex/config.toml",
    codexOfficialConfigLabel: "Official account API quota config",
    copy: "Copy",
    codexSwitching: "Writing Codex configuration...",
    codexSwitchedTo: "Codex switched to {name}",
    codexImportPrompt: "Name for the imported Codex config:",
    codexImportDefaultName: "Current Codex Config",
    codexToastImported: "Current Codex config imported",
    codexToastAdded: "Codex config added",
    codexToastUpdated: "Codex config updated",
    codexToastDeleted: "Codex config deleted",
    codexNoConfigsTitle: "No Codex configs yet",
    codexNoConfigsDesc: "Create a config to sync Codex settings in one click.",
    codexAddFirstConfig: "Add your first Codex config",
    grokPageTab: "Grok / xAI",
    grokStatusTitle: "Grok Status",
    grokProfilesTitle: "Grok Config List",
    grokAddConfig: "Add Grok Config",
    grokEditConfig: "Edit Grok Config",
    grokNameLabel: "Config Name",
    grokPresetLabel: "Preset",
    grokPresetCustom: "Custom",
    grokPresetHintDefault: "Choose a preset to fill common xAI / Grok settings.",
    grokApiKeyLabel: "XAI API Key",
    grokBaseUrlLabel: "XAI Base URL",
    grokModelLabel: "Model",
    grokModelHint: "Optional. Written to [model.varswitch].model and XAI_MODEL.",
    grokApiBackendLabel: "API Backend",
    grokApiBackendHint: "Maps to api_backend in ~/.grok/config.toml.",
    grokOpenFolder: "Open .grok folder",
    grokBackupRuntime: "Backup config.toml",
    grokImportCurrent: "Import current",
    grokStatusHint: "Switching writes ~/.grok/config.toml (default model + API), and also syncs XAI_API_KEY / XAI_BASE_URL. Restart Grok CLI to apply.",
    grokActiveConfigLabel: "Active Grok Config",
    grokSwitching: "Writing ~/.grok/config.toml...",
    grokSwitchedTo: "Grok switched to {name}",
    grokImportPrompt: "Name for the imported Grok config:",
    grokImportDefaultName: "Current Grok Config",
    grokToastImported: "Current Grok config imported",
    grokToastAdded: "Grok config added",
    grokToastUpdated: "Grok config updated",
    grokToastDeleted: "Grok config deleted",
    grokNoConfigsTitle: "No Grok configs yet",
    grokNoConfigsDesc: "Create a config to switch ~/.grok/config.toml (and env vars) in one click.",
    geminiNoConfigsTitle: "No Gemini configs yet",
    geminiNoConfigsDesc: "Create a config to switch the Gemini CLI gateway and model in one click.",
    grokAddFirstConfig: "Add your first Grok config",
    opencodePageTab: "OpenCode",
    opencodePageSubtitle: "Manage OpenCode providers, API keys and the default model.",
    opencodeStatusTitle: "OpenCode Status",
    opencodeProfilesTitle: "OpenCode Config List",
    opencodeAddConfig: "Add OpenCode Config",
    opencodeEditConfig: "Edit OpenCode Config",
    opencodeNameLabel: "Config Name",
    opencodePresetLabel: "Preset",
    opencodePresetCustom: "Custom",
    opencodePresetHintDefault: "Pick a preset to fill the models.dev provider id and its flagship model.",
    opencodeProviderLabel: "Provider ID",
    opencodeProviderHint: "models.dev provider id, e.g. anthropic / openai / deepseek / moonshotai.",
    opencodeApiKeyLabel: "API Key",
    opencodeBaseUrlLabel: "Base URL",
    opencodeBaseUrlPlaceholder: "Leave empty to use the provider's official endpoint",
    opencodeOfficialBaseUrl: "Official endpoint",
    opencodeModelLabel: "Model",
    opencodeModelHint: "Sets the default model and registers it with the provider so custom gateway models can be selected in OpenCode.",
    opencodeCliLabel: "CLI",
    opencodeInstalled: "Installed",
    opencodeNotInstalled: "Not detected",
    opencodeConfigPathLabel: "Config Path",
    opencodeSourceLabel: "Source",
    opencodeConfigMissing: "config not created yet",
    opencodeStatusLoadFailed: "Failed to load OpenCode status",
    opencodeSwitchedTo: "OpenCode config saved: {name}. Start a new session to use the default model.",
    opencodeToastAdded: "OpenCode config added",
    opencodeToastUpdated: "OpenCode config updated",
    opencodeToastDeleted: "OpenCode config deleted",
    opencodeNoConfigsTitle: "No OpenCode configs yet",
    opencodeNoConfigsDesc: "Create a config to switch the provider, API key and model in opencode.json in one click.",
    opencodeImportCurrent: "Import current",
    opencodeImportDefaultName: "Current OpenCode Config",
    opencodeImportEmpty: "No OpenCode provider found in the current config",
    opencodeImportPrefilled: "Prefilled from the current config. Enter the API key and save.",
    opencodeNoActiveProfile: "No active OpenCode profile",
    codexToolbox: "Toolbox",
    codexToolboxTitle: "Codex Toolbox",
    toolboxTabSession: "Session Sync",
    toolboxTabRemote: "Mobile Control",
    toolboxSessionHint: "Click sync to import local Codex history into VarSwitch. Mobile bindings are managed only in Mobile Control.",
    toolboxSessionSummaryEmpty: "Not synced yet",
    toolboxSessionSummary: "Synced {count} conversations · {time}",
    toolboxSyncedThreadsTitle: "Synced Codex Threads",
    toolboxThreadsTitle: "Control Conversation",
    toolboxBindingsTitle: "Mobile Channels",
    toolboxMobileAppLabel: "Bind App",
    toolboxMobileThreadLabel: "Control Conversation",
    toolboxMobileNoThreadOption: "Sync local history first",
    toolboxBindWechat: "Bind WeChat",
    toolboxBindLark: "Bind Feishu/Lark",
    toolboxBindQq: "Bind QQ",
    toolboxSelectThread: "Switch",
    toolboxSelectedThread: "Selected",
    toolboxSyncNow: "Sync Now",
    toolboxUnbind: "Unbind",
    toolboxNoThreads: "No synced Codex threads. Sync local history first.",
    toolboxNoBindings: "No mobile channels are bound yet.",
    toolboxRemoteHint: "Select a synced conversation, bind Feishu/WeChat/QQ, then start platform-bot listening for mobile control outside your LAN.",
    toolboxRemoteStatus: "Status",
    toolboxRemoteAccessUrl: "Active Conversation",
    toolboxRemoteToken: "Token",
    toolboxRemoteDevice: "Device",
    toolboxRemoteRunning: "Platform Listening",
    toolboxRemoteStopped: "Stopped",
    toolboxSmartControlConnected: "Advanced control connected",
    toolboxSmartControlWaiting: "Advanced control waiting",
    toolboxSmartControlCompat: "Compatibility mode",
    toolboxSmartControlCopied: "Protocol event copied",
    toolboxSmartControlApprovalTitle: "Pending approvals",
    toolboxSmartControlApprovalEmpty: "No pending approval",
    toolboxSmartControlApprovalSubmitted: "Approval submitted",
    toolboxRemoteStart: "Start Platform Link",
    toolboxRemoteStop: "Stop",
    toolboxChannelCredentials: "Platform Credentials",
    toolboxCredentialStatus: "Credential Status",
    toolboxAppId: "App ID",
    toolboxAppSecret: "App Secret",
    toolboxBotToken: "Bot Token",
    toolboxAccountId: "Account ID",
    toolboxBaseUrl: "Base URL",
    toolboxUserId: "User ID",
    toolboxBotOpenId: "Bot Open ID",
    toolboxSaveChannel: "Save Channel",
    toolboxCreateLarkBot: "Create Lark Bot",
    toolboxRebindLarkBot: "Bind Existing Bot",
    toolboxUnbindLarkSession: "Unbind Conversation",
    toolboxStopLarkListen: "Stop Lark Listening",
    toolboxClearLarkBinding: "Clear Binding",
    toolboxStartQqQr: "Scan QQ QR",
    toolboxStartWechatQr: "Bind WeChat",
    toolboxPollWechatQr: "Check WeChat Scan",
    toolboxQrOpen: "Open QR Link",
    toolboxQrStatus: "QR Status",
    toolboxLastError: "Last Error",
    toolboxChannelSaved: "Mobile channel saved",
    toolboxDraftSaved: "Toolbox draft saved",
    toolboxBindingSaved: "Session binding saved",
    toolboxBindingRemoved: "Session binding removed",
    toolboxBindingSynced: "Session binding synced",
    toolboxSessionsSynced: "Local Codex history synced",
    toolboxSessionSafeNote: "Session manager actions only hide records inside VarSwitch; Codex App history files stay untouched.",
    toolboxSessionSearchPlaceholder: "Search title, project, message, or session ID",
    toolboxSessionSelectAll: "Select All",
    toolboxSessionClearSelected: "Clear Selection",
    toolboxSessionCopyIds: "Copy IDs",
    toolboxSessionOpenTrash: "Trash",
    toolboxSessionMoveTrash: "Move to Trash",
    toolboxSessionTrashTitle: "Session Trash",
    toolboxSessionTrashHint: "Restore sessions hidden from this toolbox. Original Codex files were not deleted.",
    toolboxSessionTrashClose: "Close",
    toolboxSessionRestoreSelected: "Restore Selected",
    toolboxSessionTrashEmpty: "Trash is empty",
    toolboxSessionNoSearchResults: "No sessions match the search.",
    toolboxSessionSelectedSummary: "{selected} selected · {total} visible · {trash} in trash",
    toolboxSessionCopiedIds: "Copied selected session IDs",
    toolboxSessionMovedTrash: "Moved selected sessions to toolbox trash",
    toolboxSessionRestored: "Sessions restored",
    toolboxSessionConfirmTrash: "Move selected sessions to VarSwitch trash? This will not delete Codex App history files.",
    toolboxSessionProjectUnknown: "Unknown Project",
    toolboxSessionIdLabel: "Session ID",
    toolboxSessionFileLabel: "File",
    toolboxSessionDeletedAt: "Hidden at",
    toolboxSessionCopyId: "Copy session ID",
    toolboxThreadSelected: "Control conversation switched",
    toolboxRemoteStarted: "Mobile platform link is starting",
    toolboxRemoteStopped: "Mobile control stopped",
    readFailed: "Read failed",
    synced: "Synced",
    unsynced: "Not Synced",
    noConfigsTitle: "No configs yet",
    noConfigsDesc: "Create a config to sync System / VSCode / Claude in one click.",
    addFirstConfig: "Add your first config",
    inUse: "In Use",
    switchUse: "Switch",
    edit: "Edit",
    delete: "Delete",
    toastUpdated: "Config updated",
    toastAdded: "Config added",
    toastSaving: "Saving...",
    toastDeleted: "Config deleted",
    toastImported: "Current config imported",
    toastCopied: "Copied to clipboard",
    switchedTo: "Switched to {name}",
    partialSuccess: "Partially succeeded: {ok}\nFailed: {errors}",
    cancelledRestored: "Switch cancelled. Previous config restored",
    cancelRestoreFailed: "Restore after cancellation failed: {error}",
    switchFailed: "Switch failed: {error}",
    switchRolledBack: "Switch failed. Previous configuration restored: {error}",
    snapshotFailed: "Snapshot failed: {error}",
    confirmDelete: "Delete \"{name}\"?",
    importPrompt: "Name for the imported config:",
    importDefaultName: "Current Config",
    loadStatusFailed: "Failed to load status: {error}",
    loadProfilesFailed: "Failed to load profiles: {error}",
    activeConfigLabel: "Active Config",
    syncNow: "Sync Now",
    switchToDark: "Dark",
    switchToLight: "Light",
    placeholderName: "e.g. Production",
    placeholderApiKey: "sk-...",
    placeholderBaseUrl: "Leave empty for official https://api.anthropic.com",
    modelIdLabel: "Model ID",
    placeholderModelId: "e.g. opus, sonnet",
    modelIdHint: "Optional. Sets model in editor and Claude settings.",
    modelMappingTitle: "Advanced Model Mapping",
    modelMappingHint: "Optional. Written to ANTHROPIC_DEFAULT_SONNET_MODEL / ANTHROPIC_DEFAULT_OPUS_MODEL / ANTHROPIC_DEFAULT_HAIKU_MODEL. Leave empty to skip.",
    sonnetModelLabel: "Sonnet Model",
    opusModelLabel: "Opus Model",
    haikuModelLabel: "Haiku Model",
    dragToReorder: "Drag to reorder",
    reorderFailed: "Failed to save order: {error}",
    endpointTest: "Verify",
    endpointTesting: "Verifying...",
    endpointUse: "Use",
    modelFetch: "Fetch Models",
    modelFetching: "Fetching...",
    modelFetchMissing: "Enter an API Key first.",
    providerPresetLabel: "Provider Preset",
    providerPresetCustom: "Custom",
    claudePresetHintDefault: "Pick a provider to auto-fill its endpoint and default model. Leave Base URL empty for the official API.",
    claudeApiFormatLabel: "API Format",
    claudeApiFormatHint: "Pick OpenAI format when the upstream only exposes an OpenAI API: requests go through the local proxy at 127.0.0.1:25789, so keep VarSwitch running.",
    claudeApiFormatOptionAnthropic: "Anthropic Messages (direct, default)",
    claudeApiFormatOptionOpenAiChat: "OpenAI Chat Completions (via local proxy)",
    claudeApiFormatNeedsBaseUrl: "OpenAI format requires an upstream Base URL.",
    claudeApiFormatNeedsModel: "OpenAI format needs a Model ID (upstream model name, e.g. deepseek-chat).",
    proxyFailoverLabel: "Join proxy failover pool",
    proxyFailoverHint: "When the active config fails, the local proxy automatically switches to pool configs in list order. Requires a Base URL.",
    proxyFailoverBadge: "Failover",
    proxyTakeoverLabel: "Route through local proxy",
    proxyTakeoverHint: "Passes requests through 127.0.0.1:25789 to gain failover and circuit breaking. VarSwitch must keep running, otherwise Claude Code cannot connect.",
    proxyTakeoverBadge: "Proxied",
    proxyHealthTitle: "Proxy Health",
    proxyHealthRunning: "Running (127.0.0.1:{port})",
    proxyHealthStopped: "Not running",
    proxyHealthStatusLabel: "Proxy Status",
    proxyHealthPrimaryLabel: "Primary",
    proxyHealthFailoverLabel: "Failover",
    proxyHealthPoolEmpty: "No failover upstreams. Check \"Join proxy failover pool\" on other configs that have a Base URL.",
    proxyHealthFailoverCountLabel: "Auto Failovers",
    proxyHealthLastErrorLabel: "Last Error",
    proxyHealthNoError: "None",
    proxyHealthResetBreaker: "Reset Breaker",
    proxyHealthResetDone: "Circuit breaker and health stats reset",
    proxyHealthStatsTitle: "failures / total requests",
    proxyBreakerClosed: "Healthy",
    proxyBreakerOpen: "Tripped",
    proxyBreakerHalfOpen: "Probing",
    codexWireApiLabel: "Upstream Protocol",
    codexWireApiHint: "Written to wire_api in ~/.codex/config.toml. Presets set this automatically.",
    codexWireApiDeepseekHint: "DeepSeek's official endpoint uses Responses API. This value is fixed for this preset.",
    codexAdvancedTitle: "Advanced options",
    verifyOkLabel: "Verified",
    verifyModelsSuffix: "models",
    verifyOkToast: "Connection verified: key and endpoint are working.",
    verifyAuthFailed: "Authentication failed (401/403). Check your API Key.",
    verifyNoModelsEndpoint: "This endpoint does not expose /models (404/405), so it cannot be auto-verified.",
    modelFetchNoResults: "No models returned",
    modelSelected: "Model selected",
    skillsManage: "Skills",
    skillsTitle: "Skills Management",
    addSkill: "+ Add Skill",
    skillName: "Command Name",
    skillContent: "Content",
    skillNamePlaceholder: "command-name",
    toastSkillSaved: "Skill saved",
    toastSkillDeleted: "Skill deleted",
    confirmDeleteSkill: "Delete skill \"{name}\"?",
    noSkills: "No skills yet. Create slash commands for Claude Code.",
    promptsManage: "Prompts",
    promptsTitle: "Claude Prompts",
    promptsPathLabel: "~/.claude/CLAUDE.md",
    toastPromptSaved: "Prompt saved",
    mcpManage: "MCP Servers",
    mcpTitle: "MCP Server Management",
    mcpPathLabel: "~/.claude.json · ~/.codex/config.toml · ~/.gemini/settings.json",
    addMcp: "+ Add Server",
    mcpName: "Server Name",
    mcpConfig: "Config (JSON)",
    mcpNamePlaceholder: "context7",
    mcpIntro: "MCP servers give AI CLIs extra abilities (docs lookup, file access, database queries, and so on). Register one here and it syncs to each app's config file below.",
    mcpNameHint: "Unique identifier used by the CLI, e.g. context7, filesystem.",
    mcpModeForm: "Form",
    mcpModeJson: "JSON",
    mcpTransportLabel: "Transport",
    mcpTransportStdio: "Local command (stdio)",
    mcpTransportHttp: "Remote HTTP",
    mcpTransportSse: "Remote SSE",
    mcpTransportHint: "Most MCP servers are local commands: the CLI spawns a process and talks to it over stdio.",
    mcpCommandLabel: "Command",
    mcpArgsLabel: "Arguments (one per line)",
    mcpEnvLabel: "Environment variables (KEY=VALUE per line, optional)",
    mcpUrlLabel: "Server URL",
    mcpHeadersLabel: "Headers (Key: Value per line, optional)",
    mcpNeedName: "Server name is required.",
    mcpNeedCommand: "A launch command is required, e.g. npx.",
    mcpNeedUrl: "A server URL is required.",
    mcpJsonTooComplex: "This config has fields the form cannot represent. Keep editing it as JSON.",
    toastMcpSaved: "MCP server saved",
    toastMcpDeleted: "MCP server deleted",
    confirmDeleteMcp: "Delete MCP server \"{name}\"? It will be removed from all apps (Claude / Codex / Gemini / Claude Desktop).",
    invalidJson: "Invalid JSON format",
    noMcpServers: "No MCP servers configured.",
    mcpAppsLabel: "Enable for Apps",
    mcpNoAppSelected: "Select at least one app",
    toastMcpAppEnabled: "{name} enabled for {app}",
    toastMcpAppDisabled: "{name} disabled for {app}",
    mcpDesktopNotInstalled: "Claude Desktop not detected",
    mcpDesktopPathLabel: "Claude Desktop: {path}",
    confirmDisableLastMcpApp: "\"{name}\" is only enabled for {app}. Disabling it will remove the server from all apps. Continue?",
    // Skills Discovery
    skillsTabInstalled: "Installed",
    skillsTabDiscover: "Discover",
    installFromZip: "Install from ZIP",
    zipInstallTitle: "Install Skill from ZIP",
    zipInstallTargets: "Install to",
    zipInstallConfirmBtn: "Install",
    zipNoAppSelected: "Select at least one app",
    zipOverwriteConfirm: "Skill \"{name}\" already exists. Overwrite?",
    toastZipInstalledTo: "Skill \"{name}\" installed to {apps}",
    discoverSearchPlaceholder: "Search skills...",
    allRepos: "All Repos",
    filterAll: "All",
    filterInstalled: "Installed",
    filterNotInstalled: "Not Installed",
    manageRepos: "Repos",
    discoverLoading: "Loading skills from repositories...",
    discoverEmpty: "No skills found.",
    discoverNoMatch: "No skills match your search.",
    installBtn: "Install",
    installedBadge: "Installed",
    uninstallBtn: "Uninstall",
    repoManagerTitle: "Manage Repositories",
    addRepoLabel: "Add Repository",
    addRepoPlaceholder: "owner/repo or https://github.com/owner/repo",
    toastSkillInstalled: "Skill \"{name}\" installed",
    toastSkillUninstalled: "Skill \"{name}\" uninstalled",
    toastRepoAdded: "Repository added",
    toastRepoRemoved: "Repository removed",
    toastZipInstalled: "{count} skill(s) installed from ZIP",
    toastZipNoSkills: "No skills found in ZIP file",
    commands: "commands",
    localSkill: "Local",
    repoSkill: "Repo",
    sourceCommand: "Command",
    sourceSkill: "Skill",
    // Prompt Templates
    promptTabEditor: "Editor",
    promptTabTemplates: "Templates",
    insertSnippet: "-- Insert snippet --",
    appendToPrompt: "Append",
    replacePrompt: "Replace",
    // Prompt Presets（预设库 + 跨应用同步 + 回填保护）
    promptTabPresets: "Presets",
    presetNew: "+ New Preset",
    presetName: "Preset Name",
    presetNamePlaceholder: "e.g. Chinese Dev",
    presetApps: "Sync to apps",
    presetContent: "Content",
    presetContentPlaceholder: "System prompt content...",
    presetActive: "Active",
    presetActivate: "Activate",
    presetEdit: "Edit",
    presetDelete: "Delete",
    presetEmpty: "No presets yet. Create one to sync prompts across apps.",
    presetSaved: "Preset saved",
    presetDeleted: "Preset deleted",
    presetActivated: "Preset activated",
    presetBackfilled: "Manual edits detected in live file; backfilled into the previous preset",
    confirmDeletePreset: "Delete preset \"{name}\"?",
    confirmActivatePreset: "Activate preset \"{name}\"? Content will be written to:",
    presetNeedName: "Preset name is required",
    presetNeedApp: "Select at least one target app",
    templateSaveAsPreset: "Save as preset",
    snippetLanguagePref: "Language: Chinese",
    snippetCodeQuality: "Code Quality Rules",
    snippetSecurity: "Security Guidelines",
    snippetConcise: "Concise Mode",
    snippetArchitect: "Architecture Guidelines",
    toastSnippetInserted: "Snippet inserted",
    toastTemplateApplied: "Template applied",
    mcpTabInstalled: "Installed",
    mcpTabPresets: "Presets",
    mcpSearchPlaceholder: "Search MCP servers on GitHub...",
    mcpSearchLoading: "Searching GitHub...",
    mcpRequiresApiKey: "Requires API key configuration",
    mcpInstalled: "Installed",
    mcpInstallBtn: "Install",
    mcpGithubBtn: "GitHub",
    mcpNoPresets: "No presets available.",
    // Skills Discovery GitHub search
    skillsSearchGithub: "Search GitHub",
    skillsSearchGithubPlaceholder: "Search skills on GitHub...",
    skillsGithubLoading: "Searching GitHub...",
    skillsGithubResults: "Showing GitHub search results",
    skillsBackToCatalog: "Back to catalog",
    // Settings
    settingsTitle: "Settings",
    settingsGroupGeneral: "General",
    settingsGroupPaths: "Paths",
    settingsGroupBackup: "Backup",
    settingsAutoStart: "Launch at startup",
    settingsAutoStartDesc: "Automatically start VarSwitch when you log in",
    settingsMinTray: "Minimize to tray",
    settingsMinTrayDesc: "Hide to system tray when closing the window",
    settingsConfigDir: "Config directory",
    settingsClaudePath: "Claude settings",
    settingsCodexPath: "Codex settings",
    settingsLogs: "Runtime logs",
    settingsLogsDesc: "Open the logs folder to view or report issues",
    settingsOpen: "Open",
    settingsCopyPath: "Copy path",
    settingsBrowse: "Browse",
    settingsSavePath: "Save Path",
    settingsReset: "Reset",
    settingsPathPlaceholder: "Paste a settings directory or settings.json path",
    settingsPathEmpty: "Enter an editor settings path first",
    settingsCurrentPath: "Current path",
    settingsDefaultPathLabel: "Built-in default",
    settingsEditorStatusCustom: "Manual path",
    settingsEditorStatusDetected: "Auto-detected",
    settingsEditorStatusDefault: "Default path",
    settingsEditorHintCustom: "Uses your saved path for detection and environment sync.",
    settingsEditorHintDetected: "Using the built-in path detected on this device.",
    settingsEditorHintDefault: "Not detected yet. Save a path here if this editor is installed elsewhere.",
    settingsDefaultPath: "Default: {path}",
    settingsExport: "Export Profiles",
    settingsImport: "Import Profiles",
    settingsManualBackup: "Manual config backup",
    settingsManualBackupDesc: "Import or export all current profiles",
    settingsAutoBackup: "Auto backup",
    settingsAutoBackupDesc: "Snapshots are taken before every switch; you can roll back mistakes",
    settingsViewBackups: "Roll back",
    toastSettingsSaved: "Settings saved",
    toastEditorPathSaved: "{name} path saved",
    toastEditorPathReset: "{name} path reset",
    toastEditorPathBrowseCancelled: "Path selection cancelled",
    toastExported: "Profiles exported",
    toastImported2: "{count} profile(s) imported",
    toastImportNone: "No new profiles to import",
    settingsSilentStart: "Silent startup",
    settingsSilentStartDesc: "Start minimized to system tray",
    settingsHotkey: "Global shortcut",
    settingsHotkeyDesc: "Show / hide the VarSwitch window from anywhere",
    settingsHotkeyPlaceholder: "Click, then press keys",
    settingsHotkeyClear: "Clear",
    settingsHotkeyNeedModifier: "The shortcut must include Ctrl, Alt or Win",
    settingsHotkeySaved: "Global shortcut set to {keys}",
    settingsHotkeyCleared: "Global shortcut disabled",
    // 配置体检
    healthCheckGroup: "Health Check",
    healthCheckLabel: "Check whether every profile still works",
    healthCheckDesc: "Probes the Base URL of each profile one by one and reports why a profile fails. No profile is modified or deleted.",
    healthCheckBtn: "Start check",
    healthChecking: "Checking...",
    healthSummary: "{total} profile(s) checked: {ok} healthy, {bad} with problems, {dead} unreachable",
    healthLevelOk: "Healthy",
    healthLevelWarn: "Suspicious",
    healthLevelBad: "Problem",
    healthLevelDead: "Unreachable",
    healthLevelSkipped: "Skipped",
    healthFailed: "Health check failed",
    balanceLabel: "Balance",
    balanceCheck: "Check balance",
    balanceLoading: "Checking...",
    balanceUnsupported: "N/A",
    balanceUnsupportedHint: "Balance query is not supported for this provider",
    balanceFailedShort: "Query failed",
    balanceUsedLabel: "Used",
    balanceQuotaLabel: "Quota",
    balanceGrantedLabel: "Granted",
    balanceToppedUpLabel: "Topped up",
    balanceUnlimitedHint: "This site reports no quota cap, so only the used amount is shown",
    balanceUpdatedAt: "Updated {time}",
    siteTokenTitle: "Site access token",
    siteTokenHint: "Enter the system access token generated in the relay site's account settings to read your real account balance. This is not the sk- API key.",
    siteTokenValueLabel: "Access token",
    siteTokenUserIdLabel: "User ID (required by new-api sites)",
    siteTokenUserIdHint: "Digits only, found in your profile on the site. Leave empty for one-api sites.",
    siteTokenSave: "Save and check",
    siteTokenDelete: "Delete",
    siteTokenConfigure: "Set site token for real balance",
    siteTokenSaved: "Site token saved for {host}",
    siteTokenDeleted: "Site token removed for {host}",
    siteTokenEmpty: "Please enter the access token",
    siteTokenFailedHint: "Site token query failed: {error}",
    settingsLang: "Language",
    settingsTheme: "Theme",
    supportSectionTitle: "Quick Actions",
    supportHintDefault: "Open the usage guide, check for updates, or jump to the repository.",
    supportHintUpdateAvailable: "New version available: current {currentVersion}, latest {latestVersion}. Click to download and install automatically.",
    supportHintUpToDate: "You're already on the latest version: {version}.",
    usageGuideBtn: "Usage Guide",
    updateCheckBtn: "Check for Updates",
    updateReleaseBtn: "Install Update {version}",
    downloadSiteBtn: "Download Site",
    githubRepoBtn: "GitHub Repo",
    usageGuideKicker: "Usage Guide",
    usageGuideTitle: "How to use VarSwitch",
    usageGuideIntro: "VarSwitch centralizes Claude Code, Codex, prompts, MCP servers, mobile control, settings, and backups.",
    usageGuideStep1Title: "Claude Code configs",
    usageGuideStep1Desc: "Add or import Token/Base URL configs and verify connectivity with your key, then switch to sync system env, supported editors, and ~/.claude/settings.json.",
    usageGuideStep2Title: "Codex configs",
    usageGuideStep2Desc: "Manage Codex API Key, Base URL, model, provider, and auth mode, then sync ~/.codex/config.toml and auth.json.",
    usageGuideStep3Title: "Codex Toolbox",
    usageGuideStep3Desc: "Sync Codex sessions and bind mobile control.",
    usageGuideStep4Title: "Skills, prompts, and MCP",
    usageGuideStep4Desc: "Use toolbar entries to edit Claude Skills/Commands, manage CLAUDE.md templates, and edit MCP server JSON in ~/.claude.json.",
    usageGuideStep5Title: "Settings and backups",
    usageGuideStep5Desc: "Set language, theme, tray behavior, startup options, editor paths, profile export/import, automatic backups, and rollback.",
    usageGuideStep6Title: "Updates and restart tips",
    usageGuideStep6Desc: "Use the home shortcuts to check updates, open the download site or repository. After switching configs, restart terminals and editors.",
    usageGuideClose: "Close",
    usageGuideNever: "Never remind again",
    toastGuideDisabled: "Usage guide disabled",
    checkingUpdates: "Checking for Updates...",
    downloadingUpdate: "Downloading update {percent}%",
    installingUpdate: "Installing update...",
    openingReleasePage: "Opening Download Page...",
    toastUpdateAvailable: "Update available: current {currentVersion}, latest {latestVersion}",
    updatePillText: "New version available: current {currentVersion}, latest {latestVersion}",
    updatePillAction: "Download",
    toastUpdateDownloaded: "Update installer started. VarSwitch will restart automatically if needed.",
    toastAlreadyLatest: "You're already on the latest version",
    toastReleaseOpened: "Download page opened",
    toastRepoOpened: "Repository opened",
    cliSessionsNavLabel: "Sessions",
    cliSessionsPageTitle: "Sessions",
    cliSessionsPageSubtitle: "Browse local Claude Code and Codex session history, and resume any of them in one click.",
    cliSessionsRefresh: "Refresh",
    cliSessionsSearchPlaceholder: "Search title, directory or session ID",
    cliSessionsFilterAll: "All",
    cliSessionsLoading: "Scanning local sessions…",
    cliSessionsCount: "{count} sessions",
    cliSessionsEmptyTitle: "No sessions yet",
    cliSessionsEmptyText: "Sessions from Claude Code and Codex will show up here once you use them.",
    cliSessionsEmptyFilteredTitle: "No matching sessions",
    cliSessionsEmptyFilteredText: "Try a different keyword or source filter.",
    cliSessionsResume: "Resume",
    cliSessionsResumeOpened: "Session opened in terminal / app",
    cliSessionsResumeFailed: "Failed to resume session: {error}",
    cliSessionsLoadFailed: "Failed to load sessions: {error}",
    cliSessionsNoCwd: "Unknown directory",
    settingsGroupDataDir: "Data Directory (Multi-device Sync)",
    settingsDataDirLabel: "Data directory",
    settingsDataDirDesc: "Point it to a OneDrive / Dropbox / Nutstore / NAS synced folder to share configs across devices. Note: configs contain plaintext API keys, make sure the sync folder is trusted.",
    settingsDataDirDefault: "Default",
    settingsDataDirCustom: "Custom",
    settingsDataDirPick: "Choose Folder…",
    settingsDataDirReset: "Use Default",
    dataDirSwitchTitle: "Data directory switched",
    dataDirSwitchSummary: "Copied {copied} item(s), skipped {skipped} existing item(s).",
    dataDirRestartHint: "Please restart VarSwitch for all features to take effect.",
    dataDirResetDone: "Default data directory restored.",
    dataDirConfirmReset: "Restore the default data directory? Files in the custom folder will not be deleted.",
    dataDirAlreadyDefault: "Already using the default data directory",
    dataDirGotIt: "OK",
    deeplinkTitle: "Import via Link",
    deeplinkWarning: "This configuration comes from an external link. Make sure you trust the source before importing.",
    deeplinkTargetApp: "Target app",
    deeplinkFieldName: "Name",
    deeplinkFieldBaseUrl: "Base URL",
    deeplinkFieldApiKey: "API Key",
    deeplinkConfigPreview: "MCP config preview",
    deeplinkConfirm: "Confirm Import",
    deeplinkImporting: "Importing...",
    deeplinkInvalid: "Deep link parse failed: {message}",
    claudeDesktopPageTitle: "Claude Desktop",
    claudeDesktopPageSubtitle: "Use third-party APIs through an independent 3P Profile, with Gateway and Direct modes.",
    claudeDesktopSync: "Sync Now",
    claudeDesktopImport: "Import from Claude Code",
    claudeDesktopAddProfile: "Add Desktop Profile",
    claudeDesktopEditProfile: "Edit Desktop Profile",
    claudeDesktopStatusTitle: "Claude Desktop Status",
    claudeDesktopProfilesTitle: "Claude Desktop Profiles",
    claudeDesktopGatewayHealthTitle: "Desktop Gateway Health",
    claudeDesktopModeOfficial: "Official",
    claudeDesktopModeGateway: "Gateway",
    claudeDesktopModeDirect: "Direct",
    claudeDesktopInstalled: "Detected",
    claudeDesktopNotInstalled: "Not detected",
    claudeDesktopInstallStatus: "Installation",
    claudeDesktopCurrentMode: "Mode",
    claudeDesktopActiveProvider: "Active provider",
    claudeDesktopGatewayStatus: "Gateway",
    claudeDesktopProfilePath: "3P Profile",
    claudeDesktopGatewayRunning: "Running",
    claudeDesktopGatewayStopped: "Stopped",
    claudeDesktopGatewayNotRequired: "Not required",
    claudeDesktopGatewayDependencyWarning: "Gateway mode requires VarSwitch to stay running. Fully quit and restart Claude Desktop after switching.",
    claudeDesktopFailoverCount: "Failovers",
    claudeDesktopFailoverBadge: "Failover",
    claudeDesktopOfficialLogin: "Authentication",
    claudeDesktopOfficialLoginHint: "Claude official account",
    claudeDesktopApiFormat: "API Format",
    claudeDesktopDefaultModel: "Default model",
    claudeDesktopModelHint: "Gateway: fetch models first, then enter the upstream default used when no mapping matches. Anthropic passthrough keeps the original body; OpenAI conversion applies exact mappings below.",
    claudeDesktopModelMappingHint: "Manually add the model Claude Code sees and the upstream model it should call. Only OpenAI conversion replaces it; Anthropic passthrough keeps the full body.",
    claudeDesktopSourceModelLabel: "Claude Code model",
    claudeDesktopTargetModelLabel: "Upstream model",
    claudeDesktopAddMapping: "+ Add model mapping",
    claudeDesktopRemoveMapping: "Remove",
    claudeDesktopNoProfiles: "No Claude Desktop profiles",
    claudeDesktopNoProfilesHint: "Add one or import existing Claude Code providers.",
    claudeDesktopLoadFailed: "Failed to load Claude Desktop: {error}",
    claudeDesktopGatewayHint: "Gateway supports model mapping, OpenAI Chat conversion and failover. Keep VarSwitch running.",
    claudeDesktopDirectHint: "Direct mode supports Anthropic Messages only and does not require VarSwitch after switching.",
    claudeDesktopModelRequired: "Enter a default model or at least one complete model mapping.",
    claudeDesktopAdded: "Claude Desktop profile added",
    claudeDesktopUpdated: "Claude Desktop profile updated",
    claudeDesktopDeleted: "Claude Desktop profile deleted",
    claudeDesktopDeleteConfirm: "Delete Claude Desktop profile {name}?",
    claudeDesktopImportConfirm: "Copy all current Claude Code providers into the independent Claude Desktop list?",
    claudeDesktopImported: "Imported {count} Claude Desktop profile(s)",
    claudeDesktopRestartRequired: "Fully quit and restart Claude Desktop to apply the profile.",
    claudeDesktopBreakerReset: "Desktop Gateway breaker reset",
    claudeDesktopFetchModels: "Fetch models",
    claudeDesktopFetchingModels: "Fetching models...",
    claudeDesktopModelsFetched: "Fetched {count} model(s)",
    claudeDesktopModelsFetchFailed: "Failed to fetch models: {error}",
    navSectionWorkspace: "Workspace",
    navSectionToolbox: "Toolbox",
    navAddProvider: "Add Config",
    navSettings: "Settings",
    claudePageSubtitle: "Manage system environment variables and Claude settings sync.",
    claudePageAddBtnText: "Add Claude Config",
    geminiPageSubtitle: "Manage the Gemini CLI API key, custom gateway, and default model.",
    geminiPageAddBtnText: "Add Gemini Config",
    universalPageTitle: "Add Unified Provider",
    universalPageSubtitle: "Configure the API gateway once and sync it to the selected apps.",
    universalPresetHeading: "Provider Presets",
    universalPresetDesc: "As in cc-switch, a unified provider starts from NewAPI or a custom gateway.",
    universalPresetNewapiDesc: "Multi-protocol unified API gateway",
    universalPresetCustom: "Custom Gateway",
    universalPresetCustomDesc: "Configure a compatible service manually",
    universalConnHeading: "Connection",
    universalConnDesc: "Every selected app shares this endpoint and key.",
    universalProviderNameLabel: "Provider name",
    universalBaseUrlLabel: "API endpoint",
    universalAppsHeading: "Enabled apps",
    universalAppsDesc: "Saving creates a profile for each app and adds it to the sidebar.",
    universalParamsHeading: "Per-app settings",
    universalParamsDesc: "Set the protocol and default model per app. After a successful connection test the model field autocompletes; leave it empty to let each client decide.",
    universalClaudeTarget: "Writes ~/.claude/settings.json and system environment variables",
    universalCodexTarget: "Writes the wire_api field in ~/.codex/config.toml",
    universalGrokTarget: "Writes the api_backend field in ~/.grok/config.toml",
    universalGeminiTarget: "Generative Language · writes GOOGLE_GEMINI_BASE_URL",
    universalApiFormatLabel: "API format",
    universalDefaultModelLabel: "Default model",
    universalWireApiLabel: "Upstream protocol",
    toolboxPageSubtitle: "Sync Codex sessions and set up mobile remote control.",
    toolboxSyncStatusHeading: "Sync status",
    developerToolsSubtitle: "Manage Claude Code skills, prompts, and MCP servers.",
    settingsPageSubtitle: "Manage preferences, paths, backups, and help links.",
    settingsLangLabel: "Language",
    settingsLangDesc: "Choose the interface language",
    settingsThemeLabel: "Appearance",
    settingsThemeDesc: "Choose a light or dark theme",
    settingsThemeLightBtn: "Light",
    settingsThemeDarkBtn: "Dark",
    settingsGuideTitle: "Usage guide",
    settingsGuideDesc: "Read the switching and configuration guide",
    settingsUpdateTitle: "Check for updates",
    settingsDownloadTitle: "Download site",
    settingsDownloadDesc: "Open the release download page",
    settingsGithubTitle: "GitHub repository",
    settingsGithubDesc: "Browse the source and report issues",
    universalPresetNewapiName: "NewAPI",
    universalPresetCustomHint: "Sync one endpoint and key to multiple apps",
    universalSyncTargets: "Will sync to {apps}",
    universalNoAppSelected: "Enable at least one app",
    universalAutoV1Hint: "A /v1 suffix is appended automatically on save",
    showKey: "Show",
    showApiKey: "Show API key",
    fetchModels: "Fetch models",
    testConnection: "Test connection",
    hideApiKey: "Hide API key",
    pasteApiKey: "Paste API key",
    clipboardReadFailed: "Unable to read clipboard",
    universalTestConn: "Test connection",
    resetBtn: "Reset",
    universalSubmit: "Add and sync",
    geminiProfilesTitle: "Gemini Config List",
    settingsLangZhBtn: "中文",
    settingsLangEnBtn: "English",
    hideKey: "Hide",
  },
  zh: {
    appTitle: "VarSwitch",
    appSubtitle: "环境变量同步工具",
    importBtn: "导入当前配置",
    addBtn: "+ 添加配置",
    statusTitle: "Claude 状态",
    statusHint: "切换后请重新打开终端，并完全退出后重开编辑器，使环境变量生效。",
    profilesTitle: "配置列表",
    activeProfileLabel: "当前生效",
    addConfig: "添加配置",
    editConfig: "编辑配置",
    nameLabel: "配置名称",
    tokenLabel: "令牌",
    urlLabel: "地址",
    cancel: "取消",
    save: "保存",
    switchingTo: "正在切换到",
    preparing: "正在准备...",
    switchDone: "切换完成",
    cancelSwitch: "取消切换",
    stepSystem: "系统环境变量",
    stepEditors: "编辑器",
    stepClaude: "Claude",
    progressSystem: "正在更新系统环境变量...",
    progressEditors: "正在更新编辑器设置...",
    progressClaude: "正在更新 Claude 设置...",
    progressFinalize: "正在收尾...",
    progressDone: "完成",
    progressCancelling: "正在取消...",
    statusSystemEnv: "系统环境变量",
    statusClaude: "Claude 设置",
    codexPageTab: "Codex",
    codexStatusTitle: "Codex 状态",
    codexProfilesTitle: "Codex 配置列表",
    codexAddConfig: "添加 Codex 配置",
    codexEditConfig: "编辑 Codex 配置",
    codexNameLabel: "配置名称",
    codexPresetLabel: "预设",
    codexPresetCustom: "自定义",
    codexPresetHintDefault: "选择预设可自动填充常用 Codex 供应商配置。",
    codexApiKeyLabel: "Codex API Key",
    codexBaseUrlLabel: "Codex Base URL",
    codexModelLabel: "Codex 模型",
    codexProviderLabel: "Codex 供应商",
    codexImageSectionTitle: "Codex 图片生成 Skill",
    codexImageSectionHint: "可选。启用此配置时会自动安装本地图片生成 Skill 并同步 API；切换后请重启 Codex。",
    codexImageApiKeyLabel: "图片 API Key",
    codexImageBaseUrlLabel: "图片 Base URL",
    codexImageSkillReady: "已安装 · 重启 Codex 后刷新",
    codexImageSkillNeedsSwitch: "尚未安装 · 请启用此配置",
    codexAuthModeLabel: "写入方式",
    codexAuthModeDefaultTitle: "默认写入",
    codexAuthModeDefaultHint: "~/.codex/auth.json + ~/.codex/config.toml",
    codexAuthModeOfficialTitle: "官方账号登录，api额度消耗",
    codexAuthModeOfficialHint: "只写 ~/.codex/config.toml",
    codexOfficialConfigLabel: "官方账号登录，api额度消耗配置",
    copy: "复制",
    codexSwitching: "正在写入 Codex 配置...",
    codexSwitchedTo: "Codex 已切换到 {name}",
    codexImportPrompt: "请输入导入的 Codex 配置名称：",
    codexImportDefaultName: "当前 Codex 配置",
    codexToastImported: "当前 Codex 配置已导入",
    codexToastAdded: "Codex 配置已添加",
    codexToastUpdated: "Codex 配置已更新",
    codexToastDeleted: "Codex 配置已删除",
    codexNoConfigsTitle: "暂无 Codex 配置",
    codexNoConfigsDesc: "创建一个配置，一键同步 Codex 设置。",
    codexAddFirstConfig: "添加第一个 Codex 配置",
    grokPageTab: "Grok / xAI",
    grokStatusTitle: "Grok 状态",
    grokProfilesTitle: "Grok 配置列表",
    grokAddConfig: "添加 Grok 配置",
    grokEditConfig: "编辑 Grok 配置",
    grokNameLabel: "配置名称",
    grokPresetLabel: "预设",
    grokPresetCustom: "自定义",
    grokPresetHintDefault: "选择预设可自动填充常用 xAI / Grok 配置。",
    grokApiKeyLabel: "XAI API Key",
    grokBaseUrlLabel: "XAI Base URL",
    grokModelLabel: "模型",
    grokModelHint: "可选。写入 [model.varswitch].model，并同步 XAI_MODEL。",
    grokApiBackendLabel: "API Backend",
    grokApiBackendHint: "对应 ~/.grok/config.toml 的 api_backend 字段。",
    grokOpenFolder: "打开 .grok 目录",
    grokBackupRuntime: "备份 config.toml",
    grokImportCurrent: "导入当前配置",
    grokStatusHint: "切换后会写入 ~/.grok/config.toml（默认模型与 API），并同步 XAI_API_KEY / XAI_BASE_URL。请重启 Grok CLI 使配置生效。",
    grokActiveConfigLabel: "当前 Grok 配置",
    grokSwitching: "正在写入 ~/.grok/config.toml...",
    grokSwitchedTo: "Grok 已切换到 {name}",
    grokImportPrompt: "请输入导入的 Grok 配置名称：",
    grokImportDefaultName: "当前 Grok 配置",
    grokToastImported: "当前 Grok 配置已导入",
    grokToastAdded: "Grok 配置已添加",
    grokToastUpdated: "Grok 配置已更新",
    grokToastDeleted: "Grok 配置已删除",
    grokNoConfigsTitle: "暂无 Grok 配置",
    grokNoConfigsDesc: "创建一个配置，一键切换 ~/.grok/config.toml（并同步环境变量）。",
    geminiNoConfigsTitle: "暂无 Gemini 配置",
    geminiNoConfigsDesc: "创建一个配置，一键切换 Gemini CLI 的网关与模型。",
    grokAddFirstConfig: "添加第一个 Grok 配置",
    opencodePageTab: "OpenCode",
    opencodePageSubtitle: "管理 OpenCode 的 provider、API Key 与默认模型。",
    opencodeStatusTitle: "OpenCode 状态",
    opencodeProfilesTitle: "OpenCode 配置列表",
    opencodeAddConfig: "添加 OpenCode 配置",
    opencodeEditConfig: "编辑 OpenCode 配置",
    opencodeNameLabel: "配置名称",
    opencodePresetLabel: "预设",
    opencodePresetCustom: "自定义",
    opencodePresetHintDefault: "选择预设可自动填入 models.dev 的 provider id 与官方主推模型。",
    opencodeProviderLabel: "Provider ID",
    opencodeProviderHint: "models.dev 的 provider id，例如 anthropic / openai / deepseek / moonshotai。",
    opencodeApiKeyLabel: "API Key",
    opencodeBaseUrlLabel: "Base URL",
    opencodeBaseUrlPlaceholder: "留空使用该 provider 的官方地址",
    opencodeOfficialBaseUrl: "官方地址",
    opencodeModelLabel: "模型",
    opencodeModelHint: "设置默认模型并注册到 provider 的模型列表，让自定义网关模型也能在 OpenCode 中选用。",
    opencodeCliLabel: "命令行",
    opencodeInstalled: "已安装",
    opencodeNotInstalled: "未检测到",
    opencodeConfigPathLabel: "配置文件",
    opencodeSourceLabel: "配置来源",
    opencodeConfigMissing: "配置文件尚未创建",
    opencodeStatusLoadFailed: "OpenCode 状态加载失败",
    opencodeSwitchedTo: "OpenCode 配置已写入：{name}。请新建会话使用默认模型。",
    opencodeToastAdded: "OpenCode 配置已添加",
    opencodeToastUpdated: "OpenCode 配置已更新",
    opencodeToastDeleted: "OpenCode 配置已删除",
    opencodeNoConfigsTitle: "暂无 OpenCode 配置",
    opencodeNoConfigsDesc: "创建一个配置，一键切换 opencode.json 里的 provider、API Key 与模型。",
    opencodeImportCurrent: "导入当前配置",
    opencodeImportDefaultName: "当前 OpenCode 配置",
    opencodeImportEmpty: "当前配置里没有检测到 OpenCode provider",
    opencodeImportPrefilled: "已按当前配置预填，请补全 API Key 后保存。",
    opencodeNoActiveProfile: "暂无启用的 OpenCode 配置",
    codexToolbox: "工具箱",
    codexToolboxTitle: "Codex 工具箱",
    toolboxTabSession: "会话同步",
    toolboxTabRemote: "手机控制",
    toolboxSessionHint: "点击同步即可把本地 Codex 历史记录同步到这个软件里；飞书/微信/QQ 绑定只在手机控制里管理。",
    toolboxSessionSummaryEmpty: "尚未同步",
    toolboxSessionSummary: "已同步 {count} 个对话 · {time}",
    toolboxSyncedThreadsTitle: "已同步 Codex 对话",
    toolboxThreadsTitle: "控制对话",
    toolboxBindingsTitle: "手机通道",
    toolboxMobileAppLabel: "绑定应用",
    toolboxMobileThreadLabel: "控制对话",
    toolboxMobileNoThreadOption: "请先同步本地历史",
    toolboxBindWechat: "绑定微信",
    toolboxBindLark: "绑定飞书",
    toolboxBindQq: "绑定 QQ",
    toolboxSelectThread: "切换",
    toolboxSelectedThread: "已选",
    toolboxSyncNow: "立即同步",
    toolboxUnbind: "解绑",
    toolboxNoThreads: "还没有同步 Codex 对话，请先同步本地历史。",
    toolboxNoBindings: "还没有绑定任何通道。",
    toolboxRemoteHint: "先选择已同步的对话，再绑定飞书/微信/QQ，最后开启平台机器人监听；手机不需要和电脑在同一局域网。",
    toolboxRemoteStatus: "状态",
    toolboxRemoteAccessUrl: "当前控制对话",
    toolboxRemoteToken: "令牌",
    toolboxRemoteDevice: "设备",
    toolboxRemoteRunning: "平台监听中",
    toolboxRemoteStopped: "未启动",
    toolboxSmartControlConnected: "高级控制通道已连接",
    toolboxSmartControlWaiting: "高级控制通道等待 Codex 连接",
    toolboxSmartControlCompat: "兼容模式",
    toolboxSmartControlCopied: "协议事件已复制",
    toolboxSmartControlApprovalTitle: "待处理审批",
    toolboxSmartControlApprovalEmpty: "暂无待处理审批",
    toolboxSmartControlApprovalSubmitted: "审批已提交",
    toolboxRemoteStart: "开启平台连接",
    toolboxRemoteStop: "停止",
    toolboxChannelCredentials: "平台凭据",
    toolboxCredentialStatus: "凭据状态",
    toolboxAppId: "App ID",
    toolboxAppSecret: "App Secret",
    toolboxBotToken: "Bot Token",
    toolboxAccountId: "Account ID",
    toolboxBaseUrl: "Base URL",
    toolboxUserId: "User ID",
    toolboxBotOpenId: "Bot Open ID",
    toolboxSaveChannel: "保存通道",
    toolboxCreateLarkBot: "创建新飞书机器人",
    toolboxRebindLarkBot: "换绑已有机器人",
    toolboxUnbindLarkSession: "解除会话绑定",
    toolboxStopLarkListen: "停止飞书监听",
    toolboxClearLarkBinding: "解除绑定",
    toolboxStartQqQr: "QQ 扫码绑定",
    toolboxStartWechatQr: "绑定微信",
    toolboxPollWechatQr: "检查微信扫码",
    toolboxQrOpen: "打开二维码链接",
    toolboxQrStatus: "扫码状态",
    toolboxLastError: "最近错误",
    toolboxChannelSaved: "手机通道已保存",
    toolboxDraftSaved: "工具箱草稿已保存",
    toolboxBindingSaved: "会话绑定已保存",
    toolboxBindingRemoved: "会话绑定已解除",
    toolboxBindingSynced: "会话绑定已同步",
    toolboxSessionsSynced: "本地 Codex 历史已同步",
    toolboxSessionSafeNote: "会话管理只在 VarSwitch 内隐藏记录，不会删除 Codex App 的历史会话文件。",
    toolboxSessionSearchPlaceholder: "搜索标题、项目、消息或会话 ID",
    toolboxSessionSelectAll: "全选",
    toolboxSessionClearSelected: "取消选择",
    toolboxSessionCopyIds: "复制 ID",
    toolboxSessionOpenTrash: "回收站",
    toolboxSessionMoveTrash: "移到回收站",
    toolboxSessionTrashTitle: "会话回收站",
    toolboxSessionTrashHint: "恢复从本工具列表中隐藏的会话；Codex 原始文件从未删除。",
    toolboxSessionTrashClose: "关闭",
    toolboxSessionRestoreSelected: "恢复所选",
    toolboxSessionTrashEmpty: "回收站为空",
    toolboxSessionNoSearchResults: "没有匹配的会话。",
    toolboxSessionSelectedSummary: "已选 {selected} 个 · 当前显示 {total} 个 · 回收站 {trash} 个",
    toolboxSessionCopiedIds: "已复制所选会话 ID",
    toolboxSessionMovedTrash: "已移入工具内回收站",
    toolboxSessionRestored: "会话已恢复",
    toolboxSessionConfirmTrash: "把所选会话移入 VarSwitch 回收站？这不会删除 Codex App 的历史会话文件。",
    toolboxSessionProjectUnknown: "未知项目",
    toolboxSessionIdLabel: "会话 ID",
    toolboxSessionFileLabel: "文件",
    toolboxSessionDeletedAt: "隐藏时间",
    toolboxSessionCopyId: "复制会话 ID",
    toolboxThreadSelected: "手机控制对话已切换",
    toolboxRemoteStarted: "手机平台连接正在启动",
    toolboxRemoteStopped: "手机控制已停止",
    readFailed: "读取失败",
    synced: "已同步",
    unsynced: "未同步",
    noConfigsTitle: "暂无配置",
    noConfigsDesc: "创建一个配置，一键同步系统环境变量 / VSCode / Claude。",
    addFirstConfig: "添加第一个配置",
    inUse: "使用中",
    switchUse: "切换使用",
    edit: "编辑",
    delete: "删除",
    toastUpdated: "配置已更新",
    toastAdded: "配置已添加",
    toastSaving: "保存中...",
    toastDeleted: "配置已删除",
    toastImported: "当前配置已导入",
    toastCopied: "已复制到剪贴板",
    switchedTo: "已切换到 {name}",
    partialSuccess: "部分成功: {ok}\n失败: {errors}",
    cancelledRestored: "已取消切换，已恢复之前配置",
    cancelRestoreFailed: "取消后恢复失败: {error}",
    switchFailed: "切换失败: {error}",
    switchRolledBack: "切换失败，已恢复之前配置：{error}",
    snapshotFailed: "快照失败: {error}",
    confirmDelete: "确认删除 \"{name}\"？",
    importPrompt: "请输入导入配置名称：",
    importDefaultName: "当前配置",
    loadStatusFailed: "读取状态失败: {error}",
    loadProfilesFailed: "读取配置失败: {error}",
    activeConfigLabel: "当前配置",
    syncNow: "立即同步",
    switchToDark: "夜间",
    switchToLight: "白天",
    placeholderName: "例如：生产环境",
    placeholderApiKey: "sk-...",
    placeholderBaseUrl: "留空使用官方地址 https://api.anthropic.com",
    modelIdLabel: "模型 ID",
    placeholderModelId: "如 opus, sonnet",
    modelIdHint: "可选。设置编辑器和 Claude 系统设置中的模型。",
    modelMappingTitle: "高级模型映射",
    modelMappingHint: "可选。分别写入 ANTHROPIC_DEFAULT_SONNET_MODEL / ANTHROPIC_DEFAULT_OPUS_MODEL / ANTHROPIC_DEFAULT_HAIKU_MODEL，留空则不设置。",
    sonnetModelLabel: "Sonnet 模型",
    opusModelLabel: "Opus 模型",
    haikuModelLabel: "Haiku 模型",
    dragToReorder: "拖拽排序",
    reorderFailed: "排序保存失败: {error}",
    endpointTest: "验证连接",
    endpointTesting: "验证中...",
    endpointUse: "使用",
    modelFetch: "获取模型",
    modelFetching: "获取中...",
    modelFetchMissing: "请先填写 API Key。",
    providerPresetLabel: "供应商预设",
    providerPresetCustom: "自定义",
    claudePresetHintDefault: "选择供应商自动填充官方地址与默认模型；Base URL 留空即使用官方 API。",
    claudeApiFormatLabel: "API 格式",
    claudeApiFormatHint: "上游仅提供 OpenAI 接口时选第二项：请求经 127.0.0.1:25789 本地代理转换协议，需保持 VarSwitch 运行。",
    claudeApiFormatOptionAnthropic: "Anthropic Messages（默认直连）",
    claudeApiFormatOptionOpenAiChat: "OpenAI Chat Completions（经本地代理转换）",
    claudeApiFormatNeedsBaseUrl: "OpenAI 格式必须填写上游 Base URL。",
    claudeApiFormatNeedsModel: "OpenAI 格式需要填写 Model ID（上游真实模型名，例如 deepseek-chat）。",
    proxyFailoverLabel: "加入代理故障转移池",
    proxyFailoverHint: "当前激活配置故障时，本地代理按列表顺序自动切到池内配置。需填写 Base URL。",
    proxyFailoverBadge: "备用",
    proxyTakeoverLabel: "由本地代理接管",
    proxyTakeoverHint: "开启后请求经 127.0.0.1:25789 透传，可享受故障转移与熔断；需保持 VarSwitch 运行，否则 Claude Code 连不上。",
    proxyTakeoverBadge: "代理",
    proxyHealthTitle: "代理健康",
    proxyHealthRunning: "运行中（127.0.0.1:{port}）",
    proxyHealthStopped: "未运行",
    proxyHealthStatusLabel: "代理状态",
    proxyHealthPrimaryLabel: "主上游",
    proxyHealthFailoverLabel: "备用",
    proxyHealthPoolEmpty: "暂无备用上游，可在其他填写了 Base URL 的配置中勾选「加入代理故障转移池」。",
    proxyHealthFailoverCountLabel: "自动转移次数",
    proxyHealthLastErrorLabel: "最近错误",
    proxyHealthNoError: "无",
    proxyHealthResetBreaker: "重置熔断",
    proxyHealthResetDone: "熔断器与健康统计已重置",
    proxyHealthStatsTitle: "失败 / 总请求",
    proxyBreakerClosed: "正常",
    proxyBreakerOpen: "熔断",
    proxyBreakerHalfOpen: "探测中",
    codexWireApiLabel: "上游协议",
    codexWireApiHint: "写入 ~/.codex/config.toml 的 wire_api 字段；选择预设时自动匹配。",
    codexWireApiDeepseekHint: "DeepSeek 官方端点使用 Responses API，此预设已固定协议。",
    codexAdvancedTitle: "高级选项",
    verifyOkLabel: "验证通过",
    verifyModelsSuffix: "个模型",
    verifyOkToast: "连接验证通过：API Key 与端点均可用。",
    verifyAuthFailed: "鉴权失败（401/403），请检查 API Key 是否有效。",
    verifyNoModelsEndpoint: "该端点不支持 /models 接口（404/405），无法自动验证。",
    modelFetchNoResults: "没有返回模型",
    modelSelected: "已选择模型",
    skillsManage: "技能",
    skillsTitle: "技能管理",
    addSkill: "+ 添加技能",
    skillName: "命令名称",
    skillContent: "内容",
    skillNamePlaceholder: "command-name",
    toastSkillSaved: "技能已保存",
    toastSkillDeleted: "技能已删除",
    confirmDeleteSkill: "确认删除技能 \"{name}\"？",
    noSkills: "暂无技能。为 Claude Code 创建斜杠命令。",
    promptsManage: "提示词",
    promptsTitle: "Claude 提示词",
    promptsPathLabel: "~/.claude/CLAUDE.md",
    toastPromptSaved: "提示词已保存",
    mcpManage: "MCP 服务器",
    mcpTitle: "MCP 服务器管理",
    mcpPathLabel: "~/.claude.json · ~/.codex/config.toml · ~/.gemini/settings.json",
    addMcp: "+ 添加服务器",
    mcpName: "服务器名称",
    mcpConfig: "配置 (JSON)",
    mcpNamePlaceholder: "context7",
    mcpIntro: "MCP Server 为 AI CLI 提供额外能力（查文档、读写文件、连数据库等）。在这里登记一次，即可同步到下面各个应用的配置文件。",
    mcpNameHint: "供 CLI 引用的唯一标识，例如 context7、filesystem。",
    mcpModeForm: "表单填写",
    mcpModeJson: "JSON",
    mcpTransportLabel: "连接方式",
    mcpTransportStdio: "本地命令（stdio）",
    mcpTransportHttp: "远程 HTTP",
    mcpTransportSse: "远程 SSE",
    mcpTransportHint: "大多数 MCP Server 是本地命令：由 CLI 启动一个进程并通过标准输入输出通信。",
    mcpCommandLabel: "启动命令",
    mcpArgsLabel: "参数（一行一个）",
    mcpEnvLabel: "环境变量（一行一个 KEY=VALUE，可留空）",
    mcpUrlLabel: "服务地址",
    mcpHeadersLabel: "请求头（一行一个 Key: Value，可留空）",
    mcpNeedName: "请填写服务器名称。",
    mcpNeedCommand: "请填写启动命令，例如 npx。",
    mcpNeedUrl: "请填写服务地址。",
    mcpJsonTooComplex: "该配置包含表单无法表达的字段，请继续用 JSON 模式编辑。",
    toastMcpSaved: "MCP 服务器已保存",
    toastMcpDeleted: "MCP 服务器已删除",
    confirmDeleteMcp: "确认删除 MCP 服务器 \"{name}\"？将从所有应用（Claude / Codex / Gemini / Claude Desktop）中移除。",
    invalidJson: "JSON 格式无效",
    noMcpServers: "暂无 MCP 服务器配置。",
    mcpAppsLabel: "启用到应用",
    mcpNoAppSelected: "请至少选择一个应用",
    toastMcpAppEnabled: "{name} 已在 {app} 启用",
    toastMcpAppDisabled: "{name} 已在 {app} 停用",
    mcpDesktopNotInstalled: "未检测到 Claude Desktop",
    mcpDesktopPathLabel: "Claude Desktop：{path}",
    confirmDisableLastMcpApp: "\"{name}\" 目前仅在 {app} 启用，停用后该服务器将从所有应用中移除。是否继续？",
    // Skills Discovery
    skillsTabInstalled: "已安装",
    skillsTabDiscover: "发现",
    installFromZip: "从 ZIP 安装",
    zipInstallTitle: "从 ZIP 安装技能",
    zipInstallTargets: "安装到",
    zipInstallConfirmBtn: "安装",
    zipNoAppSelected: "请至少选择一个应用",
    zipOverwriteConfirm: "技能 \"{name}\" 已存在，是否覆盖？",
    toastZipInstalledTo: "技能 \"{name}\" 已安装到 {apps}",
    discoverSearchPlaceholder: "搜索技能...",
    allRepos: "全部仓库",
    filterAll: "全部",
    filterInstalled: "已安装",
    filterNotInstalled: "未安装",
    manageRepos: "仓库",
    discoverLoading: "正在从仓库加载技能...",
    discoverEmpty: "未发现技能。",
    discoverNoMatch: "没有匹配的技能。",
    installBtn: "安装",
    installedBadge: "已安装",
    uninstallBtn: "卸载",
    repoManagerTitle: "管理仓库",
    addRepoLabel: "添加仓库",
    addRepoPlaceholder: "owner/repo 或 https://github.com/owner/repo",
    toastSkillInstalled: "技能 \"{name}\" 已安装",
    toastSkillUninstalled: "技能 \"{name}\" 已卸载",
    toastRepoAdded: "仓库已添加",
    toastRepoRemoved: "仓库已删除",
    toastZipInstalled: "已从 ZIP 安装 {count} 个技能",
    toastZipNoSkills: "ZIP 文件中未找到技能",
    commands: "个命令",
    localSkill: "本地",
    repoSkill: "仓库",
    sourceCommand: "命令",
    sourceSkill: "技能",
    // Prompt Templates
    promptTabEditor: "编辑器",
    promptTabTemplates: "模板库",
    insertSnippet: "-- 插入片段 --",
    appendToPrompt: "追加",
    replacePrompt: "替换",
    // Prompt Presets（预设库 + 跨应用同步 + 回填保护）
    promptTabPresets: "预设",
    presetNew: "+ 新建预设",
    presetName: "预设名称",
    presetNamePlaceholder: "例如：中文开发",
    presetApps: "同步到应用",
    presetContent: "内容",
    presetContentPlaceholder: "系统提示词内容...",
    presetActive: "激活中",
    presetActivate: "激活",
    presetEdit: "编辑",
    presetDelete: "删除",
    presetEmpty: "暂无预设。创建预设可在多个应用间同步提示词。",
    presetSaved: "预设已保存",
    presetDeleted: "预设已删除",
    presetActivated: "预设已激活",
    presetBackfilled: "检测到 live 文件有手工修改，已回填到原预设",
    confirmDeletePreset: "确认删除预设 \"{name}\"？",
    confirmActivatePreset: "激活预设 \"{name}\"？内容将写入：",
    presetNeedName: "请填写预设名称",
    presetNeedApp: "请至少勾选一个目标应用",
    templateSaveAsPreset: "存为预设",
    snippetLanguagePref: "语言：中文",
    snippetCodeQuality: "代码质量规则",
    snippetSecurity: "安全指南",
    snippetConcise: "简洁模式",
    snippetArchitect: "架构指南",
    toastSnippetInserted: "片段已插入",
    toastTemplateApplied: "模板已应用",
    mcpTabInstalled: "已安装",
    mcpTabPresets: "预设",
    mcpSearchPlaceholder: "在 GitHub 搜索 MCP 服务器...",
    mcpSearchLoading: "正在搜索 GitHub...",
    mcpRequiresApiKey: "需要配置 API 密钥",
    mcpInstalled: "已安装",
    mcpInstallBtn: "安装",
    mcpGithubBtn: "GitHub",
    mcpNoPresets: "暂无预设。",
    // Skills Discovery GitHub search
    skillsSearchGithub: "搜索 GitHub",
    skillsSearchGithubPlaceholder: "在 GitHub 搜索技能...",
    skillsGithubLoading: "正在搜索 GitHub...",
    // Settings
    settingsTitle: "设置",
    settingsGroupGeneral: "通用",
    settingsGroupPaths: "目录",
    settingsGroupBackup: "备份",
    settingsAutoStart: "开机自启",
    settingsAutoStartDesc: "登录系统时自动启动 VarSwitch",
    settingsMinTray: "最小化到托盘",
    settingsMinTrayDesc: "关闭窗口时隐藏到系统托盘",
    settingsConfigDir: "配置目录",
    settingsClaudePath: "Claude 设置",
    settingsCodexPath: "Codex 设置",
    settingsLogs: "运行日志",
    settingsLogsDesc: "出现问题时可打开日志文件夹查看或反馈",
    settingsOpen: "打开",
    settingsCopyPath: "复制路径",
    settingsBrowse: "浏览",
    settingsSavePath: "保存路径",
    settingsReset: "重置",
    settingsPathPlaceholder: "粘贴 settings 目录或 settings.json 路径",
    settingsPathEmpty: "请先输入编辑器设置路径",
    settingsCurrentPath: "当前使用路径",
    settingsDefaultPathLabel: "内置默认路径",
    settingsEditorStatusCustom: "手动路径",
    settingsEditorStatusDetected: "已自动识别",
    settingsEditorStatusDefault: "默认路径",
    settingsEditorHintCustom: "当前使用你保存的路径进行环境识别和同步。",
    settingsEditorHintDetected: "当前使用此设备上自动识别到的内置路径。",
    settingsEditorHintDefault: "暂未识别到该编辑器；如果装在其他位置，可以在这里手动指定。",
    settingsDefaultPath: "默认路径：{path}",
    settingsExport: "导出配置",
    settingsImport: "导入配置",
    settingsManualBackup: "手动配置备份",
    settingsManualBackupDesc: "导入与导出当前的所有配置",
    settingsAutoBackup: "自动备份",
    settingsAutoBackupDesc: "每次切换配置前自动快照，误操作可回滚",
    settingsViewBackups: "回滚",
    toastSettingsSaved: "设置已保存",
    toastEditorPathSaved: "已保存 {name} 路径",
    toastEditorPathReset: "已重置 {name} 路径",
    toastEditorPathBrowseCancelled: "已取消选择路径",
    toastExported: "配置已导出",
    toastImported2: "已导入 {count} 个配置",
    toastImportNone: "没有新配置可导入",
    settingsSilentStart: "静默启动",
    settingsSilentStartDesc: "启动时最小化到系统托盘",
    settingsHotkey: "全局快捷键",
    settingsHotkeyDesc: "在任意界面按下快捷键，显示 / 隐藏 VarSwitch 主窗口",
    settingsHotkeyPlaceholder: "点击后按下组合键",
    settingsHotkeyClear: "清除",
    settingsHotkeyNeedModifier: "快捷键需要包含 Ctrl、Alt 或 Win 键",
    settingsHotkeySaved: "全局快捷键已设为 {keys}",
    settingsHotkeyCleared: "已关闭全局快捷键",
    // 配置体检
    healthCheckGroup: "配置体检",
    healthCheckLabel: "检测所有配置是否可用",
    healthCheckDesc: "逐个探测各配置的 Base URL，标出失效原因；不会修改或删除任何配置。",
    healthCheckBtn: "开始检测",
    healthChecking: "检测中...",
    healthSummary: "共 {total} 项：{ok} 可用、{bad} 有问题、{dead} 不可达",
    healthLevelOk: "可用",
    healthLevelWarn: "可疑",
    healthLevelBad: "有问题",
    healthLevelDead: "不可达",
    healthLevelSkipped: "已跳过",
    healthFailed: "体检失败",
    balanceLabel: "余额",
    balanceCheck: "查询余额",
    balanceLoading: "查询中...",
    balanceUnsupported: "不支持",
    balanceUnsupportedHint: "该供应商暂不支持余额查询",
    balanceFailedShort: "查询失败",
    balanceUsedLabel: "已用",
    balanceQuotaLabel: "总额度",
    balanceGrantedLabel: "赠送",
    balanceToppedUpLabel: "充值",
    balanceUnlimitedHint: "该站点未设置额度上限，因此只显示已用金额",
    balanceUpdatedAt: "更新于 {time}",
    siteTokenTitle: "站点访问令牌",
    siteTokenHint: "填写中转站后台「个人设置」里生成的系统访问令牌，即可查询账户真实余额。这不是 sk- 开头的 API Key。",
    siteTokenValueLabel: "访问令牌",
    siteTokenUserIdLabel: "用户 ID（new-api 站点必填）",
    siteTokenUserIdHint: "纯数字，可在站点后台个人资料中查看。one-api 站点可留空。",
    siteTokenSave: "保存并查询",
    siteTokenDelete: "删除",
    siteTokenConfigure: "配置站点令牌以查询真实余额",
    siteTokenSaved: "已保存 {host} 的站点令牌",
    siteTokenDeleted: "已删除 {host} 的站点令牌",
    siteTokenEmpty: "请填写访问令牌",
    siteTokenFailedHint: "站点令牌查询失败：{error}",
    settingsLang: "语言",
    settingsTheme: "主题",
    supportSectionTitle: "快捷操作",
    supportHintDefault: "打开使用说明、检查更新，或直接访问仓库。",
    supportHintUpdateAvailable: "发现新版本：当前版本 {currentVersion}，新版本 {latestVersion}，点击即可后台下载并自动安装。",
    supportHintUpToDate: "当前已经是最新版本：{version}。",
    usageGuideBtn: "使用说明",
    updateCheckBtn: "检查更新",
    updateReleaseBtn: "安装更新 {version}",
    downloadSiteBtn: "下载网站",
    githubRepoBtn: "GitHub 仓库",
    usageGuideKicker: "使用说明",
    usageGuideTitle: "VarSwitch 使用说明",
    usageGuideIntro: "VarSwitch 可集中管理 Claude Code、Codex、提示词、MCP Server、移动端控制、设置与备份。",
    usageGuideStep1Title: "Claude Code 配置",
    usageGuideStep1Desc: "添加或导入 Token/Base URL 配置，可带 Key 验证接口连通性；切换后会同步系统环境变量、已支持编辑器和 ~/.claude/settings.json。",
    usageGuideStep2Title: "Codex 配置",
    usageGuideStep2Desc: "管理 Codex API Key、Base URL、模型、Provider 和写入方式，并同步 ~/.codex/config.toml 与 auth.json。",
    usageGuideStep3Title: "Codex Toolbox",
    usageGuideStep3Desc: "同步 Codex 会话，并绑定飞书/Lark、QQ、微信移动端控制。",
    usageGuideStep4Title: "Skills、Prompts 与 MCP",
    usageGuideStep4Desc: "顶部工具栏可编辑 Claude Skills/Commands、维护 CLAUDE.md 模板，并管理 ~/.claude.json 中的 MCP Server。",
    usageGuideStep5Title: "设置与备份",
    usageGuideStep5Desc: "设置语言、主题、托盘行为、开机启动、编辑器路径，支持配置导入导出、自动备份和回滚。",
    usageGuideStep6Title: "更新与生效提示",
    usageGuideStep6Desc: "首页可检查更新、打开下载站或仓库。切换配置后，请重启终端和编辑器让环境变量生效。",
    usageGuideClose: "关闭",
    usageGuideNever: "永不提醒",
    toastGuideDisabled: "已关闭使用说明提醒",
    checkingUpdates: "正在检查更新...",
    downloadingUpdate: "正在下载更新 {percent}%",
    installingUpdate: "正在安装更新...",
    openingReleasePage: "正在打开下载页...",
    toastUpdateAvailable: "发现新版本：当前版本 {currentVersion}，新版本 {latestVersion}",
    updatePillText: "发现新版本：当前版本 {currentVersion}，新版本 {latestVersion}",
    updatePillAction: "下载更新",
    toastUpdateDownloaded: "更新安装程序已启动，必要时 VarSwitch 会自动重启。",
    toastAlreadyLatest: "当前已经是最新版本",
    toastReleaseOpened: "已打开下载页",
    toastRepoOpened: "已打开仓库地址",
    cliSessionsNavLabel: "会话",
    cliSessionsPageTitle: "会话",
    cliSessionsPageSubtitle: "浏览 Claude Code 与 Codex 的本机历史会话，一键在终端或应用中恢复。",
    cliSessionsRefresh: "刷新",
    cliSessionsSearchPlaceholder: "搜索标题、目录或会话 ID",
    cliSessionsFilterAll: "全部",
    cliSessionsLoading: "正在扫描本机会话…",
    cliSessionsCount: "共 {count} 个会话",
    cliSessionsEmptyTitle: "暂无历史会话",
    cliSessionsEmptyText: "使用 Claude Code 或 Codex 后，这里会列出可恢复的本机会话。",
    cliSessionsEmptyFilteredTitle: "没有匹配的会话",
    cliSessionsEmptyFilteredText: "换个关键词或来源筛选试试。",
    cliSessionsResume: "恢复会话",
    cliSessionsResumeOpened: "已在终端 / 应用中打开",
    cliSessionsResumeFailed: "恢复会话失败：{error}",
    cliSessionsLoadFailed: "会话加载失败：{error}",
    cliSessionsNoCwd: "未知目录",
    settingsGroupDataDir: "数据目录（多设备同步）",
    settingsDataDirLabel: "数据目录",
    settingsDataDirDesc: "可指向 OneDrive / Dropbox / 坚果云 / NAS 同步目录，在多台设备间共享配置。注意：配置含明文密钥，请确保同步目录可信。",
    settingsDataDirDefault: "默认",
    settingsDataDirCustom: "自定义",
    settingsDataDirPick: "选择目录…",
    settingsDataDirReset: "恢复默认",
    dataDirSwitchTitle: "数据目录已切换",
    dataDirSwitchSummary: "已复制 {copied} 项，跳过 {skipped} 项已存在文件。",
    dataDirRestartHint: "请重启应用使所有功能生效。",
    dataDirResetDone: "已恢复默认数据目录。",
    dataDirConfirmReset: "恢复默认数据目录？自定义目录中的文件不会被删除。",
    dataDirAlreadyDefault: "当前已是默认数据目录",
    dataDirGotIt: "知道了",
    deeplinkTitle: "通过链接导入",
    deeplinkWarning: "此配置来自外部链接，请确认链接来源可信后再导入。",
    deeplinkTargetApp: "目标应用",
    deeplinkFieldName: "名称",
    deeplinkFieldBaseUrl: "Base URL",
    deeplinkFieldApiKey: "API Key",
    deeplinkConfigPreview: "MCP 配置预览",
    deeplinkConfirm: "确认导入",
    deeplinkImporting: "导入中...",
    deeplinkInvalid: "链接解析失败：{message}",
    claudeDesktopPageTitle: "Claude Desktop",
    claudeDesktopPageSubtitle: "通过独立的 3P Profile 使用第三方 API，支持 Gateway 与直连。",
    claudeDesktopSync: "立即同步",
    claudeDesktopImport: "从 Claude Code 导入",
    claudeDesktopAddProfile: "添加 Desktop 配置",
    claudeDesktopEditProfile: "编辑 Desktop 配置",
    claudeDesktopStatusTitle: "Claude Desktop 状态",
    claudeDesktopProfilesTitle: "Claude Desktop 配置列表",
    claudeDesktopGatewayHealthTitle: "Desktop Gateway 健康",
    claudeDesktopModeOfficial: "Official",
    claudeDesktopModeGateway: "Gateway",
    claudeDesktopModeDirect: "直连",
    claudeDesktopInstalled: "已检测到",
    claudeDesktopNotInstalled: "未检测到",
    claudeDesktopInstallStatus: "安装状态",
    claudeDesktopCurrentMode: "当前模式",
    claudeDesktopActiveProvider: "当前供应商",
    claudeDesktopGatewayStatus: "本地 Gateway",
    claudeDesktopProfilePath: "3P Profile",
    claudeDesktopGatewayRunning: "运行中",
    claudeDesktopGatewayStopped: "未运行",
    claudeDesktopGatewayNotRequired: "无需运行",
    claudeDesktopGatewayDependencyWarning: "Gateway 模式需要保持 VarSwitch 运行；切换后请完全退出并重启 Claude Desktop。",
    claudeDesktopFailoverCount: "故障转移次数",
    claudeDesktopFailoverBadge: "备用",
    claudeDesktopOfficialLogin: "认证方式",
    claudeDesktopOfficialLoginHint: "Claude 官方账号",
    claudeDesktopApiFormat: "API 格式",
    claudeDesktopDefaultModel: "默认模型",
    claudeDesktopModelHint: "Gateway：先点“获取模型”，填写未命中映射时使用的上游默认模型。Anthropic 透传保留原始请求体；OpenAI 转换按下方逐项映射替换。",
    claudeDesktopModelMappingHint: "手动添加 Claude Code 看到的模型与上游实际模型；仅 OpenAI 转换替换，Anthropic 透传完整保留原始请求体。",
    claudeDesktopSourceModelLabel: "Claude Code 模型",
    claudeDesktopTargetModelLabel: "上游实际模型",
    claudeDesktopAddMapping: "+ 添加模型映射",
    claudeDesktopRemoveMapping: "删除",
    claudeDesktopNoProfiles: "暂无 Claude Desktop 配置",
    claudeDesktopNoProfilesHint: "添加配置，或从 Claude Code 复制现有供应商。",
    claudeDesktopLoadFailed: "加载 Claude Desktop 失败：{error}",
    claudeDesktopGatewayHint: "Gateway 支持模型映射、OpenAI Chat 转换与故障转移，需要保持 VarSwitch 运行。",
    claudeDesktopDirectHint: "直连仅支持 Anthropic Messages；切换完成后不需要保持 VarSwitch 运行。",
    claudeDesktopModelRequired: "请至少填写一个默认模型或一条完整的模型映射。",
    claudeDesktopAdded: "Claude Desktop 配置已添加",
    claudeDesktopUpdated: "Claude Desktop 配置已更新",
    claudeDesktopDeleted: "Claude Desktop 配置已删除",
    claudeDesktopDeleteConfirm: "删除 Claude Desktop 配置「{name}」？",
    claudeDesktopImportConfirm: "把当前全部 Claude Code 供应商复制到独立的 Claude Desktop 列表？",
    claudeDesktopImported: "已导入 {count} 个 Claude Desktop 配置",
    claudeDesktopRestartRequired: "请完全退出并重启 Claude Desktop 使配置生效。",
    claudeDesktopBreakerReset: "Desktop Gateway 熔断状态已重置",
    claudeDesktopFetchModels: "获取模型",
    claudeDesktopFetchingModels: "正在获取模型...",
    claudeDesktopModelsFetched: "已获取 {count} 个模型",
    claudeDesktopModelsFetchFailed: "获取模型失败：{error}",
    navSectionWorkspace: "工作台",
    navSectionToolbox: "工具箱",
    navAddProvider: "添加配置",
    navSettings: "设置",
    claudePageSubtitle: "管理系统环境变量与 Claude 设置同步状态。",
    claudePageAddBtnText: "添加 Claude 配置",
    geminiPageSubtitle: "管理 Gemini CLI 的 API Key、自定义网关与默认模型。",
    geminiPageAddBtnText: "添加 Gemini 配置",
    universalPageTitle: "添加统一供应商",
    universalPageSubtitle: "一次配置 API 网关，并同步到选中的应用。",
    universalPresetHeading: "供应商预设",
    universalPresetDesc: "与 cc-switch 一致，统一供应商从 NewAPI 或自定义网关开始。",
    universalPresetNewapiDesc: "多协议统一 API 网关",
    universalPresetCustom: "自定义网关",
    universalPresetCustomDesc: "手动配置兼容服务",
    universalConnHeading: "连接信息",
    universalConnDesc: "所有选中的应用共用这组地址和密钥。",
    universalProviderNameLabel: "供应商名称",
    universalBaseUrlLabel: "API 地址",
    universalAppsHeading: "启用的应用",
    universalAppsDesc: "保存后会生成对应配置，并在左侧显示栏目。",
    universalParamsHeading: "应用参数",
    universalParamsDesc: "按应用设置协议与默认模型；验证连接后模型输入框支持自动补全，留空时由对应客户端决定。",
    universalClaudeTarget: "写入 ~/.claude/settings.json 与系统环境变量",
    universalCodexTarget: "写入 ~/.codex/config.toml 的 wire_api 字段",
    universalGrokTarget: "写入 ~/.grok/config.toml 的 api_backend 字段",
    universalGeminiTarget: "Generative Language · 写入 GOOGLE_GEMINI_BASE_URL",
    universalApiFormatLabel: "API 格式",
    universalDefaultModelLabel: "默认模型",
    universalWireApiLabel: "上游协议",
    toolboxPageSubtitle: "同步 Codex 会话，并配置手机端远程控制。",
    toolboxSyncStatusHeading: "同步状态",
    developerToolsSubtitle: "管理 Claude Code 的 Skills、Prompts 与 MCP Servers。",
    settingsPageSubtitle: "管理应用偏好、路径、备份与帮助入口。",
    settingsLangLabel: "语言",
    settingsLangDesc: "选择界面显示语言",
    settingsThemeLabel: "外观",
    settingsThemeDesc: "选择浅色或深色主题",
    settingsThemeLightBtn: "浅色",
    settingsThemeDarkBtn: "深色",
    settingsGuideTitle: "使用说明",
    settingsGuideDesc: "查看安全切换与配置指南",
    settingsUpdateTitle: "检查更新",
    settingsDownloadTitle: "下载网站",
    settingsDownloadDesc: "打开版本下载页面",
    settingsGithubTitle: "GitHub 仓库",
    settingsGithubDesc: "查看源码与问题反馈",
    universalPresetNewapiName: "NewAPI",
    universalPresetCustomHint: "使用同一组 API 地址和密钥同步到多个应用",
    universalSyncTargets: "将同步到 {apps}",
    universalNoAppSelected: "请至少启用一个应用",
    universalAutoV1Hint: "保存时地址自动补全 /v1 后缀",
    showKey: "显示",
    showApiKey: "显示 API Key",
    fetchModels: "拉取模型",
    testConnection: "测试连接",
    hideApiKey: "隐藏 API Key",
    pasteApiKey: "粘贴 API Key",
    clipboardReadFailed: "无法读取剪贴板",
    universalTestConn: "验证连接",
    resetBtn: "重置",
    universalSubmit: "添加并同步",
    geminiProfilesTitle: "Gemini 配置列表",
    settingsLangZhBtn: "中文",
    settingsLangEnBtn: "English",
    hideKey: "隐藏",
  }
};

let currentLang = localStorage.getItem(LANG_STORAGE_KEY) || "zh";
if (!I18N[currentLang]) {
  currentLang = "zh";
}
// 用户没有手动切换过语言时,忽略历史遗留的存储值,进入软件默认中文
if (!localStorage.getItem(LANG_USER_SET_KEY)) {
  currentLang = "zh";
  localStorage.setItem(LANG_STORAGE_KEY, "zh");
}

let currentTheme = localStorage.getItem(THEME_STORAGE_KEY) || "light";
if (currentTheme !== "light" && currentTheme !== "dark") {
  currentTheme = "light";
}

let profiles = [];
let claudeDesktopProfiles = [];
let claudeDesktopStatus = null;
let claudeDesktopGatewayHealth = null;
let editingClaudeDesktopProfileId = null;
let claudeDesktopSaving = false;
let claudeDesktopHealthTimer = null;
let claudeDesktopModelCatalog = [];
let claudeDesktopModelMappings = [];
let codexProfiles = [];
let grokProfiles = [];
let geminiProfiles = [];
let opencodeProfiles = [];
let grokDiagnostics = null;
let codexToolbox = null;
let codexDiagnostics = null;
let currentPage = "add-provider";
let activeConsolePage = "add-provider";
let selectedUniversalProviderPreset = "newapi";
let universalProviderSaving = false;
let codexEnableAfterSave = false;
let configurationFilter = "all";
let configurationSearch = "";
let lastClaudeStatus = null;
let lastCodexStatus = null;
let lastGrokStatus = null;
let lastGeminiStatus = null;
let lastOpenCodeStatus = null;
let editingGrokId = null;
let editingGeminiId = null;
let editingOpenCodeId = null;
let detectedEditors = {}; // { id: displayName }
let editingId = null;
let profileSaving = false;
let grokProfileSaving = false;
let geminiProfileSaving = false;
let opencodeProfileSaving = false;
let progressUnlisten = null;
let mobileChannelStatusUnlisten = null;
let isSwitchingProfile = false;
let skillsData = [];
let editingSkillName = null;
let skillSaving = false;
let mcpServers = {};
let mcpServerApps = {}; // name -> { claude, codex, gemini, claudeDesktop }（统一 MCP 面板各应用的启用状态）
let editingMcpName = null;
let mcpSaving = false;
let mcpAppToggling = false; // 应用徽标切换防并发
// Claude Desktop 的 MCP 状态（installed=false 时第 4 个 chip 置灰禁用）
let mcpDesktopInfo = { installed: false, configPath: "", servers: {} };
let discoverSkills = [];
let skillRepos = [];
let repoAdding = false;
let activeSkillsTab = "installed";
let discoverSearchQuery = "";
let discoverRepoFilter = "all";
let discoverStatusFilter = "all";
let isDiscovering = false;
let promptTemplates = [];
let activePromptTab = "presets";
// 预设库数据（get_prompt_presets 返回的 { presets, activeId, live }）
let promptPresetsData = { presets: [], activeId: null, live: {} };
// 右侧编辑区正在编辑的预设 id；null 表示新建
let editingPromptPresetId = null;
let isShowingGithubSkills = false;
let updateInfo = null;
let updateBusy = false;
let updateBusyAction = null;
let updatePillHideTimer = null;
let updateDownloadPercent = 0;
let updateDownloadUnlisten = null;
let appSettings = null;
let appPaths = null;
let usageGuideAutoHandled = false;
let activeToolboxTab = "session";
let activeDeveloperTool = "skills";
let selectedCodexThreadId = "";
let selectedMobileChannel = "wechat";
let toolboxRefreshTimer = null;
let toolboxRefreshBusy = false;
let pendingApprovalIds = new Set(); // 正在提交的审批 requestId，防止同一卡片双重提交
let larkCredentialSaveTimer = null;
let toolboxRemoteBusy = false;
let toolboxSessionSyncBusy = false;
let toolboxSessionProgressTimer = null;
let toolboxSessionProgressValue = 0;
let toolboxSessionSearchQuery = "";
let toolboxSelectedSessionIds = new Set();
let toolboxSelectedTrashSessionIds = new Set();
let toolboxSessionTrashOpen = false;
let toolboxCopiedSessionId = "";
let mobileBindBusyAction = "";

/**
 * A10: 容器级事件委托，替代「innerHTML 全量重建后逐个卡片 addEventListener」。
 *
 * 为什么要这么做：
 * 1. 逐卡片绑定要求每次重渲染都重新绑一遍，一旦将来做局部更新（只替换某张卡片），
 *    极易出现同一个按钮被绑定两次、点一次触发两次的 bug。
 * 2. 委托只在容器上绑一次，重建 innerHTML 不影响监听器，也不会随卡片数量线性增长。
 *
 * 用 dataset 标记保证同一个容器只绑定一次（容器本身是 index.html 里的静态节点，
 * 不会被 innerHTML 替换掉，所以标记不会丢）。
 *
 * @param {HTMLElement|null} container 静态容器节点
 * @param {string} flag 该容器的绑定标记名，同一容器上多种用途请用不同 flag
 * @param {(action: string, target: HTMLElement, event: MouseEvent) => void} dispatch 分派函数
 */
function bindDelegatedActions(container, flag, dispatch) {
  if (!container) return;
  const key = `bound${flag}`;
  if (container.dataset[key] === "1") return;
  container.dataset[key] = "1";
  container.addEventListener("click", (event) => {
    const target = event.target.closest("[data-action]");
    // 只处理落在本容器内的按钮，避免嵌套容器互相截胡
    if (!target || !container.contains(target)) return;
    const action = target.getAttribute("data-action");
    if (!action) return;
    dispatch(action, target, event);
  });
}

/**
 * A10: 状态卡片里「复制」按钮的容器级委托。
 * 这些按钮用 data-copy 携带待复制文本，语义单一，单独给一个绑定入口。
 */
function bindDelegatedCopyButtons(container, flag) {
  if (!container) return;
  const key = `bound${flag}`;
  if (container.dataset[key] === "1") return;
  container.dataset[key] = "1";
  container.addEventListener("click", (event) => {
    const btn = event.target.closest(".copy-btn");
    if (!btn || !container.contains(btn)) return;
    event.stopPropagation();
    const text = btn.getAttribute("data-copy");
    if (!text) return;
    navigator.clipboard.writeText(text).then(() => showToast(t("toastCopied"), "success"));
  });
}

/**
 * A10: profile 卡片网格的公共委托绑定。
 * 四个 provider 的卡片按钮语义完全一致（switch / edit / delete + data-id），
 * 差异只有 provider 类型，所以共用一份分派逻辑。
 */
function bindProfileGridActions(grid, flag, type) {
  bindDelegatedActions(grid, flag, (action, target) => {
    const id = target.getAttribute("data-id");
    if (!id) return;
    // data-action 允许带 provider 前缀（如 codex-switch），统一去前缀后分派
    const kind = action.replace(/^(?:claude|codex|grok|gemini|opencode)-/, "");
    if (kind === "switch") switchAnyProviderProfile(type, id);
    else if (kind === "edit") editProviderProfile(type, id);
    else if (kind === "delete") deleteProviderProfile(type, id);
    else if (kind === "balance") queryProfileBalance(type, id);
    else if (kind === "balance-token") openSiteTokenDialog(type, id);
  });
}

// ── 配置卡片拖拽排序 ──────────────────────────────
// 四个列表共用一套实现；后端命令为跨智能体契约，名称不可改。
const PROFILE_SORT_KINDS = {
  claude: {
    command: "reorder_profiles",
    getList: () => profiles,
    setList: (list) => { profiles = list; },
    render: () => renderProfiles(),
    reload: () => loadProfiles(),
  },
  "claude-desktop": {
    command: "reorder_claude_desktop_profiles",
    getList: () => claudeDesktopProfiles,
    setList: (list) => {
      const official = list.find((item) => item.connectionMode === "official");
      claudeDesktopProfiles = official
        ? [official, ...list.filter((item) => item !== official)]
        : list;
    },
    render: () => renderClaudeDesktopProfiles(),
    reload: () => loadClaudeDesktopPage(),
  },
  codex: {
    command: "reorder_codex_profiles",
    getList: () => codexProfiles,
    setList: (list) => { codexProfiles = list; },
    render: () => renderCodexProfiles(),
    reload: () => loadCodexProfiles(),
  },
  grok: {
    command: "reorder_grok_profiles",
    getList: () => grokProfiles,
    setList: (list) => { grokProfiles = list; },
    render: () => renderGrokProfiles(),
    reload: () => loadGrokProfiles(),
  },
  gemini: {
    command: "reorder_gemini_profiles",
    getList: () => geminiProfiles,
    setList: (list) => { geminiProfiles = list; },
    render: () => renderGeminiProfiles(),
    reload: () => loadGeminiProfiles(),
  },
  opencode: {
    command: "reorder_opencode_profiles",
    getList: () => opencodeProfiles,
    setList: (list) => { opencodeProfiles = list; },
    render: () => renderOpenCodeProfiles(),
    reload: () => loadOpenCodeProfiles(),
  },
};

// ── 配置卡片余额查询 ──────────────────────────────
// 根据配置的 Base URL 识别供应商，调用后端 query_provider_balance 查询余额。
// 结果缓存在 localStorage：常规结果 10 分钟内不自动重查，「不支持」6 小时，
// 失败 1 分钟后允许自动重试；手动点刷新按钮总是强制重查。
// v2：v1 缓存里可能存着中转站占位额度算出的假余额，升版本号让旧数据直接作废
const BALANCE_CACHE_STORAGE_KEY = "varswitch_balance_cache_v2";
const BALANCE_TTL_MS = 10 * 60 * 1000;
const BALANCE_UNSUPPORTED_TTL_MS = 6 * 60 * 60 * 1000;
const BALANCE_ERROR_RETRY_MS = 60 * 1000;
const BALANCE_REFRESH_ICON = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/></svg>`;
const BALANCE_TOKEN_ICON = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 2l-2 2m-7.61 7.61a5.5 5.5 0 1 1-7.778 7.778 5.5 5.5 0 0 1 7.777-7.777zm0 0L15.5 7.5m0 0l3 3L22 7l-3-3"/></svg>`;

// OpenCode 官方 provider 可以不填 Base URL，查询余额时映射到官方端点
const OPENCODE_BALANCE_BASE_URLS = {
  deepseek: "https://api.deepseek.com",
  moonshotai: "https://api.moonshot.cn",
  siliconflow: "https://api.siliconflow.cn",
  openrouter: "https://openrouter.ai",
};

// 单个查询最坏要等后端探测多个端点，因此限制并发：手动点击插队优先，
// 自动刷新排在后面慢慢跑，避免打开页面时对几十个配置同时发请求
const BALANCE_MAX_CONCURRENCY = 3;

let balanceCache = null;
// 已配置站点令牌的列表（令牌本身由后端打码，前端只用来判断是否已配置）
let siteTokens = [];
const balanceInflight = new Set();
const balanceQueue = [];
let balanceRunningCount = 0;

function pumpBalanceQueue() {
  while (balanceRunningCount < BALANCE_MAX_CONCURRENCY && balanceQueue.length > 0) {
    const task = balanceQueue.shift();
    balanceRunningCount += 1;
    task().finally(() => {
      balanceRunningCount -= 1;
      pumpBalanceQueue();
    });
  }
}

function scheduleBalanceTask(task, { priority = false } = {}) {
  if (priority) balanceQueue.unshift(task);
  else balanceQueue.push(task);
  pumpBalanceQueue();
}

function getBalanceCache() {
  if (balanceCache) return balanceCache;
  try {
    localStorage.removeItem("varswitch_balance_cache_v1");
    balanceCache = JSON.parse(localStorage.getItem(BALANCE_CACHE_STORAGE_KEY)) || {};
  } catch {
    balanceCache = {};
  }
  return balanceCache;
}

function persistBalanceCache() {
  try {
    localStorage.setItem(BALANCE_CACHE_STORAGE_KEY, JSON.stringify(getBalanceCache()));
  } catch {
    // 存储写入失败时放弃持久化，内存缓存仍然可用
  }
}

function balanceProfileTarget(type, profile) {
  const apiKey = (profile.apiKey || "").trim();
  let baseUrl = (profile.baseUrl || "").trim();
  if (!baseUrl && type === "opencode") {
    baseUrl = OPENCODE_BALANCE_BASE_URLS[profile.providerId] || "";
  }
  if (!apiKey || !baseUrl) return null;
  return { apiKey, baseUrl };
}

// 缓存键带上地址和 Key 尾部：编辑配置换 Key/地址后旧缓存自动失效
function balanceCacheKey(type, profile) {
  const target = balanceProfileTarget(type, profile);
  if (!target) return null;
  return `${type}:${profile.id}:${target.baseUrl}:${target.apiKey.slice(-6)}`;
}

function isBalanceEntryStale(entry) {
  if (!entry || !entry.ts) return true;
  if (entry.error) return Date.now() - entry.ts > BALANCE_ERROR_RETRY_MS;
  const unsupported = entry.result && entry.result.supported === false;
  const ttl = unsupported ? BALANCE_UNSUPPORTED_TTL_MS : BALANCE_TTL_MS;
  return Date.now() - entry.ts > ttl;
}

function formatBalanceAmount(value, currency) {
  if (!Number.isFinite(value)) return "--";
  const symbol = currency === "CNY" ? "¥" : currency === "USD" ? "$" : currency ? `${currency} ` : "";
  const digits = Math.abs(value) >= 1000 ? 0 : 2;
  return `${symbol}${value.toLocaleString(undefined, { minimumFractionDigits: digits, maximumFractionDigits: digits })}`;
}

// 只有走通用计费接口（第三方中转站）的配置才谈得上「站点令牌」，
// DeepSeek 这类官方端点有自己的余额接口，不需要额外凭据
function balanceSupportsSiteToken(entry) {
  const provider = entry?.result?.provider;
  return provider === "openai_compat" || provider === "site_account" || provider === "unsupported";
}

function balanceTooltip(entry) {
  const lines = [];
  const result = entry.result || {};
  if (result.totalQuota != null) lines.push(`${t("balanceQuotaLabel")}: ${formatBalanceAmount(result.totalQuota, result.currency)}`);
  if (result.used != null) lines.push(`${t("balanceUsedLabel")}: ${formatBalanceAmount(result.used, result.currency)}`);
  if (result.toppedUp != null) lines.push(`${t("balanceToppedUpLabel")}: ${formatBalanceAmount(result.toppedUp, result.currency)}`);
  if (result.granted != null) lines.push(`${t("balanceGrantedLabel")}: ${formatBalanceAmount(result.granted, result.currency)}`);
  if (result.unlimitedQuota) lines.push(t("balanceUnlimitedHint"));
  if (result.siteTokenError) lines.push(t("siteTokenFailedHint", { error: result.siteTokenError }));
  if (entry.ts) lines.push(t("balanceUpdatedAt", { time: new Date(entry.ts).toLocaleString() }));
  return lines.join("\n");
}

function balanceDisplayHtml(entry) {
  if (!entry) return `<span class="balance-muted">--</span>`;
  if (entry.error) {
    return `<span class="balance-error" title="${esc(entry.error)}">${t("balanceFailedShort")}</span>`;
  }
  const result = entry.result || {};
  if (result.supported === false) {
    return `<span class="balance-muted" title="${esc(t("balanceUnsupportedHint"))}">${t("balanceUnsupported")}</span>`;
  }
  const tooltip = esc(balanceTooltip(entry));
  // 配了站点令牌却查不通时数值来自回退路径，标黄提醒用户去检查令牌
  const tokenFailed = !!result.siteTokenError;
  if (result.balance == null) {
    // 算不出剩余余额时退化展示已用或总额度（站点不限额度，或 OpenRouter 不限额 Key）
    const cls = tokenFailed ? "balance-warn" : "balance-neutral";
    if (result.used != null) {
      return `<span class="${cls}" title="${tooltip}">${t("balanceUsedLabel")} ${formatBalanceAmount(result.used, result.currency)}</span>`;
    }
    if (result.totalQuota != null) {
      return `<span class="${cls}" title="${tooltip}">${t("balanceQuotaLabel")} ${formatBalanceAmount(result.totalQuota, result.currency)}</span>`;
    }
    return `<span class="balance-muted">--</span>`;
  }
  const cls = tokenFailed
    ? "balance-warn"
    : result.balance <= 0 ? "balance-error" : result.balance < 5 ? "balance-warn" : "balance-ok";
  return `<span class="${cls}" title="${tooltip}">${formatBalanceAmount(result.balance, result.currency)}</span>`;
}

// 卡片里的「余额」行：缺 Key 或缺地址（无法查询）时整行不渲染
function profileBalanceRowHtml(type, profile) {
  const target = balanceProfileTarget(type, profile);
  if (!target) return "";
  const entry = getBalanceCache()[balanceCacheKey(type, profile)];
  // 令牌入口只对第三方中转站显示，官方端点没有这个概念
  const tokenBtn = balanceSupportsSiteToken(entry)
    ? `<button class="balance-refresh-btn" data-action="balance-token" data-id="${esc(profile.id)}" type="button" title="${esc(t("siteTokenConfigure"))}" aria-label="${esc(t("siteTokenConfigure"))}">${BALANCE_TOKEN_ICON}</button>`
    : "";
  return `
    <div class="profile-field balance-field">
      <span class="field-label">${t("balanceLabel")}</span>
      <span class="field-value balance-value" data-balance-slot="${esc(`${type}:${profile.id}`)}">${balanceDisplayHtml(entry)}</span>
      ${tokenBtn}
      <button class="balance-refresh-btn" data-action="balance" data-id="${esc(profile.id)}" type="button" title="${esc(t("balanceCheck"))}" aria-label="${esc(t("balanceCheck"))}">${BALANCE_REFRESH_ICON}</button>
    </div>`;
}

// ── 站点访问令牌弹窗 ──────────────────────────────
// 令牌按站点（host）存储，同一中转站的多套配置共用一份，保存后立即重查该站点全部配置。
let siteTokenContext = null;

function openSiteTokenDialog(type, profileId) {
  const list = PROFILE_SORT_KINDS[type]?.getList() || [];
  const profile = list.find((p) => p.id === profileId);
  if (!profile) return;
  const target = balanceProfileTarget(type, profile);
  if (!target) return;
  let host;
  try {
    host = new URL(target.baseUrl).host;
  } catch {
    showToast(t("balanceFailedShort"), "error");
    return;
  }
  siteTokenContext = { baseUrl: target.baseUrl, host };
  setText("siteTokenHost", host);
  const existing = siteTokens.find((item) => item.host === host);
  // 已保存的令牌无法回显明文，留空表示不修改由用户重填
  $("siteTokenValue").value = "";
  $("siteTokenValue").placeholder = existing ? existing.maskedToken : "";
  $("siteTokenUserId").value = existing?.userId || "";
  $("siteTokenDelete").hidden = !existing;
  $("siteTokenOverlay").classList.add("open");
  document.body.classList.add("modal-open");
  setTimeout(() => $("siteTokenValue")?.focus(), 30);
}

function closeSiteTokenDialog() {
  siteTokenContext = null;
  $("siteTokenOverlay")?.classList.remove("open");
  document.body.classList.remove("modal-open");
}

async function loadSiteTokens() {
  try {
    siteTokens = await invoke("get_site_balance_tokens");
  } catch (error) {
    console.error("get_site_balance_tokens failed:", error);
    siteTokens = [];
  }
}

// 令牌是按站点存的，保存后把该站点下所有配置的缓存作废并强制重查
function refreshBalancesForHost(host) {
  const cache = getBalanceCache();
  for (const [type, kind] of Object.entries(PROFILE_SORT_KINDS)) {
    for (const profile of kind.getList() || []) {
      const target = balanceProfileTarget(type, profile);
      if (!target) continue;
      let profileHost;
      try {
        profileHost = new URL(target.baseUrl).host;
      } catch {
        continue;
      }
      if (profileHost !== host) continue;
      delete cache[balanceCacheKey(type, profile)];
      queryProfileBalance(type, profile.id, { force: true });
    }
  }
  persistBalanceCache();
}

async function handleSiteTokenSave() {
  if (!siteTokenContext) return;
  const { baseUrl, host } = siteTokenContext;
  const token = $("siteTokenValue").value.trim();
  const userId = $("siteTokenUserId").value.trim();
  if (!token) {
    showToast(t("siteTokenEmpty"), "error");
    return;
  }
  try {
    await invoke("save_site_balance_token", { baseUrl, token, userId });
    await loadSiteTokens();
    closeSiteTokenDialog();
    showToast(t("siteTokenSaved", { host }), "success");
    refreshBalancesForHost(host);
  } catch (error) {
    showToast(String(error), "error");
  }
}

async function handleSiteTokenDelete() {
  if (!siteTokenContext) return;
  const { baseUrl, host } = siteTokenContext;
  try {
    await invoke("delete_site_balance_token", { baseUrl });
    await loadSiteTokens();
    closeSiteTokenDialog();
    showToast(t("siteTokenDeleted", { host }), "success");
    refreshBalancesForHost(host);
  } catch (error) {
    showToast(String(error), "error");
  }
}

function updateBalanceSlot(type, profileId) {
  const slot = document.querySelector(`[data-balance-slot="${type}:${profileId}"]`);
  if (!slot) return;
  const list = PROFILE_SORT_KINDS[type]?.getList() || [];
  const profile = list.find((p) => p.id === profileId);
  if (!profile) return;
  const entry = getBalanceCache()[balanceCacheKey(type, profile)];
  slot.innerHTML = balanceDisplayHtml(entry);
}

// 只负责入队，不等待请求结果：调用方都是「触发一次刷新」的语义
function queryProfileBalance(type, profileId, { force = true } = {}) {
  const list = PROFILE_SORT_KINDS[type]?.getList() || [];
  const profile = list.find((p) => p.id === profileId);
  if (!profile) return;
  const target = balanceProfileTarget(type, profile);
  const key = balanceCacheKey(type, profile);
  if (!target || !key) return;
  const cache = getBalanceCache();
  if (!force && !isBalanceEntryStale(cache[key])) {
    updateBalanceSlot(type, profileId);
    return;
  }
  if (balanceInflight.has(key)) return;
  balanceInflight.add(key);
  const slot = document.querySelector(`[data-balance-slot="${type}:${profileId}"]`);
  if (slot) slot.innerHTML = `<span class="balance-muted">${t("balanceLoading")}</span>`;
  scheduleBalanceTask(async () => {
    try {
      const result = await invoke("query_provider_balance", {
        baseUrl: target.baseUrl,
        apiKey: target.apiKey,
      });
      cache[key] = { ts: Date.now(), result };
    } catch (error) {
      cache[key] = { ts: Date.now(), error: String(error) };
    } finally {
      balanceInflight.delete(key);
      persistBalanceCache();
      updateBalanceSlot(type, profileId);
    }
  }, { priority: force });
}

// 列表渲染后触发：只对缓存过期的配置发起查询，避免每次切页都打一轮请求
function autoRefreshProfileBalances(type) {
  const list = PROFILE_SORT_KINDS[type]?.getList() || [];
  for (const profile of list) {
    const key = balanceCacheKey(type, profile);
    if (!key) continue;
    if (isBalanceEntryStale(getBalanceCache()[key])) {
      queryProfileBalance(type, profile.id, { force: false });
    }
  }
}

// 当前拖拽会话状态（同一时刻只可能有一个拖拽）
let profileDragState = null;

const DROP_INDICATOR_CLASSES = ["drop-target-top", "drop-target-bottom", "drop-target-left", "drop-target-right"];

// 这些元素上按下时不发起拖拽，保证按钮可点、输入框可编辑
const NON_DRAGGABLE_SELECTOR = "button, a, input, select, textarea, [contenteditable='true']";

function profileDragHandleHtml() {
  return `<span class="profile-drag-handle" title="${esc(t("dragToReorder"))}" aria-label="${esc(t("dragToReorder"))}">
    <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <circle cx="9" cy="6" r="1.6"/><circle cx="15" cy="6" r="1.6"/>
      <circle cx="9" cy="12" r="1.6"/><circle cx="15" cy="12" r="1.6"/>
      <circle cx="9" cy="18" r="1.6"/><circle cx="15" cy="18" r="1.6"/>
    </svg>
  </span>`;
}

function clearDropIndicators(grid) {
  grid.querySelectorAll(".profile-card").forEach((card) => card.classList.remove(...DROP_INDICATOR_CLASSES));
}

// 网格可能多列：按指针偏离卡片中心的主导轴判断插入方向，并返回对应的指示线位置
function computeDropPosition(event, card) {
  const rect = card.getBoundingClientRect();
  const dx = (event.clientX - rect.left) / Math.max(rect.width, 1) - 0.5;
  const dy = (event.clientY - rect.top) / Math.max(rect.height, 1) - 0.5;
  if (Math.abs(dy) >= Math.abs(dx)) {
    return { before: dy < 0, indicator: dy < 0 ? "drop-target-top" : "drop-target-bottom" };
  }
  return { before: dx < 0, indicator: dx < 0 ? "drop-target-left" : "drop-target-right" };
}

async function persistProfileOrder(kind, ids) {
  const config = PROFILE_SORT_KINDS[kind];
  try {
    if (kind === "claude-desktop") {
      await invoke("reorder_claude_desktop_profiles", { ids });
    } else {
      await invoke(config.command, { ids });
    }
  } catch (error) {
    showToast(t("reorderFailed", { error: String(error) }), "error");
    await config.reload();
  }
}

function bindProfileGridDragSort(grid, kind) {
  if (!grid || grid.dataset.boundDragSort === "1") return;
  grid.dataset.boundDragSort = "1";

  grid.addEventListener("dragstart", (event) => {
    const card = event.target.closest?.(".profile-card");
    // 整张卡片都可发起拖拽，但从按钮/输入控件按下时放弃，避免误拖点击操作
    if (!card || !card.dataset.id || event.target.closest?.(NON_DRAGGABLE_SELECTOR)) {
      event.preventDefault();
      return;
    }
    profileDragState = { kind, id: card.dataset.id };
    event.dataTransfer.effectAllowed = "move";
    try { event.dataTransfer.setData("text/plain", card.dataset.id); } catch (_) { /* 某些 WebView 不支持 */ }
    // 延迟到拖拽快照生成后再降透明度，避免快照本身变淡
    requestAnimationFrame(() => card.classList.add("dragging"));
  });

  grid.addEventListener("dragover", (event) => {
    if (!profileDragState || profileDragState.kind !== kind) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "move";
    clearDropIndicators(grid);
    const card = event.target.closest?.(".profile-card");
    if (!card || card.classList.contains("dragging") || card.dataset.id === profileDragState.id) return;
    card.classList.add(computeDropPosition(event, card).indicator);
  });

  grid.addEventListener("dragleave", (event) => {
    if (!event.relatedTarget || !grid.contains(event.relatedTarget)) clearDropIndicators(grid);
  });

  grid.addEventListener("drop", (event) => {
    const state = profileDragState;
    // drop 即本次拖拽会话结束；成功重排后 render() 会重建卡片，
    // dragend 不再从已脱离 DOM 的源卡片冒泡到 grid，因此在此处消费状态
    profileDragState = null;
    clearDropIndicators(grid);
    if (!state || state.kind !== kind) return;
    event.preventDefault();
    const targetCard = event.target.closest?.(".profile-card");
    if (!targetCard || !targetCard.dataset.id || targetCard.dataset.id === state.id) return;

    const config = PROFILE_SORT_KINDS[kind];
    const list = config.getList().slice();
    const fromIndex = list.findIndex((item) => String(item.id) === state.id);
    if (fromIndex < 0) return;
    const { before } = computeDropPosition(event, targetCard);
    const [moved] = list.splice(fromIndex, 1);
    let toIndex = list.findIndex((item) => String(item.id) === targetCard.dataset.id);
    if (toIndex < 0) return;
    if (!before) toIndex += 1;
    list.splice(toIndex, 0, moved);

    const changed = list.some((item, index) => item !== config.getList()[index]);
    config.setList(list);
    config.render();
    if (changed) persistProfileOrder(kind, list.map((item) => item.id));
  });

  grid.addEventListener("dragend", () => {
    profileDragState = null;
    clearDropIndicators(grid);
    grid.querySelectorAll(".profile-card.dragging").forEach((card) => card.classList.remove("dragging"));
  });
}

function t(key, params) {
  const dict = I18N[currentLang] || I18N.en;
  const raw = dict[key] || I18N.en[key] || key;
  if (!params) {
    return raw;
  }
  return raw.replace(/\{(\w+)\}/g, (_, token) => {
    if (Object.prototype.hasOwnProperty.call(params, token)) {
      return String(params[token]);
    }
    return `{${token}}`;
  });
}

function esc(s) {
  const div = document.createElement("div");
  div.textContent = s;
  return div.innerHTML;
}

function setButtonBusy(button, busy, label) {
  if (!button) return;
  if (busy) {
    if (!button.dataset.originalText) {
      button.dataset.originalText = button.textContent;
    }
    button.disabled = true;
    button.classList.add("is-busy");
    button.innerHTML = `<span class="inline-spinner" aria-hidden="true"></span><span>${esc(label || button.dataset.originalText || "")}</span>`;
  } else {
    button.disabled = false;
    button.classList.remove("is-busy");
    if (button.dataset.originalText) {
      button.textContent = button.dataset.originalText;
      delete button.dataset.originalText;
    }
  }
}

function productIcon(kind) {
  if (kind === "anthropic") {
    return `<span class="product-icon product-icon-anthropic" aria-hidden="true">
      <img src="anthropic-color.svg" alt="">
    </span>`;
  }
  if (kind === "codex") {
    return `<span class="product-icon product-icon-codex" aria-hidden="true">
      <img src="OpenAI-black-monoblossom.svg" alt="">
    </span>`;
  }
  if (kind === "grok") {
    return `<span class="product-icon product-icon-grok" aria-hidden="true">
      <img src="grok-color.svg" width="16" height="16" alt="">
    </span>`;
  }
  if (kind === "gemini") {
    return `<span class="product-icon product-icon-gemini" aria-hidden="true">
      <img src="gemini-color.svg" width="16" height="16" alt="">
    </span>`;
  }
  if (kind === "opencode") {
    return `<span class="product-icon product-icon-opencode" aria-hidden="true">
      <img src="icon-opencode.svg" width="16" height="16" alt="">
    </span>`;
  }
  return "";
}

function maskKey(key) {
  if (!key || key.length < 12) return key || "--";
  return `${key.slice(0, 6)}****${key.slice(-4)}`;
}

function truncUrl(url, max = 40) {
  if (!url) return "--";
  return url.length > max ? `${url.slice(0, max)}...` : url;
}

function shouldAutoOpenUsageGuide(settings) {
  if (typeof helpers.shouldAutoOpenUsageGuide === "function") {
    return helpers.shouldAutoOpenUsageGuide(settings);
  }
  return !settings || settings.neverShowUsageGuide !== true;
}

function getUpdateActionMode() {
  if (typeof helpers.getUpdateActionMode === "function") {
    return helpers.getUpdateActionMode(updateInfo, updateBusy);
  }
  if (updateBusy) return "busy";
  if (updateInfo?.hasUpdate) return "release";
  return "check";
}

function formatVersionTag(version) {
  if (typeof helpers.formatVersionTag === "function") {
    return helpers.formatVersionTag(version);
  }
  if (!version) return "";
  return version.startsWith("v") ? version : `v${version}`;
}

function updateVersionParams(info = updateInfo) {
  return {
    currentVersion: formatVersionTag(info?.currentVersion),
    latestVersion: formatVersionTag(info?.latestVersion),
    version: formatVersionTag(info?.latestVersion)
  };
}

function getEditorPathMode(editorInfo) {
  if (typeof helpers.getEditorPathMode === "function") {
    return helpers.getEditorPathMode(editorInfo);
  }
  if (editorInfo?.customized) return "custom";
  if (editorInfo?.detected) return "detected";
  return "default";
}

function validateEditorPathInput(value) {
  if (typeof helpers.validateEditorPathInput === "function") {
    return helpers.validateEditorPathInput(value);
  }
  const normalized = typeof value === "string" ? value.trim() : "";
  if (!normalized) {
    return { valid: false, reason: "empty" };
  }
  return { valid: true, value: normalized };
}

function syncAppSettingsAppearance() {
  if (!appSettings) return;
  appSettings.language = currentLang;
  appSettings.theme = currentTheme;
}

function currentSupportHint() {
  if (updateBusy) {
    if (updateBusyAction === "download") {
      return t("downloadingUpdate", { percent: updateDownloadPercent });
    }
    if (updateBusyAction === "install") {
      return t("installingUpdate");
    }
    return t("checkingUpdates");
  }
  if (updateInfo?.hasUpdate) {
    return t("supportHintUpdateAvailable", updateVersionParams());
  }
  return t("supportHintDefault");
}

// 更新状态统一渲染到设置页的「检查更新」条目上：旧的 hero 命令区已移除，
// 这里是用户能看到检查/下载/安装进度的唯一常驻入口。
function renderUpdateButton() {
  const btn = $("settingsUpdateBtn");
  const descEl = $("settingsUpdateBtnDesc");
  const mode = getUpdateActionMode();

  if (descEl) {
    if (mode === "busy") {
      if (updateBusyAction === "download") {
        descEl.textContent = t("downloadingUpdate", { percent: updateDownloadPercent });
      } else if (updateBusyAction === "install") {
        descEl.textContent = t("installingUpdate");
      } else {
        descEl.textContent = t("checkingUpdates");
      }
    } else if (mode === "release" && updateInfo?.latestVersion) {
      descEl.textContent = t("updateReleaseBtn", updateVersionParams());
    } else {
      descEl.textContent = t("updateCheckBtn");
    }
  }
  if (btn) btn.disabled = mode === "busy";

  const hintEl = $("supportHint");
  if (hintEl) hintEl.textContent = currentSupportHint();
  renderUpdatePill();
  renderUpdateDownloadProgress();
}

function renderUpdatePill() {
  const banner = $("updatePillBanner");
  const textEl = $("updatePillText");
  const actionEl = $("updatePillAction");
  if (!banner || !textEl || !actionEl) return;

  if (!updateInfo?.hasUpdate || !updateInfo.latestVersion) {
    banner.hidden = true;
    return;
  }

  textEl.textContent = t("updatePillText", updateVersionParams());
  actionEl.textContent = updateBusyAction === "download"
    ? `${updateDownloadPercent}%`
    : t("updatePillAction");
  banner.hidden = false;
}

function renderUpdateDownloadProgress() {
  const progress = $("updateDownloadProgress");
  const bar = $("updateDownloadProgressBar");
  if (!progress || !bar) return;
  const show = updateBusyAction === "download" || updateBusyAction === "install";
  progress.hidden = !show;
  bar.style.width = `${Math.max(0, Math.min(100, updateDownloadPercent))}%`;
}

function updateDownloadProgress(payload = {}) {
  const total = Number(payload.total) || 100;
  const step = Number(payload.step) || 0;
  const label = payload.label || "download";
  updateDownloadPercent = Math.max(0, Math.min(100, Math.round((step / total) * 100)));
  if (label === "install" || label === "done" || label === "open") {
    updateBusyAction = "install";
  } else {
    updateBusyAction = "download";
  }
  renderUpdateButton();
}

function hideUpdatePillSoon() {
  if (updatePillHideTimer) {
    clearTimeout(updatePillHideTimer);
  }
  updatePillHideTimer = setTimeout(() => {
    const banner = $("updatePillBanner");
    if (banner) {
      banner.hidden = true;
    }
    updatePillHideTimer = null;
  }, 3000);
}

function openUsageGuide() {
  $("usageGuideOverlay").classList.add("open");
}

function closeUsageGuide() {
  $("usageGuideOverlay").classList.remove("open");
}

async function loadAppSettings() {
  try {
    appSettings = await invoke("get_app_settings");
  } catch (error) {
    console.error("Failed to load app settings:", error);
    appSettings = appSettings || { neverShowUsageGuide: false };
  }
  appSettings = appSettings || {};
  appSettings.editorPaths = appSettings.editorPaths || {};
  syncAppSettingsAppearance();
  return appSettings;
}

async function persistAppSettings() {
  if (!appSettings) {
    await loadAppSettings();
  }
  appSettings.editorPaths = appSettings.editorPaths || {};
  syncAppSettingsAppearance();
  await invoke("save_app_settings", { settings: appSettings });
}

async function handleNeverShowUsageGuide() {
  try {
    if (!appSettings) {
      await loadAppSettings();
    }
    appSettings.neverShowUsageGuide = true;
    await persistAppSettings();
    closeUsageGuide();
    showToast(t("toastGuideDisabled"), "success");
  } catch (error) {
    showToast(String(error), "error");
  }
}

async function maybeOpenUsageGuide() {
  if (usageGuideAutoHandled) return;
  usageGuideAutoHandled = true;
  if (shouldAutoOpenUsageGuide(appSettings)) {
    openUsageGuide();
  }
}

function showChangelogDialog(release) {
  const overlay = $("changelogOverlay");
  const list = $("changelogItems");
  if (!overlay || !list) return Promise.resolve(false);
  const zh = currentLang === "zh";
  $("changelogTitle").textContent = zh ? "更新日志" : "What's new";
  $("changelogVersion").textContent = `VarSwitch v${release.version}${release.date ? ` · ${release.date}` : ""}`;
  $("changelogConfirm").textContent = zh ? "知道了" : "Got it";
  $("changelogClose").setAttribute("aria-label", zh ? "关闭" : "Close");
  list.replaceChildren();
  for (const item of release.items) {
    const li = document.createElement("li");
    li.textContent = item.text;
    list.appendChild(li);
  }
  return new Promise((resolve) => {
    const previousFocus = document.activeElement;
    const close = () => {
      overlay.classList.remove("open");
      overlay.removeEventListener("click", onClick);
      document.removeEventListener("keydown", onKey, true);
      previousFocus?.focus();
      resolve(true);
    };
    const onClick = (event) => {
      if (event.target === overlay || event.target.closest("#changelogClose, #changelogConfirm")) close();
    };
    const onKey = (event) => {
      if (event.key === "Escape") { event.preventDefault(); event.stopImmediatePropagation(); close(); }
      if (event.key === "Tab") {
        const first = $("changelogClose");
        const last = $("changelogConfirm");
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
      }
    };
    overlay.addEventListener("click", onClick);
    document.addEventListener("keydown", onKey, true);
    overlay.classList.add("open");
    $("changelogConfirm").focus();
  });
}

async function showStartupDialogs() {
  try {
    await window.VarSwitchChangelog.showOnStartup({
      getVersion: () => window.__TAURI__.app.getVersion(),
      storage: localStorage,
      loadChangelog: async () => {
        const response = await fetch("changelog.json", { cache: "no-store" });
        if (!response.ok) throw new Error(`changelog: HTTP ${response.status}`);
        return response.json();
      },
      show: showChangelogDialog,
    });
  } catch (error) {
    console.warn("Startup changelog failed:", error);
  }
  // 等更新日志关闭后才展示使用指南，避免两个弹窗互相遮挡。
  await maybeOpenUsageGuide();
}

async function checkForUpdates() {
  updateBusy = true;
  updateBusyAction = "check";
  renderUpdateButton();

  try {
    updateInfo = await invoke("check_app_update");
    if (updateInfo?.hasUpdate) {
      showToast(
        t("toastUpdateAvailable", updateVersionParams()),
        "success"
      );
      hideUpdatePillSoon();
    }
  } catch (error) {
    showToast(String(error), "error");
  } finally {
    updateBusy = false;
    updateBusyAction = null;
    renderUpdateButton();
  }
  return updateInfo;
}

async function checkForUpdatesOnStartup() {
  if (updateBusy) return;
  updateBusy = true;
  updateBusyAction = "startup";
  renderUpdateButton();

  try {
    updateInfo = await invoke("check_app_update");
  } catch (error) {
    console.warn("Startup update check failed:", error);
  } finally {
    updateBusy = false;
    updateBusyAction = null;
    renderUpdateButton();
    // 启动时只在版本不一致时显示更新横幅；相同版本保持安静。
  }
}

async function openUpdateReleasePage() {
  try {
    await invoke("open_external_target", { target: APP_DOWNLOAD_PAGE_URL });
    showToast(t("toastReleaseOpened"), "success");
  } catch (error) {
    showToast(String(error), "error");
  }
}

async function installAppUpdate() {
  updateBusy = true;
  updateBusyAction = "download";
  updateDownloadPercent = 0;
  renderUpdateButton();

  try {
    if (updateDownloadUnlisten) {
      updateDownloadUnlisten();
      updateDownloadUnlisten = null;
    }
    updateDownloadUnlisten = await listen("update-download-progress", (event) => {
      updateDownloadProgress(event.payload || {});
    });
    const result = await invoke("install_app_update");
    updateDownloadPercent = 100;
    updateBusyAction = "install";
    renderUpdateButton();
    showToast(
      t("toastUpdateDownloaded", { fileName: result?.fileName || "" }),
      "success"
    );
    hideUpdatePillSoon();
  } catch (error) {
    showToast(String(error), "error");
  } finally {
    if (updateDownloadUnlisten) {
      updateDownloadUnlisten();
      updateDownloadUnlisten = null;
    }
    setTimeout(() => {
      updateBusy = false;
      updateBusyAction = null;
      updateDownloadPercent = 0;
      renderUpdateButton();
    }, 900);
  }
}

async function handleUpdateButton() {
  const mode = getUpdateActionMode();
  if (mode === "busy") return;
  if (mode === "release") {
    await installAppUpdate();
    return;
  }
  const info = await checkForUpdates();
  if (info?.hasUpdate) {
    await installAppUpdate();
  }
}

async function openGitHubRepo() {
  try {
    await invoke("open_external_target", { target: APP_REPOSITORY_URL });
    showToast(t("toastRepoOpened"), "success");
  } catch (error) {
    showToast(String(error), "error");
  }
}

function updateSettingsSegControls() {
  const states = [
    ["settingsLangZh", currentLang === "zh"],
    ["settingsLangEn", currentLang === "en"],
    ["settingsThemeLight", currentTheme === "light"],
    ["settingsThemeDark", currentTheme === "dark"],
  ];
  states.forEach(([id, active]) => {
    const button = $(id);
    if (!button) return;
    button.classList.toggle("active", active);
    button.setAttribute("aria-pressed", String(active));
  });
}

function updateThemeSegControl() {
  updateSettingsSegControls();
  const lightBtn = $("themeLightBtn");
  const darkBtn = $("themeDarkBtn");
  if (!lightBtn || !darkBtn) return;
  if (currentTheme === "light") {
    lightBtn.classList.add("active");
    darkBtn.classList.remove("active");
  } else {
    lightBtn.classList.remove("active");
    darkBtn.classList.add("active");
  }
  lightBtn.textContent = t("switchToLight");
  darkBtn.textContent = t("switchToDark");
}

function updateLangSegControl() {
  updateSettingsSegControls();
  const zhBtn = $("langZhBtn");
  const enBtn = $("langEnBtn");
  if (!zhBtn || !enBtn) return;
  if (currentLang === "zh") {
    zhBtn.classList.add("active");
    enBtn.classList.remove("active");
  } else {
    zhBtn.classList.remove("active");
    enBtn.classList.add("active");
  }
}

function applyTheme() {
  document.documentElement.setAttribute("data-theme", currentTheme);
  updateThemeSegControl();
}

// 静态文案统一走 data-i18n：在 index.html 上标好 key，这里一次性刷新。
// 逐个 setText(id, ...) 需要每处都有 id，漏掉一处就会在另一种语言下留下未翻译的文字。
function applyStaticI18n(root = document) {
  root.querySelectorAll("[data-i18n]").forEach((el) => {
    const key = el.getAttribute("data-i18n");
    if (key) el.textContent = t(key);
  });
  // 占位符与 title 走各自的属性，避免覆盖元素内容
  root.querySelectorAll("[data-i18n-placeholder]").forEach((el) => {
    const key = el.getAttribute("data-i18n-placeholder");
    if (key) el.placeholder = t(key);
  });
  root.querySelectorAll("[data-i18n-title]").forEach((el) => {
    const key = el.getAttribute("data-i18n-title");
    if (key) el.title = t(key);
  });
}

function applyLanguage() {
  try {
  document.documentElement.lang = currentLang === "zh" ? "zh-CN" : "en";
  document.title = t("appTitle");
  applyStaticI18n();
  try { renderBaseUrlActions(); renderApiKeyActions(); } catch (_) {}

  setText("appTitle", t("appTitle"));
  setText("appSubtitle", t("appSubtitle"));
  const supportTitle = $("supportSectionTitle");
  if (supportTitle) supportTitle.textContent = t("supportSectionTitle");
  updateClaudeStatusTitle();
  setText("statusHint", t("statusHint"));
  setText("profilesSectionTitle", currentLang === "zh" ? "Claude 配置列表" : "Claude Config List");
  setText("profileNameLabel", t("nameLabel"));
  setText("profileApiKeyLabel", t("tokenLabel"));
  setText("profileBaseUrlLabel", t("urlLabel"));
  setText("cancelBtn", t("cancel"));
  setText("submitBtn", t("save"));
  setText("switchPanelTitle", t("switchingTo"));
  setText("switchStep1Text", t("stepSystem"));
  setText("switchStep2Text", t("stepEditors"));
  setText("switchStep3Text", t("stepClaude"));
  setText("switchCancelBtn", t("cancelSwitch"));
  setText("switchStepLabel", t("preparing"));
  setText("activeConfigLabel", t("activeConfigLabel"));
  setText("claudeSyncBtn", t("syncNow"));
  setText("claudePageImportBtn", t("importBtn"));
  setText("claudeDesktopPageTitle", t("claudeDesktopPageTitle"));
  setText("claudeDesktopPageSubtitle", t("claudeDesktopPageSubtitle"));
  setText("claudeDesktopSyncBtn", t("claudeDesktopSync"));
  setText("claudeDesktopImportBtn", t("claudeDesktopImport"));
  setText("claudeDesktopAddBtn", t("claudeDesktopAddProfile"));
  setText("claudeDesktopStatusTitle", t("claudeDesktopStatusTitle"));
  setText("claudeDesktopProfilesTitle", t("claudeDesktopProfilesTitle"));
  setText("claudeDesktopGatewayHealthTitle", t("claudeDesktopGatewayHealthTitle"));
  setText("claudeDesktopDependencyWarningText", t("claudeDesktopGatewayDependencyWarning"));
  setText("claudeDesktopProfileNameLabel", currentLang === "zh" ? "配置名称" : "Profile Name");
  setText("claudeDesktopProfileConnectionModeLabel", currentLang === "zh" ? "连接模式" : "Connection Mode");
  setText("claudeDesktopProfileApiFormatLabel", t("claudeDesktopApiFormat"));
  setText("claudeDesktopProfileBaseUrlLabel", "Base URL");
  setText("claudeDesktopProfileApiKeyLabel", "API Key");
  setText("claudeDesktopProfileModelIdLabel", t("claudeDesktopDefaultModel"));
  setText("claudeDesktopProfileModelHint", t("claudeDesktopModelHint"));
  setText("claudeDesktopProfileModelMappingTitle", currentLang === "zh" ? "模型映射" : "Model Mapping");
  setText("claudeDesktopProfileModelMappingHint", t("claudeDesktopModelMappingHint"));
  setText("claudeDesktopProfileSourceModelLabel", t("claudeDesktopSourceModelLabel"));
  setText("claudeDesktopProfileTargetModelLabel", t("claudeDesktopTargetModelLabel"));
  setText("claudeDesktopProfileAddMappingBtn", t("claudeDesktopAddMapping"));
  setText("claudeDesktopProfileSonnetModelLabel", currentLang === "zh" ? "Sonnet 模型" : "Sonnet Model");
  setText("claudeDesktopProfileOpusModelLabel", currentLang === "zh" ? "Opus 模型" : "Opus Model");
  setText("claudeDesktopProfileHaikuModelLabel", currentLang === "zh" ? "Haiku 模型" : "Haiku Model");
  setText("claudeDesktopProfileProxyFailoverText", currentLang === "zh" ? "加入 Desktop Gateway 故障转移池" : "Join Desktop Gateway failover pool");
  setText("claudeDesktopProfileCancel", t("cancel"));
  setText("claudeDesktopProfileSubmit", t("save"));
  const desktopModeSelect = $("claudeDesktopProfileConnectionMode");
  if (desktopModeSelect?.options?.length >= 2) {
    desktopModeSelect.options[0].textContent = currentLang === "zh" ? "Gateway（推荐）" : "Gateway (Recommended)";
    desktopModeSelect.options[1].textContent = currentLang === "zh" ? "直连 Anthropic" : "Direct Anthropic";
  }
  updateClaudeDesktopProfileFormState();
  if (claudeDesktopStatus) renderClaudeDesktopStatus(claudeDesktopStatus);
  if (claudeDesktopProfiles.length) renderClaudeDesktopProfiles();
  setText("usageGuideKicker", t("usageGuideKicker"));
  setText("usageGuideTitle", t("usageGuideTitle"));
  setText("usageGuideIntro", t("usageGuideIntro"));
  setText("usageGuideStep1Title", t("usageGuideStep1Title"));
  setText("usageGuideStep1Desc", t("usageGuideStep1Desc"));
  setText("usageGuideStep2Title", t("usageGuideStep2Title"));
  setText("usageGuideStep2Desc", t("usageGuideStep2Desc"));
  setText("usageGuideStep3Title", t("usageGuideStep3Title"));
  setText("usageGuideStep3Desc", t("usageGuideStep3Desc"));
  setText("usageGuideStep4Title", t("usageGuideStep4Title"));
  setText("usageGuideStep4Desc", t("usageGuideStep4Desc"));
  setText("usageGuideStep5Title", t("usageGuideStep5Title"));
  setText("usageGuideStep5Desc", t("usageGuideStep5Desc"));
  setText("usageGuideStep6Title", t("usageGuideStep6Title"));
  setText("usageGuideStep6Desc", t("usageGuideStep6Desc"));
  setText("usageGuideCloseBtn", t("usageGuideClose"));
  setText("usageGuideNeverBtn", t("usageGuideNever"));

  applyUsagePanelLanguage();
  applyCliSessionsPanelLanguage();

  setPlaceholder("profileName", t("placeholderName"));
  setPlaceholder("profileApiKey", t("placeholderApiKey"));
  setPlaceholder("profileBaseUrl", t("placeholderBaseUrl"));
  setText("profileModelIdLabel", t("modelIdLabel"));
  setPlaceholder("profileModelId", t("placeholderModelId"));
  setText("profileModelIdHint", t("modelIdHint"));
  setText("profileModelMappingSummary", t("modelMappingTitle"));
  setText("profileModelMappingHint", t("modelMappingHint"));
  setText("profileSonnetModelLabel", t("sonnetModelLabel"));
  setText("profileOpusModelLabel", t("opusModelLabel"));
  setText("profileHaikuModelLabel", t("haikuModelLabel"));
  setText("profilePresetLabel", t("providerPresetLabel"));
  setText("profilePresetHint", t("claudePresetHintDefault"));
  setText("profileApiFormatLabel", t("claudeApiFormatLabel"));
  setText("profileApiFormatHint", t("claudeApiFormatHint"));
  const claudeApiFormatSelect = $("profileApiFormat");
  if (claudeApiFormatSelect && claudeApiFormatSelect.options.length >= 2) {
    claudeApiFormatSelect.options[0].textContent = t("claudeApiFormatOptionAnthropic");
    claudeApiFormatSelect.options[1].textContent = t("claudeApiFormatOptionOpenAiChat");
  }
  setText("profileProxyFailoverText", t("proxyFailoverLabel"));
  setText("profileProxyFailoverHint", t("proxyFailoverHint"));
  setText("profileProxyTakeoverText", t("proxyTakeoverLabel"));
  setText("profileProxyTakeoverHint", t("proxyTakeoverHint"));
  setText("proxyHealthSectionTitle", t("proxyHealthTitle"));
  setText("proxyHealthResetBtn", t("proxyHealthResetBreaker"));
  renderClaudePresetOptions();

  // Codex page labels
  updateCodexStatusTitle();
  setText("codexProfilesSectionTitle", t("codexProfilesTitle"));
  setText("codexAccountLoginBtn", currentLang === "zh" ? "账号登录" : "Account login");
  setText("codexSyncBtn", t("syncNow"));
  setText("codexPageImportBtn", t("importBtn"));
  setText("codexPresetLabel", t("providerPresetLabel"));
  setText("codexWireApiLabel", t("codexWireApiLabel"));
  setText("codexWireApiHint", t("codexWireApiHint"));
  const codexWireSelect = $("codexWireApi");
  if (codexWireSelect && codexWireSelect.options.length >= 2) {
    codexWireSelect.options[0].textContent = currentLang === "zh"
      ? "OpenAI Responses（官方 / 兼容网关）"
      : "OpenAI Responses (official / compatible gateways)";
    codexWireSelect.options[1].textContent = currentLang === "zh"
      ? "OpenAI Chat Completions（旧网关 / 本地转换）"
      : "OpenAI Chat Completions (legacy gateways / local translation)";
  }
  syncCodexWireApiControl();
  setText("codexAdvancedTitle", t("codexAdvancedTitle"));
  setPlaceholder("codexBaseUrl", currentLang === "zh" ? "留空使用官方地址 https://api.openai.com/v1" : "Leave empty for official https://api.openai.com/v1");
  setText("codexNameLabel", t("codexNameLabel"));
  setText("codexApiKeyLabel", t("codexApiKeyLabel"));
  setText("codexBaseUrlLabel", t("codexBaseUrlLabel"));
  setText("codexModelLabel", t("codexModelLabel"));
  setText("codexProviderLabel", t("codexProviderLabel"));
  setText("codexImageSectionTitle", t("codexImageSectionTitle"));
  setText("codexImageSectionHint", t("codexImageSectionHint"));
  setText("codexImageApiKeyLabel", t("codexImageApiKeyLabel"));
  setText("codexImageBaseUrlLabel", t("codexImageBaseUrlLabel"));
  setText("codexAuthModeLabel", t("codexAuthModeLabel"));
  setText("codexAuthModeDefaultTitle", t("codexAuthModeDefaultTitle"));
  setText("codexAuthModeDefaultHint", t("codexAuthModeDefaultHint"));
  setText("codexAuthModeOfficialTitle", t("codexAuthModeOfficialTitle"));
  setText("codexAuthModeOfficialHint", t("codexAuthModeOfficialHint"));
  setText("codexOfficialConfigLabel", t("codexOfficialConfigLabel"));
  setText("codexCopyOfficialConfigBtn", t("copy"));
  setText("codexCancelBtn", t("cancel"));
  setText("codexSubmitBtn", t("save"));
  // Grok page labels
  updateGrokActiveConfigBar();
  if ($("grokProfilesSectionTitle")) setText("grokProfilesSectionTitle", t("grokProfilesTitle"));
  if ($("grokPresetLabel")) setText("grokPresetLabel", t("grokPresetLabel"));
  if ($("grokNameLabel")) setText("grokNameLabel", t("grokNameLabel"));
  if ($("grokApiKeyLabel")) setText("grokApiKeyLabel", t("grokApiKeyLabel"));
  if ($("grokBaseUrlLabel")) setText("grokBaseUrlLabel", t("grokBaseUrlLabel"));
  if ($("grokModelLabel")) setText("grokModelLabel", t("grokModelLabel"));
  if ($("grokModelHint")) setText("grokModelHint", t("grokModelHint"));
  if ($("grokApiBackendLabel")) setText("grokApiBackendLabel", t("grokApiBackendLabel"));
  if ($("grokApiBackendHint")) setText("grokApiBackendHint", t("grokApiBackendHint"));
  if ($("grokCancelBtn")) setText("grokCancelBtn", t("cancel"));
  if ($("grokSubmitBtn")) setText("grokSubmitBtn", t("save"));
  if ($("grokPageAddBtn")) setText("grokPageAddBtn", t("grokAddConfig"));
  if ($("grokRefreshBtn")) setText("grokRefreshBtn", currentLang === "zh" ? "立即同步" : "Sync now");
  if ($("grokPageImportBtn")) setText("grokPageImportBtn", t("grokImportCurrent"));
  if ($("grokProfileName")) setPlaceholder("grokProfileName", t("placeholderName"));
  if ($("grokApiKey")) setPlaceholder("grokApiKey", "xai-...");
  if ($("grokBaseUrl")) setPlaceholder("grokBaseUrl", currentLang === "zh" ? "留空使用官方地址 https://api.x.ai/v1" : "Leave empty for official https://api.x.ai/v1");
  if ($("grokModel")) setPlaceholder("grokModel", "e.g. grok-4");
  renderGrokPresetOptions();
  // OpenCode page labels
  updateOpenCodeStatusTitle();
  if ($("opencodePageTitle")) setText("opencodePageTitle", t("opencodePageTab"));
  if ($("opencodePageSubtitle")) setText("opencodePageSubtitle", t("opencodePageSubtitle"));
  if ($("opencodeProfilesSectionTitle")) setText("opencodeProfilesSectionTitle", t("opencodeProfilesTitle"));
  if ($("opencodePresetLabel")) setText("opencodePresetLabel", t("opencodePresetLabel"));
  if ($("opencodeNameLabel")) setText("opencodeNameLabel", t("opencodeNameLabel"));
  if ($("opencodeProviderLabel")) setText("opencodeProviderLabel", t("opencodeProviderLabel"));
  if ($("opencodeProviderHint")) setText("opencodeProviderHint", t("opencodeProviderHint"));
  if ($("opencodeApiKeyLabel")) setText("opencodeApiKeyLabel", t("opencodeApiKeyLabel"));
  if ($("opencodeBaseUrlLabel")) setText("opencodeBaseUrlLabel", t("opencodeBaseUrlLabel"));
  if ($("opencodeModelLabel")) setText("opencodeModelLabel", t("opencodeModelLabel"));
  if ($("opencodeModelHint")) setText("opencodeModelHint", t("opencodeModelHint"));
  if ($("opencodeCancelBtn")) setText("opencodeCancelBtn", t("cancel"));
  if ($("opencodeSubmitBtn")) setText("opencodeSubmitBtn", t("save"));
  if ($("opencodePageAddBtn")) setText("opencodePageAddBtn", t("opencodeAddConfig"));
  if ($("opencodeRefreshBtn")) setText("opencodeRefreshBtn", currentLang === "zh" ? "立即同步" : "Sync now");
  if ($("opencodePageImportBtn")) setText("opencodePageImportBtn", t("opencodeImportCurrent"));
  if ($("opencodeProfileName")) setPlaceholder("opencodeProfileName", t("placeholderName"));
  if ($("opencodeProviderId")) setPlaceholder("opencodeProviderId", "anthropic");
  if ($("opencodeApiKey")) setPlaceholder("opencodeApiKey", "sk-...");
  if ($("opencodeBaseUrl")) setPlaceholder("opencodeBaseUrl", t("opencodeBaseUrlPlaceholder"));
  if ($("opencodeModel")) setPlaceholder("opencodeModel", "e.g. claude-sonnet-5");
  renderOpenCodePresetOptions();
  const codexToolboxBtn = $("codexToolboxBtn");
  if (codexToolboxBtn) codexToolboxBtn.textContent = t("codexToolbox");
  setText("codexToolboxTitle", t("codexToolboxTitle"));
  setText("toolboxTabSession", t("toolboxTabSession"));
  setText("toolboxTabRemote", t("toolboxTabRemote"));
  setText("toolboxSessionHint", t("toolboxSessionHint"));
  setText("sessionPageSyncBtn", t("toolboxSyncNow"));
  setText("toolboxSyncedThreadsTitle", t("toolboxSyncedThreadsTitle"));
  setText("toolboxSessionSafeNote", t("toolboxSessionSafeNote"));
  setPlaceholder("toolboxSessionSearchInput", t("toolboxSessionSearchPlaceholder"));
  setText("toolboxSessionTrashTitle", t("toolboxSessionTrashTitle"));
  setText("toolboxSessionTrashHint", t("toolboxSessionTrashHint"));
  setText("toolboxSessionTrashCloseBtn", t("toolboxSessionTrashClose"));
  setText("toolboxSessionRestoreBtn", t("toolboxSessionRestoreSelected"));
  setText("toolboxRemoteHint", t("toolboxRemoteHint"));
  setText("toolboxMobileAppLabel", t("toolboxMobileAppLabel"));
  setText("toolboxMobileThreadLabel", t("toolboxMobileThreadLabel"));
  setText("toolboxRemoteStartBtn", t("toolboxRemoteStart"));
  setText("toolboxRemoteStopBtn", t("toolboxRemoteStop"));
  renderCodexPresetOptions();
  updateCodexPresetHint();

  // Management panel labels
  setTitle("skillsBtn", t("skillsManage"));
  setTitle("promptsBtn", t("promptsManage"));
  setTitle("mcpBtn", t("mcpManage"));
  setText("skillsTitle", t("skillsTitle"));
  setText("addSkillBtn", t("addSkill"));
  setText("skillNameLabel2", t("skillName"));
  setText("skillContentLabel", t("skillContent"));
  setPlaceholder("skillNameInput", t("skillNamePlaceholder"));
  setText("skillCancelBtn", t("cancel"));
  setText("skillSaveBtn", t("save"));
  setText("promptsTitle2", t("promptsTitle"));
  setText("promptsPath", t("promptsPathLabel"));
  setText("promptSaveBtn", t("save"));
  setText("mcpTitle2", t("mcpTitle"));
  setText("mcpTabInstalled", t("mcpTabInstalled"));
  setText("mcpTabPresets", t("mcpTabPresets"));
  setPlaceholder("mcpPresetSearch", t("mcpSearchPlaceholder"));
  setText("mcpPresetLoadingText", t("mcpSearchLoading"));
  setText("mcpIntro", t("mcpIntro"));
  setText("mcpPath", t("mcpPathLabel"));
  setText("addMcpBtn", t("addMcp"));
  setText("mcpNameLabel2", t("mcpName"));
  setText("mcpConfigLabel", t("mcpConfig"));
  setText("mcpAppsLabel", t("mcpAppsLabel"));
  setPlaceholder("mcpNameInput", t("mcpNamePlaceholder"));
  setText("mcpNameHint", t("mcpNameHint"));
  setText("mcpModeFormBtn", t("mcpModeForm"));
  setText("mcpModeJsonBtn", t("mcpModeJson"));
  setText("mcpTransportLabel", t("mcpTransportLabel"));
  setText("mcpTransportHint", t("mcpTransportHint"));
  setText("mcpCommandLabel", t("mcpCommandLabel"));
  setText("mcpArgsLabel", t("mcpArgsLabel"));
  setText("mcpEnvLabel", t("mcpEnvLabel"));
  setText("mcpUrlLabel", t("mcpUrlLabel"));
  setText("mcpHeadersLabel", t("mcpHeadersLabel"));
  const transportSelect = $("mcpTransport");
  if (transportSelect && transportSelect.options.length >= 3) {
    transportSelect.options[0].textContent = t("mcpTransportStdio");
    transportSelect.options[1].textContent = t("mcpTransportHttp");
    transportSelect.options[2].textContent = t("mcpTransportSse");
  }
  setText("mcpCancelBtn", t("cancel"));
  setText("mcpSaveBtn", t("save"));

  // Skills Discovery labels
  setText("skillsTabInstalled", t("skillsTabInstalled"));
  setText("skillsTabDiscover", t("skillsTabDiscover"));
  setText("installZipBtn", t("installFromZip"));
  setText("zipInstallTitle", t("zipInstallTitle"));
  setText("zipInstallAppsLabel", t("zipInstallTargets"));
  setText("zipInstallCancel", t("cancel"));
  setText("zipInstallConfirm", t("zipInstallConfirmBtn"));
  setPlaceholder("discoverSearch", t("discoverSearchPlaceholder"));
  setText("discoverLoadingText", t("discoverLoading"));
  setText("manageReposBtn", t("manageRepos"));
  setText("repoManagerTitle", t("repoManagerTitle"));
  setText("addRepoLabel", t("addRepoLabel"));
  setPlaceholder("repoUrlInput", t("addRepoPlaceholder"));
  setText("searchGithubSkillsBtnText", t("skillsSearchGithub"));
  setText("discoverGithubBannerText", t("skillsGithubResults"));
  setText("backToCatalogBtnText", t("skillsBackToCatalog"));

  // Prompt tabs
  setText("promptTabPresets", t("promptTabPresets"));
  setText("promptTabEditor", t("promptTabEditor"));
  setText("promptTabTemplates", t("promptTabTemplates"));
  // Prompt presets（预设库）
  setText("addPromptPresetBtn", t("presetNew"));
  setText("promptPresetNameLabel", t("presetName"));
  setPlaceholder("promptPresetNameInput", t("presetNamePlaceholder"));
  setText("promptPresetAppsLabel", t("presetApps"));
  setText("promptPresetContentLabel", t("presetContent"));
  setPlaceholder("promptPresetContentInput", t("presetContentPlaceholder"));
  setText("promptPresetSaveBtn", t("save"));
  const insertSelect = $("promptInsertSelect");
  if (insertSelect.options.length > 0) {
    insertSelect.options[0].textContent = t("insertSnippet");
  }

  // Update discover filter labels
  const repoFilter = $("discoverRepoFilter");
  if (repoFilter.options.length > 0) {
    repoFilter.options[0].textContent = t("allRepos");
  }
  const statusFilter = $("discoverStatusFilter");
  if (statusFilter.options.length >= 3) {
    statusFilter.options[0].textContent = t("filterAll");
    statusFilter.options[1].textContent = t("filterInstalled");
    statusFilter.options[2].textContent = t("filterNotInstalled");
  }

  // Settings panel labels
  setText("settingsTitle2", t("settingsTitle"));
  setText("settingsGroupGeneral", t("settingsGroupGeneral"));
  setText("settingsGroupPaths", t("settingsGroupPaths"));
  setText("settingsGroupBackup", t("settingsGroupBackup"));
  setText("settingsAutoStartLabel", t("settingsAutoStart"));
  setText("settingsAutoStartDesc", t("settingsAutoStartDesc"));
  setText("settingsMinTrayLabel", t("settingsMinTray"));
  setText("settingsMinTrayDesc", t("settingsMinTrayDesc"));
  setText("settingsConfigDirLabel", t("settingsConfigDir"));
  setText("settingsClaudePathLabel", t("settingsClaudePath"));
  setText("settingsCodexPathLabel", t("settingsCodexPath"));
  setText("settingsLogsLabel", t("settingsLogs"));
  setText("settingsLogsValue", t("settingsLogsDesc"));
  setText("settingsOpenConfigDir", t("settingsOpen"));
  setText("settingsOpenClaudeDir", t("settingsOpen"));
  setText("settingsOpenCodexDir", t("settingsOpen"));
  setText("settingsOpenLogsDir", t("settingsOpen"));
  setText("settingsOpenBackupsBtn", t("settingsOpen"));
  document.querySelectorAll("[data-settings-copy-path]").forEach((button) => {
    button.title = t("settingsCopyPath");
    button.setAttribute("aria-label", t("settingsCopyPath"));
  });
  setText("settingsManualBackupLabel", t("settingsManualBackup"));
  setText("settingsManualBackupDesc", t("settingsManualBackupDesc"));
  setText("settingsExportBtn", t("settingsExport"));
  setText("settingsImportBtn", t("settingsImport"));
  setText("settingsAutoBackupLabel", t("settingsAutoBackup"));
  setText("settingsAutoBackupDesc", t("settingsAutoBackupDesc"));
  setText("settingsViewBackupsBtn", t("settingsViewBackups"));
  setText("settingsSilentStartLabel", t("settingsSilentStart"));
  setText("settingsSilentStartDesc", t("settingsSilentStartDesc"));
  setText("settingsHotkeyLabel", t("settingsHotkey"));
  setText("settingsHotkeyDesc", t("settingsHotkeyDesc"));
  setText("settingsHotkeyClear", t("settingsHotkeyClear"));
  const hotkeyInput = $("settingsHotkeyInput");
  if (hotkeyInput) hotkeyInput.placeholder = t("settingsHotkeyPlaceholder");
  // 配置体检区块
  setText("settingsGroupHealth", t("healthCheckGroup"));
  setText("settingsHealthLabel", t("healthCheckLabel"));
  setText("settingsHealthDesc", t("healthCheckDesc"));
  // 检测途中按钮上是「检测中...」，此时覆盖会让 setButtonBusy 还原出错误文案
  if (!healthCheckBusy) setText("settingsHealthCheckBtn", t("healthCheckBtn"));
  // 数据目录（多设备同步）区块
  setText("settingsGroupDataDir", t("settingsGroupDataDir"));
  setText("settingsDataDirLabel", t("settingsDataDirLabel"));
  setText("settingsDataDirDesc", t("settingsDataDirDesc"));
  setText("settingsDataDirPickBtn", t("settingsDataDirPick"));
  setText("settingsDataDirResetBtn", t("settingsDataDirReset"));
  renderDataDirInfo();
  // 深链导入确认弹窗
  setText("deeplinkTitle", t("deeplinkTitle"));
  setText("deeplinkWarning", t("deeplinkWarning"));
  setText("deeplinkAppLabel", t("deeplinkTargetApp"));
  setText("deeplinkNameLabel", t("deeplinkFieldName"));
  setText("deeplinkBaseUrlLabel", t("deeplinkFieldBaseUrl"));
  setText("deeplinkApiKeyLabel", t("deeplinkFieldApiKey"));
  setText("deeplinkConfigLabel", t("deeplinkConfigPreview"));
  setText("deeplinkCancel", t("cancel"));
  setText("deeplinkConfirm", t("deeplinkConfirm"));
  // 站点访问令牌弹窗
  setText("siteTokenTitle", t("siteTokenTitle"));
  setText("siteTokenHint", t("siteTokenHint"));
  setText("siteTokenValueLabel", t("siteTokenValueLabel"));
  setText("siteTokenUserIdLabel", t("siteTokenUserIdLabel"));
  setText("siteTokenUserIdHint", t("siteTokenUserIdHint"));
  setText("siteTokenCancel", t("cancel"));
  setText("siteTokenSave", t("siteTokenSave"));
  setText("siteTokenDelete", t("siteTokenDelete"));

  updateLangSegControl();
  updateThemeSegControl();
  renderUpdateButton();
  // 侧栏 tooltip 的文案取自项内标签，换语言后要跟着更新
  syncSidebarItemTitles();

  if ($("modalOverlay")?.classList.contains("open")) {
    setText("modalTitle", editingId ? t("editConfig") : t("addConfig"));
  }
  if (activeConsolePage === "settings") {
    try { renderSettingsEditorPaths(getSettingsEditorPathInfos()); } catch (_) {}
  }
  } catch (error) {
    console.error("applyLanguage failed:", error);
  }
}

function setLanguage(lang) {
  currentLang = lang;
  localStorage.setItem(LANG_STORAGE_KEY, currentLang);
  localStorage.setItem(LANG_USER_SET_KEY, "1");
  syncAppSettingsAppearance();
  applyLanguage();

  // 所有页面都常驻 DOM，只重渲染当前页会让其他页停留在旧语言，
  // 切回去才发现没变。这里一律重渲染，失败一项不影响其余。
  const renderers = [
    renderProfiles, loadStatus,
    renderCodexProfiles, loadCodexStatus,
    renderGrokProfiles, loadGrokStatus,
    renderGeminiProfiles, loadGeminiStatus,
    renderOpenCodeProfiles, loadOpenCodeStatus,
    renderClaudeDesktopProfiles,
    renderUniversalProviderForm,
    renderSessionStatusCard, renderMobileTimeline,
  ];
  for (const render of renderers) {
    try {
      if (typeof render === "function") render();
    } catch (error) {
      console.error("setLanguage re-render failed:", error);
    }
  }

  if (codexToolbox) {
    try { renderCodexToolbox(); } catch (error) { console.error(error); }
  }
  if (activeConsolePage === "usage") {
    loadUsageDashboard();
  }
  if (activeConsolePage === "cli-sessions") {
    try { renderCliSessions(); } catch (error) { console.error(error); }
  }
}

function setTheme(theme) {
  currentTheme = theme;
  localStorage.setItem(THEME_STORAGE_KEY, currentTheme);
  syncAppSettingsAppearance();
  applyTheme();
}

async function loadCodexToolbox() {
  try {
    codexToolbox = await invoke("get_codex_toolbox");
    await loadSmartControlDebug(false);
    renderCodexToolbox();
    renderNavigationStatus();
  } catch (error) {
    console.error("loadCodexToolbox failed:", error);
    if (typeof showToast === "function") showToast(String(error), "error");
  }
}

/**
 * B15: 订阅后端推送的手机通道状态。
 *
 * 后端在通道状态发生变化时 emit("mobile-channel-status", <ToolboxSnapshot>)，
 * payload 与 get_codex_toolbox 返回值同结构，这里直接整体替换本地缓存。
 * 只在工具箱页可见时重渲染，其他页面留给下次进入时统一渲染，避免无谓开销。
 */
async function bindMobileChannelStatusListener() {
  if (mobileChannelStatusUnlisten) return;
  try {
    mobileChannelStatusUnlisten = await listen("mobile-channel-status", (event) => {
      if (!event?.payload) return;
      codexToolbox = event.payload;
      if (activeConsolePage === "toolbox") renderCodexToolbox();
      // 侧边栏绑定状态指示灯不依赖当前页面，始终同步
      renderNavigationStatus();
    });
  } catch (error) {
    console.error("bindMobileChannelStatusListener failed:", error);
  }
}

async function loadSmartControlDebug(showError = false) {
  try {
    codexDiagnostics = await invoke("get_smart_control_debug");
    return codexDiagnostics;
  } catch (error) {
    if (showError) showToast(String(error), "error");
    return null;
  }
}

function switchToolboxTab(tab) {
  activeToolboxTab = tab;
  const sessionTab = $("toolboxTabSession");
  const remoteTab = $("toolboxTabRemote");
  sessionTab?.classList.toggle("active", tab === "session");
  remoteTab?.classList.toggle("active", tab === "remote");
  sessionTab?.setAttribute("aria-selected", String(tab === "session"));
  remoteTab?.setAttribute("aria-selected", String(tab === "remote"));
  const session = $("toolboxSessionContent");
  const remote = $("toolboxRemoteContent");
  if (session) session.style.display = tab === "session" ? "" : "none";
  if (remote) remote.style.display = tab === "remote" ? "" : "none";
}

function openCodexToolbox() {
  switchConsolePage("toolbox");
  switchToolboxTab("session");
  loadCodexToolbox();
}

function closeCodexToolbox() {
  stopToolboxRefresh();
}

function startToolboxRefresh(ticks = 8) {
  stopToolboxRefresh();
  let remaining = ticks;
  toolboxRefreshTimer = setInterval(async () => {
    if (toolboxRefreshBusy) return;
    // Toolbox 已改为内联页面，存活条件按当前页面判定（旧 overlay 不再加 open class）
    if (activeConsolePage !== "toolbox" || remaining <= 0) {
      stopToolboxRefresh();
      return;
    }
    remaining -= 1;
    toolboxRefreshBusy = true;
    try {
      // B13: 飞书注册轮询已由后端 worker 按服务端下发的 interval 单点执行，
      // 前端这里不再并行调 poll_lark_bot_registration，避免双重轮询打爆接口频率限制。
      // 飞书状态只读后端缓存（get_codex_toolbox / mobile-channel-status 事件推送）。
      // 微信暂时仍只有前端在轮询，删掉会导致扫码绑定卡住，因此保留。
      const wechat = codexToolbox?.mobileChannels?.find((binding) => binding.channel === "wechat");
      if (wechat?.qrDeviceCode && !wechat?.botToken) {
        codexToolbox = await invoke("poll_wechat_qr_binding", { verifyCode: "" });
      } else {
        codexToolbox = await invoke("get_codex_toolbox");
      }
      await loadSmartControlDebug(false);
      renderCodexToolbox();
    } catch (_) {
      codexToolbox = await invoke("get_codex_toolbox").catch(() => codexToolbox);
      await loadSmartControlDebug(false);
      renderCodexToolbox();
    } finally {
      toolboxRefreshBusy = false;
    }
  }, 1000);
}

function stopToolboxRefresh() {
  if (toolboxRefreshTimer) {
    clearInterval(toolboxRefreshTimer);
    toolboxRefreshTimer = null;
  }
  toolboxRefreshBusy = false;
}

function renderCodexToolbox() {
  if (!codexToolbox) return;
  renderToolboxSessionSync();
  renderToolboxSyncedThreads();
  renderToolboxMobileControl();
  renderToolboxRemote();
}

function renderToolboxSessionSync() {
  const summary = $("toolboxSessionSummary");
  const state = codexToolbox?.sessionSync || {};
  const count = state.total || (codexToolbox?.syncedCodexThreads || []).length || 0;
  renderToolboxSessionProgress();
  if (!state.lastSyncedAt && !count) {
    summary.textContent = t("toolboxSessionSummaryEmpty");
    return;
  }
  summary.textContent = t("toolboxSessionSummary", {
    count,
    time: state.lastSyncedAt || "--",
  });
}

function renderToolboxSessionProgress() {
  const progress = $("toolboxSessionProgress");
  if (!progress) return;
  progress.hidden = !toolboxSessionSyncBusy;
  [$("sessionPageSyncBtn")].filter(Boolean).forEach((button) => {
    button.disabled = toolboxSessionSyncBusy;
    button.classList.toggle("is-busy", toolboxSessionSyncBusy);
  });
}

function updateToolboxSessionProgress(percent, label) {
  toolboxSessionProgressValue = Math.max(0, Math.min(100, Number(percent) || 0));
  const progress = $("toolboxSessionProgress");
  const bar = $("toolboxSessionProgressBar");
  const labelEl = $("toolboxSessionProgressLabel");
  const percentEl = $("toolboxSessionProgressPercent");
  if (progress) progress.hidden = false;
  if (bar) bar.style.width = `${toolboxSessionProgressValue}%`;
  if (labelEl) labelEl.textContent = label || "正在同步 Codex 会话...";
  if (percentEl) percentEl.textContent = `${Math.round(toolboxSessionProgressValue)}%`;
}

function startToolboxSessionProgress() {
  toolboxSessionSyncBusy = true;
  updateToolboxSessionProgress(8, "正在扫描本地 Codex 会话...");
  if (toolboxSessionProgressTimer) {
    clearInterval(toolboxSessionProgressTimer);
  }
  toolboxSessionProgressTimer = setInterval(() => {
    const next = toolboxSessionProgressValue < 72
      ? toolboxSessionProgressValue + 9
      : toolboxSessionProgressValue < 92
        ? toolboxSessionProgressValue + 2
        : toolboxSessionProgressValue;
    updateToolboxSessionProgress(next, next < 72 ? "正在导入会话记录..." : "正在整理会话索引...");
  }, 360);
  renderToolboxSessionProgress();
}

function finishToolboxSessionProgress(success) {
  if (toolboxSessionProgressTimer) {
    clearInterval(toolboxSessionProgressTimer);
    toolboxSessionProgressTimer = null;
  }
  updateToolboxSessionProgress(success ? 100 : Math.max(35, toolboxSessionProgressValue), success ? "同步完成" : "同步失败");
  window.setTimeout(() => {
    toolboxSessionSyncBusy = false;
    const progress = $("toolboxSessionProgress");
    if (progress) progress.hidden = true;
    renderToolboxSessionProgress();
  }, success ? 520 : 900);
}

function parseToolboxSessionTime(value) {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value > 1_000_000_000_000 ? value : value * 1000;
  }
  const text = String(value || "").trim();
  if (!text) return 0;
  if (/^\d+$/.test(text)) {
    const numeric = Number(text);
    return numeric > 1_000_000_000_000 ? numeric : numeric * 1000;
  }
  const parsed = Date.parse(text);
  return Number.isFinite(parsed) ? parsed : 0;
}

function formatToolboxSessionTime(value) {
  const time = parseToolboxSessionTime(value);
  if (!time) return "--";
  const diffSeconds = Math.max(0, Math.floor((Date.now() - time) / 1000));
  if (diffSeconds < 3600) {
    const minutes = Math.max(1, Math.floor(diffSeconds / 60));
    return currentLang === "zh" ? `${minutes} 分钟前` : `${minutes}m ago`;
  }
  if (diffSeconds < 86400) {
    const hours = Math.floor(diffSeconds / 3600);
    return currentLang === "zh" ? `${hours} 小时前` : `${hours}h ago`;
  }
  if (diffSeconds < 604800) {
    const days = Math.floor(diffSeconds / 86400);
    return currentLang === "zh" ? `${days} 天前` : `${days}d ago`;
  }
  return new Date(time).toLocaleString();
}

function shortToolboxSessionId(sessionId) {
  const text = String(sessionId || "");
  return text.length <= 18 ? text : `${text.slice(0, 8)}...${text.slice(-6)}`;
}

function toolboxSessionTitle(thread) {
  return thread.threadName || thread.lastUserMessage || thread.id || t("toolboxSessionProjectUnknown");
}

function toolboxSessionProjectLabel(cwd) {
  const normalized = String(cwd || "").replace(/\\/g, "/").replace(/\/+$/, "");
  const parts = normalized.split("/").filter(Boolean);
  return parts[parts.length - 1] || t("toolboxSessionProjectUnknown");
}

function filterToolboxSessions(threads) {
  const query = toolboxSessionSearchQuery.trim().toLowerCase();
  if (!query) return threads;
  return threads.filter((thread) => {
    const haystack = [
      thread.id,
      thread.threadName,
      thread.cwd,
      thread.sessionFile,
      thread.lastUserMessage,
      thread.lastAssistantMessage,
    ].join("\n").toLowerCase();
    return haystack.includes(query);
  });
}

function groupToolboxSessions(threads) {
  const groups = new Map();
  threads.forEach((thread) => {
    const key = thread.cwd || t("toolboxSessionProjectUnknown");
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(thread);
  });
  return Array.from(groups.entries())
    .map(([cwd, sessions]) => ({
      cwd,
      sessions: sessions
        .slice()
        .sort((a, b) => parseToolboxSessionTime(b.updatedAt) - parseToolboxSessionTime(a.updatedAt)),
      latest: Math.max(...sessions.map((item) => parseToolboxSessionTime(item.updatedAt)), 0),
    }))
    .sort((a, b) => b.latest - a.latest || toolboxSessionProjectLabel(a.cwd).localeCompare(toolboxSessionProjectLabel(b.cwd)));
}

function syncToolboxSessionSelection(threads) {
  const valid = new Set(threads.map((thread) => thread.id));
  toolboxSelectedSessionIds = new Set([...toolboxSelectedSessionIds].filter((id) => valid.has(id)));
  const trashed = new Set((codexToolbox?.trashedCodexThreads || []).map((thread) => thread.id));
  toolboxSelectedTrashSessionIds = new Set([...toolboxSelectedTrashSessionIds].filter((id) => trashed.has(id)));
}

function renderToolboxSessionRow(thread) {
  const selected = toolboxSelectedSessionIds.has(thread.id);
  const copied = toolboxCopiedSessionId === thread.id;
  const preview = thread.lastUserMessage || thread.lastAssistantMessage || "";
  return `
    <div class="toolbox-session-row ${selected ? "selected" : ""}">
      <label class="toolbox-session-row-main">
        <input type="checkbox" data-toolbox-session-check="${esc(thread.id)}" ${selected ? "checked" : ""}>
        <span class="toolbox-session-row-text">
          <strong title="${esc(toolboxSessionTitle(thread))}">${esc(toolboxSessionTitle(thread))}</strong>
          <span class="toolbox-session-row-meta">${esc(t("toolboxSessionIdLabel"))}: ${esc(shortToolboxSessionId(thread.id))}</span>
          ${thread.sessionFile ? `<span class="toolbox-session-row-meta">${esc(t("toolboxSessionFileLabel"))}: ${esc(thread.sessionFile)}</span>` : ""}
          ${preview ? `<span class="toolbox-session-row-preview">${esc(preview)}</span>` : ""}
        </span>
      </label>
      <div class="toolbox-session-row-actions">
        <button class="toolbox-session-copy-btn ${copied ? "is-copied" : ""}" data-toolbox-session-copy="${esc(thread.id)}" type="button" title="${esc(t("toolboxSessionCopyId"))}">
          ${copied ? "✓" : "⧉"}
        </button>
        <span class="toolbox-session-row-time">${esc(formatToolboxSessionTime(thread.updatedAt))}</span>
      </div>
    </div>
  `;
}

function renderToolboxSessionGroup(group) {
  const ids = group.sessions.map((thread) => thread.id);
  const allSelected = ids.length > 0 && ids.every((id) => toolboxSelectedSessionIds.has(id));
  return `
    <section class="toolbox-session-folder">
      <div class="toolbox-session-folder-row">
        <label class="toolbox-session-folder-main">
          <input type="checkbox" data-toolbox-session-group="${esc(ids.join(","))}" ${allSelected ? "checked" : ""}>
          <span class="toolbox-session-folder-icon" aria-hidden="true">▣</span>
          <span class="toolbox-session-folder-text">
            <strong title="${esc(group.cwd)}">${esc(toolboxSessionProjectLabel(group.cwd))}</strong>
            <span>${esc(group.cwd || t("toolboxSessionProjectUnknown"))}</span>
          </span>
        </label>
        <span class="toolbox-session-folder-meta">${group.sessions.length} · ${esc(formatToolboxSessionTime(group.latest))}</span>
      </div>
      <div class="toolbox-session-folder-children">
        ${group.sessions.map(renderToolboxSessionRow).join("")}
      </div>
    </section>
  `;
}

function renderToolboxSessionTrash() {
  const drawer = $("toolboxSessionTrashDrawer");
  const list = $("toolboxSessionTrashList");
  const trash = codexToolbox?.trashedCodexThreads || [];
  drawer.hidden = !toolboxSessionTrashOpen;
  if (!toolboxSessionTrashOpen) return;
  $("toolboxSessionRestoreBtn").disabled = toolboxSelectedTrashSessionIds.size === 0;
  if (trash.length === 0) {
    list.innerHTML = `<div class="mgmt-empty">${t("toolboxSessionTrashEmpty")}</div>`;
    return;
  }
  list.innerHTML = trash.map((thread) => {
    const selected = toolboxSelectedTrashSessionIds.has(thread.id);
    return `
      <label class="toolbox-session-trash-row">
        <input type="checkbox" data-toolbox-trash-check="${esc(thread.id)}" ${selected ? "checked" : ""}>
        <span class="toolbox-session-trash-row-text">
          <strong>${esc(toolboxSessionTitle(thread))}</strong>
          <span>${esc(toolboxSessionProjectLabel(thread.cwd))} · ${esc(shortToolboxSessionId(thread.id))}</span>
          <span>${esc(t("toolboxSessionDeletedAt"))}: ${esc(thread.deletedAt || "--")}</span>
        </span>
      </label>
    `;
  }).join("");
  list.querySelectorAll("[data-toolbox-trash-check]").forEach((input) => {
    input.addEventListener("change", () => {
      const id = input.getAttribute("data-toolbox-trash-check");
      if (!id) return;
      if (input.checked) toolboxSelectedTrashSessionIds.add(id);
      else toolboxSelectedTrashSessionIds.delete(id);
      renderToolboxSyncedThreads();
    });
  });
}

function renderToolboxSessionManagerControls(filteredThreads, allThreads) {
  const filteredIds = filteredThreads.map((thread) => thread.id);
  const allFilteredSelected = filteredIds.length > 0 && filteredIds.every((id) => toolboxSelectedSessionIds.has(id));
  $("toolboxSessionSelectAllBtn").textContent = allFilteredSelected ? t("toolboxSessionClearSelected") : t("toolboxSessionSelectAll");
  $("toolboxSessionCopyIdsBtn").textContent = `${t("toolboxSessionCopyIds")} (${toolboxSelectedSessionIds.size})`;
  $("toolboxSessionTrashBtn").textContent = `${t("toolboxSessionMoveTrash")} (${toolboxSelectedSessionIds.size})`;
  $("toolboxSessionRestoreOpenBtn").textContent = `${t("toolboxSessionOpenTrash")} (${(codexToolbox?.trashedCodexThreads || []).length})`;
  $("toolboxSessionCopyIdsBtn").disabled = toolboxSelectedSessionIds.size === 0;
  $("toolboxSessionTrashBtn").disabled = toolboxSelectedSessionIds.size === 0;
  $("toolboxSessionSelectAllBtn").disabled = filteredIds.length === 0;
  $("toolboxSessionManagerStatus").textContent = t("toolboxSessionSelectedSummary", {
    selected: toolboxSelectedSessionIds.size,
    total: filteredThreads.length,
    trash: (codexToolbox?.trashedCodexThreads || []).length,
  });
}

function renderToolboxSyncedThreads() {
  const list = $("toolboxSyncedThreadsList");
  const allThreads = codexToolbox?.syncedCodexThreads || [];
  syncToolboxSessionSelection(allThreads);
  const filteredThreads = filterToolboxSessions(allThreads);
  const groups = groupToolboxSessions(filteredThreads);
  renderToolboxSessionManagerControls(filteredThreads, allThreads);
  renderToolboxSessionTrash();
  if (allThreads.length === 0) {
    list.innerHTML = `<div class="mgmt-empty">${t("toolboxNoThreads")}</div>`;
    bindToolboxSessionManagerEvents(filteredThreads);
    return;
  }
  if (filteredThreads.length === 0) {
    list.innerHTML = `<div class="mgmt-empty">${t("toolboxSessionNoSearchResults")}</div>`;
    bindToolboxSessionManagerEvents(filteredThreads);
    return;
  }
  list.innerHTML = groups.map(renderToolboxSessionGroup).join("");
  bindToolboxSessionManagerEvents(filteredThreads);
}

async function copyToolboxText(text) {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text);
    return;
  }
  const input = document.createElement("textarea");
  input.value = text;
  input.style.position = "fixed";
  input.style.opacity = "0";
  document.body.appendChild(input);
  input.select();
  document.execCommand("copy");
  input.remove();
}

function bindToolboxSessionManagerEvents(filteredThreads) {
  const list = $("toolboxSyncedThreadsList");
  list.querySelectorAll("[data-toolbox-session-check]").forEach((input) => {
    input.addEventListener("change", () => {
      const id = input.getAttribute("data-toolbox-session-check");
      if (!id) return;
      if (input.checked) toolboxSelectedSessionIds.add(id);
      else toolboxSelectedSessionIds.delete(id);
      renderToolboxSyncedThreads();
    });
  });
  list.querySelectorAll("[data-toolbox-session-group]").forEach((input) => {
    input.addEventListener("change", () => {
      const ids = (input.getAttribute("data-toolbox-session-group") || "").split(",").filter(Boolean);
      const allSelected = ids.every((id) => toolboxSelectedSessionIds.has(id));
      ids.forEach((id) => {
        if (allSelected) toolboxSelectedSessionIds.delete(id);
        else toolboxSelectedSessionIds.add(id);
      });
      renderToolboxSyncedThreads();
    });
  });
  list.querySelectorAll("[data-toolbox-session-copy]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const id = btn.getAttribute("data-toolbox-session-copy");
      if (!id) return;
      try {
        await copyToolboxText(id);
        toolboxCopiedSessionId = id;
        renderToolboxSyncedThreads();
        window.setTimeout(() => {
          if (toolboxCopiedSessionId === id) {
            toolboxCopiedSessionId = "";
            renderToolboxSyncedThreads();
          }
        }, 1000);
      } catch (error) {
        showToast(String(error), "error");
      }
    });
  });
  $("toolboxSessionSelectAllBtn").onclick = () => {
    const ids = filteredThreads.map((thread) => thread.id);
    const allSelected = ids.length > 0 && ids.every((id) => toolboxSelectedSessionIds.has(id));
    ids.forEach((id) => {
      if (allSelected) toolboxSelectedSessionIds.delete(id);
      else toolboxSelectedSessionIds.add(id);
    });
    renderToolboxSyncedThreads();
  };
  $("toolboxSessionCopyIdsBtn").onclick = async () => {
    const ids = [...toolboxSelectedSessionIds];
    if (ids.length === 0) return;
    try {
      await copyToolboxText(ids.join("\n"));
      showToast(t("toolboxSessionCopiedIds"), "success");
    } catch (error) {
      showToast(String(error), "error");
    }
  };
  $("toolboxSessionTrashBtn").onclick = handleToolboxMoveSelectedToTrash;
  $("toolboxSessionRestoreOpenBtn").onclick = () => {
    toolboxSessionTrashOpen = !toolboxSessionTrashOpen;
    renderToolboxSyncedThreads();
  };
  $("toolboxSessionTrashCloseBtn").onclick = () => {
    toolboxSessionTrashOpen = false;
    renderToolboxSyncedThreads();
  };
  $("toolboxSessionRestoreBtn").onclick = handleToolboxRestoreSelectedSessions;
}

async function handleToolboxMoveSelectedToTrash() {
  const threadIds = [...toolboxSelectedSessionIds];
  if (threadIds.length === 0) return;
  if (!(await appConfirm(t("toolboxSessionConfirmTrash"), { title: currentLang === "zh" ? "移入回收站" : "Move to trash", danger: true, confirmText: currentLang === "zh" ? "移入回收站" : "Move" }))) return;
  try {
    codexToolbox = await invoke("trash_codex_sessions", { threadIds });
    toolboxSelectedSessionIds.clear();
    showToast(t("toolboxSessionMovedTrash"), "success");
    renderCodexToolbox();
  } catch (error) {
    showToast(String(error), "error");
  }
}

async function handleToolboxRestoreSelectedSessions() {
  const threadIds = [...toolboxSelectedTrashSessionIds];
  if (threadIds.length === 0) return;
  try {
    codexToolbox = await invoke("restore_codex_sessions", { threadIds });
    toolboxSelectedTrashSessionIds.clear();
    showToast(t("toolboxSessionRestored"), "success");
    renderCodexToolbox();
  } catch (error) {
    showToast(String(error), "error");
  }
}

function getSelectedMobileBinding() {
  const bindings = codexToolbox?.mobileChannels || [];
  return bindings.find((binding) => binding.channel === selectedMobileChannel) || { channel: selectedMobileChannel };
}

function renderToolboxMobileControl() {
  const appSelect = $("toolboxMobileAppSelect");
  const threadSelect = $("toolboxMobileThreadSelect");
  const threads = codexToolbox?.syncedCodexThreads || [];

  const appOptionsHtml = [
    `<option value="wechat">${channelLabel("wechat")}</option>`,
    `<option value="qq">${channelLabel("qq")}</option>`,
    `<option value="lark">${channelLabel("lark")}</option>`,
  ].join("");
  // 仅在内容变化时重建，避免每秒轮询时下拉被强行关闭
  if (appSelect.innerHTML !== appOptionsHtml) appSelect.innerHTML = appOptionsHtml;
  if (appSelect.value !== selectedMobileChannel) appSelect.value = selectedMobileChannel;

  if (codexToolbox?.selectedMobileThreadId) {
    selectedCodexThreadId = codexToolbox.selectedMobileThreadId;
  } else if (!selectedCodexThreadId && threads[0]) {
    selectedCodexThreadId = threads[0].id;
  }
  const threadOptionsHtml = threads.length
    ? threads.map((thread) => `<option value="${esc(thread.id)}">${esc(thread.threadName || thread.lastUserMessage || thread.id)}</option>`).join("")
    : `<option value="">${t("toolboxMobileNoThreadOption")}</option>`;
  if (threadSelect.innerHTML !== threadOptionsHtml) threadSelect.innerHTML = threadOptionsHtml;
  const nextThreadValue = threads.some((thread) => thread.id === selectedCodexThreadId) ? selectedCodexThreadId : "";
  if (threadSelect.value !== nextThreadValue) threadSelect.value = nextThreadValue;

  bindMobileControlSelectEvents();

  const panel = $("toolboxMobileBindPanel");
  if (!panel) return;
  const nextPanelHtml = renderSelectedMobileBinding(getSelectedMobileBinding());
  // 用户正在填写凭据输入框时跳过重建，否则每秒轮询会销毁输入框、丢焦点丢内容
  const active = document.activeElement;
  const typingInPanel =
    active && active !== document.body && panel.contains(active) && active.hasAttribute?.("data-channel-field");
  if (typingInPanel) return;
  if (panel.innerHTML === nextPanelHtml) return;
  panel.innerHTML = nextPanelHtml;
  bindMobileControlPanelEvents();
}

function bindMobileControlSelectEvents() {
  const appSelect = $("toolboxMobileAppSelect");
  if (appSelect) {
    appSelect.onchange = () => {
      selectedMobileChannel = appSelect.value || "wechat";
      renderCodexToolbox();
    };
  }

  const threadSelect = $("toolboxMobileThreadSelect");
  if (threadSelect) {
    threadSelect.onchange = async () => {
      selectedCodexThreadId = threadSelect.value || "";
      if (!selectedCodexThreadId) return;
      try {
        await bindCurrentMobileSelection();
        showToast(t("toolboxThreadSelected"), "success");
        renderCodexToolbox();
      } catch (error) {
        showToast(String(error), "error");
      }
    };
  }
}

function bindMobileControlPanelEvents() {
  $("toolboxMobileBindPanel").querySelectorAll("button[data-action]").forEach((btn) => {
    btn.addEventListener("click", handleMobileBindAction);
  });
  $("toolboxMobileBindPanel").querySelectorAll("[data-channel-field]").forEach((input) => {
    input.addEventListener("input", scheduleMobileChannelAutoSave);
    input.addEventListener("change", () => saveSelectedMobileChannelDraft({ render: true }));
  });
}

async function bindCurrentMobileSelection() {
  mobileDebug("bind selection requested");
  if (!selectedCodexThreadId) {
    const first = codexToolbox?.syncedCodexThreads?.[0];
    selectedCodexThreadId = first?.id || "";
    mobileDebug("bind selection fallback thread", { fallbackThreadId: selectedCodexThreadId });
  }
  if (!selectedCodexThreadId) {
    mobileDebugError("bind selection failed: no thread", t("toolboxNoThreads"));
    throw new Error(t("toolboxNoThreads"));
  }
  mobileDebug("select_mobile_thread invoke:start");
  codexToolbox = await invoke("select_mobile_thread", { threadId: selectedCodexThreadId });
  mobileDebug("select_mobile_thread invoke:success", {
    activeThreadId: codexToolbox?.mobileRemote?.activeThreadId,
    activeThreadName: codexToolbox?.mobileRemote?.activeThreadName,
  });
  mobileDebug("bind_codex_thread invoke:start");
  codexToolbox = await invoke("bind_codex_thread", {
    channel: selectedMobileChannel,
    threadId: selectedCodexThreadId,
    syncEnabled: true,
    note: "mobile-control",
  });
  mobileDebug("bind_codex_thread invoke:success", {
    activeThreadId: codexToolbox?.mobileRemote?.activeThreadId,
    activeThreadName: codexToolbox?.mobileRemote?.activeThreadName,
    binding: getSelectedMobileBinding(),
  });
}

function scheduleMobileChannelAutoSave() {
  window.clearTimeout(larkCredentialSaveTimer);
  larkCredentialSaveTimer = window.setTimeout(() => {
    saveSelectedMobileChannelDraft({ render: false });
  }, 700);
}

async function saveSelectedMobileChannelDraft({ render = false } = {}) {
  if (selectedMobileChannel !== "lark") return;
  const panel = $("toolboxMobileBindPanel");
  const appId = panel.querySelector("[data-channel-field='appId']")?.value || "";
  const appSecret = panel.querySelector("[data-channel-field='appSecret']")?.value || "";
  if (!appId.trim() && !appSecret.trim()) return;
  try {
    mobileDebug("configure_mobile_channel invoke:start", {
      channel: "lark",
      hasAppId: Boolean(appId.trim()),
      hasAppSecret: Boolean(appSecret.trim()),
      render,
    });
    codexToolbox = await invoke("configure_mobile_channel", {
      channel: "lark",
      appId,
      appSecret,
      botToken: "",
      accountId: "",
      baseUrl: "https://open.feishu.cn",
      userId: "",
      botOpenId: "",
    });
    mobileDebug("configure_mobile_channel invoke:success", {
      binding: getSelectedMobileBinding(),
    });
    if (render) renderCodexToolbox();
  } catch (error) {
    mobileDebugError("configure_mobile_channel invoke:failed", error);
    showToast(String(error), "error");
  }
}

async function handleMobileBindAction(event) {
  const btn = event.currentTarget;
  const action = btn.getAttribute("data-action");
  // 已有绑定操作在执行时直接忽略，避免重复调用后端命令
  if (mobileBindBusyAction && action !== "toolbox-cancel-qq-qr") return;
  mobileBindBusyAction = action || "";
  // 注意：renderCodexToolbox() 会重建整个面板，btn 随即变成游离节点，
  // 因此这里不再对 btn 设 busy，改由模板按 mobileBindBusyAction 输出 disabled。
  renderCodexToolbox();
  try {
    if (action === "toolbox-open-lark-create") {
      selectedMobileChannel = "lark";
      mobileDebug("start_lark_bot_registration invoke:start", { createOnly: true });
      codexToolbox = await invoke("start_lark_bot_registration", { createOnly: true });
      mobileDebug("start_lark_bot_registration invoke:success", { createOnly: true });
      startToolboxRefresh(120);
      showToast(t("toolboxCreateLarkBot"), "success");
    } else if (action === "toolbox-open-lark-existing") {
      selectedMobileChannel = "lark";
      mobileDebug("start_lark_bot_registration invoke:start", { createOnly: false });
      codexToolbox = await invoke("start_lark_bot_registration", { createOnly: false });
      mobileDebug("start_lark_bot_registration invoke:success", { createOnly: false });
      startToolboxRefresh(120);
      showToast(t("toolboxRebindLarkBot"), "success");
    } else if (action === "toolbox-unbind-lark-session") {
      mobileDebug("unbind_codex_thread invoke:start", { channel: "lark" });
      codexToolbox = await invoke("unbind_codex_thread", { channel: "lark" });
      mobileDebug("unbind_codex_thread invoke:success", { channel: "lark" });
      showToast(t("toolboxUnbindLarkSession"), "success");
    } else if (action === "toolbox-stop-lark-listen") {
      mobileDebug("stop_mobile_remote invoke:start", { source: "lark-panel" });
      codexToolbox = await invoke("stop_mobile_remote", {});
      mobileDebug("stop_mobile_remote invoke:success", { source: "lark-panel" });
      showToast(t("toolboxStopLarkListen"), "success");
    } else if (action === "toolbox-clear-lark-binding") {
      mobileDebug("clear_mobile_channel_binding invoke:start", { channel: "lark" });
      codexToolbox = await invoke("clear_mobile_channel_binding", { channel: "lark" });
      mobileDebug("clear_mobile_channel_binding invoke:success", { channel: "lark" });
      showToast(t("toolboxClearLarkBinding"), "success");
    } else if (action === "toolbox-clear-qq-binding") {
      mobileDebug("clear_mobile_channel_binding invoke:start", { channel: "qq" });
      codexToolbox = await invoke("clear_mobile_channel_binding", { channel: "qq" });
      mobileDebug("clear_mobile_channel_binding invoke:success", { channel: "qq" });
      showToast("QQ 绑定已清除", "success");
    } else if (action === "toolbox-clear-wechat-binding") {
      mobileDebug("clear_mobile_channel_binding invoke:start", { channel: "wechat" });
      codexToolbox = await invoke("clear_mobile_channel_binding", { channel: "wechat" });
      mobileDebug("clear_mobile_channel_binding invoke:success", { channel: "wechat" });
      showToast("微信绑定已清除", "success");
    } else if (action === "toolbox-start-qq-qr") {
      selectedMobileChannel = "qq";
      startToolboxRefresh(120);
      showToast(t("toolboxStartQqQr"), "success");
      const qqBinding = getSelectedMobileBinding();
      qqBinding.qrStatus = "正在生成 QQ 扫码二维码，请稍等...";
      qqBinding.status = "正在生成 QQ 扫码二维码，请稍等...";
      renderCodexToolbox();
      // 必须 await：否则 finally 会在二维码生成前清空 busy，导致可以连点重复绑定
      codexToolbox = await invoke("start_qq_qr_binding", {});
      startToolboxRefresh(120);
    } else if (action === "toolbox-cancel-qq-qr") {
      mobileDebug("cancel_qq_qr_binding invoke:start");
      codexToolbox = await invoke("cancel_qq_qr_binding", {});
      mobileDebug("cancel_qq_qr_binding invoke:success");
      showToast(currentLang === "zh" ? "已取消 QQ 扫码绑定" : "QQ QR binding cancelled", "success");
    } else if (action === "toolbox-start-wechat-qr") {
      selectedMobileChannel = "wechat";
      startToolboxRefresh(120);
      showToast(t("toolboxStartWechatQr"), "success");
      codexToolbox = await invoke("start_wechat_qr_binding", {});
    } else if (action === "toolbox-poll-wechat-qr") {
      codexToolbox = await invoke("poll_wechat_qr_binding", { verifyCode: "" });
      showToast(t("toolboxPollWechatQr"), "success");
    } else if (action === "toolbox-open-qr") {
      await invoke("open_external_target", { target: btn.getAttribute("data-url") || "" });
    }
    renderCodexToolbox();
  } catch (error) {
    mobileDebugError("mobile bind action failed", error, { action });
    showToast(String(error), "error");
    if (action === "toolbox-start-qq-qr") loadCodexToolbox();
  } finally {
    mobileBindBusyAction = "";
    renderCodexToolbox();
  }
}

function renderSelectedMobileBinding(binding) {
  const channel = binding.channel || selectedMobileChannel;
  const title = channelLabel(channel);
  const uiState = getMobileBindingUiState(binding);
  const status = getMobileBindingStatusText(binding, uiState);
  const error = binding.lastError ? `<div class="mgmt-item-desc danger">${t("toolboxLastError")}: ${esc(binding.lastError)}</div>` : "";
  const qr = uiState.showQr ? renderChannelQr(binding) : "";
  const busy = uiState.busy ||
    mobileBindBusyAction.startsWith(`toolbox-${channel}`) ||
    mobileBindBusyAction.includes(channel) ||
    mobileBindBusyAction.includes("remote");
  const loading = busy
    ? `<div class="toolbox-loading-line"><span class="inline-spinner" aria-hidden="true"></span><span>${esc(getMobileBindingLoadingText(channel, mobileBindBusyAction))}</span></div>`
    : "";
  const stateBadge = `<span class="toolbox-binding-state toolbox-binding-state-${esc(uiState.kind)}">${esc(getMobileBindingStateLabel(uiState.kind))}</span>`;
  // 有绑定操作在进行中就禁用全部动作按钮，避免重复调用后端命令
  const dis = mobileBindBusyAction ? " disabled" : "";
  let body = "";
  let actions = "";

  if (channel === "wechat") {
    body = `${qr}${loading}<div class="mgmt-item-desc">${esc(status.detail || "点击绑定微信后，用手机微信扫码并确认绑定。")}</div>`;
    actions = `
      <button class="btn btn-primary btn-sm" data-action="toolbox-start-wechat-qr"${dis}>${t("toolboxStartWechatQr")}</button>
      <button class="btn btn-secondary btn-sm danger-text" data-action="toolbox-clear-wechat-binding"${dis}>清除绑定</button>
    `;
  } else if (channel === "qq") {
    const qqQrPending = Boolean(
      binding.qrStartedAt &&
      !binding.appId &&
      !binding.appSecret &&
      /扫码|二维码|正在|等待/i.test(`${binding.status || ""} ${binding.qrStatus || ""}`)
    );
    body = `${qr}${loading}<div class="mgmt-item-desc">${esc(status.detail || "点击 QQ 扫码绑定后，用 QQ 扫描二维码即可保存机器人凭据。")}</div>`;
    actions = `
      <button class="btn btn-primary btn-sm" data-action="toolbox-start-qq-qr"${dis}>${t("toolboxStartQqQr")}</button>
      ${qqQrPending ? `<button class="btn btn-secondary btn-sm" data-action="toolbox-cancel-qq-qr"${mobileBindBusyAction && mobileBindBusyAction !== "toolbox-start-qq-qr" ? " disabled" : ""}>取消扫码</button>` : ""}
      <button class="btn btn-secondary btn-sm danger-text" data-action="toolbox-clear-qq-binding"${dis}>清除绑定</button>
    `;
  } else {
    body = `
      ${qr}
      ${loading}
      <div class="mgmt-item-desc">创建新机器人会打开飞书开放平台；创建完成后 App ID 和 App Secret 会自动填充并绑定当前对话。</div>
      <div class="toolbox-channel-form toolbox-channel-form-compact">
        <label class="toolbox-channel-field">
          <span>${t("toolboxAppId")}</span>
          <input type="text" data-channel-field="appId" autocomplete="off" value="${esc(binding.appId || "")}">
        </label>
        <label class="toolbox-channel-field">
          <span>${t("toolboxAppSecret")}</span>
          <input type="password" data-channel-field="appSecret" autocomplete="off" placeholder="${binding.appSecret === '*' ? '(已保存)' : ''}" value="">
        </label>
      </div>
    `;
    actions = `
      <button class="btn btn-success btn-sm" data-action="toolbox-open-lark-existing"${dis}>${t("toolboxRebindLarkBot")}</button>
      <button class="btn btn-secondary btn-sm" data-action="toolbox-open-lark-create"${dis}>${t("toolboxCreateLarkBot")}</button>
      <button class="btn btn-secondary btn-sm danger-text" data-action="toolbox-unbind-lark-session"${dis}>${t("toolboxUnbindLarkSession")}</button>
      <button class="btn btn-secondary btn-sm danger-text" data-action="toolbox-stop-lark-listen"${dis}>${t("toolboxStopLarkListen")}</button>
      <button class="btn btn-secondary btn-sm danger-text" data-action="toolbox-clear-lark-binding"${dis}>${t("toolboxClearLarkBinding")}</button>
    `;
  }

  return `
    <div class="toolbox-mobile-card">
      <div class="toolbox-mobile-card-title"><span>${esc(title)}</span>${stateBadge}</div>
      <div class="mgmt-item-desc">${esc(status.main)}</div>
      ${error}
      ${body}
      <div class="toolbox-thread-actions">${actions}</div>
    </div>
  `;
}

function getMobileBindingUiState(binding) {
  if (typeof helpers.getMobileBindingUiState === "function") {
    return helpers.getMobileBindingUiState(binding);
  }
  const hasCredential = Boolean(binding?.bound || binding?.botToken || binding?.appId || binding?.appSecret || binding?.accountId || binding?.userId || binding?.botOpenId);
  if (binding?.lastError) return { kind: "error", hasCredential, showQr: false, busy: false };
  if (hasCredential) return { kind: "bound", hasCredential, showQr: false, busy: false };
  if (shouldRenderChannelQr(binding)) return { kind: "qr", hasCredential, showQr: true, busy: false };
  return { kind: "unbound", hasCredential, showQr: false, busy: false };
}

function getMobileBindingStateLabel(kind) {
  const zh = {
    bound: "已绑定",
    qr: "等待扫码",
    binding: "连接中",
    error: "异常",
    unbound: "未绑定",
  };
  const en = {
    bound: "Bound",
    qr: "Scan QR",
    binding: "Connecting",
    error: "Error",
    unbound: "Unbound",
  };
  return (currentLang === "zh" ? zh : en)[kind] || kind;
}

function getMobileBindingStatusText(binding, uiState) {
  const channel = channelLabel(binding?.channel || selectedMobileChannel);
  if (uiState.kind === "bound") {
    return {
      main: `${channel} 已绑定，可直接开启平台连接`,
      detail: `如果手机端没有收到消息，请点击「开启平台连接」重新监听；不需要重新扫码。`,
    };
  }
  if (uiState.kind === "qr") {
    return {
      main: `${channel} 二维码已生成`,
      detail: `请使用 ${channel} 扫码并在手机端确认。`,
    };
  }
  if (uiState.kind === "binding") {
    return {
      main: `${channel} 正在连接`,
      detail: binding?.status || binding?.qrStatus || `正在准备 ${channel} 绑定，请稍等。`,
    };
  }
  if (uiState.kind === "error") {
    return {
      main: `${channel} 状态异常`,
      detail: `请重新绑定或清除后再试。`,
    };
  }
  return {
    main: `${channel} 尚未绑定`,
    detail: binding?.status || binding?.qrStatus || `请选择对话后绑定 ${channel}。`,
  };
}

function getMobileBindingLoadingText(channel, action) {
  const label = channelLabel(channel);
  if (action.includes("remote")) return `正在开启 ${label} 平台连接...`;
  if (action.includes("clear")) return `正在清除 ${label} 绑定...`;
  if (action.includes("lark")) return `正在准备飞书绑定流程...`;
  if (action.includes("qq")) return `正在生成 QQ 扫码二维码...`;
  if (action.includes("wechat")) return `正在生成微信扫码二维码...`;
  return `正在处理 ${label} 状态...`;
}

function renderChannelQr(binding) {
  if (!shouldRenderChannelQr(binding)) return "";
  const canOpenUrl = binding.channel === "lark";
  const image = binding.qrDataUrl
    ? `<img class="toolbox-qr-image" src="${esc(binding.qrDataUrl)}" alt="${esc(channelLabel(binding.channel))} QR">`
    : "";
  const open = canOpenUrl && binding.qrUrl
    ? `<button class="btn btn-link btn-sm toolbox-qr-link" type="button" data-action="toolbox-open-qr" data-url="${esc(binding.qrUrl)}">${t("toolboxQrOpen")}</button>`
    : "";
  if (!image && !open) return "";
  return `<div class="toolbox-qr-box">${image}${open}</div>`;
}

function shouldRenderChannelQr(binding) {
  if (typeof helpers.shouldRenderChannelQr === "function") {
    return helpers.shouldRenderChannelQr(binding);
  }
  if (!binding || (!binding.qrDataUrl && !binding.qrUrl)) return false;
  if (binding.channel === "lark") return Boolean(binding.qrDataUrl || binding.qrUrl);
  if (binding.channel === "qq") {
    return Boolean(binding.qrDataUrl && isFreshMobileQr(binding));
  }
  if (binding.channel === "wechat") {
    const dataUrl = String(binding.qrDataUrl || "").trim().toLowerCase();
    return Boolean(
      binding.qrDataUrl &&
      binding.qrDeviceCode &&
      isFreshMobileQr(binding) &&
      !dataUrl.startsWith("data:image/svg+xml")
    );
  }
  return Boolean(binding.qrDataUrl);
}

function isFreshMobileQr(binding) {
  if (typeof helpers.isFreshMobileQr === "function") {
    return helpers.isFreshMobileQr(binding);
  }
  const startedAt = Number(binding?.qrStartedAt || 0);
  if (!Number.isFinite(startedAt) || startedAt <= 0) return false;
  return Date.now() - startedAt <= 10 * 60 * 1000;
}

function isQqAuthorizationTarget(value) {
  if (typeof helpers.isQqAuthorizationTarget === "function") {
    return helpers.isQqAuthorizationTarget(value);
  }
  return /^(https?:\/\/|mqqapi:\/\/|qqbot:\/\/)/i.test(String(value || "").trim());
}

function renderToolboxRemote() {
  const remote = codexToolbox?.mobileRemote;
  if (!remote) return;
  const binding = getSelectedMobileBinding();
  const activeThread = remote.activeThreadName || remote.activeThreadId || "";
  const smartControlText = remote.remoteControlConnected
    ? t("toolboxSmartControlConnected")
    : (remote.remoteControlStatus || remote.remoteControlDetail
      ? `${t("toolboxSmartControlWaiting")}: ${remote.remoteControlStatus || remote.remoteControlDetail}`
      : t("toolboxSmartControlCompat"));
  const stateText = binding?.lastError || (remote.enabled ? t("toolboxRemoteRunning") : (remote.lastError || t("toolboxRemoteStopped")));
  $("toolboxRemoteStatusValue").textContent = [
    smartControlText,
    stateText,
    channelLabel(selectedMobileChannel),
    activeThread,
    binding.status || binding.qrStatus || "",
  ].filter(Boolean).join(" · ");
  $("toolboxRemoteStatusValue").title = currentLang === "zh"
    ? "点击复制最近高级控制协议事件"
    : "Click to copy the latest advanced-control protocol event";
  $("toolboxRemoteStatusValue").style.cursor = "copy";
  $("toolboxRemoteStatusValue").onclick = copySmartControlDebugEvent;
  renderSmartControlApprovals();
}

function ensureSmartControlApprovalPanel() {
  let panel = $("smartControlApprovalPanel");
  if (panel) return panel;
  const status = $("toolboxRemoteStatusValue");
  if (!status || !status.parentElement) return null;
  panel = document.createElement("div");
  panel.id = "smartControlApprovalPanel";
  panel.className = "smart-control-approval-panel";
  status.insertAdjacentElement("afterend", panel);
  return panel;
}

function renderSmartControlApprovals() {
  const panel = ensureSmartControlApprovalPanel();
  if (!panel) return;
  const approvals = codexDiagnostics?.approvals || [];
  if (!approvals.length) {
    panel.innerHTML = `<div class="smart-control-approval-empty">${esc(t("toolboxSmartControlApprovalEmpty"))}</div>`;
    return;
  }
  panel.innerHTML = `<div class="smart-control-approval-title">${esc(t("toolboxSmartControlApprovalTitle"))}</div>
    ${approvals.slice(-3).reverse().map((approval) => {
      const options = approval.options?.length ? approval.options : ["approve", "deny"];
      // 整卡片 disabled — 只要这张卡正在提交，所有按钮都禁用
      const pending = pendingApprovalIds.has(approval.requestId || "");
      const dis = pending ? " disabled" : "";
      return `<div class="smart-control-approval-card">
        <div class="smart-control-approval-card-title">${esc(approval.title || approval.method || "Approval")}</div>
        <div class="smart-control-approval-card-body">${esc(approval.body || approval.rawPreview || "")}</div>
        <div class="smart-control-approval-actions">
          ${options.map((option) => `<button class="btn btn-secondary btn-sm" type="button" data-approval-id="${esc(approval.requestId || "")}" data-approval-decision="${esc(option)}"${dis}>${esc(option)}</button>`).join("")}
        </div>
      </div>`;
    }).join("")}`;
  panel.querySelectorAll("[data-approval-id]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const requestId = btn.getAttribute("data-approval-id");
      const decision = btn.getAttribute("data-approval-decision");
      if (!requestId || !decision) return;
      // 整卡片加入 pending 集合，下次渲染时所有按钮都 disabled
      if (pendingApprovalIds.has(requestId)) return;
      pendingApprovalIds.add(requestId);
      renderSmartControlApprovals();
      try {
        await invoke("submit_smart_control_approval", { requestId, decision });
        showToast(t("toolboxSmartControlApprovalSubmitted"), "success");
        await loadSmartControlDebug(true);
        renderSmartControlApprovals();
      } catch (error) {
        showToast(String(error), "error");
        pendingApprovalIds.delete(requestId);
        renderSmartControlApprovals();
      }
    });
  });
}

function channelLabel(channel) {
  if (channel === "lark") return currentLang === "zh" ? "飞书" : "Feishu/Lark";
  if (channel === "wechat") return currentLang === "zh" ? "微信" : "WeChat";
  if (channel === "qq") return "QQ";
  return String(channel || "").toUpperCase();
}

async function copySmartControlDebugEvent() {
  try {
    const debug = await invoke("get_smart_control_debug");
    const latest = debug?.lastEvent || debug?.events?.[debug.events.length - 1] || null;
    const payload = latest || debug || {};
    await navigator.clipboard.writeText(JSON.stringify(payload, null, 2));
    showToast(t("toolboxSmartControlCopied"), "success");
  } catch (error) {
    showToast(String(error), "error");
  }
}

function waitForNextPaint() {
  return new Promise((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(resolve));
  });
}

function showSwitchOverlay(profileName, kind = "claude") {
  const state = helpers.getSwitchOverlayState?.(kind) || {
    cancellable: kind === "claude",
    indeterminate: kind !== "claude",
    showSteps: kind === "claude",
  };
  const progressBar = $("switchProgressBar");
  $("switchProfileName").textContent = profileName;
  progressBar.classList.toggle("indeterminate", state.indeterminate);
  progressBar.style.width = state.indeterminate ? "38%" : "0%";
  const switchingLabel =
    kind === "codex" ? t("codexSwitching") : kind === "grok" ? t("grokSwitching") : t("preparing");
  $("switchStepLabel").textContent = switchingLabel;
  $("switchProgressPercent").textContent = "0%";
  $("switchProgressPercent").hidden = state.indeterminate;
  $("switchStep1").className = "switch-step";
  $("switchStep2").className = "switch-step";
  $("switchStep3").className = "switch-step";
  $("switchSteps").hidden = !state.showSteps;
  $("switchCancelBtn").hidden = !state.cancellable;
  $("switchCancelBtn").disabled = false;
  $("switchOverlay").classList.add("open");
}

function hideSwitchOverlay() {
  $("switchOverlay").classList.remove("open");
}

function completeSwitchOverlay() {
  $("switchProgressBar").classList.remove("indeterminate");
  $("switchProgressBar").style.width = "100%";
  $("switchProgressPercent").hidden = false;
  $("switchProgressPercent").textContent = "100%";
  $("switchStepLabel").textContent = t("switchDone");
}

function switchProgressLabel(step) {
  if (step <= 1) return t("preparing");
  if (step === 2) return t("progressSystem");
  if (step === 3) return t("progressEditors");
  if (step === 4) return t("progressClaude");
  if (step === 5) return t("progressFinalize");
  if (step >= 6) return t("progressDone");
  return t("preparing");
}

function updateSwitchProgress(payload) {
  const step = Math.max(1, Number(payload?.step || 1));
  const total = Math.max(1, Number(payload?.total || 6));
  const pct = Math.round((step / total) * 100);

  $("switchProgressBar").style.width = `${pct}%`;
  $("switchProgressPercent").textContent = `${pct}%`;

  const labelMap = {
    prepare: t("preparing"),
    system: t("progressSystem"),
    vscode: t("progressEditors"),
    editors: t("progressEditors"),
    claude: t("progressClaude"),
    finalize: t("progressFinalize"),
    done: t("progressDone")
  };
  const payloadLabel = payload?.label ? labelMap[payload.label] : null;
  $("switchStepLabel").textContent = payloadLabel || switchProgressLabel(step);

  for (let i = 1; i <= total; i += 1) {
    const el = $(`switchStep${i}`);
    if (!el) continue;
    if (i < step) {
      el.className = "switch-step done";
    } else if (i === step) {
      el.className = "switch-step active";
    } else {
      el.className = "switch-step";
    }
  }
}

function updateClaudeStatusTitle() {
  const active = profiles.find((profile) => profile.isActive);
  const activeContext = active
    ? (currentLang === "zh" ? ` (当前: ${active.name})` : ` (Current: ${active.name})`)
    : "";
  setText("statusSectionTitle", `${t("statusTitle")}${activeContext}`);
}

function renderClaudeStatus(status) {
  const grid = $("statusGrid");
  if (!grid) return;

  const item = status?.claude || {};
  const model = status?.claudeModel || "--";
  const apiKeyLabel = "Claude API Key";
  const baseUrlLabel = "Claude Base URL";
  const modelLabel = currentLang === "zh" ? "Claude 模型" : "Claude Model";
  updateClaudeStatusTitle();
  const COPY_ICON = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>`;

  grid.innerHTML = `
    <div class="status-card">
      <div class="status-card-title">
        <span class="status-card-title-text">${productIcon("anthropic")}Claude</span>
      </div>
      <div class="status-item">
        <span class="status-label">${apiKeyLabel}</span>
        <div class="status-value-wrapper">
          <span class="status-value" title="${esc(item.apiKey || "--")}">${esc(maskKey(item.apiKey))}</span>
          ${item.apiKey ? `<button class="copy-btn" type="button" data-copy="${esc(item.apiKey)}" title="${t("copy")}" aria-label="${t("copy")}">${COPY_ICON}</button>` : ""}
        </div>
      </div>
      <div class="status-item">
        <span class="status-label">${baseUrlLabel}</span>
        <div class="status-value-wrapper">
          <span class="status-value" title="${esc(item.baseUrl || "--")}">${esc(item.baseUrl || "--")}</span>
          ${item.baseUrl ? `<button class="copy-btn" type="button" data-copy="${esc(item.baseUrl)}" title="${t("copy")}" aria-label="${t("copy")}">${COPY_ICON}</button>` : ""}
        </div>
      </div>
      <div class="status-item">
        <span class="status-label">${modelLabel}</span>
        <div class="status-value-wrapper">
          <span class="status-value" title="${esc(model)}">${esc(model)}</span>
          ${model !== "--" ? `<button class="copy-btn" type="button" data-copy="${esc(model)}" title="${t("copy")}" aria-label="${t("copy")}">${COPY_ICON}</button>` : ""}
        </div>
      </div>
    </div>`;

  bindDelegatedCopyButtons(grid, "ClaudeStatusCopy");
}

async function loadStatus() {
  try {
    const [status, editors] = await Promise.all([
      invoke("get_status"),
      invoke("get_detected_editors"),
    ]);
    detectedEditors = editors || {};
    lastClaudeStatus = status;
    renderClaudeStatus(status);
    renderNavigationStatus();
  } catch (error) {
    console.error("loadStatus failed:", error);
    showToast(t("loadStatusFailed", { error: String(error) }), "error");
  }
}

async function loadProfiles() {
  try {
    const data = await invoke("get_profiles");
    profiles = data.profiles || [];
    renderProfiles();
    if (lastClaudeStatus) renderClaudeStatus(lastClaudeStatus);
    renderNavigationStatus();
  } catch (error) {
    console.error(error);
    showToast(t("loadProfilesFailed", { error: String(error) }), "error");
  }
}

function renderProfiles() {
  const grid = $("profilesGrid");
  if (!grid) return;

  if (profiles.length === 0) {
    grid.innerHTML = `
      <div class="empty-state">
        <svg class="empty-state-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
          <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/>
          <polyline points="14 2 14 8 20 8"/>
          <line x1="12" y1="18" x2="12" y2="12"/>
          <line x1="9" y1="15" x2="15" y2="15"/>
        </svg>
        <div class="empty-state-title">${t("noConfigsTitle")}</div>
        <p>${t("noConfigsDesc")}</p>
      </div>`;
    updateActiveConfigBar();
    return;
  }

  grid.innerHTML = profiles.map((profile) => `
    <div class="profile-card ${profile.isActive ? "active" : ""}" data-id="${esc(profile.id)}" draggable="true">
      <div class="profile-header">
        ${profileDragHandleHtml()}
        <span class="profile-name">${esc(profile.name)}</span>
        ${profile.proxyTakeover ? `<span class="proxy-failover-badge" title="${esc(t("proxyTakeoverHint"))}">${t("proxyTakeoverBadge")}</span>` : ""}
        ${profile.proxyFailover ? `<span class="proxy-failover-badge" title="${esc(t("proxyFailoverHint"))}">${t("proxyFailoverBadge")}</span>` : ""}
        ${profile.isActive ? `<span class="active-badge">${t("inUse")}</span>` : ""}
      </div>
      <div class="profile-body">
        <div class="profile-field">
          <span class="field-label">Claude API Key</span>
          <span class="field-value">${esc(maskKey(profile.apiKey))}</span>
        </div>
        <div class="profile-field">
          <span class="field-label">Claude Base URL</span>
          <span class="field-value">${esc(truncUrl(profile.baseUrl, 50))}</span>
        </div>
        ${profile.apiFormat === "openai_chat" ? `<div class="profile-field">
          <span class="field-label">${currentLang === "zh" ? "API 格式" : "API Format"}</span>
          <span class="field-value">${currentLang === "zh" ? "OpenAI Chat（经本地代理）" : "OpenAI Chat (via local proxy)"}</span>
        </div>` : ""}
        ${profile.modelId ? `<div class="profile-field">
          <span class="field-label">${currentLang === "zh" ? "Claude 模型" : "Claude Model"}</span>
          <span class="field-value">${esc(profile.modelId)}</span>
        </div>` : ""}
        ${modelMappingBadgesHtml(profile)}
        ${profileBalanceRowHtml("claude", profile)}
      </div>
      <div class="profile-actions">
        ${profile.isActive ? "" : `<button class="btn btn-switch btn-sm" data-action="switch" data-id="${profile.id}" type="button">${t("switchUse")}</button>`}
        <button class="btn btn-secondary btn-sm" data-action="edit" data-id="${profile.id}" type="button">${t("edit")}</button>
        <button class="btn btn-danger btn-sm" data-action="delete" data-id="${profile.id}" type="button">${t("delete")}</button>
      </div>
    </div>
  `).join("");

  bindProfileGridActions(grid, "ClaudeProfiles", "claude");
  bindProfileGridDragSort(grid, "claude");
  autoRefreshProfileBalances("claude");
  updateActiveConfigBar();
  updateProxyHealthPanel();
}

// ── Claude Desktop 独立供应商与 Gateway ──────────────

function claudeDesktopModeLabel(mode) {
  const labels = {
    official: t("claudeDesktopModeOfficial"),
    gateway: t("claudeDesktopModeGateway"),
    direct: t("claudeDesktopModeDirect"),
  };
  return labels[mode] || mode || "--";
}

function renderClaudeDesktopStatus(status) {
  const grid = $("claudeDesktopStatusGrid");
  if (!grid) return;
  const installedText = status?.installed
    ? t("claudeDesktopInstalled")
    : t("claudeDesktopNotInstalled");
  const gatewayText = status?.mode === "gateway"
    ? (status?.gatewayRunning ? t("claudeDesktopGatewayRunning") : t("claudeDesktopGatewayStopped"))
    : t("claudeDesktopGatewayNotRequired");
  grid.innerHTML = `
    <div class="status-card">
      <div class="status-card-title"><span class="status-card-title-text">${productIcon("anthropic")}Claude Desktop</span></div>
      <div class="status-item"><span class="status-label">${t("claudeDesktopInstallStatus")}</span><span class="status-value">${esc(installedText)}</span></div>
      <div class="status-item"><span class="status-label">${t("claudeDesktopCurrentMode")}</span><span class="status-value">${esc(claudeDesktopModeLabel(status?.mode))}</span></div>
      <div class="status-item"><span class="status-label">${t("claudeDesktopActiveProvider")}</span><span class="status-value">${esc(status?.activeProfileName || "--")}</span></div>
      <div class="status-item"><span class="status-label">${t("claudeDesktopGatewayStatus")}</span><span class="status-value">${esc(gatewayText)}</span></div>
      <div class="status-item"><span class="status-label">${t("claudeDesktopProfilePath")}</span><span class="status-value" title="${esc(status?.profilePath || "--")}">${esc(truncUrl(status?.profilePath || "--", 58))}</span></div>
    </div>`;

  const warning = $("claudeDesktopDependencyWarning");
  if (warning) warning.hidden = !status?.warning && status?.mode !== "gateway";
  setText(
    "claudeDesktopDependencyWarningText",
    status?.warning || t("claudeDesktopGatewayDependencyWarning")
  );
  const healthSection = $("claudeDesktopGatewayHealthSection");
  if (healthSection) healthSection.hidden = status?.mode !== "gateway";
  const navState = $("claudeDesktopNavState");
  if (navState) {
    navState.className = `nav-state-dot ${status?.supported && status?.installed ? "healthy" : "warning"}`;
  }
  updateClaudeDesktopHealthRefresh();
}

function renderClaudeDesktopGatewayHealth(data) {
  const grid = $("claudeDesktopGatewayHealthGrid");
  if (!grid) return;
  const health = Array.isArray(data?.health) ? data.health : [];
  grid.innerHTML = `
    <div class="status-card">
      <div class="status-card-title"><span class="status-card-title-text">${t("claudeDesktopGatewayHealthTitle")}</span></div>
      <div class="status-item"><span class="status-label">${t("claudeDesktopGatewayStatus")}</span><span class="status-value">${data?.running ? t("claudeDesktopGatewayRunning") : t("claudeDesktopGatewayStopped")}</span></div>
      <div class="status-item"><span class="status-label">${t("claudeDesktopFailoverCount")}</span><span class="status-value">${Number(data?.failoverCount || 0)}</span></div>
      <div class="proxy-upstream-list">${health.length ? health.map(proxyUpstreamRowHtml).join("") : `<span class="status-value">--</span>`}</div>
    </div>`;
}

function renderClaudeDesktopProfiles() {
  const grid = $("claudeDesktopProfilesList");
  if (!grid) return;
  if (!claudeDesktopProfiles.length) {
    grid.innerHTML = `<div class="empty-state"><div class="empty-state-title">${t("claudeDesktopNoProfiles")}</div><p>${t("claudeDesktopNoProfilesHint")}</p></div>`;
    return;
  }
  const ordered = [
    ...claudeDesktopProfiles.filter((profile) => profile.connectionMode === "official"),
    ...claudeDesktopProfiles.filter((profile) => profile.connectionMode !== "official"),
  ];
  grid.innerHTML = ordered.map((profile) => {
    const official = profile.connectionMode === "official";
    const mode = claudeDesktopModeLabel(profile.connectionMode);
    return `
      <div class="profile-card ${profile.isActive ? "active" : ""} ${official ? "claude-desktop-official-card" : ""}" data-id="${esc(profile.id)}" draggable="${official ? "false" : "true"}">
        <div class="profile-header">
          ${official ? productIcon("anthropic") : profileDragHandleHtml()}
          <span class="profile-name">${esc(profile.name)}</span>
          <span class="claude-desktop-mode-badge mode-${esc(profile.connectionMode)}">${esc(mode)}</span>
          ${profile.proxyFailover ? `<span class="proxy-failover-badge">${t("claudeDesktopFailoverBadge")}</span>` : ""}
          ${profile.isActive ? `<span class="active-badge">${t("inUse")}</span>` : ""}
        </div>
        <div class="profile-body">
          ${official ? `<div class="profile-field"><span class="field-label">${t("claudeDesktopOfficialLogin")}</span><span class="field-value">${t("claudeDesktopOfficialLoginHint")}</span></div>` : `
            <div class="profile-field"><span class="field-label">API Key</span><span class="field-value">${esc(maskKey(profile.apiKey))}</span></div>
            <div class="profile-field"><span class="field-label">Base URL</span><span class="field-value">${esc(truncUrl(profile.baseUrl, 50))}</span></div>
            <div class="profile-field"><span class="field-label">${t("claudeDesktopApiFormat")}</span><span class="field-value">${profile.apiFormat === "openai_chat" ? "OpenAI Chat Completions" : "Anthropic Messages"}</span></div>
            ${profile.modelId ? `<div class="profile-field"><span class="field-label">${t("claudeDesktopDefaultModel")}</span><span class="field-value">${esc(profile.modelId)}</span></div>` : ""}
            ${modelMappingBadgesHtml(profile)}
          `}
        </div>
        <div class="profile-actions">
          ${profile.isActive ? "" : `<button class="btn btn-switch btn-sm" data-action="switch" data-id="${esc(profile.id)}" type="button">${t("switchUse")}</button>`}
          ${official ? "" : `<button class="btn btn-secondary btn-sm" data-action="edit" data-id="${esc(profile.id)}" type="button">${t("edit")}</button><button class="btn btn-danger btn-sm" data-action="delete" data-id="${esc(profile.id)}" type="button">${t("delete")}</button>`}
        </div>
      </div>`;
  }).join("");

  bindDelegatedActions(grid, "ClaudeDesktopProfiles", (action, target) => {
    const id = target.getAttribute("data-id");
    if (action === "switch") switchClaudeDesktopProfile(id);
    else if (action === "edit") openClaudeDesktopProfileDialog(id);
    else if (action === "delete") deleteClaudeDesktopProfile(id);
  });
  bindProfileGridDragSort(grid, "claude-desktop");
}

async function loadClaudeDesktopGatewayHealth() {
  try {
    claudeDesktopGatewayHealth = await invoke("get_claude_desktop_gateway_health");
    renderClaudeDesktopGatewayHealth(claudeDesktopGatewayHealth);
  } catch (error) {
    console.error("get_claude_desktop_gateway_health failed:", sanitizeForLog(error));
  }
}

async function loadClaudeDesktopPage() {
  try {
    const [profilesData, status] = await Promise.all([
      invoke("get_claude_desktop_profiles"),
      invoke("get_claude_desktop_provider_status"),
    ]);
    claudeDesktopProfiles = Array.isArray(profilesData?.profiles) ? profilesData.profiles : [];
    claudeDesktopStatus = status || null;
    renderClaudeDesktopProfiles();
    renderClaudeDesktopStatus(claudeDesktopStatus);
    if (status?.mode === "gateway") await loadClaudeDesktopGatewayHealth();
  } catch (error) {
    showToast(t("claudeDesktopLoadFailed", { error: String(error) }), "error");
  }
}

function stopClaudeDesktopHealthRefresh() {
  if (claudeDesktopHealthTimer) clearInterval(claudeDesktopHealthTimer);
  claudeDesktopHealthTimer = null;
}

function updateClaudeDesktopHealthRefresh() {
  stopClaudeDesktopHealthRefresh();
  if (activeConsolePage !== "claude-desktop" || claudeDesktopStatus?.mode !== "gateway") return;
  claudeDesktopHealthTimer = setInterval(() => {
    if (activeConsolePage !== "claude-desktop") return stopClaudeDesktopHealthRefresh();
    loadClaudeDesktopGatewayHealth();
  }, 5000);
}

function closeClaudeDesktopProfileDialog() {
  editingClaudeDesktopProfileId = null;
  $("claudeDesktopProfileOverlay")?.classList.remove("open");
  document.body.classList.remove("modal-open");
}

function openClaudeDesktopProfileDialog(id = null) {
  const profile = id ? claudeDesktopProfiles.find((item) => item.id === id) : null;
  if (profile?.connectionMode === "official") return;
  editingClaudeDesktopProfileId = profile?.id || null;
  setText("claudeDesktopProfileTitle", profile ? t("claudeDesktopEditProfile") : t("claudeDesktopAddProfile"));
  $("claudeDesktopProfileId").value = profile?.id || "";
  $("claudeDesktopProfileName").value = profile?.name || "";
  $("claudeDesktopProfileConnectionMode").value = profile?.connectionMode || "gateway";
  $("claudeDesktopProfileApiFormat").value = profile?.apiFormat || "anthropic";
  $("claudeDesktopProfileBaseUrl").value = profile?.baseUrl || "";
  $("claudeDesktopProfileApiKey").value = profile?.apiKey || "";
  $("claudeDesktopProfileApiKey").type = "password";
  $("claudeDesktopProfileModelId").value = profile?.modelId || "";
  $("claudeDesktopProfileSonnetModel").value = profile?.sonnetModel || "";
  $("claudeDesktopProfileOpusModel").value = profile?.opusModel || "";
  $("claudeDesktopProfileHaikuModel").value = profile?.haikuModel || "";
  claudeDesktopModelMappings = Array.isArray(profile?.modelMappings)
    ? profile.modelMappings.map((item) => ({
      sourceModel: String(item?.sourceModel || ""),
      targetModel: String(item?.targetModel || ""),
    }))
    : [];
  renderClaudeDesktopModelMappings();
  const advanced = $("claudeDesktopProfileAdvancedSection");
  if (advanced) advanced.open = Boolean(profile?.proxyFailover || claudeDesktopModelMappings.length);
  claudeDesktopModelCatalog = Array.isArray(profile?.availableModels) ? [...profile.availableModels] : [];
  renderClaudeDesktopModelOptions(claudeDesktopModelCatalog);
  $("claudeDesktopProfileProxyFailover").checked = Boolean(profile?.proxyFailover);
  if ($("claudeDesktopProfileSaveAndActivate")) $("claudeDesktopProfileSaveAndActivate").checked = false;
  clearProviderInlineStatus("claude-desktop");
  updateProviderNameValidation("claude-desktop");
  updateClaudeDesktopProfileFormState();
  $("claudeDesktopProfileOverlay")?.classList.add("open");
  document.body.classList.add("modal-open");
  setTimeout(() => $("claudeDesktopProfileName")?.focus(), 30);
  if (profile?.apiKey && profile?.baseUrl) {
    setTimeout(() => fetchClaudeDesktopModels({ silent: true }), 60);
  }
}

function renderClaudeDesktopModelMappings() {
  const container = $("claudeDesktopModelMappings");
  if (!container) return;
  container.innerHTML = claudeDesktopModelMappings.map((mapping, index) => `
    <div class="claude-desktop-model-mapping-row" data-index="${index}">
      <input type="text" class="claude-desktop-model-source" list="claudeDesktopModelOptions" autocomplete="off" spellcheck="false" placeholder="claude-opus-4-6" value="${esc(mapping.sourceModel)}">
      <input type="text" class="claude-desktop-model-target" list="claudeDesktopModelOptions" autocomplete="off" spellcheck="false" placeholder="上游模型 ID" value="${esc(mapping.targetModel)}">
      <button type="button" class="link-button claude-desktop-model-mapping-remove" data-index="${index}">${esc(t("claudeDesktopRemoveMapping"))}</button>
    </div>
  `).join("");
  container.querySelectorAll(".claude-desktop-model-source, .claude-desktop-model-target").forEach((input) => {
    input.addEventListener("input", () => {
      const row = input.closest("[data-index]");
      const index = Number(row?.dataset.index);
      if (!Number.isInteger(index) || !claudeDesktopModelMappings[index]) return;
      if (input.classList.contains("claude-desktop-model-source")) claudeDesktopModelMappings[index].sourceModel = input.value;
      else claudeDesktopModelMappings[index].targetModel = input.value;
    });
  });
  container.querySelectorAll(".claude-desktop-model-mapping-remove").forEach((button) => {
    button.addEventListener("click", () => {
      claudeDesktopModelMappings.splice(Number(button.dataset.index), 1);
      renderClaudeDesktopModelMappings();
    });
  });
}

function addClaudeDesktopModelMapping() {
  claudeDesktopModelMappings.push({ sourceModel: "", targetModel: "" });
  renderClaudeDesktopModelMappings();
  const rows = document.querySelectorAll("#claudeDesktopModelMappings .claude-desktop-model-source");
  rows[rows.length - 1]?.focus();
}

function renderClaudeDesktopModelOptions(models) {
  const datalist = $("claudeDesktopModelOptions");
  if (!datalist) return;
  const unique = [...new Set((models || []).map((model) => String(model || "").trim()).filter(Boolean))];
  datalist.innerHTML = unique.map((model) => '<option value="' + esc(model) + '"></option>').join("");
}

async function fetchClaudeDesktopModels({ silent = false, triggerButtonId = "claudeDesktopProfileModelFetchBtn" } = {}) {
  const button = $(triggerButtonId) || $("claudeDesktopProfileModelFetchBtn");
  const result = $("claudeDesktopProfileModelFetchResults");
  const baseUrl = $("claudeDesktopProfileBaseUrl")?.value.trim() || "";
  const apiKey = $("claudeDesktopProfileApiKey")?.value.trim() || "";
  if (!apiKey) {
    if (!silent) showToast(t("modelFetchMissing"), "warning");
    return;
  }
  const previousText = button?.textContent || t("claudeDesktopFetchModels");
  if (button) {
    button.disabled = true;
    button.textContent = t("claudeDesktopFetchingModels");
  }
  const startedAt = performance.now();
  try {
    const protocol = $("claudeDesktopProfileApiFormat")?.value === "openai_chat" ? "codex" : "claude";
    const models = await invoke("fetch_available_models", {
      baseUrl,
      apiKey,
      timeoutSecs: 12,
      protocol,
    });
    const normalized = helpers.normalizeFetchedModels
      ? helpers.normalizeFetchedModels(models || [])
      : (models || []).map((item) => item.id || item).filter(Boolean);
    const safe = helpers.normalizeClaudeDesktopModels
      ? helpers.normalizeClaudeDesktopModels(normalized)
      : normalized;
    claudeDesktopModelCatalog = safe;
    renderProviderInlineStatus("claude-desktop", { tone: "success", latencyMs: Math.round(performance.now() - startedAt) });
    renderClaudeDesktopModelOptions(safe);
    if (result) {
      result.innerHTML = '<div class="endpoint-row"><span class="endpoint-url">' + esc(t("claudeDesktopModelsFetched", { count: safe.length })) + '</span><span class="endpoint-meta ' + (safe.length ? "fast" : "failed") + '"></span></div>';
      result.classList.add("open");
    }
    if (!silent || safe.length) showToast(t("claudeDesktopModelsFetched", { count: safe.length }), safe.length ? "success" : "warning");
  } catch (error) {
    const message = describeVerifyError(String(error));
    renderProviderInlineStatus("claude-desktop", { tone: "error", statusCode: providerStatusCode(error), summary: message });
    if (result) {
      result.innerHTML = '<div class="endpoint-row"><span class="endpoint-url">' + esc(t("claudeDesktopModelsFetchFailed", { error: message })) + '</span></div>';
      result.classList.add("open");
    }
    if (!silent) showToast(t("claudeDesktopModelsFetchFailed", { error: message }), "error");
  } finally {
    if (button) {
      button.disabled = false;
      button.textContent = previousText;
    }
  }
}

function updateClaudeDesktopProfileFormState() {
  const direct = $("claudeDesktopProfileConnectionMode")?.value === "direct";
  const apiFormat = $("claudeDesktopProfileApiFormat");
  if (apiFormat) {
    if (direct) apiFormat.value = "anthropic";
    apiFormat.disabled = direct;
  }
  const failover = $("claudeDesktopProfileFailoverGroup");
  if (failover) failover.hidden = direct;
  setText(
    "claudeDesktopProfileConnectionModeHint",
    direct ? t("claudeDesktopDirectHint") : t("claudeDesktopGatewayHint")
  );
}

async function submitClaudeDesktopProfile(event) {
  event.preventDefault();
  if (claudeDesktopSaving) return;
  const directMode = $("claudeDesktopProfileConnectionMode").value === "direct";
  const input = {
    name: $("claudeDesktopProfileName").value.trim(),
    apiKey: $("claudeDesktopProfileApiKey").value.trim(),
    baseUrl: $("claudeDesktopProfileBaseUrl").value.trim(),
    connectionMode: $("claudeDesktopProfileConnectionMode").value,
    apiFormat: $("claudeDesktopProfileApiFormat").value,
    modelId: $("claudeDesktopProfileModelId").value.trim(),
    // Legacy role fields are relevant only to Direct mode; Gateway uses exact modelMappings.
    sonnetModel: directMode ? $("claudeDesktopProfileSonnetModel").value.trim() : "",
    opusModel: directMode ? $("claudeDesktopProfileOpusModel").value.trim() : "",
    haikuModel: directMode ? $("claudeDesktopProfileHaikuModel").value.trim() : "",
    modelMappings: claudeDesktopModelMappings
      .map((item) => ({ sourceModel: item.sourceModel.trim(), targetModel: item.targetModel.trim() }))
      .filter((item) => item.sourceModel && item.targetModel),
    availableModels: claudeDesktopModelCatalog,
    proxyFailover: Boolean($("claudeDesktopProfileProxyFailover").checked),
  };
  if (!updateProviderNameValidation("claude-desktop")) return;
  const saveAndActivate = Boolean($("claudeDesktopProfileSaveAndActivate")?.checked);
  if (![input.modelId, input.sonnetModel, input.opusModel, input.haikuModel, ...input.modelMappings.map((item) => item.targetModel)].some(Boolean)) {
    showToast(t("claudeDesktopModelRequired"), "warning");
    return;
  }
  claudeDesktopSaving = true;
  const submit = $("claudeDesktopProfileSubmit");
  setButtonBusy(submit, true, t("toastSaving"));
  try {
    if (editingClaudeDesktopProfileId) {
      await invoke("update_claude_desktop_profile", { id: editingClaudeDesktopProfileId, input });
      showToast(t("claudeDesktopUpdated"), "success");
    } else {
      await invoke("add_claude_desktop_profile", { input });
      showToast(t("claudeDesktopAdded"), "success");
    }
    closeClaudeDesktopProfileDialog();
    await loadClaudeDesktopPage();
    if (saveAndActivate) {
      const saved = claudeDesktopProfiles.find((item) => item.name === input.name);
      if (saved?.id) await switchClaudeDesktopProfile(saved.id);
    }
  } catch (error) {
    showToast(String(error), "error");
  } finally {
    claudeDesktopSaving = false;
    setButtonBusy(submit, false);
  }
}

async function switchClaudeDesktopProfile(id) {
  const profile = claudeDesktopProfiles.find((item) => item.id === id);
  if (!profile) return;
  try {
    const result = await invoke("switch_claude_desktop_profile", { id });
    showToast(result?.message || t("claudeDesktopRestartRequired"), "success");
    await loadClaudeDesktopPage();
  } catch (error) {
    showToast(String(error), "error");
  }
}

async function deleteClaudeDesktopProfile(id) {
  const profile = claudeDesktopProfiles.find((item) => item.id === id);
  if (!profile || profile.connectionMode === "official" || profile.isActive) return;
  const confirmed = await appConfirm(t("claudeDesktopDeleteConfirm", { name: profile.name }), {
    title: currentLang === "zh" ? "删除 Desktop 配置" : "Delete Desktop Profile",
    danger: true,
    confirmText: currentLang === "zh" ? "删除" : "Delete",
  });
  if (!confirmed) return;
  try {
    await invoke("delete_claude_desktop_profile", { id });
    showToast(t("claudeDesktopDeleted"), "success");
    await loadClaudeDesktopPage();
  } catch (error) {
    showToast(String(error), "error");
  }
}

async function importClaudeProfilesToDesktop() {
  const confirmed = await appConfirm(t("claudeDesktopImportConfirm"), {
    title: currentLang === "zh" ? "导入 Desktop 配置" : "Import Desktop Profiles",
    confirmText: currentLang === "zh" ? "复制导入" : "Import",
  });
  if (!confirmed) return;
  const before = claudeDesktopProfiles.filter((profile) => profile.connectionMode !== "official").length;
  try {
    const data = await invoke("import_claude_profiles_to_desktop");
    claudeDesktopProfiles = Array.isArray(data?.profiles) ? data.profiles : [];
    const after = claudeDesktopProfiles.filter((profile) => profile.connectionMode !== "official").length;
    showToast(t("claudeDesktopImported", { count: Math.max(0, after - before) }), "success");
    await loadClaudeDesktopPage();
  } catch (error) {
    showToast(String(error), "error");
  }
}

async function syncClaudeDesktopProfile() {
  try {
    const result = await invoke("sync_claude_desktop_profile");
    showToast(result?.message || t("claudeDesktopRestartRequired"), "success");
    await loadClaudeDesktopPage();
  } catch (error) {
    showToast(String(error), "error");
  }
}

async function resetClaudeDesktopGatewayBreaker() {
  try {
    await invoke("claude_desktop_gateway_reset_breaker");
    await loadClaudeDesktopGatewayHealth();
    showToast(t("claudeDesktopBreakerReset"), "success");
  } catch (error) {
    showToast(String(error), "error");
  }
}

// Claude 配置模型映射徽标；Desktop 显示逐项映射，Claude Code 保留环境变量徽标。
function modelMappingBadgesHtml(profile) {
  if (Array.isArray(profile.modelMappings)) {
    const mappings = profile.modelMappings.filter((item) => item?.sourceModel && item?.targetModel);
    if (!mappings.length) return "";
    return `<div class="model-map-badges">${mappings.map((item) =>
      `<span class="model-map-badge" title="${esc(`${item.sourceModel} → ${item.targetModel}`)}"><b>↔</b>${esc(item.sourceModel)} → ${esc(item.targetModel)}</span>`,
    ).join("")}</div>`;
  }
  const entries = [
    ["S", "ANTHROPIC_DEFAULT_SONNET_MODEL", profile.sonnetModel],
    ["O", "ANTHROPIC_DEFAULT_OPUS_MODEL", profile.opusModel],
    ["H", "ANTHROPIC_DEFAULT_HAIKU_MODEL", profile.haikuModel],
  ].filter(([, , value]) => value);
  if (entries.length === 0) return "";
  const shorten = (value) => (value.length > 20 ? `${value.slice(0, 19)}…` : value);
  return `<div class="model-map-badges">${entries.map(([letter, envName, value]) =>
    `<span class="model-map-badge" title="${esc(`${envName}=${value}`)}"><b>${letter}</b>${esc(shorten(value))}</span>`,
  ).join("")}</div>`;
}

function updateActiveConfigBar() {
  updateClaudeStatusTitle();
}

// ── Claude 本地代理健康面板 ──────────────────────────
// 仅当激活配置走 openai_chat（经本地代理）时显示；Claude 页可见且面板显示期间
// 每 5 秒轮询一次，页面切走或面板隐藏即停（对齐 toolboxRefreshTimer 的定时器管理模式）
let proxyHealthTimer = null;
let proxyHealthBusy = false;

// 激活配置的请求经代理时才有健康数据：openai_chat 必经代理，
// anthropic 则取决于是否勾选了接管
function shouldShowProxyHealthPanel() {
  return profiles.some((p) => p.isActive && (p.apiFormat === "openai_chat" || p.proxyTakeover));
}

function updateProxyHealthPanel() {
  const section = $("claudeProxyHealthSection");
  if (!section) return;
  const show = shouldShowProxyHealthPanel();
  section.hidden = !show;
  if (show && activeConsolePage === "claude") {
    startProxyHealthRefresh();
  } else {
    stopProxyHealthRefresh();
  }
}

function startProxyHealthRefresh() {
  stopProxyHealthRefresh();
  refreshProxyHealth();
  proxyHealthTimer = setInterval(() => {
    // 页面切走或面板已隐藏时自停，避免常驻定时器泄漏
    if (activeConsolePage !== "claude" || $("claudeProxyHealthSection")?.hidden) {
      stopProxyHealthRefresh();
      return;
    }
    refreshProxyHealth();
  }, 5000);
}

function stopProxyHealthRefresh() {
  if (proxyHealthTimer) {
    clearInterval(proxyHealthTimer);
    proxyHealthTimer = null;
  }
  proxyHealthBusy = false;
}

async function refreshProxyHealth() {
  if (proxyHealthBusy) return;
  proxyHealthBusy = true;
  try {
    const data = await invoke("claude_proxy_health");
    renderProxyHealth(data);
  } catch (error) {
    console.error("claude_proxy_health failed:", error);
  } finally {
    proxyHealthBusy = false;
  }
}

function proxyBreakerBadgeHtml(state) {
  const map = {
    closed: ["proxyBreakerClosed", "breaker-closed"],
    open: ["proxyBreakerOpen", "breaker-open"],
    half_open: ["proxyBreakerHalfOpen", "breaker-half-open"],
  };
  const [key, cls] = map[state] || map.closed;
  return `<span class="breaker-badge ${cls}">${t(key)}</span>`;
}

// 单个上游行：角色 + 脱敏地址 + 模型 + 熔断徽标；统计与错误详情放 title
function proxyUpstreamRowHtml(entry) {
  const roleKey = entry.role === "primary" ? "proxyHealthPrimaryLabel" : "proxyHealthFailoverLabel";
  const statsTitle = `${t("proxyHealthStatsTitle")}: ${entry.totalFailures || 0}/${entry.totalRequests || 0}${entry.lastError ? `\n${entry.lastError}` : ""}`;
  return `
    <div class="proxy-upstream-row" title="${esc(statsTitle)}">
      <span class="proxy-upstream-role ${entry.role === "primary" ? "is-primary" : ""}">${t(roleKey)}</span>
      <span class="proxy-upstream-url">${esc(truncUrl(entry.baseUrl || "--", 42))}</span>
      ${entry.model ? `<span class="proxy-upstream-model">${esc(entry.model)}</span>` : ""}
      ${proxyBreakerBadgeHtml(entry.state)}
    </div>`;
}

function renderProxyHealth(data) {
  const grid = $("proxyHealthGrid");
  if (!grid || !data) return;
  const health = Array.isArray(data.health) ? data.health : [];
  const primaryRows = health.filter((h) => h.role === "primary");
  const failoverRows = health.filter((h) => h.role !== "primary");
  // 全部上游中时间戳最新的一条错误作为面板级「最近错误」
  const lastErrorEntry = health
    .filter((h) => h.lastError)
    .sort((a, b) => (b.lastErrorTs || 0) - (a.lastErrorTs || 0))[0];
  const lastErrorFull = lastErrorEntry ? String(lastErrorEntry.lastError) : "";
  const lastErrorShort = lastErrorFull.length > 120 ? `${lastErrorFull.slice(0, 119)}…` : lastErrorFull;
  grid.innerHTML = `
    <div class="status-card proxy-health-card">
      <div class="status-item">
        <span class="status-label">${t("proxyHealthStatusLabel")}</span>
        <div class="status-value-wrapper">
          <span class="status-value"><span class="proxy-run-dot ${data.running ? "is-running" : "is-stopped"}"></span>${data.running ? t("proxyHealthRunning", { port: data.port }) : t("proxyHealthStopped")}</span>
        </div>
      </div>
      <div class="proxy-upstream-list">
        ${primaryRows.map(proxyUpstreamRowHtml).join("")}
        ${failoverRows.length ? failoverRows.map(proxyUpstreamRowHtml).join("") : `<div class="proxy-pool-empty">${t("proxyHealthPoolEmpty")}</div>`}
      </div>
      <div class="status-item">
        <span class="status-label">${t("proxyHealthFailoverCountLabel")}</span>
        <div class="status-value-wrapper"><span class="status-value">${Number(data.failoverCount) || 0}</span></div>
      </div>
      <div class="status-item">
        <span class="status-label">${t("proxyHealthLastErrorLabel")}</span>
        <div class="status-value-wrapper">
          <span class="status-value proxy-last-error" title="${esc(lastErrorFull)}">${lastErrorEntry ? esc(lastErrorShort) : t("proxyHealthNoError")}</span>
        </div>
      </div>
    </div>`;
}

async function handleProxyHealthReset() {
  const button = $("proxyHealthResetBtn");
  try {
    if (button) button.disabled = true;
    await invoke("claude_proxy_reset_breaker");
    // 绕过 refreshProxyHealth 的 busy 防重入，重置后立即拉一次最新状态
    renderProxyHealth(await invoke("claude_proxy_health"));
    showToast(t("proxyHealthResetDone"), "success");
  } catch (error) {
    showToast(String(error), "error");
  } finally {
    if (button) button.disabled = false;
  }
}

function handleSyncNow() {
  const activeProfile = profiles.find((p) => p.isActive);
  if (activeProfile) {
    handleSwitch(activeProfile.id);
  } else {
    // A9: 无活动配置时给用户明确提示，而非静默无反应
    showToast(currentLang === "zh" ? "没有活动配置，请先切换到一个配置" : "No active config. Please switch to one first.", "warning");
  }
}

// 剪贴板自动检测填写 URL / Key
async function tryClipboardAutoFill(field, targetId) {
  try {
    const target = $(targetId);
    if (!target || target.value.trim()) return;

    const text = (await navigator.clipboard.readText() || "").trim();
    if (!text) return;
    if (field === "url") {
      if (/^https?:\/\//i.test(text)) target.value = text;
    } else if (field === "key") {
      if (!/^https?:\/\//i.test(text) && text.length >= 8) target.value = text;
    }
  } catch (_) { /* 剪贴板不可用时静默忽略 */ }
}

function productFieldMap(kind) {
  if (kind === "codex") {
    return {
      baseUrl: "codexBaseUrl",
      apiKey: "codexApiKey",
      model: "codexModel",
      endpointResults: "codexEndpointResults",
      modelResults: "codexModelResults",
      modelFetchBtn: "codexModelFetchBtn",
      endpointTestBtn: "codexEndpointTestBtn",
    };
  }
  if (kind === "grok") {
    return {
      baseUrl: "grokBaseUrl",
      apiKey: "grokApiKey",
      model: "grokModel",
      endpointResults: "grokEndpointResults",
      modelResults: "grokModelResults",
      modelFetchBtn: "grokModelFetchBtn",
      endpointTestBtn: "grokEndpointTestBtn",
    };
  }
  if (kind === "gemini") {
    return {
      baseUrl: "geminiBaseUrl",
      apiKey: "geminiApiKey",
      model: "geminiModel",
      endpointResults: "geminiEndpointResults",
      modelResults: "geminiModelResults",
      modelFetchBtn: "geminiModelFetchBtn",
      endpointTestBtn: "geminiEndpointTestBtn",
    };
  }
  if (kind === "opencode") {
    return {
      baseUrl: "opencodeBaseUrl",
      apiKey: "opencodeApiKey",
      model: "opencodeModel",
      endpointResults: "opencodeEndpointResults",
      modelResults: "opencodeModelResults",
      modelFetchBtn: "opencodeModelFetchBtn",
      endpointTestBtn: "opencodeEndpointTestBtn",
    };
  }
  return {
    baseUrl: "profileBaseUrl",
    apiKey: "profileApiKey",
    model: "profileModelId",
    endpointResults: "profileEndpointResults",
    modelResults: "profileModelResults",
    modelFetchBtn: "profileModelFetchBtn",
    endpointTestBtn: "profileEndpointTestBtn",
  };
}

function clearEndpointResults(kind) {
  const resultsId = productFieldMap(kind).endpointResults;
  const container = $(resultsId);
  if (!container) return;
  container.innerHTML = "";
  container.classList.remove("open");
}

const PROVIDER_DIALOG_CONFIG = {
  claude: { nameInput: "profileName", nameError: "profileNameError", apiKey: "profileApiKey", submitButtons: ["submitBtn"], status: "claude" },
  codex: { nameInput: "codexProfileName", nameError: "codexProfileNameError", apiKey: "codexApiKey", submitButtons: ["codexSubmitBtn", "codexSaveEnableBtn"], status: "codex" },
  grok: { nameInput: "grokProfileName", nameError: "grokProfileNameError", apiKey: "grokApiKey", submitButtons: ["grokSubmitBtn"], status: "grok" },
  gemini: { nameInput: "geminiProfileName", nameError: "geminiProfileNameError", apiKey: "geminiApiKey", submitButtons: ["geminiSubmitBtn"], status: "gemini" },
  "claude-desktop": { nameInput: "claudeDesktopProfileName", nameError: "claudeDesktopProfileNameError", apiKey: "claudeDesktopProfileApiKey", submitButtons: ["claudeDesktopProfileSubmit"], status: "claude-desktop" },
  opencode: { nameInput: "opencodeProfileName", nameError: "opencodeProfileNameError", apiKey: "opencodeApiKey", submitButtons: ["opencodeSubmitBtn"], status: "opencode" },
};

function providerProfiles(kind) {
  return kind === "claude" ? profiles
    : kind === "codex" ? codexProfiles
      : kind === "grok" ? grokProfiles
        : kind === "gemini" ? geminiProfiles
          : kind === "claude-desktop" ? claudeDesktopProfiles
            : opencodeProfiles;
}

function providerEditingId(kind) {
  return kind === "claude" ? editingId
    : kind === "codex" ? editingCodexId
      : kind === "grok" ? editingGrokId
        : kind === "gemini" ? editingGeminiId
          : kind === "claude-desktop" ? editingClaudeDesktopProfileId
            : editingOpenCodeId;
}

function validateProviderName(kind, name, currentId = providerEditingId(kind)) {
  const normalized = String(name || "").trim().toLowerCase();
  if (!normalized) return { valid: false, message: currentLang === "zh" ? "请填写配置名称" : "Config name is required" };
  const duplicate = providerProfiles(kind).some((profile) =>
    String(profile?.id) !== String(currentId || "")
    && String(profile?.name || "").trim().toLowerCase() === normalized
  );
  return duplicate
    ? { valid: false, message: currentLang === "zh" ? "配置名称已存在" : "Config name already exists" }
    : { valid: true, message: "" };
}

function updateProviderNameValidation(kind) {
  const config = PROVIDER_DIALOG_CONFIG[kind];
  if (!config) return true;
  const input = $(config.nameInput);
  const error = $(config.nameError);
  if (!input) return true;
  const result = validateProviderName(kind, input.value);
  if (error) {
    error.textContent = result.message;
    error.hidden = result.valid;
  }
  input.setAttribute("aria-invalid", String(!result.valid));
  config.submitButtons.forEach((id) => {
    const button = $(id);
    if (button) button.disabled = !result.valid;
  });
  return result.valid;
}

function bindProviderNameValidation() {
  Object.entries(PROVIDER_DIALOG_CONFIG).forEach(([kind, config]) => {
    const input = $(config.nameInput);
    if (!input || input.dataset.nameValidationBound) return;
    input.dataset.nameValidationBound = "true";
    ["input", "blur"].forEach((eventName) => input.addEventListener(eventName, () => updateProviderNameValidation(kind)));
    updateProviderNameValidation(kind);
  });
}

function clearProviderInlineStatus(kind) {
  const status = document.querySelector(`[data-inline-status="${kind}"]`);
  if (!status) return;
  status.hidden = true;
  status.textContent = "";
  status.className = "provider-inline-status";
}

function renderProviderInlineStatus(kind, state) {
  const status = document.querySelector(`[data-inline-status="${kind}"]`);
  if (!status) return;
  const success = state?.tone === "success";
  const code = state?.statusCode ? `${state.statusCode} ` : "";
  const summary = success
    ? `✓ ${currentLang === "zh" ? "延迟" : "Latency"} ${state.latencyMs}ms`
    : `✕ ${code}${state?.statusCode === "401"
      ? (currentLang === "zh" ? "未授权" : "Unauthorized")
      : (state?.summary || (currentLang === "zh" ? "连接失败" : "Connection failed"))}`;
  status.hidden = false;
  status.className = `provider-inline-status ${success ? "is-success" : "is-error"}`;
  status.textContent = summary;
}

function providerStatusCode(raw) {
  const match = String(raw || "").match(/HTTP\s+(\d{3})/i);
  return match ? match[1] : "";
}

function highlightPresetOverwrite(fieldIds) {
  fieldIds.filter(Boolean).forEach((id) => {
    const field = $(id);
    if (!field) return;
    field.classList.remove("preset-overwritten");
    void field.offsetWidth;
    field.classList.add("preset-overwritten");
    setTimeout(() => field.classList.remove("preset-overwritten"), 1300);
  });
}

// 六个供应商弹窗的「显示 / 粘贴」按钮组结构完全相同，之前在 index.html 里各写一遍，
// 两个内联 SVG 因此重复了 12 次（其中一份的粘贴图标路径还抄错了）。
// 现在由 <span data-api-key-actions="目标输入框 id"> 占位，这里统一生成。
const API_KEY_ICONS = {
  toggle: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M2.5 12s3.2-6 9.5-6 9.5 6 9.5 6-3.2 6-9.5 6-9.5-6-9.5-6Z"/><circle cx="12" cy="12" r="2.5"/></svg>',
  paste: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 5h6M9 3h6a1 1 0 0 1 1 1v2H8V4a1 1 0 0 1 1-1ZM7 5H5a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-2M16 9h3a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2h-3M16 9v12"/></svg>',
};

// 「拉取模型 / 测试连接 + 内联状态」在六个弹窗里结构完全相同，只有 id 前缀和
// data-inline-status 的取值不同，同样由占位符生成，顺带让按钮文案跟随语言。
function renderBaseUrlActions() {
  document.querySelectorAll("[data-base-url-actions]").forEach((host) => {
    const status = host.getAttribute("data-base-url-actions");
    const prefix = host.getAttribute("data-id-prefix");
    if (!status || !prefix) return;
    // 复用字典里已有的键，applyLanguage 不再逐个 setText 这两个按钮
    const fetchLabel = t("modelFetch");
    const testLabel = t("endpointTest");
    if (host.childElementCount) {
      setText(`${prefix}ModelFetchBtn`, fetchLabel);
      setText(`${prefix}EndpointTestBtn`, testLabel);
      return;
    }
    host.innerHTML =
      `<button class="link-button" id="${esc(prefix)}ModelFetchBtn" type="button">${esc(fetchLabel)}</button>`
      + `<button class="link-button primary-action" id="${esc(prefix)}EndpointTestBtn" type="button">${esc(testLabel)}</button>`
      + `<span class="provider-inline-status" data-inline-status="${esc(status)}" role="status" aria-live="polite" hidden></span>`;
  });
}

function renderApiKeyActions() {
  document.querySelectorAll("[data-api-key-actions]").forEach((host) => {
    const target = host.getAttribute("data-api-key-actions");
    if (!target) return;
    const labels = { toggle: t("showApiKey"), paste: t("pasteApiKey") };
    // 已渲染过就只刷新文案，避免重复绑定
    if (host.childElementCount) {
      host.querySelectorAll("[data-api-key-action]").forEach((button) => {
        const action = button.dataset.apiKeyAction;
        const label = action === "toggle" && $(target)?.type === "text" ? t("hideApiKey") : labels[action];
        button.setAttribute("aria-label", label);
        button.title = label;
      });
      return;
    }
    host.innerHTML = ["toggle", "paste"]
      .map((action) => `<button class="api-key-action" type="button" data-api-key-action="${action}"`
        + ` data-api-key-target="${esc(target)}" aria-label="${esc(labels[action])}"`
        + ` title="${esc(labels[action])}">${API_KEY_ICONS[action]}</button>`)
      .join("");
  });
}

function bindProviderApiKeyActions() {
  renderApiKeyActions();
  document.querySelectorAll("[data-api-key-action]").forEach((button) => {
    if (button.dataset.apiKeyBound) return;
    button.dataset.apiKeyBound = "true";
    button.addEventListener("click", async () => {
      const input = $(button.dataset.apiKeyTarget);
      if (!input) return;
      if (button.dataset.apiKeyAction === "toggle") {
        const showing = input.type === "password";
        input.type = showing ? "text" : "password";
        const label = showing ? t("hideApiKey") : t("showApiKey");
        button.setAttribute("aria-label", label);
        button.title = label;
        return;
      }
      try {
        input.value = (await navigator.clipboard.readText() || "").trim();
        input.dispatchEvent(new Event("input", { bubbles: true }));
      } catch (_) {
        showToast(t("clipboardReadFailed"), "error");
      }
    });
  });
}

// 两个按钮组必须在下面的顶层 addEventListener 之前存在，否则拿不到元素。
// 这里的调用点先于所有 on(...) 绑定，也先于 init()。
renderBaseUrlActions();
renderApiKeyActions();

function bindProviderDialogEnhancements() {
  bindProviderApiKeyActions();
  bindProviderNameValidation();
}

// Claude 配置选了 OpenAI 格式时，验证/取模型也要按 OpenAI 方式带 Bearer 头
function productProtocol(kind) {
  if (kind === "claude" && $("profileApiFormat")?.value === "openai_chat") return "codex";
  if (kind === "opencode") return "codex";
  return kind;
}

function modelInputId(kind) {
  return productFieldMap(kind).model;
}

function clearModelResults(kind) {
  const resultsId = productFieldMap(kind).modelResults;
  const container = $(resultsId);
  if (!container) return;
  container.innerHTML = "";
  container.classList.remove("open");
}

function renderModelResults(kind, models) {
  const resultsId = productFieldMap(kind).modelResults;
  const container = $(resultsId);
  if (!container) return;
  const normalizedModels = helpers.normalizeFetchedModels
    ? helpers.normalizeFetchedModels(models)
    : (models || []).map((item) => item.id || item).filter(Boolean).sort();

  if (normalizedModels.length === 0) {
    container.innerHTML = `<div class="model-row"><span class="model-id">${t("modelFetchNoResults")}</span></div>`;
    container.classList.add("open");
    return;
  }

  container.innerHTML = normalizedModels.map((model) => `
    <button class="model-row model-use-btn" data-action="use-model" data-model="${esc(model)}" type="button" title="${esc(model)}">
      <span class="model-id">${esc(model)}</span>
      <span class="model-use">${t("endpointUse")}</span>
    </button>
  `).join("");
  container.classList.add("open");
  // A10: 容器级委托，kind 存在容器 dataset 上按需回读
  container.dataset.modelKind = kind;
  bindDelegatedActions(container, "ModelResults", (action, target) => {
    if (action !== "use-model") return;
    const model = target.getAttribute("data-model");
    if (!model) return;
    const input = $(modelInputId(container.dataset.modelKind));
    if (!input) return;
    input.value = model;
    updateCodexOfficialConfigPreview();
    showToast(t("modelSelected"), "success");
  });
}

async function handleModelFetch(kind) {
  const fields = productFieldMap(kind);
  const buttonId = fields.modelFetchBtn;
  const baseUrlId = fields.baseUrl;
  const apiKeyId = fields.apiKey;
  const button = $(buttonId);
  const baseUrl = $(baseUrlId).value.trim() || OFFICIAL_BASE_URLS[kind] || "";
  const apiKey = $(apiKeyId).value.trim();
  if (!apiKey) {
    showToast(t("modelFetchMissing"), "warning");
    return;
  }

  const previousText = button.textContent;
  button.disabled = true;
  button.textContent = t("modelFetching");
  try {
    const models = await invoke("fetch_available_models", { baseUrl, apiKey, timeoutSecs: 12, protocol: productProtocol(kind) });
    renderModelResults(kind, models || []);
  } catch (error) {
    showToast(describeVerifyError(String(error)), "error");
  } finally {
    button.disabled = false;
    button.textContent = previousText || t("modelFetch");
  }
}

// 把后端返回的原始错误翻译成用户可理解的验证结论
function describeVerifyError(raw) {
  if (/HTTP 40[13]\b/.test(raw)) return t("verifyAuthFailed");
  if (/HTTP 40[45]\b/.test(raw)) return t("verifyNoModelsEndpoint");
  return raw;
}

// 真实连通性验证：带 API Key 请求 /models 端点（后端会按协议自动补 /v1 等路径），
// 能同时验证端点可达性与 Key 有效性，并顺带展示可用模型列表。
async function handleEndpointTest(kind) {
  const fields = productFieldMap(kind);
  const button = $(fields.endpointTestBtn);
  const baseUrl = $(fields.baseUrl).value.trim() || OFFICIAL_BASE_URLS[kind] || "";
  const apiKey = $(fields.apiKey).value.trim();
  const container = $(fields.endpointResults);
  clearProviderInlineStatus(kind);
  if (!apiKey) {
    showToast(t("modelFetchMissing"), "warning");
    return;
  }

  setButtonBusy(button, true, t("endpointTesting"));
  const startedAt = performance.now();
  try {
    const models = await invoke("fetch_available_models", { baseUrl, apiKey, timeoutSecs: 12, protocol: productProtocol(kind) });
    const elapsed = Math.round(performance.now() - startedAt);
    const count = (models || []).length;
    renderProviderInlineStatus(kind, { tone: "success", latencyMs: elapsed });
    if (container) {
      container.innerHTML = `<div class="endpoint-row"><span class="endpoint-url" title="${esc(baseUrl)}">${esc(baseUrl)}</span><span class="endpoint-meta fast">${t("verifyOkLabel")} · ${count} ${t("verifyModelsSuffix")} · ${elapsed}ms</span></div>`;
      container.classList.add("open");
    }
    renderModelResults(kind, models || []);
    showToast(t("verifyOkToast"), "success");
  } catch (error) {
    const message = describeVerifyError(String(error));
    renderProviderInlineStatus(kind, { tone: "error", statusCode: providerStatusCode(error), summary: message });
    if (container) {
      container.innerHTML = `<div class="endpoint-row"><span class="endpoint-url" title="${esc(baseUrl)}">${esc(baseUrl)}</span><span class="endpoint-meta failed">${esc(message)}</span></div>`;
      container.classList.add("open");
    }
    showToast(message, "error");
  } finally {
    setButtonBusy(button, false);
  }
}

function getSelectedClaudePreset() {
  const presetId = $("profilePresetSelect")?.value || "";
  return CLAUDE_PRESETS.find((preset) => preset.id === presetId) || null;
}

function renderClaudePresetOptions() {
  const select = $("profilePresetSelect");
  if (!select) return;
  const currentValue = select.value;
  select.innerHTML = [
    `<option value="">${t("providerPresetCustom")}</option>`,
    ...CLAUDE_PRESETS.map((preset) => `<option value="${esc(preset.id)}">${esc(preset.name)}</option>`),
  ].join("");
  select.value = CLAUDE_PRESETS.some((preset) => preset.id === currentValue) ? currentValue : "";
}

function applyClaudePreset(preset) {
  if (!preset) return;
  const overwritten = [];
  if (!$("profileName").value.trim()) {
    $("profileName").value = preset.name;
    overwritten.push("profileName");
  }
  $("profileBaseUrl").value = preset.baseUrl;
  overwritten.push("profileBaseUrl");
  $("profileModelId").value = preset.model || "";
  overwritten.push("profileModelId");
  // 内置预设均为 Anthropic 兼容端点，重置为直连
  if ($("profileApiFormat")) {
    $("profileApiFormat").value = preset.apiFormat || "anthropic";
    overwritten.push("profileApiFormat");
  }
  highlightPresetOverwrite(overwritten);
  updateProxyFailoverGroupVisibility();
  updateProviderNameValidation("claude");
  clearEndpointResults("claude");
  clearProviderInlineStatus("claude");
  clearModelResults("claude");
}

function openModal(profile) {
  editingId = profile ? profile.id : null;
  $("modalTitle").textContent = profile ? t("editConfig") : t("addConfig");
  $("profileId").value = editingId || "";
  if ($("profilePresetSelect")) $("profilePresetSelect").value = "";
  $("profileName").value = profile ? profile.name : "";
  $("profileApiKey").value = profile ? profile.apiKey : "";
  $("profileBaseUrl").value = profile ? profile.baseUrl : "";
  $("profileModelId").value = profile ? (profile.modelId || "") : "";
  if ($("profileApiFormat")) $("profileApiFormat").value = profile ? (profile.apiFormat || "anthropic") : "anthropic";
  // 代理相关勾选：编辑时回填；接管开关随 apiFormat 显示/隐藏
  if ($("profileProxyFailover")) $("profileProxyFailover").checked = profile ? Boolean(profile.proxyFailover) : false;
  if ($("profileProxyTakeover")) $("profileProxyTakeover").checked = profile ? Boolean(profile.proxyTakeover) : false;
  if ($("profileSaveAndActivate")) $("profileSaveAndActivate").checked = false;
  updateProxyFailoverGroupVisibility();
  // 高级模型映射：编辑时回填；已配置过任一角色模型时默认展开
  const sonnetModel = profile ? (profile.sonnetModel || "") : "";
  const opusModel = profile ? (profile.opusModel || "") : "";
  const haikuModel = profile ? (profile.haikuModel || "") : "";
  if ($("profileSonnetModel")) $("profileSonnetModel").value = sonnetModel;
  if ($("profileOpusModel")) $("profileOpusModel").value = opusModel;
  if ($("profileHaikuModel")) $("profileHaikuModel").value = haikuModel;
  const mappingSection = $("profileModelMappingSection");
  if (mappingSection) mappingSection.open = Boolean(sonnetModel || opusModel || haikuModel);
  clearEndpointResults("claude");
  clearProviderInlineStatus("claude");
  clearModelResults("claude");
  updateProviderNameValidation("claude");
  $("modalOverlay").classList.add("open");
  $("profileName").focus();
}

function closeModal() {
  $("modalOverlay").classList.remove("open");
  editingId = null;
}

// 「由本地代理接管」只对 anthropic 直连配置有意义（openai_chat 本就必经代理）；
// 「加入故障转移池」两种格式都能用，只要填了 Base URL——池成员由代理内部访问，
// 与该配置自己被激活时是否走代理无关。
function updateProxyFailoverGroupVisibility() {
  const isOpenAi = ($("profileApiFormat")?.value || "anthropic") === "openai_chat";
  const takeoverGroup = $("profileProxyTakeoverGroup");
  if (takeoverGroup) takeoverGroup.hidden = isOpenAi;
  const failoverGroup = $("profileProxyFailoverGroup");
  if (failoverGroup) failoverGroup.hidden = false;
}

// 这些字段决定实际写入系统环境变量与本地代理的内容；改动当前生效的配置后
// 必须重新应用一次，否则运行环境还停留在旧值（表现为改了没反应）
const RUNTIME_PROFILE_FIELDS = [
  "apiKey",
  "baseUrl",
  "modelId",
  "apiFormat",
  "proxyTakeover",
  "sonnetModel",
  "opusModel",
  "haikuModel",
];

function runtimeProfileFieldsChanged(previous, next) {
  return RUNTIME_PROFILE_FIELDS.some(
    (field) => String(previous?.[field] ?? "") !== String(next?.[field] ?? "")
  );
}

async function handleSubmit(event) {
  event.preventDefault();
  if (profileSaving) return;
  const isNewProfile = !editingId;
  const savingId = editingId;
  const previousProfile = savingId ? profiles.find((item) => item.id === savingId) : null;

  const name = $("profileName").value.trim();
  if (!updateProviderNameValidation("claude")) return;
  const apiKey = $("profileApiKey").value.trim();
  const baseUrl = $("profileBaseUrl").value.trim();
  const modelId = $("profileModelId").value.trim();
  const apiFormat = $("profileApiFormat")?.value || "anthropic";
  const saveAndActivate = Boolean($("profileSaveAndActivate")?.checked);
  // 备用池成员由代理内部访问，两种格式都可入池；没有 Base URL 则无从转发
  const proxyFailover = Boolean($("profileProxyFailover")?.checked) && Boolean(baseUrl);
  // 接管只对 anthropic 直连有意义：openai_chat 本就必经代理，强制落回 false
  const proxyTakeover =
    apiFormat !== "openai_chat" && Boolean($("profileProxyTakeover")?.checked) && Boolean(baseUrl);
  // 角色模型映射（跨智能体契约字段名：sonnetModel / opusModel / haikuModel），留空传 null 表示不设置
  const sonnetModel = $("profileSonnetModel")?.value.trim() || null;
  const opusModel = $("profileOpusModel")?.value.trim() || null;
  const haikuModel = $("profileHaikuModel")?.value.trim() || null;
  if (apiFormat === "openai_chat") {
    // OpenAI 格式没有官方地址可回退；模型名必填（Claude Code 发来的 claude-* 上游不认识）
    if (!baseUrl) {
      showToast(t("claudeApiFormatNeedsBaseUrl"), "warning");
      return;
    }
    if (!modelId) {
      showToast(t("claudeApiFormatNeedsModel"), "warning");
      return;
    }
  }

  profileSaving = true;
  const submitButton = $("submitBtn");
  setButtonBusy(submitButton, true, t("toastSaving") || "保存中...");
  try {
    if (editingId) {
      await invoke("update_profile", { id: editingId, name, apiKey, baseUrl, modelId, apiFormat, sonnetModel, opusModel, haikuModel, proxyFailover, proxyTakeover });
      showToast(t("toastUpdated"), "success");
    } else {
      await invoke("add_profile", { name, apiKey, baseUrl, modelId: modelId || null, apiFormat, sonnetModel, opusModel, haikuModel, proxyFailover, proxyTakeover });
      showToast(t("toastAdded"), "success");
    }

    closeModal();
    await loadProfiles();
    await loadStatus();
    if (saveAndActivate) {
      const saved = profiles.find((item) => item.name === name);
      if (saved?.id) await handleSwitch(saved.id);
    } else if (isNewProfile) {
      switchConsolePage("claude");
    } else if (
      previousProfile?.isActive &&
      runtimeProfileFieldsChanged(previousProfile, {
        apiKey,
        baseUrl,
        modelId,
        apiFormat,
        proxyTakeover,
        sonnetModel,
        opusModel,
        haikuModel,
      })
    ) {
      // 改的是正在生效的配置：重新走一遍切换，把新值写进环境变量与本地代理
      await handleSwitch(savingId);
    }
  } catch (error) {
    showToast(String(error), "error");
  } finally {
    profileSaving = false;
    setButtonBusy(submitButton, false);
  }
}

async function handleSwitch(id) {
  if (isSwitchingProfile) return;
  const profile = profiles.find((item) => item.id === id);
  if (!profile) return;

  isSwitchingProfile = true;
  showSwitchOverlay(profile.name, "claude");

  try {
    await waitForNextPaint();
    progressUnlisten = await listen("switch-progress", (event) => {
      updateSwitchProgress(event.payload);
    });
    const result = await invoke("switch_profile", { id });

    if (result.success) {
      completeSwitchOverlay();
      $("switchStep1").className = "switch-step done";
      $("switchStep2").className = "switch-step done";
      $("switchStep3").className = "switch-step done";
      await new Promise((resolve) => setTimeout(resolve, 350));
    }

    if (result.cancelled) {
      showToast(result.rolledBack ? t("cancelledRestored") : t("cancelRestoreFailed", { error: (result.errors || []).join("; ") }), "warning");
    } else if (result.rolledBack) {
      showToast(t("switchRolledBack", { error: (result.errors || []).join("; ") }), "error");
    } else if (result.success) {
      showToast(t("switchedTo", { name: result.profileName }), "success");
    } else {
      // 构建成功项列表
      const okItems = [];
      if (result.results?.envVars) okItems.push(t("statusSystemEnv"));
      // 动态编辑器结果
      if (result.results?.editors) {
        for (const [editorId, success] of Object.entries(result.results.editors)) {
          if (success) okItems.push(detectedEditors[editorId] || editorId);
        }
      }
      if (result.results?.claude) okItems.push(t("statusClaude"));
      showToast(
        t("partialSuccess", {
          ok: okItems.join(", ") || "--",
          errors: (result.errors || []).join("; ") || "--"
        }),
        "warning"
      );
    }
  } catch (error) {
    const message = t("switchFailed", { error: String(error) });
    showToast(message, "error");
  } finally {
    if (progressUnlisten) {
      progressUnlisten();
      progressUnlisten = null;
    }
    hideSwitchOverlay();
    isSwitchingProfile = false;
    await Promise.all([loadProfiles(), loadStatus()]);
  }
}

async function handleCancelSwitch() {
  $("switchStepLabel").textContent = t("progressCancelling");
  $("switchCancelBtn").disabled = true;
  try {
    await invoke("cancel_switch");
  } catch (error) {
    showToast(String(error), "error");
  }
}

// A10: 编辑/删除逻辑统一走 PROVIDER_CONFIG 驱动的公共实现
function handleEdit(id) {
  editProviderProfile("claude", id);
}

async function handleDelete(id) {
  return deleteProviderProfile("claude", id);
}

async function handleImport() {
  const input = await appPrompt(
    currentLang === "zh"
      ? "系统将从当前 Claude 环境读取 Token / Base URL，并保存为新配置。"
      : "Import current Claude environment as a new profile.",
    t("importDefaultName"),
    {
      title: currentLang === "zh" ? "导入当前 Claude 配置" : "Import Claude Config",
      inputLabel: currentLang === "zh" ? "配置名称" : "Config name",
      confirmText: currentLang === "zh" ? "导入配置" : "Import",
    }
  );
  if (input === null) return;

  const name = String(input).trim() || t("importDefaultName");
  try {
    await invoke("import_current", { name });
    showToast(t("toastImported"), "success");
    await loadProfiles();
    await loadStatus();
  } catch (error) {
    showToast(String(error), "error");
  }
}

// ── Grok Profile Management ─────────────────────────

function getSelectedGrokPreset() {
  const presetId = $("grokPresetSelect")?.value || "";
  return GROK_PRESETS.find((preset) => preset.id === presetId) || null;
}

function renderGrokPresetOptions() {
  const select = $("grokPresetSelect");
  if (!select) return;
  const currentValue = select.value;
  select.innerHTML = [
    `<option value="">${t("grokPresetCustom")}</option>`,
    ...GROK_PRESETS.map((preset) => `<option value="${esc(preset.id)}">${esc(preset.name)}</option>`),
  ].join("");
  select.value = GROK_PRESETS.some((preset) => preset.id === currentValue) ? currentValue : "";
}

function updateGrokPresetHint() {
  const hint = $("grokPresetHint");
  if (!hint) return;
  hint.textContent = t("grokPresetHintDefault");
}

function applyGrokPreset(preset) {
  if (!preset) {
    updateGrokPresetHint();
    return;
  }
  if (!$("grokProfileName").value.trim()) {
    $("grokProfileName").value = preset.name;
  }
  $("grokBaseUrl").value = preset.baseUrl;
  $("grokModel").value = preset.model || "";
  if ($("grokApiBackend")) $("grokApiBackend").value = preset.apiBackend || "chat_completions";
  highlightPresetOverwrite(["grokProfileName", "grokBaseUrl", "grokModel", "grokApiBackend"]);
  updateProviderNameValidation("grok");
  clearEndpointResults("grok");
  clearProviderInlineStatus("grok");
  clearModelResults("grok");
  updateGrokPresetHint();
}

async function loadGrokProfiles({ rethrow = false } = {}) {
  try {
    const data = await invoke("get_grok_profiles");
    grokProfiles = data.profiles || [];
    renderGrokProfiles();
    renderNavigationStatus();
  } catch (error) {
    showToast(String(error), "error");
    if (rethrow) throw error;
  }
}

function renderGrokProfiles() {
  const grid = $("grokProfilesGrid");
  if (!grid) return;

  if (grokProfiles.length === 0) {
    grid.innerHTML = `
      <div class="empty-state">
        <svg class="empty-state-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
          <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/>
          <polyline points="14 2 14 8 20 8"/>
          <line x1="12" y1="18" x2="12" y2="12"/>
          <line x1="9" y1="15" x2="15" y2="15"/>
        </svg>
        <div class="empty-state-title">${t("grokNoConfigsTitle")}</div>
        <p>${t("grokNoConfigsDesc")}</p>
      </div>`;
    updateGrokActiveConfigBar();
    return;
  }

  grid.innerHTML = grokProfiles.map((profile) => `
    <div class="profile-card ${profile.isActive ? "active" : ""}" data-id="${esc(profile.id)}" draggable="true">
      <div class="profile-header">
        ${profileDragHandleHtml()}
        <span class="profile-name">${esc(profile.name)}</span>
        ${profile.isActive ? `<span class="active-badge">${t("inUse")}</span>` : ""}
      </div>
      <div class="profile-body">
        <div class="profile-field">
          <span class="field-label">${t("grokApiKeyLabel")}</span>
          <span class="field-value">${esc(maskKey(profile.apiKey))}</span>
        </div>
        <div class="profile-field">
          <span class="field-label">${t("grokBaseUrlLabel")}</span>
          <span class="field-value">${esc(truncUrl(profile.baseUrl, 50))}</span>
        </div>
        ${profile.model ? `<div class="profile-field">
          <span class="field-label">${t("grokModelLabel")}</span>
          <span class="field-value">${esc(profile.model)}</span>
        </div>` : ""}
        ${profile.apiBackend ? `<div class="profile-field">
          <span class="field-label">${t("grokApiBackendLabel")}</span>
          <span class="field-value">${esc(profile.apiBackend)}</span>
        </div>` : ""}
        ${profileBalanceRowHtml("grok", profile)}
      </div>
      <div class="profile-actions">
        ${profile.isActive ? "" : `<button class="btn btn-switch btn-sm" data-action="grok-switch" data-id="${profile.id}" type="button">${t("switchUse")}</button>`}
        <button class="btn btn-secondary btn-sm" data-action="grok-edit" data-id="${profile.id}" type="button">${t("edit")}</button>
        <button class="btn btn-danger btn-sm" data-action="grok-delete" data-id="${profile.id}" type="button">${t("delete")}</button>
      </div>
    </div>
  `).join("");

  bindProfileGridActions(grid, "GrokProfiles", "grok");
  bindProfileGridDragSort(grid, "grok");
  autoRefreshProfileBalances("grok");
  updateGrokActiveConfigBar();
}

function updateGrokActiveConfigBar() {
  // 与 Claude 保持一致:当前配置名直接显示在状态区标题中
  if (!$("grokStatusSectionTitle")) return;
  const active = grokProfiles.find((p) => p.isActive);
  const activeContext = active
    ? (currentLang === "zh" ? ` (当前: ${active.name})` : ` (Current: ${active.name})`)
    : "";
  setText("grokStatusSectionTitle", `${t("grokStatusTitle")}${activeContext}`);
}

async function loadGrokStatus({ rethrow = false } = {}) {
  try {
    const status = await invoke("get_grok_status");
    lastGrokStatus = status;
    const grid = $("grokStatusGrid");
    if (!grid) {
      renderNavigationStatus();
      return;
    }
    if (!status || (!status.apiKey && !status.configExists)) {
      grid.innerHTML = `<div class="status-card" style="display:flex;align-items:center;justify-content:center;color:var(--text-muted);font-size:13px;">Grok: --</div>`;
      renderNavigationStatus();
      return;
    }
    const COPY_ICON = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>`;
    grid.innerHTML = `
      <div class="status-card">
        <div class="status-card-title">
          <span class="status-card-title-text">${productIcon("grok")}Grok</span>
        </div>
        <div class="status-item">
          <span class="status-label">${t("grokApiKeyLabel")}</span>
          <div class="status-value-wrapper">
            <span class="status-value" title="${esc(status.apiKey || "--")}">${esc(maskKey(status.apiKey))}</span>
            ${status.apiKey ? `<button class="copy-btn" type="button" data-copy="${esc(status.apiKey)}" title="${t("copy")}" aria-label="${t("copy")}">${COPY_ICON}</button>` : ""}
          </div>
        </div>
        <div class="status-item">
          <span class="status-label">${t("grokBaseUrlLabel")}</span>
          <div class="status-value-wrapper">
            <span class="status-value" title="${esc(status.baseUrl || "--")}">${esc(status.baseUrl || "--")}</span>
            ${status.baseUrl ? `<button class="copy-btn" type="button" data-copy="${esc(status.baseUrl)}" title="${t("copy")}" aria-label="${t("copy")}">${COPY_ICON}</button>` : ""}
          </div>
        </div>
        <div class="status-item">
          <span class="status-label">${t("grokModelLabel")}</span>
          <div class="status-value-wrapper">
            <span class="status-value" title="${esc(status.model || "--")}">${esc(status.model || "--")}</span>
            ${status.model ? `<button class="copy-btn" type="button" data-copy="${esc(status.model)}" title="${t("copy")}" aria-label="${t("copy")}">${COPY_ICON}</button>` : ""}
          </div>
        </div>
        ${status.defaultModelId ? `<div class="status-item">
          <span class="status-label">${currentLang === "zh" ? "默认模型" : "Default Model"}</span>
          <div class="status-value-wrapper">
            <span class="status-value" title="${esc(status.defaultModelId)}">${esc(status.defaultModelId)}</span>
            <button class="copy-btn" type="button" data-copy="${esc(status.defaultModelId)}" title="${t("copy")}" aria-label="${t("copy")}">${COPY_ICON}</button>
          </div>
        </div>` : ""}
      </div>`;
    bindDelegatedCopyButtons(grid, "GrokStatusCopy");
    renderNavigationStatus();
  } catch (error) {
    // 与 loadStatus 保持一致，失败时弹 toast 让用户感知
    showToast(`Grok 状态加载失败: ${error}`, "error");
    console.error("Failed to load grok status:", error);
    if (rethrow) throw error;
  }
}

function renderGrokDiagnostics() {
  const panel = $("grokDiagnosticsPanel");
  if (!panel) return;
  const d = grokDiagnostics;
  if (!d) {
    panel.innerHTML = `<div class="diagnostics-card muted">Grok diagnostics: --</div>`;
    return;
  }
  const healthy = Array.isArray(d.issues) && d.issues.length === 0;
  const issueItems = (d.issues || []).map((item) => `<li>${esc(item)}</li>`).join("");
  const suggestionItems = (d.suggestions || []).map((item) => `<li>${esc(item)}</li>`).join("");
  panel.innerHTML = `
    <div class="diagnostics-card ${healthy ? "healthy" : "warning"}">
      <div class="diagnostics-head">
        <div>
          <div class="diagnostics-kicker">Grok Health</div>
          <div class="diagnostics-title">${healthy ? (currentLang === "zh" ? "配置健康" : "Healthy") : (currentLang === "zh" ? "需要处理" : "Needs attention")}</div>
        </div>
        <span class="diagnostics-state ${healthy ? "ok" : "warn"}">${healthy ? "OK" : `${d.issues.length} issues`}</span>
      </div>
      <div class="diagnostics-grid">
        <div><span>Active</span><strong>${esc(d.activeProfileName || "--")}</strong></div>
        <div><span>default</span><strong>${esc(d.defaultModelId || "--")}</strong></div>
        <div><span>Model</span><strong>${esc(d.model || "--")}</strong></div>
        <div><span>Backend</span><strong>${esc(d.apiBackend || "--")}</strong></div>
      </div>
      <div class="diagnostics-paths">
        <div title="${esc(d.configPath || "")}">config: ${esc(d.configExists ? d.configPath : (currentLang === "zh" ? "未找到" : "missing"))}</div>
        <div>source: ${esc(d.source || "--")}</div>
      </div>
      ${issueItems ? `<div class="diagnostics-list"><strong>${currentLang === "zh" ? "问题" : "Issues"}</strong><ul>${issueItems}</ul></div>` : ""}
      ${suggestionItems ? `<div class="diagnostics-list"><strong>${currentLang === "zh" ? "建议" : "Suggestions"}</strong><ul>${suggestionItems}</ul></div>` : ""}
      <div class="diagnostics-footer">Last checked: ${esc(d.lastCheckedAt || "--")}</div>
    </div>`;
}

async function loadGrokDiagnostics({ rethrow = false } = {}) {
  try {
    grokDiagnostics = await invoke("get_grok_diagnostics");
    renderGrokDiagnostics();
  } catch (error) {
    const panel = $("grokDiagnosticsPanel");
    if (panel) {
      panel.innerHTML = `<div class="diagnostics-card warning">${currentLang === "zh" ? "诊断加载失败" : "Diagnostics failed"}：${esc(String(error))}</div>`;
    }
    if (rethrow) throw error;
  }
}

async function handleGrokRuntimeBackup() {
  try {
    const path = await invoke("backup_grok_runtime");
    showToast(currentLang === "zh" ? `已备份: ${path}` : `Backed up: ${path}`, "success");
    await loadGrokDiagnostics();
  } catch (error) {
    showToast(String(error), "error");
  }
}

async function handleOpenGrokFolder() {
  try {
    await invoke("open_grok_config_folder");
  } catch (error) {
    showToast(String(error), "error");
  }
}

function openGrokModal(profile) {
  editingGrokId = profile ? profile.id : null;
  $("grokModalTitle").textContent = profile ? t("grokEditConfig") : t("grokAddConfig");
  $("grokProfileId").value = editingGrokId || "";
  $("grokPresetSelect").value = "";
  $("grokProfileName").value = profile ? profile.name : "";
  $("grokApiKey").value = profile ? profile.apiKey : "";
  $("grokApiKey").type = "password";
  if ($("grokSaveAndActivate")) $("grokSaveAndActivate").checked = false;
  $("grokBaseUrl").value = profile ? profile.baseUrl : "";
  $("grokModel").value = profile ? (profile.model || "") : "";
  if ($("grokApiBackend")) {
    $("grokApiBackend").value = profile?.apiBackend || "chat_completions";
  }
  updateGrokPresetHint();
  clearEndpointResults("grok");
  clearProviderInlineStatus("grok");
  clearModelResults("grok");
  updateProviderNameValidation("grok");
  $("grokModalOverlay").classList.add("open");
  document.body.classList.add("modal-open");
  $("grokProfileName").focus();
}

function closeGrokModal() {
  $("grokModalOverlay").classList.remove("open");
  document.body.classList.remove("modal-open");
  editingGrokId = null;
}

async function handleGrokSubmit(event) {
  event.preventDefault();
  if (grokProfileSaving) return;
  const isNewProfile = !editingGrokId;
  const name = $("grokProfileName").value.trim();
  if (!updateProviderNameValidation("grok")) return;
  const apiKey = $("grokApiKey").value.trim();
  const baseUrl = $("grokBaseUrl").value.trim() || "https://api.x.ai/v1";
  const model = $("grokModel").value.trim();
  const apiBackend = $("grokApiBackend")?.value || "chat_completions";
  const saveAndActivate = Boolean($("grokSaveAndActivate")?.checked);

  grokProfileSaving = true;
  const submitButton = $("grokSubmitBtn");
  setButtonBusy(submitButton, true, t("toastSaving"));
  try {
    if (editingGrokId) {
      await invoke("update_grok_profile", {
        id: editingGrokId,
        name,
        apiKey,
        baseUrl,
        model: model || null,
        apiBackend,
      });
      showToast(t("grokToastUpdated"), "success");
    } else {
      await invoke("add_grok_profile", {
        name,
        apiKey,
        baseUrl,
        model: model || null,
        apiBackend,
      });
      showToast(t("grokToastAdded"), "success");
    }
    closeGrokModal();
    await Promise.all([loadGrokProfiles(), loadGrokStatus(), loadGrokDiagnostics()]);
    if (saveAndActivate) {
      const saved = grokProfiles.find((item) => item.name === name);
      if (saved?.id) await handleGrokSwitch(saved.id);
    } else if (isNewProfile) switchConsolePage("grok");
  } catch (error) {
    showToast(String(error), "error");
  } finally {
    grokProfileSaving = false;
    setButtonBusy(submitButton, false);
  }
}

// A10: 切换/删除逻辑统一走 PROVIDER_CONFIG 驱动的公共实现
async function handleGrokSwitch(id) {
  return switchProviderProfile("grok", id);
}

async function handleGrokDelete(id) {
  return deleteProviderProfile("grok", id);
}

async function handleGrokImport() {
  const input = await appPrompt(
    currentLang === "zh"
      ? "系统将从 ~/.grok/config.toml 读取当前 Grok 配置并保存。"
      : "Import current Grok config.toml as a new profile.",
    t("grokImportDefaultName"),
    {
      title: currentLang === "zh" ? "导入当前 Grok 配置" : "Import Grok Config",
      inputLabel: currentLang === "zh" ? "配置名称" : "Config name",
      confirmText: currentLang === "zh" ? "导入配置" : "Import",
    }
  );
  if (input === null) return;
  const name = String(input).trim() || t("grokImportDefaultName");
  try {
    await invoke("import_grok_current", { name });
    showToast(t("grokToastImported"), "success");
    await Promise.all([loadGrokProfiles(), loadGrokStatus(), loadGrokDiagnostics()]);
  } catch (error) {
    showToast(String(error), "error");
  }
}

// ── Gemini Profile Management ──────────────────────

async function loadGeminiProfiles({ rethrow = false } = {}) {
  try {
    const data = await invoke("get_gemini_profiles");
    geminiProfiles = data.profiles || [];
    renderGeminiProfiles();
    renderNavigationStatus();
  } catch (error) {
    showToast(String(error), "error");
    if (rethrow) throw error;
  }
}

function updateGeminiStatusTitle() {
  // 与 Claude 保持一致:当前配置名直接显示在状态区标题中
  if (!$("geminiStatusSectionTitle")) return;
  const base = currentLang === "zh" ? "Gemini 状态" : "Gemini Status";
  const active = geminiProfiles.find((p) => p.isActive);
  const activeContext = active
    ? (currentLang === "zh" ? ` (当前: ${active.name})` : ` (Current: ${active.name})`)
    : "";
  setText("geminiStatusSectionTitle", `${base}${activeContext}`);
}

function renderGeminiProfiles() {
  const grid = $("geminiProfilesGrid");
  if (!grid) return;
  updateGeminiStatusTitle();
  if (geminiProfiles.length === 0) {
    grid.innerHTML = `
      <div class="empty-state">
        <svg class="empty-state-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
          <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/>
          <polyline points="14 2 14 8 20 8"/>
          <line x1="12" y1="18" x2="12" y2="12"/>
          <line x1="9" y1="15" x2="15" y2="15"/>
        </svg>
        <div class="empty-state-title">${t("geminiNoConfigsTitle")}</div>
        <p>${t("geminiNoConfigsDesc")}</p>
      </div>`;
    return;
  }
  grid.innerHTML = geminiProfiles.map((profile) => `
    <div class="profile-card ${profile.isActive ? "active" : ""}" data-id="${esc(profile.id)}" draggable="true">
      <div class="profile-header">
        ${profileDragHandleHtml()}
        <span class="profile-name">${esc(profile.name)}</span>
        ${profile.isActive ? `<span class="active-badge">${t("inUse")}</span>` : ""}
      </div>
      <div class="profile-body">
        <div class="profile-field">
          <span class="field-label">Gemini API Key</span>
          <span class="field-value">${esc(maskKey(profile.apiKey))}</span>
        </div>
        <div class="profile-field">
          <span class="field-label">Gemini Base URL</span>
          <span class="field-value">${esc(truncUrl(profile.baseUrl, 50))}</span>
        </div>
        ${profile.model ? `<div class="profile-field">
          <span class="field-label">${currentLang === "zh" ? "Gemini 模型" : "Gemini Model"}</span>
          <span class="field-value">${esc(profile.model)}</span>
        </div>` : ""}
        ${profileBalanceRowHtml("gemini", profile)}
      </div>
      <div class="profile-actions">
        ${profile.isActive ? "" : `<button class="btn btn-switch btn-sm" data-action="gemini-switch" data-id="${profile.id}" type="button">${t("switchUse")}</button>`}
        <button class="btn btn-secondary btn-sm" data-action="gemini-edit" data-id="${profile.id}" type="button">${t("edit")}</button>
        <button class="btn btn-danger btn-sm" data-action="gemini-delete" data-id="${profile.id}" type="button">${t("delete")}</button>
      </div>
    </div>
  `).join("");
  bindProfileGridActions(grid, "GeminiProfiles", "gemini");
  bindProfileGridDragSort(grid, "gemini");
  autoRefreshProfileBalances("gemini");
}

async function loadGeminiStatus({ rethrow = false } = {}) {
  try {
    const status = await invoke("get_gemini_status");
    lastGeminiStatus = status;
    const grid = $("geminiStatusGrid");
    if (!grid) return;
    if (!status) {
      grid.innerHTML = `<div class="status-card" style="display:flex;align-items:center;justify-content:center;color:var(--text-muted);font-size:13px;">Gemini: --</div>`;
      renderNavigationStatus();
      return;
    }
    const COPY_ICON = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>`;
    grid.innerHTML = `
      <div class="status-card">
        <div class="status-card-title">
          <span class="status-card-title-text">${productIcon("gemini")}Gemini</span>
        </div>
        <div class="status-item">
          <span class="status-label">Gemini API Key</span>
          <div class="status-value-wrapper">
            <span class="status-value" title="${esc(status.apiKey || "--")}">${esc(maskKey(status.apiKey))}</span>
            ${status.apiKey ? `<button class="copy-btn" type="button" data-copy="${esc(status.apiKey)}" title="${t("copy")}" aria-label="${t("copy")}">${COPY_ICON}</button>` : ""}
          </div>
        </div>
        <div class="status-item">
          <span class="status-label">Gemini Base URL</span>
          <div class="status-value-wrapper">
            <span class="status-value" title="${esc(status.baseUrl || "--")}">${esc(status.baseUrl || "--")}</span>
            ${status.baseUrl ? `<button class="copy-btn" type="button" data-copy="${esc(status.baseUrl)}" title="${t("copy")}" aria-label="${t("copy")}">${COPY_ICON}</button>` : ""}
          </div>
        </div>
        <div class="status-item">
          <span class="status-label">${currentLang === "zh" ? "Gemini 模型" : "Gemini Model"}</span>
          <div class="status-value-wrapper">
            <span class="status-value" title="${esc(status.model || "--")}">${esc(status.model || "--")}</span>
            ${status.model ? `<button class="copy-btn" type="button" data-copy="${esc(status.model)}" title="${t("copy")}" aria-label="${t("copy")}">${COPY_ICON}</button>` : ""}
          </div>
        </div>
        <div class="status-item">
          <span class="status-label">Auth</span>
          <div class="status-value-wrapper">
            <span class="status-value" title="${esc(status.authType || "--")}">${esc(status.authType || "--")}</span>
          </div>
        </div>
      </div>`;
    bindDelegatedCopyButtons(grid, "GeminiStatusCopy");
    renderNavigationStatus();
  } catch (error) {
    showToast(String(error), "error");
    if (rethrow) throw error;
  }
}

function openGeminiModal(profile) {
  editingGeminiId = profile?.id || null;
  $("geminiModalTitle").textContent = profile ? "编辑 Gemini 配置" : "添加 Gemini 配置";
  $("geminiProfileId").value = editingGeminiId || "";
  $("geminiProfileName").value = profile?.name || "";
  $("geminiApiKey").value = profile?.apiKey || "";
  $("geminiApiKey").type = "password";
  if ($("geminiSaveAndActivate")) $("geminiSaveAndActivate").checked = false;
  $("geminiBaseUrl").value = profile?.baseUrl || "";
  $("geminiModel").value = profile?.model || "gemini-2.5-pro";
  clearEndpointResults("gemini");
  clearProviderInlineStatus("gemini");
  clearModelResults("gemini");
  updateProviderNameValidation("gemini");
  $("geminiModalOverlay").classList.add("open");
  document.body.classList.add("modal-open");
  $("geminiProfileName").focus();
}

function closeGeminiModal() {
  $("geminiModalOverlay").classList.remove("open");
  document.body.classList.remove("modal-open");
  editingGeminiId = null;
}

async function handleGeminiSubmit(event) {
  event.preventDefault();
  if (geminiProfileSaving) return;
  const payload = {
    name: $("geminiProfileName").value.trim(),
    apiKey: $("geminiApiKey").value.trim(),
    baseUrl: $("geminiBaseUrl").value.trim(),
    model: $("geminiModel").value.trim() || null,
  };
  const saveAndActivate = Boolean($("geminiSaveAndActivate")?.checked);
  if (!updateProviderNameValidation("gemini")) return;
  geminiProfileSaving = true;
  const submitButton = $("geminiSubmitBtn");
  setButtonBusy(submitButton, true, t("toastSaving"));
  try {
    if (editingGeminiId) await invoke("update_gemini_profile", { id: editingGeminiId, ...payload });
    else await invoke("add_gemini_profile", payload);
    showToast(editingGeminiId ? "Gemini 配置已更新" : "Gemini 配置已添加", "success");
    closeGeminiModal();
    await Promise.all([loadGeminiProfiles(), loadGeminiStatus()]);
    if (saveAndActivate) {
      const saved = geminiProfiles.find((item) => item.name === payload.name);
      if (saved?.id) await handleGeminiSwitch(saved.id);
    } else switchConsolePage("gemini");
  } catch (error) {
    showToast(String(error), "error");
  } finally {
    geminiProfileSaving = false;
    setButtonBusy(submitButton, false);
  }
}

// A10: 切换/删除逻辑统一走 PROVIDER_CONFIG 驱动的公共实现
async function handleGeminiSwitch(id) {
  return switchProviderProfile("gemini", id);
}

async function handleGeminiDelete(id) {
  return deleteProviderProfile("gemini", id);
}

async function handleGeminiImport() {
  const input = await appPrompt("从 Gemini CLI 当前环境变量与 settings.json 导入配置。", "当前 Gemini 配置", { title: "导入 Gemini 配置", inputLabel: "配置名称", confirmText: "导入配置" });
  if (input === null) return;
  try {
    await invoke("import_gemini_current", { name: String(input).trim() || "当前 Gemini 配置" });
    showToast("当前 Gemini 配置已导入", "success");
    await Promise.all([loadGeminiProfiles(), loadGeminiStatus()]);
  } catch (error) {
    showToast(String(error), "error");
  }
}

// ── OpenCode Profile Management ─────────────────────
// 切换写入 OpenCode 的全局/显式配置，更新凭据、默认模型及模型声明，兼容 V1/V2。

function getSelectedOpenCodePreset() {
  const presetId = $("opencodePresetSelect")?.value || "";
  return OPENCODE_PRESETS.find((preset) => preset.id === presetId) || null;
}

function renderOpenCodePresetOptions() {
  const select = $("opencodePresetSelect");
  if (!select) return;
  const currentValue = select.value;
  select.innerHTML = [
    `<option value="">${t("opencodePresetCustom")}</option>`,
    ...OPENCODE_PRESETS.map((preset) => `<option value="${esc(preset.id)}">${esc(preset.name)}</option>`),
  ].join("");
  select.value = OPENCODE_PRESETS.some((preset) => preset.id === currentValue) ? currentValue : "";
}

function updateOpenCodePresetHint() {
  const hint = $("opencodePresetHint");
  if (!hint) return;
  hint.textContent = t("opencodePresetHintDefault");
}

function applyOpenCodePreset(preset) {
  if (!preset) {
    updateOpenCodePresetHint();
    return;
  }
  if (!$("opencodeProfileName").value.trim()) {
    $("opencodeProfileName").value = preset.name;
  }
  $("opencodeProviderId").value = preset.providerId;
  $("opencodeBaseUrl").value = preset.baseUrl || "";
  $("opencodeModel").value = preset.model || "";
  updateOpenCodePresetHint();
}

async function loadOpenCodeProfiles({ rethrow = false } = {}) {
  try {
    const data = await invoke("get_opencode_profiles");
    opencodeProfiles = data.profiles || [];
    renderOpenCodeProfiles();
    renderNavigationStatus();
  } catch (error) {
    showToast(String(error), "error");
    if (rethrow) throw error;
  }
}

function updateOpenCodeStatusTitle() {
  // 与其他 provider 一致:当前配置名直接显示在状态区标题中
  if (!$("opencodeStatusSectionTitle")) return;
  const active = opencodeProfiles.find((profile) => profile.isActive);
  const activeContext = active
    ? (currentLang === "zh" ? ` (当前: ${active.name})` : ` (Current: ${active.name})`)
    : "";
  setText("opencodeStatusSectionTitle", `${t("opencodeStatusTitle")}${activeContext}`);
}

function renderOpenCodeProfiles() {
  const grid = $("opencodeProfilesGrid");
  if (!grid) return;
  updateOpenCodeStatusTitle();

  if (opencodeProfiles.length === 0) {
    grid.innerHTML = `
      <div class="empty-state">
        <svg class="empty-state-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
          <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/>
          <polyline points="14 2 14 8 20 8"/>
          <line x1="12" y1="18" x2="12" y2="12"/>
          <line x1="9" y1="15" x2="15" y2="15"/>
        </svg>
        <div class="empty-state-title">${t("opencodeNoConfigsTitle")}</div>
        <p>${t("opencodeNoConfigsDesc")}</p>
      </div>`;
    return;
  }

  grid.innerHTML = opencodeProfiles.map((profile) => `
    <div class="profile-card ${profile.isActive ? "active" : ""}" data-id="${esc(profile.id)}" draggable="true">
      <div class="profile-header">
        ${profileDragHandleHtml()}
        <span class="profile-name">${esc(profile.name)}</span>
        ${profile.isActive ? `<span class="active-badge">${t("inUse")}</span>` : ""}
      </div>
      <div class="profile-body">
        <div class="profile-field">
          <span class="field-label">${t("opencodeProviderLabel")}</span>
          <span class="field-value">${esc(profile.providerId || "--")}</span>
        </div>
        <div class="profile-field">
          <span class="field-label">${t("opencodeApiKeyLabel")}</span>
          <span class="field-value">${esc(maskKey(profile.apiKey))}</span>
        </div>
        <div class="profile-field">
          <span class="field-label">${t("opencodeBaseUrlLabel")}</span>
          <span class="field-value">${esc(profile.baseUrl ? truncUrl(profile.baseUrl, 50) : t("opencodeOfficialBaseUrl"))}</span>
        </div>
        ${profile.model ? `<div class="profile-field">
          <span class="field-label">${t("opencodeModelLabel")}</span>
          <span class="field-value">${esc(profile.model)}</span>
        </div>` : ""}
        ${profileBalanceRowHtml("opencode", profile)}
      </div>
      <div class="profile-actions">
        ${profile.isActive ? "" : `<button class="btn btn-switch btn-sm" data-action="opencode-switch" data-id="${profile.id}" type="button">${t("switchUse")}</button>`}
        <button class="btn btn-secondary btn-sm" data-action="opencode-edit" data-id="${profile.id}" type="button">${t("edit")}</button>
        <button class="btn btn-danger btn-sm" data-action="opencode-delete" data-id="${profile.id}" type="button">${t("delete")}</button>
      </div>
    </div>
  `).join("");

  bindProfileGridActions(grid, "OpenCodeProfiles", "opencode");
  bindProfileGridDragSort(grid, "opencode");
  autoRefreshProfileBalances("opencode");
}

async function loadOpenCodeStatus({ rethrow = false } = {}) {
  try {
    const status = await invoke("get_opencode_runtime_status");
    lastOpenCodeStatus = status;
    const grid = $("opencodeStatusGrid");
    if (!grid) {
      renderNavigationStatus();
      return;
    }
    if (!status) {
      grid.innerHTML = `<div class="status-card" style="display:flex;align-items:center;justify-content:center;color:var(--text-muted);font-size:13px;">OpenCode: --</div>`;
      renderNavigationStatus();
      return;
    }
    const COPY_ICON = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>`;
    const installedLabel = status.installed ? t("opencodeInstalled") : t("opencodeNotInstalled");
    grid.innerHTML = `
      <div class="status-card">
        <div class="status-card-title">
          <span class="status-card-title-text">${productIcon("opencode")}OpenCode</span>
        </div>
        <div class="status-item">
          <span class="status-label">${t("opencodeCliLabel")}</span>
          <div class="status-value-wrapper">
            <span class="status-value">${esc(installedLabel)}</span>
          </div>
        </div>
        <div class="status-item">
          <span class="status-label">${t("opencodeProviderLabel")}</span>
          <div class="status-value-wrapper">
            <span class="status-value" title="${esc(status.provider || "--")}">${esc(status.provider || "--")}</span>
          </div>
        </div>
        <div class="status-item">
          <span class="status-label">${t("opencodeModelLabel")}</span>
          <div class="status-value-wrapper">
            <span class="status-value" title="${esc(status.model || "--")}">${esc(status.model || "--")}</span>
            ${status.model ? `<button class="copy-btn" type="button" data-copy="${esc(status.model)}" title="${t("copy")}" aria-label="${t("copy")}">${COPY_ICON}</button>` : ""}
          </div>
        </div>
        <div class="status-item">
          <span class="status-label">${t("opencodeApiKeyLabel")}</span>
          <div class="status-value-wrapper">
            <span class="status-value">${esc(status.apiKey || "--")}</span>
          </div>
        </div>
        <div class="status-item">
          <span class="status-label">${t("opencodeBaseUrlLabel")}</span>
          <div class="status-value-wrapper">
            <span class="status-value" title="${esc(status.baseUrl || "")}">${esc(status.baseUrl || t("opencodeOfficialBaseUrl"))}</span>
            ${status.baseUrl ? `<button class="copy-btn" type="button" data-copy="${esc(status.baseUrl)}" title="${t("copy")}" aria-label="${t("copy")}">${COPY_ICON}</button>` : ""}
          </div>
        </div>
        <div class="status-item">
          <span class="status-label">${t("opencodeConfigPathLabel")}</span>
          <div class="status-value-wrapper">
            <span class="status-value" title="${esc(status.configPath || "")}">${esc(status.configPath || "--")}</span>
            ${status.configPath ? `<button class="copy-btn" type="button" data-copy="${esc(status.configPath)}" title="${t("copy")}" aria-label="${t("copy")}">${COPY_ICON}</button>` : ""}
          </div>
        </div>
        <div class="status-item">
          <span class="status-label">${t("opencodeSourceLabel")}</span>
          <div class="status-value-wrapper">
            <span class="status-value">${esc(status.source || "--")}${status.configExists ? "" : ` · ${esc(t("opencodeConfigMissing"))}`}</span>
          </div>
        </div>
      </div>`;
    bindDelegatedCopyButtons(grid, "OpenCodeStatusCopy");
    renderNavigationStatus();
  } catch (error) {
    showToast(`${t("opencodeStatusLoadFailed")}: ${error}`, "error");
    console.error("Failed to load opencode status:", error);
    if (rethrow) throw error;
  }
}

function openOpenCodeModal(profile) {
  editingOpenCodeId = profile ? profile.id : null;
  $("opencodeModalTitle").textContent = profile ? t("opencodeEditConfig") : t("opencodeAddConfig");
  $("opencodeProfileId").value = editingOpenCodeId || "";
  $("opencodePresetSelect").value = "";
  $("opencodeProfileName").value = profile ? profile.name : "";
  $("opencodeProviderId").value = profile ? (profile.providerId || "anthropic") : "anthropic";
  $("opencodeApiKey").value = profile ? profile.apiKey : "";
  $("opencodeApiKey").type = "password";
  if ($("opencodeSaveAndActivate")) $("opencodeSaveAndActivate").checked = false;
  $("opencodeBaseUrl").value = profile ? (profile.baseUrl || "") : "";
  $("opencodeModel").value = profile ? (profile.model || "") : "";
  updateOpenCodePresetHint();
  $("opencodeModalOverlay").classList.add("open");
  document.body.classList.add("modal-open");
  $("opencodeProfileName").focus();
}

function closeOpenCodeModal() {
  $("opencodeModalOverlay").classList.remove("open");
  document.body.classList.remove("modal-open");
  editingOpenCodeId = null;
}

async function handleOpenCodeSubmit(event) {
  event.preventDefault();
  if (opencodeProfileSaving) return;
  const isNewProfile = !editingOpenCodeId;
  const payload = {
    name: $("opencodeProfileName").value.trim(),
    apiKey: $("opencodeApiKey").value.trim(),
    baseUrl: $("opencodeBaseUrl").value.trim(),
    model: $("opencodeModel").value.trim() || null,
    providerId: $("opencodeProviderId").value.trim() || null,
  };
  if (!updateProviderNameValidation("opencode")) return;
  const saveAndActivate = Boolean($("opencodeSaveAndActivate")?.checked);

  opencodeProfileSaving = true;
  const submitButton = $("opencodeSubmitBtn");
  setButtonBusy(submitButton, true, t("toastSaving"));
  try {
    if (editingOpenCodeId) {
      await invoke("update_opencode_profile", { id: editingOpenCodeId, ...payload });
      showToast(t("opencodeToastUpdated"), "success");
    } else {
      await invoke("add_opencode_profile", payload);
      showToast(t("opencodeToastAdded"), "success");
    }
    closeOpenCodeModal();
    await Promise.all([loadOpenCodeProfiles(), loadOpenCodeStatus()]);
    if (saveAndActivate) {
      const saved = opencodeProfiles.find((item) => item.name === payload.name);
      if (saved?.id) await handleOpenCodeSwitch(saved.id);
    } else if (isNewProfile) switchConsolePage("opencode");
  } catch (error) {
    showToast(String(error), "error");
  } finally {
    opencodeProfileSaving = false;
    setButtonBusy(submitButton, false);
  }
}

// 切换/删除逻辑统一走 PROVIDER_CONFIG 驱动的公共实现
async function handleOpenCodeSwitch(id) {
  return switchProviderProfile("opencode", id);
}

async function handleOpenCodeDelete(id) {
  return deleteProviderProfile("opencode", id);
}

// 「导入当前配置」：读运行时状态，预填添加弹窗。
// 后端返回的 apiKey 是打码值，不能直接当 Key 用，所以只预填 provider / model / baseUrl，
// 让用户补一次明文 Key。
async function handleOpenCodeImport() {
  try {
    const status = await invoke("get_opencode_runtime_status");
    lastOpenCodeStatus = status;
    if (!status || (!status.provider && !status.model)) {
      showToast(t("opencodeImportEmpty"), "warning");
      return;
    }
    openOpenCodeModal(null);
    $("opencodeProfileName").value = t("opencodeImportDefaultName");
    if (status.provider) $("opencodeProviderId").value = status.provider;
    $("opencodeBaseUrl").value = status.baseUrl || "";
    // 顶层 model 形如 provider/model，表单只需要模型名部分
    const modelRef = String(status.model || "");
    $("opencodeModel").value = modelRef.includes("/") ? modelRef.slice(modelRef.indexOf("/") + 1) : modelRef;
    showToast(t("opencodeImportPrefilled"), "success");
  } catch (error) {
    showToast(String(error), "error");
  }
}

// ── Codex Profile Management ────────────────────────

let editingCodexId = null;
let codexProfileSaving = false;

function getSelectedCodexPreset() {
  const presetId = $("codexPresetSelect")?.value || "";
  return CODEX_PRESETS.find((preset) => preset.id === presetId) || null;
}

function renderCodexPresetOptions() {
  const select = $("codexPresetSelect");
  if (!select) return;
  const currentValue = select.value;
  select.innerHTML = [
    `<option value="">${t("codexPresetCustom")}</option>`,
    ...CODEX_PRESETS.map((preset) => `<option value="${esc(preset.id)}">${esc(preset.name)}</option>`),
  ].join("");
  select.value = CODEX_PRESETS.some((preset) => preset.id === currentValue) ? currentValue : "";
}

function updateCodexPresetHint() {
  const hint = $("codexPresetHint");
  if (!hint) return;
  hint.classList.remove("warning");
  hint.textContent = t("codexPresetHintDefault");
}

function syncCodexWireApiControl(preset = getSelectedCodexPreset()) {
  const wireSelect = $("codexWireApi");
  if (!wireSelect) return;
  const providerName = preset?.providerName || $("codexProvider")?.value || "";
  const baseUrl = preset?.baseUrl || $("codexBaseUrl")?.value || "";
  const locked = preset?.id === "deepseek"
    || !!helpers.isDeepseekCodexConfig?.(providerName, baseUrl);
  if (locked) wireSelect.value = "responses";
  wireSelect.disabled = locked;
  setText("codexWireApiHint", t(locked ? "codexWireApiDeepseekHint" : "codexWireApiHint"));
}

function applyCodexPreset(preset) {
  if (!preset) {
    updateCodexPresetHint();
    syncCodexWireApiControl(null);
    return;
  }
  if (!$("codexProfileName").value.trim()) {
    $("codexProfileName").value = preset.name;
  }
  $("codexBaseUrl").value = preset.baseUrl;
  $("codexModel").value = preset.model;
  $("codexProvider").value = preset.providerName;
  if ($("codexWireApi")) $("codexWireApi").value = preset.wire || "responses";
  highlightPresetOverwrite(["codexProfileName", "codexBaseUrl", "codexModel", "codexProvider", "codexWireApi"]);
  updateProviderNameValidation("codex");
  clearEndpointResults("codex");
  clearProviderInlineStatus("codex");
  clearModelResults("codex");
  if (preset.models?.length) renderModelResults("codex", preset.models);
  syncCodexWireApiControl(preset);
  updateCodexPresetHint();
  updateCodexOfficialConfigPreview();
}

function getCodexAuthMode() {
  if ($("codexAuthModeSaveOnly")?.checked) return "save_only";
  if ($("codexAuthModeOfficial")?.checked) return "official_account_api_quota";
  return "auth_json";
}

function setCodexAuthMode(mode) {
  const official = mode === "official_account_api_quota";
  const saveOnly = mode === "save_only";
  if ($("codexAuthModeOfficial")) $("codexAuthModeOfficial").checked = official;
  if ($("codexAuthModeSaveOnly")) $("codexAuthModeSaveOnly").checked = saveOnly;
  if ($("codexAuthModeDefault")) $("codexAuthModeDefault").checked = !official && !saveOnly;
  updateCodexAuthModeUi();
}

function buildCodexOfficialConfig() {
  const baseUrl = $("codexBaseUrl").value.trim().replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  const apiKey = $("codexApiKey").value.trim().replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  return `model_provider = "customer"
model = "gpt-5.5"
review_model = "gpt-5.5"
model_reasoning_effort = "xhigh"
disable_response_storage = true
preferred_auth_method = "apikey"

[model_providers.customer]
name = "customer"
wire_api = "responses"
requires_openai_auth = true
base_url = "${baseUrl}"
experimental_bearer_token = "${apiKey}"`;
}

function updateCodexOfficialConfigPreview() {
  const preview = $("codexOfficialConfig");
  if (preview) preview.value = buildCodexOfficialConfig();
}

function updateCodexAuthModeUi() {
  const isOfficialMode = getCodexAuthMode() === "official_account_api_quota";
  if ($("codexOfficialConfigGroup")) {
    $("codexOfficialConfigGroup").style.display = isOfficialMode ? "block" : "none";
  }
  updateCodexOfficialConfigPreview();
}

async function copyCodexOfficialConfig() {
  updateCodexOfficialConfigPreview();
  try {
    await navigator.clipboard.writeText($("codexOfficialConfig").value);
    showToast(t("toastCopied"), "success");
  } catch (error) {
    showToast(String(error), "error");
  }
}

async function loadCodexProfiles() {
  try {
    const data = await invoke("get_codex_profiles");
    codexProfiles = data.profiles || [];
    renderCodexProfiles();
    renderNavigationStatus();
  } catch (error) {
    showToast(String(error), "error");
  }
}

function renderCodexProfiles() {
  const grid = $("codexProfilesGrid");
  if (!grid) return;

  if (codexProfiles.length === 0) {
    grid.innerHTML = `
      <div class="empty-state">
        <svg class="empty-state-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
          <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/>
          <polyline points="14 2 14 8 20 8"/>
          <line x1="12" y1="18" x2="12" y2="12"/>
          <line x1="9" y1="15" x2="15" y2="15"/>
        </svg>
        <div class="empty-state-title">${t("codexNoConfigsTitle")}</div>
        <p>${t("codexNoConfigsDesc")}</p>
      </div>`;
    updateCodexStatusTitle();
    return;
  }

  grid.innerHTML = codexProfiles.map((profile) => `
    <div class="profile-card ${profile.isActive ? "active" : ""}" data-id="${esc(profile.id)}" draggable="true">
      <div class="profile-header">
        ${profileDragHandleHtml()}
        <span class="profile-name">${esc(profile.name)}</span>
        ${profile.isActive ? `<span class="active-badge">${t("inUse")}</span>` : ""}
      </div>
      <div class="profile-body">
        <div class="profile-field">
          <span class="field-label">${t("codexApiKeyLabel")}</span>
          <span class="field-value">${esc(maskKey(profile.apiKey))}</span>
        </div>
        <div class="profile-field">
          <span class="field-label">${t("codexBaseUrlLabel")}</span>
          <span class="field-value">${esc(truncUrl(profile.baseUrl, 50))}</span>
        </div>
        ${profile.model ? `<div class="profile-field">
          <span class="field-label">${t("codexModelLabel")}</span>
          <span class="field-value">${esc(profile.model)}</span>
        </div>` : ""}
        ${profile.providerName ? `<div class="profile-field">
          <span class="field-label">${t("codexProviderLabel")}</span>
          <span class="field-value">${esc(profile.providerName)}</span>
        </div>` : ""}
        ${profile.wireApi === "chat" ? `<div class="profile-field">
          <span class="field-label">${t("codexWireApiLabel")}</span>
          <span class="field-value">Chat Completions</span>
        </div>` : ""}
        ${profile.imageApiKey ? `<div class="profile-field">
          <span class="field-label">${t("codexImageApiKeyLabel")}</span>
          <span class="field-value">${esc(maskKey(profile.imageApiKey))}</span>
        </div>` : ""}
        ${profile.imageApiKey && profile.imageBaseUrl ? `<div class="profile-field">
          <span class="field-label">${t("codexImageBaseUrlLabel")}</span>
          <span class="field-value">${esc(truncUrl(profile.imageBaseUrl, 50))}</span>
        </div>` : ""}
        ${profileBalanceRowHtml("codex", profile)}
      </div>
      <div class="profile-actions">
        ${profile.isActive ? "" : `<button class="btn btn-switch btn-sm" data-action="codex-switch" data-id="${profile.id}" type="button">${t("switchUse")}</button>`}
        <button class="btn btn-secondary btn-sm" data-action="codex-edit" data-id="${profile.id}" type="button">${t("edit")}</button>
        <button class="btn btn-danger btn-sm" data-action="codex-delete" data-id="${profile.id}" type="button">${t("delete")}</button>
      </div>
    </div>
  `).join("");

  bindProfileGridActions(grid, "CodexProfiles", "codex");
  bindProfileGridDragSort(grid, "codex");
  autoRefreshProfileBalances("codex");
  updateCodexStatusTitle();
}

function updateCodexStatusTitle() {
  const active = codexProfiles.find((p) => p.isActive);
  const activeContext = active
    ? (currentLang === "zh" ? ` (当前: ${active.name})` : ` (Current: ${active.name})`)
    : "";
  setText("codexStatusSectionTitle", `${t("codexStatusTitle")}${activeContext}`);
}

async function loadCodexStatus() {
  try {
    const status = await invoke("get_codex_status");
    lastCodexStatus = status;
    const grid = $("codexStatusGrid");
    if (status?.accountLogin) {
      if (grid) grid.innerHTML = `<div class="status-card"><div class="status-card-title">Codex · ${currentLang === "zh" ? "账号登录" : "Account login"}</div><p>${currentLang === "zh" ? "已配置 ChatGPT 账号登录，请重新打开 Codex 完成登录。" : "ChatGPT account login configured. Reopen Codex to sign in."}</p></div>`;
      renderNavigationStatus();
      return;
    }
    if (!status || !status.apiKey) {
      if (grid) {
        grid.innerHTML = `<div class="status-card" style="display:flex;align-items:center;justify-content:center;color:var(--text-muted);font-size:13px;">Codex: --</div>`;
      }
      renderNavigationStatus();
      return;
    }
    const COPY_ICON = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>`;
    grid.innerHTML = `
      <div class="status-card">
        <div class="status-card-title">
          <span class="status-card-title-text">${productIcon("codex")}Codex</span>
        </div>
        <div class="status-item">
          <span class="status-label">${t("codexApiKeyLabel")}</span>
          <div class="status-value-wrapper">
            <span class="status-value">${esc(maskKey(status.apiKey))}</span>
            <button class="copy-btn" type="button" data-copy="${esc(status.apiKey || "")}" title="Copy">${COPY_ICON}</button>
          </div>
        </div>
        <div class="status-item">
          <span class="status-label">${t("codexBaseUrlLabel")}</span>
          <div class="status-value-wrapper">
            <span class="status-value has-tooltip" data-tooltip="${esc(status.baseUrl || "")}" title="${esc(status.baseUrl || "")}">${esc(status.baseUrl || "--")}</span>
            <button class="copy-btn" type="button" data-copy="${esc(status.baseUrl || "")}" title="Copy">${COPY_ICON}</button>
          </div>
        </div>
        <div class="status-item">
          <span class="status-label">${currentLang === "zh" ? "Codex 模型" : "Codex Model"}</span>
          <div class="status-value-wrapper">
            <span class="status-value" title="${esc(status.model || "--")}">${esc(status.model || "--")}</span>
            ${status.model ? `<button class="copy-btn" type="button" data-copy="${esc(status.model)}" title="${t("copy")}" aria-label="${t("copy")}">${COPY_ICON}</button>` : ""}
          </div>
        </div>
        ${status.imageApiKey ? `<div class="status-item">
          <span class="status-label">${t("codexImageApiKeyLabel")}</span>
          <div class="status-value-wrapper">
            <span class="status-value">${esc(maskKey(status.imageApiKey))}</span>
            <button class="copy-btn" type="button" data-copy="${esc(status.imageApiKey || "")}" title="Copy">${COPY_ICON}</button>
          </div>
        </div>
        <div class="status-item">
          <span class="status-label">${t("codexImageBaseUrlLabel")}</span>
          <div class="status-value-wrapper">
            <span class="status-value has-tooltip" data-tooltip="${esc(status.imageBaseUrl || "")}" title="${esc(status.imageBaseUrl || "")}">${esc(status.imageBaseUrl || "--")}</span>
            <button class="copy-btn" type="button" data-copy="${esc(status.imageBaseUrl || "")}" title="Copy">${COPY_ICON}</button>
          </div>
        </div>
        <div class="status-item">
          <span class="status-label">${t("codexImageSectionTitle")}</span>
          <div class="status-value-wrapper">
            <span class="status-value">${t(status.imageSkillInstalled ? "codexImageSkillReady" : "codexImageSkillNeedsSwitch")}</span>
          </div>
        </div>` : ""}
      </div>`;
    if (grid) {
      bindDelegatedCopyButtons(grid, "CodexStatusCopy");
    }
    renderNavigationStatus();
  } catch (error) {
    console.error("Failed to load codex status:", error);
  }
}

function openCodexModal(profile) {
  editingCodexId = profile ? profile.id : null;
  codexEnableAfterSave = false;
  if ($("codexSaveAndActivate")) $("codexSaveAndActivate").checked = false;
  $("codexModalTitle").textContent = profile ? t("codexEditConfig") : t("codexAddConfig");
  $("codexProfileId").value = editingCodexId || "";
  const matchedPreset = profile && helpers.isDeepseekCodexConfig?.(profile.providerName, profile.baseUrl)
    ? CODEX_PRESETS.find((preset) => preset.id === "deepseek")
    : null;
  if ($("codexPresetSelect")) $("codexPresetSelect").value = matchedPreset?.id || "";
  if ($("codexProfileName")) $("codexProfileName").value = profile ? profile.name : "";
  if ($("codexApiKey")) {
    $("codexApiKey").value = profile ? profile.apiKey : "";
    $("codexApiKey").type = "password";
  }
  if ($("codexApiKeyToggle")) {
    $("codexApiKeyToggle").setAttribute("aria-label", currentLang === "zh" ? "显示 API Key" : "Show API Key");
    $("codexApiKeyToggle").title = currentLang === "zh" ? "显示 API Key" : "Show API Key";
  }
  if ($("codexBaseUrl")) $("codexBaseUrl").value = profile ? profile.baseUrl : "";
  if ($("codexModel")) $("codexModel").value = profile ? (profile.model || "") : "";
  if ($("codexWireApi")) $("codexWireApi").value = profile ? (profile.wireApi || "responses") : "responses";
  if ($("codexProvider")) $("codexProvider").value = profile ? (profile.providerName || "") : "";
  if ($("codexImageApiKey")) $("codexImageApiKey").value = profile ? (profile.imageApiKey || "") : "";
  if ($("codexImageBaseUrl")) $("codexImageBaseUrl").value = profile ? (profile.imageBaseUrl || "") : "";
  setCodexAuthMode(profile ? (profile.authMode || "auth_json") : "auth_json");
  // 有高级字段时自动展开高级选项，避免用户找不到已保存的内容
  const advanced = $("codexAdvancedSection");
  if (advanced) {
    advanced.open = !!(profile && (
      (profile.authMode && profile.authMode !== "auth_json")
      || profile.providerName
      || profile.imageApiKey
      || profile.imageBaseUrl
    ));
  }
  updateCodexPresetHint();
  clearEndpointResults("codex");
  clearProviderInlineStatus("codex");
  clearModelResults("codex");
  updateProviderNameValidation("codex");
  if (matchedPreset?.models?.length) renderModelResults("codex", matchedPreset.models);
  syncCodexWireApiControl(matchedPreset);
  $("codexModalOverlay").classList.add("open");
  document.body.classList.add("modal-open");
  setTimeout(() => {
    if (profile) $("codexProfileName")?.focus();
    else $("codexPresetSelect")?.focus();
  }, 20);
}

function closeCodexModal() {
  $("codexModalOverlay").classList.remove("open");
  document.body.classList.remove("modal-open");
  editingCodexId = null;
}

async function handleCodexSubmit(event) {
  event.preventDefault();
  if (codexProfileSaving) return;
  const isNewProfile = !editingCodexId;
  const editingActiveProfile = codexProfiles.some((profile) => profile.id === editingCodexId && profile.isActive);
  const name = $("codexProfileName").value.trim();
  if (!updateProviderNameValidation("codex")) return;
  const apiKey = $("codexApiKey").value.trim();
  const baseUrl = $("codexBaseUrl").value.trim();
  const model = $("codexModel").value.trim();
  const providerName = $("codexProvider").value.trim();
  const deepseekNative = !!helpers.isDeepseekCodexConfig?.(providerName, baseUrl);
  const wireApi = deepseekNative
    ? "responses"
    : ($("codexWireApi")?.value === "chat" ? "chat" : "responses");
  const imageApiKey = $("codexImageApiKey").value.trim();
  const imageBaseUrl = $("codexImageBaseUrl").value.trim();
  if (!name) {
    showToast(currentLang === "zh" ? "请填写配置名称" : "Config name is required", "warning");
    return;
  }
  if (!apiKey) {
    showToast(currentLang === "zh" ? "请填写 API Key" : "API Key is required", "warning");
    return;
  }
  let authMode = getCodexAuthMode();
  // save_only：前端仅保存配置，后端仍用 auth_json 字段存储，不自动切换
  const saveOnly = authMode === "save_only";
  if (saveOnly) authMode = "auth_json";
  const saveAndActivate = Boolean($("codexSaveAndActivate")?.checked);
  const enableAfter = (codexEnableAfterSave || saveAndActivate || editingActiveProfile) && !saveOnly;
  codexEnableAfterSave = false;

  codexProfileSaving = true;
  const submitButton = $("codexSubmitBtn");
  setButtonBusy(submitButton, true, t("toastSaving"));
  try {
    let savedId = editingCodexId;
    if (editingCodexId) {
      await invoke("update_codex_profile", { id: editingCodexId, name, apiKey, baseUrl, model: model || null, providerName: providerName || null, authMode, wireApi, imageApiKey: imageApiKey || null, imageBaseUrl: imageBaseUrl || null });
      showToast(t("codexToastUpdated"), "success");
    } else {
      const created = await invoke("add_codex_profile", { name, apiKey, baseUrl, model: model || null, providerName: providerName || null, authMode, wireApi, imageApiKey: imageApiKey || null, imageBaseUrl: imageBaseUrl || null });
      savedId = created?.id || created?.profile?.id || null;
      showToast(t("codexToastAdded"), "success");
    }
    closeCodexModal();
    await loadCodexProfiles();
    if (!savedId) {
      const found = codexProfiles.find((p) => p.name === name);
      savedId = found?.id || null;
    }
    if (enableAfter && savedId) {
      await handleCodexSwitch(savedId);
    } else {
      await loadCodexStatus();
    }
    if (isNewProfile) switchConsolePage("codex");
  } catch (error) {
    showToast(String(error), "error");
  } finally {
    codexProfileSaving = false;
    setButtonBusy(submitButton, false);
  }
}

// A10: 切换/删除逻辑统一走 PROVIDER_CONFIG 驱动的公共实现
async function handleCodexAccountLogin() {
  const button = $("codexAccountLoginBtn");
  if (button?.disabled) return;
  setButtonBusy(button, true);
  try {
    await invoke("switch_codex_to_account_login");
    await loadCodexProfiles();
    await loadCodexStatus();
    showToast(currentLang === "zh"
      ? "已切换为账号登录，请重新打开 Codex 并使用 ChatGPT 账号登录。"
      : "Account login configured. Reopen Codex and sign in with ChatGPT.", "success");
  } catch (error) {
    showToast(String(error), "error");
  } finally {
    setButtonBusy(button, false);
  }
}

async function handleCodexSwitch(id) {
  return switchProviderProfile("codex", id);
}

async function handleCodexDelete(id) {
  return deleteProviderProfile("codex", id);
}

async function handleCodexImport() {
  const input = await appPrompt(
    currentLang === "zh"
      ? "系统将从本地 Codex 配置文件读取 API Key、Base URL、模型等信息，并保存为一个新的 VarSwitch 配置项。"
      : "Import current Codex runtime files as a new profile.",
    t("codexImportDefaultName"),
    {
      title: currentLang === "zh" ? "导入当前 Codex 配置" : "Import Codex Config",
      inputLabel: currentLang === "zh" ? "配置名称" : "Config name",
      confirmText: currentLang === "zh" ? "导入配置" : "Import",
    }
  );
  if (input === null) return;
  const name = String(input).trim() || t("codexImportDefaultName");
  try {
    await invoke("import_codex_current", { name });
    showToast(t("codexToastImported"), "success");
    await loadCodexProfiles();
    await loadCodexStatus();
  } catch (error) {
    showToast(String(error), "error");
  }
}

// ── Skills Management ───────────────────────────────

function openSkillsPanel() {
  openDeveloperTools("skills");
}

function closeSkillsPanel() {
  hideSkillsEdit();
}

function switchSkillsTab(tab) {
  activeSkillsTab = tab;
  $("skillsTabInstalled").classList.toggle("active", tab === "installed");
  $("skillsTabDiscover").classList.toggle("active", tab === "discover");
  $("skillsInstalledContent").style.display = tab === "installed" ? "" : "none";
  $("skillsDiscoverContent").style.display = tab === "discover" ? "" : "none";

  if (tab === "discover" && discoverSkills.length === 0 && !isDiscovering) {
    discoverSkillsFromRepos();
  }
}

async function loadSkills() {
  try {
    skillsData = await invoke("get_skills");
    renderSkills();
  } catch (error) {
    showToast(String(error), "error");
  }
}

function renderSkills() {
  const list = $("skillsList");
  if (skillsData.length === 0) {
    list.innerHTML = `<div class="mgmt-empty">${t("noSkills")}</div>`;
    return;
  }

  list.innerHTML = skillsData.map((skill) => {
    const isSkillType = skill.sourceType === "skill";
    const typeLabel = isSkillType ? t("sourceSkill") : t("sourceCommand");
    const typeBadge = `<span class="skill-card-badge ${isSkillType ? "installed" : "repo"}">${typeLabel}</span>`;
    const prefix = isSkillType ? "" : "/";
    // 显示描述：优先用 frontmatter 中的 description，否则取内容第一行
    const desc = skill.description || (skill.content || "").split("\n").find((l) => l.trim() && !l.startsWith("---")) || "";

    return `
    <div class="mgmt-item">
      <div class="mgmt-item-info">
        <div class="mgmt-item-name">${prefix}${esc(skill.name)} ${typeBadge}</div>
        <div class="mgmt-item-desc">${esc(desc.substring(0, 100))}</div>
      </div>
      <div class="mgmt-item-actions">
        <button class="btn btn-secondary btn-sm" data-action="edit-skill" data-name="${esc(skill.name)}" data-source-type="${esc(skill.sourceType || "command")}">${t("edit")}</button>
        <button class="btn btn-danger btn-sm" data-action="delete-skill" data-name="${esc(skill.name)}" data-source-type="${esc(skill.sourceType || "command")}">${t("delete")}</button>
      </div>
    </div>
    `;
  }).join("");

  // A10: 容器级委托，避免每次重建列表都逐个按钮绑定
  bindDelegatedActions(list, "SkillsList", (action, target) => {
    const name = target.getAttribute("data-name");
    const sourceType = target.getAttribute("data-source-type") || "command";
    if (action === "edit-skill") showSkillsEdit(name, sourceType);
    else if (action === "delete-skill") handleDeleteSkill(name, sourceType);
  });
}

function showSkillsEdit(name, sourceType) {
  editingSkillName = name || null;
  const skill = name ? skillsData.find((s) => s.name === name) : null;
  $("skillNameInput").value = skill ? skill.name : "";
  $("skillContentInput").value = skill ? skill.content : "";
  $("skillNameInput").disabled = !!name;
  // 记录当前编辑的 sourceType
  $("skillsEdit").dataset.sourceType = sourceType || (skill ? skill.sourceType : "command") || "command";
  $("skillsList").style.display = "none";
  $("skillsToolbar").style.display = "none";
  $("skillsEdit").style.display = "";
}

function hideSkillsEdit() {
  $("skillsList").style.display = "";
  $("skillsToolbar").style.display = "";
  $("skillsEdit").style.display = "none";
  editingSkillName = null;
}

async function handleSaveSkill() {
  if (skillSaving) return;
  const name = $("skillNameInput").value.trim();
  const content = $("skillContentInput").value;
  const sourceType = $("skillsEdit").dataset.sourceType || "command";
  if (!name) return;

  skillSaving = true;
  const saveBtn = $("skillSaveBtn");
  setButtonBusy(saveBtn, true, t("toastSaving"));
  try {
    await invoke("save_skill", { name, content, sourceType });
    showToast(t("toastSkillSaved"), "success");
    hideSkillsEdit();
    await loadSkills();
  } catch (error) {
    showToast(String(error), "error");
  } finally {
    skillSaving = false;
    setButtonBusy(saveBtn, false);
  }
}

async function handleDeleteSkill(name, sourceType) {
  const confirmed = await appConfirm(t("confirmDeleteSkill", { name }), {
    title: t("delete"),
    danger: true,
    confirmText: currentLang === "zh" ? "删除" : "Delete",
  });
  if (!confirmed) return;
  try {
    await invoke("delete_skill", { name, sourceType: sourceType || "command" });
    showToast(t("toastSkillDeleted"), "success");
    await loadSkills();
  } catch (error) {
    showToast(String(error), "error");
  }
}

// ── Skills ZIP 安装（本地 ZIP → Claude / Codex 多应用落盘）───

let zipInstallPath = null;
let zipInstalling = false;

/** 点击「从 ZIP 安装」：选文件 → 弹出目标应用确认层 */
async function handlePickSkillZip() {
  try {
    const path = await invoke("pick_skill_zip");
    if (!path) return; // 用户取消选择
    zipInstallPath = path;
    $("zipInstallFileName").textContent = path.split(/[\\/]/).pop() || path;
    $("zipAppClaude").checked = true;
    $("zipAppCodex").checked = false;
    $("zipInstallOverlay").classList.add("open");
  } catch (error) {
    showToast(String(error), "error");
  }
}

function closeZipInstall() {
  $("zipInstallOverlay").classList.remove("open");
  zipInstallPath = null;
}

async function handleZipInstallConfirm() {
  if (zipInstalling || !zipInstallPath) return;
  const apps = {
    claude: $("zipAppClaude").checked,
    codex: $("zipAppCodex").checked,
  };
  if (!apps.claude && !apps.codex) {
    showToast(t("zipNoAppSelected"), "error");
    return;
  }

  zipInstalling = true;
  const confirmBtn = $("zipInstallConfirm");
  setButtonBusy(confirmBtn, true, t("toastSaving"));
  try {
    const result = await invoke("install_skill_from_zip", {
      path: zipInstallPath,
      apps,
      overwrite: false,
    });
    await onZipSkillInstalled(result);
  } catch (error) {
    const msg = String(error);
    // 后端约定：目标已存在时返回 EXISTS:<name>，确认后带 overwrite=true 重试
    if (msg.startsWith("EXISTS:")) {
      const name = msg.slice("EXISTS:".length);
      const confirmed = await appConfirm(t("zipOverwriteConfirm", { name }), {
        title: t("zipInstallTitle"),
        danger: true,
      });
      if (confirmed) {
        try {
          const result = await invoke("install_skill_from_zip", {
            path: zipInstallPath,
            apps,
            overwrite: true,
          });
          await onZipSkillInstalled(result);
        } catch (retryError) {
          showToast(String(retryError), "error");
        }
      }
    } else {
      showToast(msg, "error");
    }
  } finally {
    zipInstalling = false;
    setButtonBusy(confirmBtn, false);
  }
}

/** 安装成功后的收尾：提示安装到了哪些应用并刷新 Installed 列表 */
async function onZipSkillInstalled(result) {
  const appNames = { claude: "Claude", codex: "Codex" };
  const apps = (result.installedTo || [])
    .map((key) => appNames[key] || key)
    .join(" / ");
  showToast(t("toastZipInstalledTo", { name: result.name, apps }), "success");
  closeZipInstall();
  await loadSkills();
}

// ── Skills Discovery Functions ──────────────────────

async function loadSkillRepos() {
  try {
    skillRepos = await invoke("get_skill_repos");
  } catch (error) {
    showToast(String(error), "error");
  }
}

function renderRepoFilter() {
  const select = $("discoverRepoFilter");
  const current = select.value;
  select.innerHTML = `<option value="all">${t("allRepos")}</option>`;
  const sources = new Set();
  discoverSkills.forEach((s) => {
    if (s.source && !sources.has(s.source)) {
      sources.add(s.source);
      const opt = document.createElement("option");
      opt.value = s.source;
      opt.textContent = s.source;
      select.appendChild(opt);
    }
  });
  select.value = current || "all";
}

async function discoverSkillsFromRepos() {
  if (isDiscovering) return;
  isDiscovering = true;
  isShowingGithubSkills = false;
  $("discoverLoading").style.display = "";
  $("discoverGrid").innerHTML = "";
  $("discoverGithubBanner").style.display = "none";
  $("discoverRepoFilter").style.display = "";
  $("discoverStatusFilter").style.display = "";

  try {
    // Load curated catalog (instant, no network)
    discoverSkills = await invoke("get_catalog_skills");
    renderRepoFilter();
    renderDiscoverGrid();
  } catch (error) {
    const errMsg = String(error);
    showToast(errMsg, "error");
    $("discoverGrid").innerHTML = `<div class="discover-empty">${esc(errMsg)}</div>`;
  } finally {
    isDiscovering = false;
    $("discoverLoading").style.display = "none";
  }
}

async function searchGitHubSkills() {
  // 防并发：与 discoverSkillsFromRepos 共用同一守卫
  if (isDiscovering) return;
  const query = $("discoverSearch").value.trim();
  if (!query) {
    // 没有搜索词时回到目录
    backToCatalog();
    return;
  }

  isDiscovering = true;
  isShowingGithubSkills = true;
  $("discoverLoading").style.display = "";
  $("discoverGrid").innerHTML = "";
  $("discoverGithubBanner").style.display = "";
  // GitHub 搜索时隐藏目录筛选器
  $("discoverRepoFilter").style.display = "none";
  $("discoverStatusFilter").style.display = "none";

  try {
    const results = await invoke("search_github_skills", { query });
    discoverSkills = results || [];
    renderDiscoverGrid();
    if (discoverSkills.length === 0) {
      $("discoverGrid").innerHTML = `<div class="discover-empty">${t("discoverNoMatch")}</div>`;
    }
  } catch (error) {
    showToast(String(error), "error");
    $("discoverGrid").innerHTML = `<div class="discover-empty">${esc(String(error))}</div>`;
  } finally {
    isDiscovering = false;
    $("discoverLoading").style.display = "none";
  }
}

function backToCatalog() {
  isShowingGithubSkills = false;
  $("discoverSearch").value = "";
  discoverSearchQuery = "";
  $("discoverGithubBanner").style.display = "none";
  $("discoverRepoFilter").style.display = "";
  $("discoverStatusFilter").style.display = "";
  discoverSkills = [];
  discoverSkillsFromRepos();
}

function renderDiscoverGrid() {
  const grid = $("discoverGrid");
  let filtered = [...discoverSkills];

  if (!isShowingGithubSkills) {
    // 仅在目录模式下应用筛选器
    if (discoverRepoFilter !== "all") {
      filtered = filtered.filter((s) => s.source === discoverRepoFilter);
    }

    if (discoverStatusFilter === "installed") {
      filtered = filtered.filter((s) => s.installed);
    } else if (discoverStatusFilter === "not-installed") {
      filtered = filtered.filter((s) => !s.installed);
    }

    // 本地搜索过滤（目录模式）
    if (discoverSearchQuery.trim()) {
      const q = discoverSearchQuery.toLowerCase();
      filtered = filtered.filter((s) =>
        s.name.toLowerCase().includes(q) ||
        s.description.toLowerCase().includes(q) ||
        (s.descriptionZh || "").toLowerCase().includes(q) ||
        s.category.toLowerCase().includes(q)
      );
    }
  }

  if (filtered.length === 0) {
    grid.innerHTML = `<div class="discover-empty">${discoverSkills.length === 0 ? t("discoverEmpty") : t("discoverNoMatch")}</div>`;
    return;
  }

  grid.innerHTML = filtered.map((skill) => {
    const desc = currentLang === "zh" ? (skill.descriptionZh || skill.description) : skill.description;
    const starsHtml = skill.stars ? `<span class="skill-card-badge">\u2605 ${esc(String(skill.stars))}</span>` : "";
    const repoLink = skill.repoUrl ? `<button class="btn btn-secondary btn-sm" data-action="open-skill-url" data-url="${esc(skill.repoUrl)}">${t("mcpGithubBtn")}</button>` : "";
    return `
    <div class="skill-card">
      <div class="skill-card-header">
        <div class="skill-card-name">${esc(skill.name)}</div>
        ${skill.installed ? `<span class="skill-card-badge installed">${t("installedBadge")}</span>` : ""}
      </div>
      ${desc ? `<div class="skill-card-desc">${esc(desc)}</div>` : ""}
      <div class="skill-card-meta">
        <span class="skill-card-badge repo">${esc(skill.source)}</span>
        ${skill.category ? `<span class="skill-card-badge">${esc(skill.category)}</span>` : ""}
        ${starsHtml}
      </div>
      <div class="skill-card-actions">
        ${skill.installed
          ? `<button class="btn btn-secondary btn-sm" disabled>${t("installedBadge")}</button>`
          : `<button class="btn btn-primary btn-sm" data-action="install-catalog" data-name="${esc(skill.name)}" data-url="${esc(skill.downloadUrl || "")}">${t("installBtn")}</button>`
        }
        ${repoLink}
      </div>
    </div>
    `;
  }).join("");

  // A10: 容器级委托。btn 就是被点中的那个按钮，禁用/改文案的行为与原来一致
  bindDelegatedActions(grid, "DiscoverGrid", async (action, btn) => {
    if (action === "open-skill-url") {
      const url = btn.getAttribute("data-url");
      if (url) await invoke("open_external_target", { target: url });
      return;
    }
    if (action !== "install-catalog") return;
    const name = btn.getAttribute("data-name");
    const url = btn.getAttribute("data-url");
    if (btn.disabled) return; // 防重复提交
    btn.disabled = true;
    btn.textContent = "...";
    try {
      await invoke("install_skill_from_url", { name, url });
      showToast(t("toastSkillInstalled", { name }), "success");
      // Update local state
      const skill = discoverSkills.find((s) => s.name === name);
      if (skill) skill.installed = true;
      renderDiscoverGrid();
      await loadSkills();
    } catch (error) {
      showToast(String(error), "error");
      btn.disabled = false;
      btn.textContent = t("installBtn");
    }
  });
}

// ── Repo Manager ─────────────────────────────────────

function openRepoManager() {
  $("repoManagerOverlay").classList.add("open");
  renderRepoList();
}

function closeRepoManager() {
  $("repoManagerOverlay").classList.remove("open");
}

function renderRepoList() {
  const list = $("repoList");
  if (skillRepos.length === 0) {
    list.innerHTML = `<div class="mgmt-empty">${t("discoverEmpty")}</div>`;
    return;
  }
  list.innerHTML = skillRepos.map((repo) => {
    const match = repo.url.match(/github\.com\/([^/]+\/[^/]+)/);
    const label = match ? match[1] : repo.url;
    return `
    <div class="mgmt-item">
      <div class="mgmt-item-info">
        <div class="mgmt-item-name">${esc(label)}</div>
        <div class="mgmt-item-desc">${esc(repo.branch)} branch</div>
      </div>
      <div class="mgmt-item-actions">
        <button class="btn btn-danger btn-sm" data-action="remove-repo" data-url="${esc(repo.url)}">${t("delete")}</button>
      </div>
    </div>
    `;
  }).join("");

  // A10: 容器级委托
  bindDelegatedActions(list, "RepoList", (action, target) => {
    if (action === "remove-repo") handleRemoveRepo(target.getAttribute("data-url"));
  });
}

async function handleAddRepo() {
  if (repoAdding) return;
  const url = $("repoUrlInput").value.trim();
  if (!url) return;

  repoAdding = true;
  const addBtn = $("addRepoBtn");
  setButtonBusy(addBtn, true, t("toastSaving"));
  try {
    await invoke("add_skill_repo", { url, branch: "main" });
    $("repoUrlInput").value = "";
    showToast(t("toastRepoAdded"), "success");
    await loadSkillRepos();
    renderRepoList();
  } catch (error) {
    showToast(String(error), "error");
  } finally {
    repoAdding = false;
    setButtonBusy(addBtn, false);
  }
}

async function handleRemoveRepo(url) {
  try {
    await invoke("remove_skill_repo", { url });
    showToast(t("toastRepoRemoved"), "success");
    await loadSkillRepos();
    renderRepoList();
  } catch (error) {
    showToast(String(error), "error");
  }
}

// ── Prompts Management ──────────────────────────────

function openPromptsPanel() {
  openDeveloperTools("prompts");
}

// 表驱动，新增 tab 只需在这里加一行，不会漏掉按钮高亮或内容显隐
const PROMPT_TABS = [
  { id: "presets", button: "promptTabPresets", content: "promptPresetsContent" },
  { id: "editor", button: "promptTabEditor", content: "promptEditorContent" },
  { id: "templates", button: "promptTabTemplates", content: "promptTemplatesContent" },
];

function switchPromptTab(tab) {
  const target = PROMPT_TABS.some((item) => item.id === tab) ? tab : PROMPT_TABS[0].id;
  activePromptTab = target;
  for (const item of PROMPT_TABS) {
    const active = item.id === target;
    $(item.button)?.classList.toggle("active", active);
    const content = $(item.content);
    if (content) content.style.display = active ? "" : "none";
  }
}

async function loadClaudeMd() {
  try {
    const content = await invoke("get_claude_md");
    $("promptContentInput").value = content;
  } catch (error) {
    showToast(String(error), "error");
  }
}

async function loadPromptTemplates() {
  try {
    promptTemplates = await invoke("get_prompt_templates");
    renderPromptTemplates();
    renderSnippetDropdown();
  } catch (error) {
    showToast(String(error), "error");
  }
}

function renderPromptTemplates() {
  const grid = $("promptTemplatesGrid");
  if (!promptTemplates || promptTemplates.length === 0) {
    grid.innerHTML = `<div class="discover-empty">No templates available.</div>`;
    return;
  }

  grid.innerHTML = promptTemplates.map((tpl) => {
    const name = currentLang === "zh" ? (tpl.nameZh || tpl.name) : tpl.name;
    const desc = currentLang === "zh" ? (tpl.descZh || tpl.desc) : tpl.desc;
    const category = tpl.category || "";
    return `
    <div class="prompt-template-card" data-id="${esc(tpl.id)}">
      <div class="prompt-template-name">${esc(name)}</div>
      ${category ? `<span class="skill-card-badge">${esc(category)}</span>` : ""}
      <div class="prompt-template-desc">${esc(desc)}</div>
      <div class="prompt-template-actions">
        <button class="btn btn-secondary btn-sm" data-action="append-template" data-id="${esc(tpl.id)}">${t("appendToPrompt")}</button>
        <button class="btn btn-primary btn-sm" data-action="replace-template" data-id="${esc(tpl.id)}">${t("replacePrompt")}</button>
        <button class="btn btn-secondary btn-sm" data-action="preset-template" data-id="${esc(tpl.id)}">${t("templateSaveAsPreset")}</button>
      </div>
    </div>
    `;
  }).join("");

  // A10: 容器级委托
  bindDelegatedActions(grid, "PromptTemplates", (action, target, e) => {
    e.stopPropagation();
    const id = target.getAttribute("data-id");
    const tpl = promptTemplates.find((t) => t.id === id);
    if (!tpl) return;
    if (action === "append-template") {
      const current = $("promptContentInput").value;
      $("promptContentInput").value = current ? current + "\n\n" + tpl.content : tpl.content;
      switchPromptTab("editor");
      showToast(t("toastSnippetInserted"), "success");
    } else if (action === "replace-template") {
      $("promptContentInput").value = tpl.content;
      switchPromptTab("editor");
      showToast(t("toastTemplateApplied"), "success");
    } else if (action === "preset-template") {
      // 把模板内容直接创建为新预设
      handleSaveTemplateAsPreset(tpl);
    }
  });
}

function renderSnippetDropdown() {
  const select = $("promptInsertSelect");
  select.innerHTML = `<option value="">${t("insertSnippet")}</option>`;
  if (promptTemplates) {
    promptTemplates.forEach((tpl) => {
      const name = currentLang === "zh" ? (tpl.nameZh || tpl.name) : tpl.name;
      const opt = document.createElement("option");
      opt.value = tpl.id;
      opt.textContent = name;
      select.appendChild(opt);
    });
  }
}

async function handleSavePrompt() {
  const content = $("promptContentInput").value;
  try {
    await invoke("save_claude_md", { content });
    showToast(t("toastPromptSaved"), "success");
  } catch (error) {
    showToast(String(error), "error");
  }
}

// ── Prompt Presets（预设库 + 跨应用同步 + 回填保护）──────────

// 预设支持的目标应用；顺序与后端回填优先级一致（claude > codex > gemini）
const PRESET_APPS = [
  { key: "claude", label: "Claude", badge: "C", fallbackPath: "~/.claude/CLAUDE.md" },
  { key: "codex", label: "Codex", badge: "X", fallbackPath: "~/.codex/AGENTS.md" },
  { key: "gemini", label: "Gemini", badge: "G", fallbackPath: "~/.gemini/GEMINI.md" },
];

async function loadPromptPresets() {
  try {
    promptPresetsData = await invoke("get_prompt_presets");
    renderPromptPresets();
  } catch (error) {
    showToast(String(error), "error");
  }
}

/** 取某应用 live 文件的实际路径（后端返回），拿不到时退回默认展示路径。 */
function promptPresetLivePath(appKey) {
  const info = promptPresetsData?.live?.[appKey];
  if (info && info.path) return info.path;
  return PRESET_APPS.find((a) => a.key === appKey)?.fallbackPath || appKey;
}

function renderPromptPresets() {
  const list = $("promptPresetList");
  if (!list) return;
  const presets = promptPresetsData?.presets || [];
  const activeId = promptPresetsData?.activeId || null;
  if (presets.length === 0) {
    list.innerHTML = `<div class="discover-empty">${t("presetEmpty")}</div>`;
    return;
  }
  list.innerHTML = presets.map((preset) => {
    const isActive = preset.id === activeId;
    const badges = PRESET_APPS
      .filter((a) => preset.apps?.[a.key])
      .map((a) => `<span class="preset-app-badge preset-app-${a.key}" title="${esc(a.label)}">${a.badge}</span>`)
      .join("");
    return `
    <div class="prompt-preset-item${isActive ? " active" : ""}" data-id="${esc(preset.id)}">
      <div class="prompt-preset-item-head">
        <span class="prompt-preset-item-name">${esc(preset.name || "")}</span>
        <span class="prompt-preset-badges">${badges}${isActive ? `<span class="preset-active-badge">${t("presetActive")}</span>` : ""}</span>
      </div>
      <div class="prompt-preset-item-actions">
        <button class="btn btn-primary btn-sm" data-action="activate-preset" data-id="${esc(preset.id)}"${isActive ? " disabled" : ""}>${t("presetActivate")}</button>
        <button class="btn btn-secondary btn-sm" data-action="edit-preset" data-id="${esc(preset.id)}">${t("presetEdit")}</button>
        <button class="btn btn-secondary btn-sm" data-action="delete-preset" data-id="${esc(preset.id)}">${t("presetDelete")}</button>
      </div>
    </div>`;
  }).join("");

  // A10: 容器级委托
  bindDelegatedActions(list, "PromptPresets", (action, target, e) => {
    e.stopPropagation();
    const id = target.getAttribute("data-id");
    if (action === "activate-preset") {
      handleActivatePromptPreset(id);
    } else if (action === "edit-preset") {
      const preset = (promptPresetsData?.presets || []).find((p) => p.id === id);
      if (preset) showPromptPresetEditor(preset);
    } else if (action === "delete-preset") {
      handleDeletePromptPreset(id);
    }
  });
}

/** 填充右侧编辑区；preset 为 null 表示新建（默认勾选 claude）。 */
function showPromptPresetEditor(preset) {
  editingPromptPresetId = preset?.id || null;
  $("promptPresetNameInput").value = preset?.name || "";
  $("presetAppClaude").checked = preset ? !!preset.apps?.claude : true;
  $("presetAppCodex").checked = !!preset?.apps?.codex;
  $("presetAppGemini").checked = !!preset?.apps?.gemini;
  $("promptPresetContentInput").value = preset?.content || "";
  $("promptPresetNameInput").focus();
}

function collectPromptPresetApps() {
  return {
    claude: $("presetAppClaude").checked,
    codex: $("presetAppCodex").checked,
    gemini: $("presetAppGemini").checked,
  };
}

async function handleSavePromptPreset() {
  const name = $("promptPresetNameInput").value.trim();
  if (!name) {
    showToast(t("presetNeedName"), "error");
    return;
  }
  const apps = collectPromptPresetApps();
  if (!apps.claude && !apps.codex && !apps.gemini) {
    showToast(t("presetNeedApp"), "error");
    return;
  }
  try {
    promptPresetsData = await invoke("save_prompt_preset", {
      id: editingPromptPresetId,
      name,
      content: $("promptPresetContentInput").value,
      apps,
    });
    // 新建保存后，继续编辑同一条（按名称定位刚创建的预设）
    if (!editingPromptPresetId) {
      const created = (promptPresetsData?.presets || []).slice(-1)[0];
      if (created) editingPromptPresetId = created.id;
    }
    renderPromptPresets();
    showToast(t("presetSaved"), "success");
  } catch (error) {
    showToast(String(error), "error");
  }
}

async function handleDeletePromptPreset(id) {
  const preset = (promptPresetsData?.presets || []).find((p) => p.id === id);
  if (!preset) return;
  const confirmed = await appConfirm(t("confirmDeletePreset", { name: preset.name || "" }), { danger: true });
  if (!confirmed) return;
  try {
    promptPresetsData = await invoke("delete_prompt_preset", { id });
    if (editingPromptPresetId === id) showPromptPresetEditor(null);
    renderPromptPresets();
    showToast(t("presetDeleted"), "success");
  } catch (error) {
    showToast(String(error), "error");
  }
}

async function handleActivatePromptPreset(id) {
  const preset = (promptPresetsData?.presets || []).find((p) => p.id === id);
  if (!preset) return;
  // 确认弹窗列出将写入的目标 live 文件路径
  const targets = PRESET_APPS
    .filter((a) => preset.apps?.[a.key])
    .map((a) => `${a.label}: ${promptPresetLivePath(a.key)}`);
  if (targets.length === 0) {
    showToast(t("presetNeedApp"), "error");
    return;
  }
  const confirmed = await appConfirm(
    `${t("confirmActivatePreset", { name: preset.name || "" })}\n${targets.join("\n")}`,
    { confirmText: t("presetActivate") },
  );
  if (!confirmed) return;
  try {
    const result = await invoke("activate_prompt_preset", { id });
    if (result?.data) promptPresetsData = result.data;
    renderPromptPresets();
    if (result?.backfilled) {
      // 回填保护命中：live 文件的手工修改已写回原激活预设
      showToast(t("presetBackfilled"), "success");
    }
    showToast(t("presetActivated"), "success");
    // 激活可能改写了 ~/.claude/CLAUDE.md，同步刷新 Editor tab 内容
    loadClaudeMd();
  } catch (error) {
    showToast(String(error), "error");
  }
}

/** Templates 的「存为预设」：把模板内容直接创建为新预设（默认仅勾选 claude）。 */
async function handleSaveTemplateAsPreset(tpl) {
  const name = currentLang === "zh" ? (tpl.nameZh || tpl.name) : tpl.name;
  try {
    promptPresetsData = await invoke("save_prompt_preset", {
      id: null,
      name,
      content: tpl.content,
      apps: { claude: true, codex: false, gemini: false },
    });
    renderPromptPresets();
    // 切到预设 tab 并让新预设进入编辑区
    const created = (promptPresetsData?.presets || []).slice(-1)[0];
    if (created) showPromptPresetEditor(created);
    switchPromptTab("presets");
    showToast(t("presetSaved"), "success");
  } catch (error) {
    showToast(String(error), "error");
  }
}

// ── MCP Server Management ───────────────────────────

function openMcpPanel() {
  openDeveloperTools("mcp");
}

function closeMcpPanel() {
  hideMcpEdit();
}

// 统一 MCP 面板的应用清单：key 与后端字段对应，label 用于 chip / toast 展示
const MCP_APP_KEYS = ["claude", "codex", "gemini", "claudeDesktop"];
function mcpAppLabel(app) {
  return app === "claudeDesktop" ? "Claude Desktop" : app.charAt(0).toUpperCase() + app.slice(1);
}

async function loadMcpServers() {
  try {
    const unified = await invoke("get_unified_mcp_servers");
    // Claude Desktop 读取失败按「未安装」降级，不影响其余三个应用的列表
    try {
      mcpDesktopInfo = await invoke("get_claude_desktop_mcp");
    } catch (_) {
      mcpDesktopInfo = { installed: false, configPath: "", servers: {} };
    }
    mcpServers = {};
    mcpServerApps = {};
    for (const item of (unified && unified.servers) || []) {
      mcpServers[item.name] = item.config || {};
      mcpServerApps[item.name] = { ...(item.apps || {}), claudeDesktop: false };
    }
    // 按 name 合并 Claude Desktop 的条目（Desktop 独有的也要显示）
    for (const [name, config] of Object.entries(mcpDesktopInfo.servers || {})) {
      if (mcpServerApps[name]) {
        mcpServerApps[name].claudeDesktop = true;
      } else {
        mcpServers[name] = config || {};
        mcpServerApps[name] = { claude: false, codex: false, gemini: false, claudeDesktop: true };
      }
    }
    renderMcpDesktopPathHint();
    renderMcpServers();
  } catch (error) {
    showToast(String(error), "error");
  }
}

// 面板顶部路径说明区的 Claude Desktop 一行（显示真实路径，未检测到时附提示）
function renderMcpDesktopPathHint() {
  const el = $("mcpDesktopPath");
  if (!el) return;
  const path = mcpDesktopInfo.configPath || "claude_desktop_config.json";
  el.textContent = mcpDesktopInfo.installed
    ? t("mcpDesktopPathLabel", { path })
    : `${t("mcpDesktopPathLabel", { path })} · ${t("mcpDesktopNotInstalled")}`;
}

function renderMcpServers() {
  const list = $("mcpList");
  const entries = Object.entries(mcpServers || {});
  if (entries.length === 0) {
    list.innerHTML = `<div class="mgmt-empty">${t("noMcpServers")}</div>`;
    return;
  }
  list.innerHTML = entries.map(([name, config]) => {
    const serverType = config.url ? "SSE" : "stdio";
    const desc = config.command
      ? `${config.command} ${(config.args || []).join(" ")}`
      : config.url || "";
    const apps = mcpServerApps[name] || {};
    const chips = MCP_APP_KEYS.map((app) => {
      const enabled = !!apps[app];
      // 未检测到 Claude Desktop 时该 chip 禁用并给出提示
      const disabled = app === "claudeDesktop" && !mcpDesktopInfo.installed;
      const title = disabled ? ` title="${esc(t("mcpDesktopNotInstalled"))}" disabled` : "";
      return `<button class="mcp-app-chip ${enabled ? "on" : "off"}" data-action="toggle-mcp-app" data-name="${esc(name)}" data-app="${app}"${title} type="button">${esc(mcpAppLabel(app))}</button>`;
    }).join("");
    return `
      <div class="mgmt-item">
        <div class="mgmt-item-info">
          <div class="mgmt-item-name">${esc(name)}</div>
          <div class="mgmt-item-desc">${esc(serverType)}: ${esc(desc.substring(0, 80))}</div>
          <div class="mcp-app-chips">${chips}</div>
        </div>
        <div class="mgmt-item-actions">
          <button class="btn btn-secondary btn-sm" data-action="edit-mcp" data-name="${esc(name)}">${t("edit")}</button>
          <button class="btn btn-danger btn-sm" data-action="delete-mcp" data-name="${esc(name)}">${t("delete")}</button>
        </div>
      </div>
    `;
  }).join("");

  // A10: 容器级委托
  bindDelegatedActions(list, "McpList", (action, target) => {
    const name = target.getAttribute("data-name");
    if (action === "edit-mcp") showMcpEdit(name);
    else if (action === "delete-mcp") handleDeleteMcp(name);
    else if (action === "toggle-mcp-app") handleToggleMcpApp(name, target.getAttribute("data-app"));
  });
}

// 单击 chip 启停某应用；停用最后一个应用等于把该服务器全删，需要确认
async function handleToggleMcpApp(name, app) {
  if (mcpAppToggling || !name || !MCP_APP_KEYS.includes(app)) return;
  const apps = { claude: false, codex: false, gemini: false, claudeDesktop: false, ...(mcpServerApps[name] || {}) };
  const next = !apps[app];
  if (app === "claudeDesktop" && next && !mcpDesktopInfo.installed) {
    showToast(t("mcpDesktopNotInstalled"), "error");
    return;
  }
  if (!next) {
    const enabledCount = MCP_APP_KEYS.filter((key) => apps[key]).length;
    if (enabledCount <= 1) {
      const confirmed = await appConfirm(
        t("confirmDisableLastMcpApp", { name, app: mcpAppLabel(app) }),
        { title: t("delete"), danger: true, confirmText: currentLang === "zh" ? "停用并删除" : "Disable & Delete" },
      );
      if (!confirmed) return;
    }
  }
  mcpAppToggling = true;
  try {
    if (app === "claudeDesktop") {
      if (next) {
        await invoke("set_claude_desktop_mcp_server", { name, config: mcpServers[name] || {} });
      } else {
        await invoke("remove_claude_desktop_mcp_server", { name });
      }
    } else {
      await invoke("save_unified_mcp_server", {
        name,
        config: mcpServers[name] || {},
        apps: { claude: apps.claude, codex: apps.codex, gemini: apps.gemini, [app]: next },
      });
    }
    showToast(t(next ? "toastMcpAppEnabled" : "toastMcpAppDisabled", { name, app: mcpAppLabel(app) }), "success");
    await loadMcpServers();
  } catch (error) {
    showToast(String(error), "error");
  } finally {
    mcpAppToggling = false;
  }
}

// name 非空 = 编辑已有 server；prefill = 预设安装等场景的预填内容 { name, config }
// ── MCP 配置表单 ↔ JSON 互转 ────────────────────────
// 表单是主入口（多数人不该被迫手写 JSON），JSON 模式留给需要写
// 非常规字段的高级用法。两种模式切换时同步一次数据，保存时以当前模式为准。

let mcpEditorMode = "form";

// "KEY=VALUE" / "Key: Value" 逐行解析；忽略空行与 # 注释
function parseKeyValueLines(text, separator) {
  const out = {};
  for (const rawLine of String(text || "").split("\n")) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const index = line.indexOf(separator);
    if (index <= 0) continue;
    const key = line.slice(0, index).trim();
    if (key) out[key] = line.slice(index + separator.length).trim();
  }
  return out;
}

function formatKeyValueLines(obj, separator) {
  return Object.entries(obj || {})
    .map(([key, value]) => `${key}${separator}${value}`)
    .join("\n");
}

function mcpTransportOf(config) {
  if (config && typeof config.url === "string" && config.url) {
    return config.type === "sse" ? "sse" : "http";
  }
  return "stdio";
}

// 表单 → config 对象。空字段一律省略，避免写出 "args": [] 这类噪声
function mcpFormToConfig() {
  const transport = $("mcpTransport")?.value || "stdio";
  if (transport === "stdio") {
    const config = { command: ($("mcpCommandInput")?.value || "").trim() };
    const args = String($("mcpArgsInput")?.value || "")
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);
    if (args.length) config.args = args;
    const env = parseKeyValueLines($("mcpEnvInput")?.value, "=");
    if (Object.keys(env).length) config.env = env;
    return config;
  }
  const config = { type: transport, url: ($("mcpUrlInput")?.value || "").trim() };
  const headers = parseKeyValueLines($("mcpHeadersInput")?.value, ":");
  if (Object.keys(headers).length) config.headers = headers;
  return config;
}

function mcpApplyConfigToForm(config) {
  const source = config && typeof config === "object" ? config : {};
  const transport = mcpTransportOf(source);
  const select = $("mcpTransport");
  if (select) select.value = transport;
  if ($("mcpCommandInput")) $("mcpCommandInput").value = source.command || "";
  if ($("mcpArgsInput")) {
    $("mcpArgsInput").value = Array.isArray(source.args) ? source.args.join("\n") : "";
  }
  if ($("mcpEnvInput")) $("mcpEnvInput").value = formatKeyValueLines(source.env, "=");
  if ($("mcpUrlInput")) $("mcpUrlInput").value = source.url || "";
  if ($("mcpHeadersInput")) $("mcpHeadersInput").value = formatKeyValueLines(source.headers, ": ");
  updateMcpTransportFields();
}

function updateMcpTransportFields() {
  const isStdio = ($("mcpTransport")?.value || "stdio") === "stdio";
  const stdio = $("mcpStdioFields");
  const remote = $("mcpRemoteFields");
  if (stdio) stdio.hidden = !isStdio;
  if (remote) remote.hidden = isStdio;
}

// 表单能无损表达的配置才允许用表单编辑；出现未知字段时留在 JSON 模式，
// 否则切过去再切回来会悄悄丢掉用户手写的内容
function mcpConfigFitsForm(config) {
  if (!config || typeof config !== "object" || Array.isArray(config)) return false;
  const known = mcpTransportOf(config) === "stdio"
    ? ["command", "args", "env"]
    : ["type", "url", "headers"];
  return Object.keys(config).every((key) => known.includes(key));
}

function setMcpEditorMode(mode, { sync = true } = {}) {
  const next = mode === "json" ? "json" : "form";
  if (sync) {
    if (next === "json" && mcpEditorMode === "form") {
      $("mcpConfigInput").value = JSON.stringify(mcpFormToConfig(), null, 2);
    } else if (next === "form" && mcpEditorMode === "json") {
      let parsed = null;
      try {
        parsed = JSON.parse($("mcpConfigInput").value);
      } catch {
        showToast(t("invalidJson"), "error");
        return;
      }
      if (!mcpConfigFitsForm(parsed)) {
        showToast(t("mcpJsonTooComplex"), "warning");
        return;
      }
      mcpApplyConfigToForm(parsed);
    }
  }
  mcpEditorMode = next;
  const formMode = $("mcpFormMode");
  const jsonMode = $("mcpJsonMode");
  if (formMode) formMode.hidden = next !== "form";
  if (jsonMode) jsonMode.hidden = next !== "json";
  document.querySelectorAll("#mcpModeTabs [data-mcp-mode]").forEach((button) => {
    button.classList.toggle("active", button.dataset.mcpMode === next);
  });
}

function showMcpEdit(name, prefill) {
  editingMcpName = name || null;
  const config = name ? mcpServers[name] : (prefill && prefill.config) || null;
  $("mcpNameInput").value = name || (prefill && prefill.name) || "";
  $("mcpConfigInput").value = config
    ? JSON.stringify(config, null, 2)
    : '{\n  "command": "",\n  "args": []\n}';
  // 结构常规的配置默认用表单编辑，含未知字段的直接进 JSON 模式
  if (config && !mcpConfigFitsForm(config)) {
    setMcpEditorMode("json", { sync: false });
  } else {
    mcpApplyConfigToForm(config);
    setMcpEditorMode("form", { sync: false });
  }
  $("mcpNameInput").disabled = !!name;
  // 应用勾选：编辑时按现状回填；新增 / 预设安装默认仅勾选 Claude
  const apps = name
    ? (mcpServerApps[name] || { claude: true })
    : { claude: true };
  $("mcpAppClaude").checked = !!apps.claude;
  $("mcpAppCodex").checked = !!apps.codex;
  $("mcpAppGemini").checked = !!apps.gemini;
  // Claude Desktop：未安装时勾选框禁用并提示
  const desktopCheck = $("mcpAppClaudeDesktop");
  if (desktopCheck) {
    desktopCheck.checked = !!apps.claudeDesktop;
    desktopCheck.disabled = !mcpDesktopInfo.installed;
    const desktopLabel = desktopCheck.closest("label");
    if (desktopLabel) desktopLabel.title = mcpDesktopInfo.installed ? "" : t("mcpDesktopNotInstalled");
  }
  $("mcpList").style.display = "none";
  $("mcpToolbar").style.display = "none";
  $("mcpEdit").style.display = "";
}

function hideMcpEdit() {
  $("mcpList").style.display = "";
  $("mcpToolbar").style.display = "";
  $("mcpEdit").style.display = "none";
  editingMcpName = null;
}

async function handleSaveMcp() {
  if (mcpSaving) return;
  const name = $("mcpNameInput").value.trim();
  if (!name) {
    showToast(t("mcpNeedName"), "error");
    return;
  }

  let config;
  if (mcpEditorMode === "form") {
    config = mcpFormToConfig();
    if (mcpTransportOf(config) === "stdio") {
      if (!config.command) {
        showToast(t("mcpNeedCommand"), "error");
        return;
      }
    } else if (!config.url) {
      showToast(t("mcpNeedUrl"), "error");
      return;
    }
  } else {
    try {
      config = JSON.parse($("mcpConfigInput").value);
    } catch {
      showToast(t("invalidJson"), "error");
      return;
    }
  }

  const apps = {
    claude: $("mcpAppClaude").checked,
    codex: $("mcpAppCodex").checked,
    gemini: $("mcpAppGemini").checked,
  };
  const desktopEl = $("mcpAppClaudeDesktop");
  const desktopChecked = !!(desktopEl && desktopEl.checked && !desktopEl.disabled);
  if (!apps.claude && !apps.codex && !apps.gemini && !desktopChecked) {
    showToast(t("mcpNoAppSelected"), "error");
    return;
  }

  mcpSaving = true;
  const saveBtn = $("mcpSaveBtn");
  setButtonBusy(saveBtn, true, t("toastSaving"));
  try {
    await invoke("save_unified_mcp_server", { name, config, apps });
    // Claude Desktop 独立读写：勾选则写入 / 更新，未勾选则移除（不存在时静默成功）
    if (desktopChecked) {
      await invoke("set_claude_desktop_mcp_server", { name, config });
    } else {
      await invoke("remove_claude_desktop_mcp_server", { name });
    }
    showToast(t("toastMcpSaved"), "success");
    hideMcpEdit();
    await loadMcpServers();
  } catch (error) {
    showToast(String(error), "error");
  } finally {
    mcpSaving = false;
    setButtonBusy(saveBtn, false);
  }
}

async function handleDeleteMcp(name) {
  const confirmed = await appConfirm(t("confirmDeleteMcp", { name }), {
    title: t("delete"),
    danger: true,
    confirmText: currentLang === "zh" ? "删除" : "Delete",
  });
  if (!confirmed) return;
  try {
    await invoke("delete_unified_mcp_server", { name });
    // 「从所有应用移除」包含 Claude Desktop（条目不存在时后端静默成功）
    await invoke("remove_claude_desktop_mcp_server", { name });
    showToast(t("toastMcpDeleted"), "success");
    await loadMcpServers();
  } catch (error) {
    showToast(String(error), "error");
  }
}

// ── MCP Presets ──────────────────────────────────────

let mcpPresets = [];
let mcpGitHubResults = [];
let mcpSearching = false;
let activeMcpTab = "installed";

function switchMcpTab(tab) {
  activeMcpTab = tab;
  $("mcpTabInstalled").classList.toggle("active", tab === "installed");
  $("mcpTabPresets").classList.toggle("active", tab === "presets");
  $("mcpInstalledContent").style.display = tab === "installed" ? "" : "none";
  $("mcpPresetsContent").style.display = tab === "presets" ? "" : "none";
  if (tab === "presets" && mcpPresets.length === 0) {
    loadMcpPresets();
  }
}

async function loadMcpPresets() {
  try {
    mcpPresets = await invoke("get_mcp_presets");
    mcpGitHubResults = [];
    renderMcpPresets();
  } catch (error) {
    showToast(String(error), "error");
  }
}

async function searchGitHubMcp() {
  // 防并发：防止连点搜索使后完成的旧请求覆盖结果
  if (mcpSearching) return;
  const query = $("mcpPresetSearch").value.trim();
  if (!query) {
    mcpGitHubResults = [];
    renderMcpPresets();
    return;
  }

  mcpSearching = true;
  $("mcpPresetLoading").style.display = "";
  $("mcpPresetsGrid").innerHTML = "";

  try {
    const results = await invoke("search_github_mcp", { query });
    mcpGitHubResults = results || [];
    renderMcpPresets();
  } catch (error) {
    showToast(String(error), "error");
    $("mcpPresetsGrid").innerHTML = `<div class="discover-empty">${esc(String(error))}</div>`;
  } finally {
    mcpSearching = false;
    $("mcpPresetLoading").style.display = "none";
  }
}

function renderMcpPresets() {
  const grid = $("mcpPresetsGrid");
  const installedNames = Object.keys(mcpServers || {});
  const showGitHub = mcpGitHubResults.length > 0;
  const items = showGitHub ? mcpGitHubResults : mcpPresets;

  if (items.length === 0) {
    grid.innerHTML = `<div class="discover-empty">${showGitHub ? t("discoverNoMatch") : t("mcpNoPresets")}</div>`;
    return;
  }

  grid.innerHTML = items.map((preset) => {
    const name = currentLang === "zh" ? (preset.nameZh || preset.name) : preset.name;
    const desc = currentLang === "zh" ? (preset.descZh || preset.desc) : preset.desc;
    const isInstalled = installedNames.includes(preset.id);
    const needsEnv = preset.config && preset.config.env && Object.values(preset.config.env).some((v) => typeof v === "string" && v.startsWith("<"));
    const stars = preset.stars ? `<span class="skill-card-badge">\u2605 ${esc(String(preset.stars))}</span>` : "";
    const source = preset.source ? `<span class="skill-card-badge repo">${esc(preset.source)}</span>` : "";

    return `
    <div class="prompt-template-card">
      <div class="prompt-template-name">${esc(name)}</div>
      <div class="prompt-template-desc">${esc(desc)}</div>
      <div class="skill-card-meta">
        ${stars}${source}
      </div>
      ${needsEnv ? `<div class="prompt-template-desc" style="color:var(--warning-text);">${t("mcpRequiresApiKey")}</div>` : ""}
      <div class="prompt-template-actions">
        ${isInstalled
          ? `<button class="btn btn-secondary btn-sm" disabled>${t("mcpInstalled")}</button>`
          : `<button class="btn btn-primary btn-sm" data-action="install-mcp-preset" data-id="${esc(preset.id)}">${t("mcpInstallBtn")}</button>`
        }
        ${preset.url ? `<button class="btn btn-secondary btn-sm" data-action="open-mcp-url" data-url="${esc(preset.url)}">${t("mcpGithubBtn")}</button>` : ""}
      </div>
    </div>
    `;
  }).join("");

  // A10: 容器级委托
  bindDelegatedActions(grid, "McpPresets", async (action, btn) => {
    if (action === "open-mcp-url") {
      const url = btn.getAttribute("data-url");
      if (url) await invoke("open_external_target", { target: url });
      return;
    }
    if (action !== "install-mcp-preset") return;
    const id = btn.getAttribute("data-id");
    const allItems = [...mcpPresets, ...mcpGitHubResults];
    const preset = allItems.find((p) => p.id === id);
    if (!preset) return;

    // 预设安装沿用 Add 表单流程：预填名称与配置（默认仅勾选 Claude），由用户确认后保存
    switchMcpTab("installed");
    showMcpEdit(null, { name: preset.id, config: preset.config });
  });
}

function showToast(message, type = "success") {
  try {
    const container = $("toastContainer");
    if (container) {
      const toast = document.createElement("div");
      toast.className = `toast ${type}`;
      toast.textContent = String(message);
      container.appendChild(toast);
      setTimeout(() => {
        toast.style.opacity = "0";
        setTimeout(() => toast.remove(), 300);
      }, 3200);
    }
  } catch (e) {
    console.error("showToast failed", e, message);
  }
}

// ── 统一 Dialog（替代 alert/confirm/prompt）────────────────
let appDialogResolver = null;

function closeAppDialog(result) {
  const overlay = $("appDialogOverlay");
  if (overlay) overlay.classList.remove("open");
  document.body.classList.remove("modal-open");
  const resolver = appDialogResolver;
  appDialogResolver = null;
  if (resolver) resolver(result);
}

function openAppDialog(options = {}) {
  return new Promise((resolve) => {
    // 若已有对话框在等待，先 resolve null 再接管，避免之前的 await 永久挂起
    if (appDialogResolver) {
      appDialogResolver(options.mode === "prompt" ? null : false);
      appDialogResolver = null;
    }
    appDialogResolver = resolve;
    const overlay = $("appDialogOverlay");
    const dialog = overlay?.querySelector(".app-dialog");
    if (!overlay || !dialog) {
      appDialogResolver = null;
      resolve(options.mode === "prompt" ? null : false);
      return;
    }

    dialog.classList.toggle("danger", !!options.danger);
    $("appDialogKicker").textContent = options.kicker || "VarSwitch";
    $("appDialogTitle").textContent = options.title || (currentLang === "zh" ? "确认操作" : "Confirm");
    $("appDialogMessage").textContent = options.message || "";
    $("appDialogCancel").textContent = options.cancelText || t("cancel");
    $("appDialogConfirm").textContent = options.confirmText || (currentLang === "zh" ? "确认" : "Confirm");

    const inputGroup = $("appDialogInputGroup");
    const input = $("appDialogInput");
    if (options.mode === "prompt") {
      inputGroup.hidden = false;
      $("appDialogInputLabel").textContent = options.inputLabel || (currentLang === "zh" ? "配置名称" : "Name");
      $("appDialogInputHint").textContent = options.inputHint || "";
      input.value = options.defaultValue || "";
      input.placeholder = options.placeholder || "";
    } else {
      inputGroup.hidden = true;
      input.value = "";
    }

    overlay.classList.add("open");
    document.body.classList.add("modal-open");
    setTimeout(() => {
      if (options.mode === "prompt") input.focus();
      else $("appDialogConfirm").focus();
    }, 30);
  });
}

async function appConfirm(message, options = {}) {
  return openAppDialog({
    mode: "confirm",
    title: options.title || (currentLang === "zh" ? "确认操作" : "Confirm"),
    message,
    confirmText: options.confirmText || (currentLang === "zh" ? "确认" : "Confirm"),
    cancelText: options.cancelText || t("cancel"),
    danger: !!options.danger,
    kicker: options.kicker || "VarSwitch",
  });
}

async function appPrompt(message, defaultValue = "", options = {}) {
  const result = await openAppDialog({
    mode: "prompt",
    title: options.title || (currentLang === "zh" ? "请输入" : "Input"),
    message,
    defaultValue,
    inputLabel: options.inputLabel,
    inputHint: options.inputHint,
    confirmText: options.confirmText || (currentLang === "zh" ? "确定" : "OK"),
    cancelText: options.cancelText || t("cancel"),
    kicker: options.kicker || "VarSwitch",
  });
  return result;
}

function bindAppDialogOnce() {
  if (window.__varswitchDialogBound) return;
  window.__varswitchDialogBound = true;
  $("appDialogClose")?.addEventListener("click", () => closeAppDialog(null));
  $("appDialogCancel")?.addEventListener("click", () => closeAppDialog(null));
  $("appDialogConfirm")?.addEventListener("click", () => {
    const inputGroup = $("appDialogInputGroup");
    if (inputGroup && !inputGroup.hidden) {
      closeAppDialog($("appDialogInput").value);
    } else {
      closeAppDialog(true);
    }
  });
  bindOverlayDismiss("appDialogOverlay", () => closeAppDialog(null));
  $("appDialogInput")?.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      $("appDialogConfirm")?.click();
    }
  });
}

function setBadge(el, text, tone = "") {
  if (!el) return;
  el.textContent = text;
  el.className = `status-badge-console${tone ? ` ${tone}` : ""}`;
}

function setNavDot(id, tone = "") {
  const el = $(id);
  if (!el) return;
  el.className = `nav-state-dot${tone ? ` ${tone}` : ""}`;
}

function getSelectedUniversalProviderPreset() {
  return UNIVERSAL_PROVIDER_PRESETS.find((preset) => preset.id === selectedUniversalProviderPreset)
    || UNIVERSAL_PROVIDER_PRESETS[0];
}

function getUniversalProviderApps() {
  return Object.fromEntries(
    [...document.querySelectorAll("[data-universal-app]")].map((input) => [
      input.getAttribute("data-universal-app"),
      input.checked,
    ])
  );
}

function renderUniversalProviderForm() {
  const preset = getSelectedUniversalProviderPreset();
  document.querySelectorAll("[data-universal-preset]").forEach((button) => {
    const active = button.getAttribute("data-universal-preset") === preset.id;
    button.classList.toggle("active", active);
    button.setAttribute("aria-checked", String(active));
  });
  setText("universalProviderPresetHint", t(preset.descriptionKey));

  const apps = getUniversalProviderApps();
  document.querySelectorAll("[data-universal-app-card]").forEach((card) => {
    card.hidden = !apps[card.getAttribute("data-universal-app-card")];
  });
  updateUniversalUrlPreviews();
  const labels = [apps.claude && "Claude", apps.codex && "Codex", apps.grok && "Grok", apps.gemini && "Gemini"].filter(Boolean);
  setText("universalProviderFooterHint", labels.length
    ? t("universalSyncTargets", { apps: labels.join(currentLang === "zh" ? "、" : ", ") })
    : t("universalNoAppSelected"));
}

// 同一个网关地址在各应用的实际写入形式不同（OpenAI 兼容协议自动补 /v1），实时展示避免歧义
function updateUniversalUrlPreviews() {
  const raw = $("universalProviderBaseUrl")?.value.trim() || "";
  const claudeOpenAi = $("universalClaudeApiFormat")?.value === "openai_chat";
  document.querySelectorAll("[data-universal-url-preview]").forEach((hint) => {
    const app = hint.getAttribute("data-universal-url-preview");
    // Claude 选 OpenAI 格式时按 OpenAI 惯例处理地址（补 /v1），并提示走本地代理
    const usesOpenAiRules = app === "codex" || app === "grok" || (app === "claude" && claudeOpenAi);
    if (!raw) {
      hint.textContent = usesOpenAiRules ? t("universalAutoV1Hint") : "";
      hint.hidden = !hint.textContent;
      return;
    }
    const resolveApp = usesOpenAiRules ? (app === "grok" ? "grok" : "codex") : app;
    const resolved = helpers.resolveUniversalAppBaseUrl
      ? helpers.resolveUniversalAppBaseUrl(resolveApp, raw)
      : raw;
    hint.textContent = app === "claude" && claudeOpenAi
      ? `上游地址：${resolved}（经 127.0.0.1:25789 本地代理转换）`
      : `写入地址：${resolved}`;
    hint.hidden = false;
  });
}

function fillUniversalModelOptions(models) {
  const datalist = $("universalModelOptions");
  if (!datalist) return;
  const normalized = helpers.normalizeFetchedModels
    ? helpers.normalizeFetchedModels(models)
    : [];
  datalist.innerHTML = normalized.map((model) => `<option value="${esc(model)}"></option>`).join("");
}

// 统一供应商的连通性验证：走 OpenAI 兼容 /models 端点（NewAPI 等网关通用），
// 成功后把模型列表填入 datalist，四个应用的模型输入框都能自动补全。
async function handleUniversalEndpointTest() {
  const button = $("universalEndpointTestBtn");
  const container = $("universalEndpointResults");
  const baseUrl = $("universalProviderBaseUrl").value.trim();
  const apiKey = $("universalProviderApiKey").value.trim();
  if (!baseUrl || !apiKey) {
    showToast("请先填写 API 地址和 API Key", "warning");
    return;
  }

  const previousText = button.textContent;
  button.disabled = true;
  button.textContent = t("endpointTesting");
  const startedAt = performance.now();
  try {
    const models = await invoke("fetch_available_models", { baseUrl, apiKey, timeoutSecs: 12, protocol: "codex" });
    const elapsed = Math.round(performance.now() - startedAt);
    const count = (models || []).length;
    fillUniversalModelOptions(models || []);
    if (container) {
      container.innerHTML = `<div class="endpoint-row"><span class="endpoint-url" title="${esc(baseUrl)}">${esc(baseUrl)}</span><span class="endpoint-meta fast">${t("verifyOkLabel")} · ${count} ${t("verifyModelsSuffix")} · ${elapsed}ms</span></div>`;
      container.classList.add("open");
    }
    showToast(t("verifyOkToast"), "success");
  } catch (error) {
    const message = describeVerifyError(String(error));
    if (container) {
      container.innerHTML = `<div class="endpoint-row"><span class="endpoint-url" title="${esc(baseUrl)}">${esc(baseUrl)}</span><span class="endpoint-meta failed">${esc(message)}</span></div>`;
      container.classList.add("open");
    }
    showToast(message, "error");
  } finally {
    button.disabled = false;
    button.textContent = previousText || t("endpointTest");
  }
}

function applyUniversalProviderPreset(presetId) {
  const preset = UNIVERSAL_PROVIDER_PRESETS.find((item) => item.id === presetId);
  if (!preset) return;
  selectedUniversalProviderPreset = preset.id;
  $("universalProviderName").value = preset.name;
  $("universalClaudeModel").value = preset.models.claude;
  $("universalCodexModel").value = preset.models.codex;
  $("universalGrokModel").value = preset.models.grok;
  $("universalGeminiModel").value = preset.models.gemini;
  renderUniversalProviderForm();
}

function resetUniversalProviderForm(protocol = null) {
  selectedUniversalProviderPreset = "newapi";
  $("universalProviderForm")?.reset();
  document.querySelectorAll("[data-universal-app]").forEach((input) => {
    input.checked = protocol ? input.getAttribute("data-universal-app") === protocol : true;
  });
  $("universalProviderBaseUrl").value = "";
  $("universalProviderApiKey").value = "";
  $("universalProviderApiKey").type = "password";
  setText("universalProviderApiKeyToggle", t("showKey"));
  const claudeApiFormat = $("universalClaudeApiFormat");
  if (claudeApiFormat) claudeApiFormat.value = "anthropic";
  const codexWireApi = $("universalCodexWireApi");
  if (codexWireApi) codexWireApi.value = "responses";
  const grokApiBackend = $("universalGrokApiBackend");
  if (grokApiBackend) grokApiBackend.value = "chat_completions";
  const endpointResults = $("universalEndpointResults");
  if (endpointResults) {
    endpointResults.innerHTML = "";
    endpointResults.classList.remove("open");
  }
  const modelOptions = $("universalModelOptions");
  if (modelOptions) modelOptions.innerHTML = "";
  applyUniversalProviderPreset("newapi");
}

function openProviderOnboarding(protocol = null) {
  switchConsolePage("add-provider");
  resetUniversalProviderForm(["claude", "codex", "grok", "gemini"].includes(protocol) ? protocol : null);
}

async function rollbackUniversalProviderProfiles(createdProfiles) {
  const deleteCommands = {
    claude: "delete_profile",
    codex: "delete_codex_profile",
    grok: "delete_grok_profile",
    gemini: "delete_gemini_profile",
  };
  const failures = [];
  for (const profile of [...createdProfiles].reverse()) {
    try {
      await invoke(deleteCommands[profile.app], { id: profile.id });
    } catch (error) {
      failures.push(`${profile.app}: ${String(error)}`);
    }
  }
  return failures;
}

async function handleUniversalProviderSubmit(event) {
  event.preventDefault();
  if (universalProviderSaving) return;

  const apps = getUniversalProviderApps();
  const enabledApps = ["claude", "codex", "grok", "gemini"].filter((app) => apps[app]);
  if (enabledApps.length === 0) {
    showToast("请至少启用一个应用", "warning");
    return;
  }

  const name = $("universalProviderName").value.trim();
  const baseUrl = $("universalProviderBaseUrl").value.trim();
  const apiKey = $("universalProviderApiKey").value.trim();
  if (!name || !baseUrl || !apiKey) {
    showToast("请填写供应商名称、API 地址和 API Key", "warning");
    return;
  }
  const claudeApiFormat = $("universalClaudeApiFormat")?.value || "anthropic";
  if (apps.claude && claudeApiFormat === "openai_chat" && !$("universalClaudeModel").value.trim()) {
    showToast(t("claudeApiFormatNeedsModel"), "warning");
    return;
  }

  const createdProfiles = [];
  const submitButton = $("universalProviderSubmitBtn");
  universalProviderSaving = true;
  setButtonBusy(submitButton, true, "正在同步...");

  const appBaseUrl = (app) => (helpers.resolveUniversalAppBaseUrl
    ? helpers.resolveUniversalAppBaseUrl(app, baseUrl)
    : baseUrl);

  try {
    if (apps.claude) {
      const created = await invoke("add_profile", {
        name,
        apiKey,
        // OpenAI 格式的上游地址遵循 OpenAI 惯例（复用 codex 的 /v1 规则）
        baseUrl: claudeApiFormat === "openai_chat" ? appBaseUrl("codex") : appBaseUrl("claude"),
        modelId: $("universalClaudeModel").value.trim() || null,
        apiFormat: claudeApiFormat,
      });
      createdProfiles.push({ app: "claude", id: created.id });
    }
    if (apps.codex) {
      const created = await invoke("add_codex_profile", {
        name,
        apiKey,
        baseUrl: appBaseUrl("codex"),
        authMode: "auth_json",
        wireApi: $("universalCodexWireApi")?.value || "responses",
        model: $("universalCodexModel").value.trim() || null,
        providerName: getSelectedUniversalProviderPreset().providerName,
        imageApiKey: null,
        imageBaseUrl: null,
      });
      createdProfiles.push({ app: "codex", id: created.id });
    }
    if (apps.grok) {
      const created = await invoke("add_grok_profile", {
        name,
        apiKey,
        baseUrl: appBaseUrl("grok"),
        model: $("universalGrokModel").value.trim() || null,
        apiBackend: $("universalGrokApiBackend")?.value || "chat_completions",
      });
      createdProfiles.push({ app: "grok", id: created.id });
    }
    if (apps.gemini) {
      const created = await invoke("add_gemini_profile", {
        name,
        apiKey,
        baseUrl: appBaseUrl("gemini"),
        model: $("universalGeminiModel").value.trim() || null,
      });
      createdProfiles.push({ app: "gemini", id: created.id });
    }

    await Promise.allSettled([loadProfiles(), loadCodexProfiles(), loadGrokProfiles(), loadGeminiProfiles()]);
    renderProviderNavigation();
    showToast(`已将 ${name} 同步到 ${enabledApps.length} 个应用`, "success");
    switchConsolePage(enabledApps[0]);
  } catch (error) {
    const rollbackFailures = await rollbackUniversalProviderProfiles(createdProfiles);
    await Promise.allSettled([loadProfiles(), loadCodexProfiles(), loadGrokProfiles(), loadGeminiProfiles()]);
    const suffix = rollbackFailures.length ? `；回滚失败：${rollbackFailures.join("；")}` : "，已回滚本次写入";
    showToast(`同步失败：${String(error)}${suffix}`, "error");
  } finally {
    universalProviderSaving = false;
    setButtonBusy(submitButton, false);
  }
}

function switchDeveloperTool(tool) {
  const nextTool = ["skills", "prompts", "mcp"].includes(tool) ? tool : "skills";
  activeDeveloperTool = nextTool;
  document.querySelectorAll("[data-developer-tool]").forEach((button) => {
    const active = button.getAttribute("data-developer-tool") === nextTool;
    button.classList.toggle("active", active);
    button.setAttribute("aria-selected", String(active));
  });
  const surfaces = {
    skills: $("developerToolSkillsContent"),
    prompts: $("developerToolPromptsContent"),
    mcp: $("developerToolMcpContent"),
  };
  Object.entries(surfaces).forEach(([name, surface]) => {
    if (surface) surface.hidden = name !== nextTool;
  });

  if (nextTool === "skills") {
    hideSkillsEdit();
    switchSkillsTab("installed");
    loadSkills();
  } else if (nextTool === "prompts") {
    switchPromptTab("presets");
    loadPromptPresets();
    loadClaudeMd();
    loadPromptTemplates();
  } else {
    hideMcpEdit();
    switchMcpTab("installed");
    loadMcpServers();
  }
}

function openDeveloperTools(tool = "skills") {
  switchConsolePage("developer-tools");
  switchDeveloperTool(tool);
}

function renderProviderNavigation() {
  const availability = {
    claude: profiles.length > 0,
    codex: codexProfiles.length > 0,
    grok: grokProfiles.length > 0,
    gemini: true,
  };
  document.querySelectorAll("[data-provider-nav]").forEach((item) => {
    const available = availability[item.getAttribute("data-provider-nav")] === true;
    item.hidden = !available;
  });
  if (availability[activeConsolePage] === false) {
    switchConsolePage("add-provider");
  }
}

// ===========================================================================
// 用量监控面板（数据口径迁移自 cc-switch）
// ===========================================================================
let usageRange = "7d";
let usageAppFilter = "all";
let usageModelFilter = "all";
let usageLoadInFlight = false;
let usageLoadedOnce = false;
let usageReloadQueued = false;
// 最近一次请求实际使用的起止时间（unix 秒），用于在面板上标注统计区间
let usageResolvedRange = null;
// 请求序号：只渲染最新一次请求的结果，防止慢响应覆盖新筛选
let usageRequestSeq = 0;

const USAGE_APP_LABELS = {
  claude: "Claude Code",
  codex: "Codex",
  gemini: "Gemini CLI",
  grok: "Grok CLI",
};

const USAGE_APP_ICONS = {
  claude: "anthropic-color.svg",
  codex: "OpenAI-black-monoblossom.svg",
  gemini: "gemini-color.svg",
  grok: "grok-color.svg",
};

// Gemini / Grok 未报告缓存写入时显示 N/A；Codex 日志可包含显式写入。
const USAGE_AUTO_CACHE_APPS = new Set(["gemini", "grok"]);

function escapeUsageHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function usageAppLabel(app) {
  return USAGE_APP_LABELS[app] || app;
}

function formatUsageCost(cost) {
  if (cost == null || !Number.isFinite(Number(cost))) return "—";
  const value = Number(cost);
  if (value === 0) return "$0.00";
  if (value < 0.01) return `$${value.toFixed(4)}`;
  if (value < 1) return `$${value.toFixed(3)}`;
  return `$${value.toFixed(2)}`;
}

// 成本缺失和真实零成本必须区分；部分自报金额只能作为下界。
function usageCostState(cost, stats = {}) {
  const zh = currentLang === "zh";
  const requests = Number(stats.totalRequests ?? stats.requests) || 0;
  const unpriced = Number(stats.unpricedRequests) || 0;
  const partial = Number(stats.partialCostRequests) || (stats.costPartial ? 1 : 0);
  const unknown = cost == null || !Number.isFinite(Number(cost)) ||
    (requests > 0 && unpriced >= requests && partial === 0);
  const incomplete = unknown || unpriced > 0 || partial > 0;
  const details = [];
  if (unpriced > 0) details.push(zh ? `${unpriced} 次请求待定价` : `${unpriced} requests unpriced`);
  else if (unknown) details.push(zh ? "未找到模型价格" : "Model price unavailable");
  if (partial > 0) details.push(zh ? `${partial} 次请求仅有部分成本` : `${partial} requests have partial cost`);
  if (incomplete && !unknown) details.push(zh ? "已知金额下界" : "Known cost lower bound");
  return {
    value: unknown ? (zh ? "待定价" : "Unpriced") : `${incomplete ? "≥ " : ""}${formatUsageCost(cost)}`,
    detail: details.join(" · "),
    incomplete,
  };
}

function formatUsageTokens(tokens) {
  const value = Number(tokens) || 0;
  if (value >= 1_000_000_000) return `${(value / 1_000_000_000).toFixed(2)}B`;
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(2)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}K`;
  return String(value);
}

// 完整千分位数字（应用大卡的主数字）
function formatUsageTokensExact(tokens) {
  return (Number(tokens) || 0).toLocaleString("en-US");
}

// 人性化换算：中文用 亿/万，英文用 B/M/K
function formatUsageTokensHuman(tokens) {
  const value = Number(tokens) || 0;
  if (currentLang !== "zh") return formatUsageTokens(value);
  if (value >= 100_000_000) return `${(value / 100_000_000).toFixed(2)} 亿`;
  if (value >= 10_000) return `${(value / 10_000).toFixed(1)} 万`;
  return String(value);
}

function formatUsageTime(unixSeconds) {
  if (!unixSeconds) return "--";
  const date = new Date(unixSeconds * 1000);
  const pad = (n) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

// 相对时间（最近记录表用），精确时间放 title
function formatUsageRelTime(unixSeconds) {
  if (!unixSeconds) return "--";
  const zh = currentLang === "zh";
  const diff = Math.floor(Date.now() / 1000) - unixSeconds;
  if (diff < 60) return zh ? "刚刚" : "just now";
  if (diff < 3600) {
    const m = Math.floor(diff / 60);
    return zh ? `${m} 分钟前` : `${m}m ago`;
  }
  if (diff < 86400) {
    const h = Math.floor(diff / 3600);
    return zh ? `${h} 小时前` : `${h}h ago`;
  }
  if (diff < 86400 * 7) {
    const d = Math.floor(diff / 86400);
    return zh ? `${d} 天前` : `${d}d ago`;
  }
  return formatUsageTime(unixSeconds);
}

// 当前范围按钮的显示名
function usageRangeLabelText() {
  const zh = currentLang === "zh";
  const labels = {
    today: zh ? "今天" : "Today",
    "1d": zh ? "24 小时" : "24 hours",
    "7d": zh ? "近 7 天" : "Last 7 days",
    "14d": zh ? "近 14 天" : "Last 14 days",
    "30d": zh ? "近 30 天" : "Last 30 days",
    all: zh ? "全部" : "All time",
    custom: zh ? "自定义" : "Custom",
  };
  return labels[usageRange] || usageRange;
}

// 把当前统计区间写到过滤器下方的标注条（请求发起时立即调用，
// 避免加载期间用户把旧数据误读为新范围的结果）
function renderUsageRangeNote() {
  const note = $("usageRangeNote");
  if (!note) return;
  const zh = currentLang === "zh";
  const label = usageRangeLabelText();
  if (!usageResolvedRange) {
    note.innerHTML = "";
    return;
  }
  if (!usageResolvedRange.startTs && !usageResolvedRange.endTs) {
    note.innerHTML = `<strong>${escapeUsageHtml(label)}</strong><span>${zh ? "全部历史记录" : "All history"}</span>`;
    return;
  }
  const startText = usageResolvedRange.startTs
    ? formatUsageTime(usageResolvedRange.startTs)
    : zh ? "最早" : "earliest";
  const endText = usageResolvedRange.endTs
    ? formatUsageTime(usageResolvedRange.endTs)
    : zh ? "现在" : "now";
  note.innerHTML = `<strong>${escapeUsageHtml(label)}</strong><span>${escapeUsageHtml(startText)} → ${escapeUsageHtml(endText)}</span>`;
}

// 加载状态：首次加载显示骨架屏；刷新时旧内容半透明置灰 + 顶部状态芯片，
// 明确告知“正在统计，当前显示的是旧结果”
function setUsageLoadingState(loading) {
  const skeleton = $("usageSkeleton");
  const chip = $("usageLoadingChip");
  const body = $("usageBody");
  const empty = $("usageEmpty");
  if (loading) {
    if (!usageLoadedOnce) {
      if (skeleton) skeleton.hidden = false;
      if (body) body.hidden = true;
      if (empty) empty.hidden = true;
    } else {
      if (chip) chip.hidden = false;
      if (body) body.classList.add("usage-stale");
      if (empty) empty.classList.add("usage-stale");
    }
  } else {
    if (skeleton) skeleton.hidden = true;
    if (chip) chip.hidden = true;
    if (body) body.classList.remove("usage-stale");
    if (empty) empty.classList.remove("usage-stale");
  }
}

// 时间范围语义见 app-helpers.js resolveUsageRange：
// today = 自然日（本地 00:00 → 24:00）；1d = 滚动 24 小时（now-24h → now）；
// 7d/14d/30d = (N-1) 天前本地零点 → 现在；custom = 用户选定起止时间
function resolveUsageRange(range) {
  if (typeof helpers.resolveUsageRange !== "function") {
    return { startTs: null, endTs: null };
  }
  const parseInput = (id) => {
    const el = $(id);
    if (!el || !el.value) return null;
    const ts = new Date(el.value).getTime();
    return Number.isFinite(ts) ? Math.floor(ts / 1000) : null;
  };
  return helpers.resolveUsageRange(range, {
    nowMs: Date.now(),
    customStartTs: parseInput("usageCustomStart"),
    customEndTs: parseInput("usageCustomEnd"),
    customLiveEnd: $("usageCustomLiveEnd")?.checked !== false,
  });
}

async function loadUsageDashboard() {
  const seq = ++usageRequestSeq;
  // 发起请求前先按最新筛选更新区间标注与加载态，
  // 用户点击范围按钮后立即获得视觉反馈，不会把旧数据误读为新结果
  const range = resolveUsageRange(usageRange);
  usageResolvedRange = range;
  renderUsageRangeNote();
  setUsageLoadingState(true);
  const errorBox = $("usageError");
  if (errorBox) errorBox.hidden = true;

  // 加载中再次触发（切换筛选）时排队，结束后按最新筛选重载一次
  if (usageLoadInFlight) {
    usageReloadQueued = true;
    return;
  }
  usageLoadInFlight = true;
  try {
    const dashboard = await invoke("get_usage_dashboard", {
      startTs: range.startTs,
      endTs: range.endTs,
      app: usageAppFilter === "all" ? null : usageAppFilter,
      model: usageModelFilter === "all" ? null : usageModelFilter,
      // 后端期望 JS getTimezoneOffset() 原值（UTC−本地，UTC+8 为 -480）
      tzOffsetMinutes: new Date().getTimezoneOffset(),
    });
    // 慢响应回来时若用户已切到别的筛选，丢弃本次结果，等排队的重载
    if (seq === usageRequestSeq) {
      usageLoadedOnce = true;
      renderUsageDashboard(dashboard);
    }
  } catch (error) {
    if (seq === usageRequestSeq) {
      const body = $("usageBody");
      const empty = $("usageEmpty");
      if (body) body.hidden = true;
      if (empty) empty.hidden = true;
      if (errorBox) {
        errorBox.hidden = false;
        errorBox.textContent = (currentLang === "zh" ? "用量统计加载失败：" : "Failed to load usage stats: ") + String(error);
      }
    }
  } finally {
    usageLoadInFlight = false;
    if (usageReloadQueued) {
      usageReloadQueued = false;
      loadUsageDashboard();
    } else {
      setUsageLoadingState(false);
    }
  }
}

// 模型下拉与应用/时间筛选级联：选项来自当前应用+时间范围下实际出现过的模型
function updateUsageModelOptions(models) {
  const select = $("usageModelFilter");
  if (!select) return false;
  const zh = currentLang === "zh";
  const list = Array.isArray(models) ? models : [];
  const selectionInvalid = usageModelFilter !== "all" && !list.includes(usageModelFilter);
  if (selectionInvalid) usageModelFilter = "all";
  select.innerHTML = [`<option value="all">${zh ? "全部模型" : "All models"}</option>`]
    .concat(list.map((m) => `<option value="${escapeUsageHtml(m)}">${escapeUsageHtml(m)}</option>`))
    .join("");
  select.value = usageModelFilter;
  return selectionInvalid;
}

function renderUsageDashboard(dashboard) {
  const body = $("usageBody");
  const empty = $("usageEmpty");
  const zh = currentLang === "zh";
  // 选中的模型在新筛选下已不存在时重置为“全部模型”并重载
  if (updateUsageModelOptions(dashboard?.availableModels)) {
    loadUsageDashboard();
    return;
  }
  if (!dashboard || !dashboard.summary || Number(dashboard.summary.totalRequests) === 0) {
    if (body) body.hidden = true;
    if (empty) empty.hidden = false;
    // 空态区分“该范围没有数据”与“从未有过数据”
    const scanned = Number(dashboard?.filesScanned) || 0;
    const rangeScoped = usageRange !== "all" && scanned > 0;
    setText(
      "usageEmptyTitle",
      rangeScoped
        ? (zh ? `「${usageRangeLabelText()}」内没有用量` : `No usage in "${usageRangeLabelText()}"`)
        : (zh ? "暂无用量数据" : "No usage data yet")
    );
    setText(
      "usageEmptyText",
      rangeScoped
        ? (zh
            ? "这个时间范围内没有找到任何请求记录，试试切换到更长的时间范围。"
            : "No requests found in this time range. Try a longer range.")
        : (zh
            ? "使用 Claude Code / Codex / Gemini CLI / Grok CLI 后，这里会自动统计本地会话日志。"
            : "Once you use Claude Code / Codex / Gemini CLI / Grok CLI, local session logs will be aggregated here automatically.")
    );
    return;
  }
  if (empty) empty.hidden = true;
  if (body) body.hidden = false;

  renderUsageHero(dashboard.summary, dashboard.prevSummary || null, dashboard.byApp || [], dashboard);
  renderUsageTrend(dashboard);
  renderUsageApps(dashboard.byApp || [], dashboard.summary);
  renderUsageModels(dashboard.models || []);
  renderUsageRecent(dashboard.recent || []);
  renderUsageMeta(dashboard);
}

function renderUsageMeta(dashboard) {
  const meta = $("usageMetaLine");
  if (!meta) return;
  const zh = currentLang === "zh";
  const parts = [];
  parts.push(
    zh
      ? `已扫描 ${dashboard.filesScanned} 个会话日志文件`
      : `Scanned ${dashboard.filesScanned} session log files`
  );
  if (dashboard.deferredFiles > 0) {
    parts.push(
      zh
        ? `${dashboard.deferredFiles} 个 Codex fork 文件待父线程就绪`
        : `${dashboard.deferredFiles} Codex fork files awaiting parent thread`
    );
  }
  const errors = dashboard.parseErrors || [];
  if (errors.length > 0) {
    parts.push(zh ? `${errors.length} 个文件解析失败` : `${errors.length} files failed to parse`);
  }
  if (dashboard.generatedAt) {
    parts.push((zh ? "更新于 " : "Updated at ") + formatUsageTime(dashboard.generatedAt));
  }
  if (dashboard.pricingDate) {
    parts.push((zh ? "参考价快照 " : "Reference prices ") + dashboard.pricingDate);
  }
  const costState = usageCostState(dashboard.summary?.totalCost, dashboard.summary);
  if (costState.detail) parts.push(costState.detail);
  meta.textContent = parts.join(" · ");
  meta.title = [
    dashboard.pricingSource ? `${zh ? "参考价格" : "Reference prices"}: ${dashboard.pricingSource}` : "",
    zh ? "按参考价快照及内置兼容价估算，未含渠道倍率；实际账单以服务商为准。" : "Reference snapshot and built-in fallback prices exclude channel multipliers; your provider determines the actual bill.",
    ...errors,
  ].filter(Boolean).join("\n");
}

const USAGE_HERO_ICONS = {
  cost: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"><circle cx="8" cy="8" r="6.4"/><path d="M8 4.6v6.8M10 5.9c-.5-.6-1.2-.9-2-.9-1.2 0-2.1.7-2.1 1.6 0 2.2 4.2.9 4.2 3 0 .9-.9 1.6-2.1 1.6-.8 0-1.5-.3-2-.9"/></svg>',
  tokens: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><path d="M8 1.8 14 5v6L8 14.2 2 11V5z"/><path d="M2 5l6 3.2L14 5M8 8.2v6"/></svg>',
  requests: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><path d="M2.5 5.5h9M9 2.5l3 3-3 3M13.5 10.5h-9M7 13.5l-3-3 3-3"/></svg>',
  cache: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><path d="M8.8 1.8 3.2 9h3.6l-.9 5.2L11.5 7H7.9z"/></svg>',
};

// 环比 badge：direction = up / down / flat；tone = good / bad / neutral
function usageHeroDelta(current, previous, options) {
  const { lowerIsBetter = false, formatter = (v) => String(v) } = options || {};
  if (previous == null) return "";
  const zh = currentLang === "zh";
  const cur = Number(current) || 0;
  const prev = Number(previous) || 0;
  if (prev === 0 && cur === 0) return "";
  let text;
  let direction;
  if (prev === 0) {
    text = zh ? "新增" : "new";
    direction = "up";
  } else {
    const pct = ((cur - prev) / prev) * 100;
    if (Math.abs(pct) < 0.05) {
      text = zh ? "持平" : "flat";
      direction = "flat";
    } else {
      text = `${pct > 0 ? "+" : ""}${Math.abs(pct) >= 100 ? pct.toFixed(0) : pct.toFixed(1)}%`;
      direction = pct > 0 ? "up" : "down";
    }
  }
  const tone =
    direction === "flat" ? "neutral" : (direction === "up") === lowerIsBetter ? "bad" : "good";
  const title = zh
    ? `上一时段：${formatter(prev)}`
    : `Previous period: ${formatter(prev)}`;
  const arrow = direction === "up" ? "↑" : direction === "down" ? "↓" : "→";
  return `<span class="usage-hero-delta usage-delta-${tone}" title="${escapeUsageHtml(title)}">${arrow} ${escapeUsageHtml(text)}</span>`;
}

function renderUsageHero(summary, prevSummary, byApp, pricing = {}) {
  const grid = $("usageHeroGrid");
  if (!grid) return;
  const zh = currentLang === "zh";
  const cacheRate = `${((Number(summary.cacheHitRate) || 0) * 100).toFixed(1)}%`;
  const prev = prevSummary || null;
  const costState = usageCostState(summary.totalCost, summary);
  const prevCostState = prev ? usageCostState(prev.totalCost, prev) : null;
  const costTitle = [
    costState.detail,
    pricing.pricingSource ? `${zh ? "参考价格" : "Reference prices"}: ${pricing.pricingSource}` : "",
    pricing.pricingDate || "",
    zh ? "按参考价快照及内置兼容价估算，未含渠道倍率；实际账单以服务商为准。" : "Reference snapshot and built-in fallback prices exclude channel multipliers; your provider determines the actual bill.",
  ].filter(Boolean).join("\n");
  // 缓存命中率是当前筛选内全部应用/模型的加权聚合；
  // 跨多个应用时在卡片上注明口径，避免被当成某单一工具的命中率
  const apps = Array.isArray(byApp) ? byApp : [];
  const cacheSub =
    apps.length > 1
      ? (zh
          ? `${apps.length} 个应用加权 · 各应用见下方卡片`
          : `Weighted across ${apps.length} apps · see per-app cards`)
      : `${zh ? "缓存读取" : "Cache read"} ${formatUsageTokens(summary.cacheReadTokens)} · ${zh ? "写入" : "Write"} ${formatUsageTokens(summary.cacheCreationTokens)}`;
  const cacheTitle = zh
    ? "命中率 = 缓存读取 ÷（新输入 + 缓存写入 + 缓存读取）\n为当前筛选范围内所有应用与模型的加权聚合。\n各应用的命中率见「按应用」卡片，各模型的命中率见「模型统计」表。"
    : "Hit rate = cache read ÷ (fresh input + cache write + cache read)\nWeighted aggregate across all apps and models in the current filter.\nSee per-app cards and the model table for individual rates.";
  const cards = [
    {
      label: zh ? "总成本" : "Total Cost",
      value: costState.value,
      sub: costState.detail || (zh ? "按模型参考价格估算" : "Estimated with reference prices"),
      title: costTitle,
      accent: "cost",
      delta: costState.incomplete || prevCostState?.incomplete ? "" : usageHeroDelta(summary.totalCost, prev?.totalCost, {
        lowerIsBetter: true,
        formatter: formatUsageCost,
      }),
    },
    {
      label: zh ? "总 Tokens" : "Total Tokens",
      value: formatUsageTokens(summary.realTotalTokens),
      sub: `${zh ? "输入" : "In"} ${formatUsageTokens(summary.inputTokens)} · ${zh ? "输出" : "Out"} ${formatUsageTokens(summary.outputTokens)}`,
      accent: "tokens",
      delta: usageHeroDelta(summary.realTotalTokens, prev?.realTotalTokens, {
        formatter: formatUsageTokens,
      }),
    },
    {
      label: zh ? "请求数" : "Requests",
      value: formatUsageTokens(summary.totalRequests),
      sub: zh ? "去重后的 API 消息数" : "Deduplicated API messages",
      accent: "requests",
      delta: usageHeroDelta(summary.totalRequests, prev?.totalRequests, {
        formatter: formatUsageTokens,
      }),
    },
    {
      label: zh ? "缓存命中率" : "Cache Hit Rate",
      value: cacheRate,
      sub: cacheSub,
      accent: "cache",
      delta: "",
      title: cacheTitle,
    },
  ];
  grid.innerHTML = cards
    .map(
      (card) => `
      <div class="usage-hero-card console-card usage-accent-${card.accent}"${card.title ? ` title="${escapeUsageHtml(card.title)}"` : ""}>
        <div class="usage-hero-head">
          <span class="usage-hero-icon">${USAGE_HERO_ICONS[card.accent] || ""}</span>
          <span class="usage-hero-label">${escapeUsageHtml(card.label)}</span>
        </div>
        <div class="usage-hero-value-row">
          <span class="usage-hero-value">${escapeUsageHtml(card.value)}</span>
          ${card.delta}
        </div>
        <div class="usage-hero-sub">${escapeUsageHtml(card.sub)}</div>
      </div>`
    )
    .join("");
}

const USAGE_QUAD_ICONS = {
  input: '<svg viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"><path d="M7 2.2v7.2M3.8 6.4 7 9.6l3.2-3.2M2.6 11.8h8.8"/></svg>',
  output: '<svg viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"><path d="M7 11.8V4.6M3.8 7.8 7 4.6l3.2 3.2M2.6 2.2h8.8"/></svg>',
  creation: '<svg viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"><rect x="2.2" y="2.2" width="9.6" height="9.6" rx="2"/><path d="M7 4.8v4.4M4.8 7h4.4"/></svg>',
  hit: '<svg viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"><path d="M7.6 1.6 2.8 8h3.1l-.8 4.4L9.9 6H6.8z"/></svg>',
};

// cc-switch 风格的应用大卡：完整千分位主数字 + 人性化换算 +
// 输入/输出/创建/命中四宫格 + 缓存命中率进度条
function renderUsageApps(byApp, totalSummary) {
  const grid = $("usageAppGrid");
  if (!grid) return;
  const zh = currentLang === "zh";
  setText(
    "usageAppsHint",
    zh ? "真实消耗 = 新增输入 + 输出 + 缓存写入 + 缓存读取" : "Real usage = fresh input + output + cache write + cache read"
  );
  if (!byApp.length) {
    grid.innerHTML = `<p class="usage-muted">${zh ? "当前筛选下没有数据" : "No data for current filter"}</p>`;
    return;
  }
  const totalCost = Number(totalSummary?.totalCost) || 0;
  const completeTotal = !usageCostState(totalSummary?.totalCost, totalSummary).incomplete;
  const sorted = [...byApp].sort(
    (a, b) => (Number(b.summary?.totalCost) || 0) - (Number(a.summary?.totalCost) || 0)
  );
  grid.innerHTML = sorted
    .map((entry) => {
      const s = entry.summary || {};
      const app = entry.app;
      const cost = Number(s.totalCost) || 0;
      const costState = usageCostState(s.totalCost, s);
      const sharePct = totalCost > 0 ? (cost / totalCost) * 100 : 0;
      const hitPct = (Number(s.cacheHitRate) || 0) * 100;
      const autoCache = USAGE_AUTO_CACHE_APPS.has(app) && !(Number(s.cacheCreationTokens) > 0);
      const creationValue = autoCache ? "N/A" : formatUsageTokensHuman(s.cacheCreationTokens);
      const creationTitle = autoCache
        ? (zh
            ? "该工具的本地日志未报告缓存写入量"
            : "This tool’s local logs do not report cache writes")
        : `${formatUsageTokensExact(s.cacheCreationTokens)} tokens`;
      const icon = USAGE_APP_ICONS[app];
      const iconHtml = icon
        ? `<img src="${icon}" alt="">`
        : `<span class="usage-app-badge usage-app-${escapeUsageHtml(app)}">${escapeUsageHtml(usageAppLabel(app).slice(0, 2))}</span>`;
      const quads = [
        {
          key: "input",
          label: zh ? "新增输入" : "Fresh Input",
          value: formatUsageTokensHuman(s.inputTokens),
          title: `${formatUsageTokensExact(s.inputTokens)} tokens`,
        },
        {
          key: "output",
          label: zh ? "输出" : "Output",
          value: formatUsageTokensHuman(s.outputTokens),
          title: `${formatUsageTokensExact(s.outputTokens)} tokens`,
        },
        {
          key: "creation",
          label: zh ? "缓存创建" : "Cache Write",
          value: creationValue,
          title: creationTitle,
          muted: autoCache,
        },
        {
          key: "hit",
          label: zh ? "缓存命中" : "Cache Read",
          value: formatUsageTokensHuman(s.cacheReadTokens),
          title: `${formatUsageTokensExact(s.cacheReadTokens)} tokens`,
        },
      ];
      const quadsHtml = quads
        .map(
          (q) => `
          <div class="usage-app-quad${q.muted ? " usage-quad-muted" : ""}" title="${escapeUsageHtml(q.title)}">
            <span class="usage-quad-icon usage-quad-${q.key}">${USAGE_QUAD_ICONS[q.key]}</span>
            <div class="usage-quad-body">
              <small>${escapeUsageHtml(q.label)}</small>
              <strong>${escapeUsageHtml(q.value)}</strong>
            </div>
          </div>`
        )
        .join("");
      return `
      <div class="usage-app-hero console-card">
        <div class="usage-app-hero-top">
          <div class="usage-app-hero-id">
            <span class="usage-app-hero-avatar">${iconHtml}</span>
            <div class="usage-app-hero-name">
              <strong>${escapeUsageHtml(usageAppLabel(app))}</strong>
              <small>${zh ? "真实消耗 Tokens" : "Real Tokens Used"}${completeTotal && !costState.incomplete && totalCost > 0 && sorted.length > 1 ? ` · ${zh ? "占总成本" : "cost share"} ${sharePct.toFixed(1)}%` : ""}</small>
            </div>
          </div>
          <div class="usage-app-hero-kpis">
            <div class="usage-app-hero-kpi">
              <small>${zh ? "总请求数" : "Requests"}</small>
              <strong>${escapeUsageHtml(formatUsageTokensExact(s.totalRequests))}</strong>
            </div>
            <div class="usage-app-hero-kpi usage-kpi-cost" title="${escapeUsageHtml(costState.detail)}">
              <small>${zh ? "总成本" : "Total Cost"}</small>
              <strong>${escapeUsageHtml(costState.value)}</strong>
            </div>
          </div>
        </div>
        <div class="usage-app-hero-big">
          <span class="usage-app-hero-number">${escapeUsageHtml(formatUsageTokensExact(s.realTotalTokens))}</span>
          <span class="usage-app-hero-approx">≈ ${escapeUsageHtml(formatUsageTokensHuman(s.realTotalTokens))}</span>
        </div>
        <div class="usage-app-hero-quads">${quadsHtml}</div>
        <div class="usage-app-hero-cache">
          <span class="usage-cache-label">${zh ? "缓存命中率" : "Cache hit rate"}</span>
          <div class="usage-cache-track"><div class="usage-cache-fill" style="width:${Math.min(hitPct, 100).toFixed(1)}%"></div></div>
          <strong class="usage-cache-pct">${hitPct.toFixed(1)}%</strong>
        </div>
      </div>`;
    })
    .join("");
}

// 组装趋势槽位：短窗口（≤48h）按小时补全，长窗口按天补全，
// 没有数据的时段补 0 值格子，保证时间轴连续、图形不空洞
function buildUsageTrendSlots(dashboard) {
  const range = usageResolvedRange || {};
  const nowSec = Math.floor(Date.now() / 1000);
  const spanKnown = Number.isFinite(range.startTs) && Number.isFinite(range.endTs);
  const hourlyMode = spanKnown && range.endTs - range.startTs <= 48 * 3600;
  const pad = (n) => String(n).padStart(2, "0");
  const slots = [];

  if (hourlyMode) {
    const hourlyData = new Map();
    (dashboard.hourly || []).forEach((h) => hourlyData.set(Number(h.hourStartTs), h));
    const startHour = new Date(range.startTs * 1000);
    startHour.setMinutes(0, 0, 0);
    for (let ms = startHour.getTime(); ms / 1000 <= range.endTs; ms += 3600000) {
      const ts = Math.floor(ms / 1000);
      const d = new Date(ms);
      const entry = hourlyData.get(ts);
      slots.push({
        label: pad(d.getHours()),
        fullLabel: `${d.getMonth() + 1}-${d.getDate()} ${pad(d.getHours())}:00`,
        cost: Number(entry?.cost) || 0,
        tokens: Number(entry?.totalTokens) || 0,
        requests: Number(entry?.requests) || 0,
        unpricedRequests: Number(entry?.unpricedRequests) || 0,
        partialCostRequests: Number(entry?.partialCostRequests) || 0,
        future: ts > nowSec,
      });
      if (slots.length >= 49) break;
    }
    return { mode: "hourly", slots };
  }

  const byDate = new Map();
  (dashboard.daily || []).forEach((d) => byDate.set(String(d.date), d));
  if (Number.isFinite(range.startTs)) {
    const cursor = new Date(range.startTs * 1000);
    cursor.setHours(0, 0, 0, 0);
    const endMs = Math.min((range.endTs ?? nowSec) * 1000, Date.now());
    while (cursor.getTime() <= endMs && slots.length < 60) {
      const dateKey = `${cursor.getFullYear()}-${pad(cursor.getMonth() + 1)}-${pad(cursor.getDate())}`;
      const entry = byDate.get(dateKey);
      slots.push({
        label: `${cursor.getMonth() + 1}-${cursor.getDate()}`,
        fullLabel: dateKey,
        cost: Number(entry?.cost) || 0,
        tokens: Number(entry?.totalTokens) || 0,
        requests: Number(entry?.requests) || 0,
        unpricedRequests: Number(entry?.unpricedRequests) || 0,
        partialCostRequests: Number(entry?.partialCostRequests) || 0,
        future: false,
      });
      cursor.setDate(cursor.getDate() + 1);
    }
  } else {
    // “全部”范围：直接用实际有数据的日期（最多最近 30 天）
    (dashboard.daily || []).slice(-30).forEach((d) => {
      slots.push({
        label: String(d.date).slice(5),
        fullLabel: String(d.date),
        cost: Number(d.cost) || 0,
        tokens: Number(d.totalTokens) || 0,
        requests: Number(d.requests) || 0,
        unpricedRequests: Number(d.unpricedRequests) || 0,
        partialCostRequests: Number(d.partialCostRequests) || 0,
        future: false,
      });
    });
  }
  return { mode: "daily", slots };
}

function renderUsageTrend(dashboard) {
  const chart = $("usageTrendChart");
  if (!chart) return;
  const zh = currentLang === "zh";
  const { mode, slots } = buildUsageTrendSlots(dashboard);
  const completeCosts = slots.every((s) => !usageCostState(s.cost, s).incomplete);
  const intervalLabel = mode === "hourly" ? (zh ? "按小时" : "Hourly") : (zh ? "按天" : "Daily");
  setText(
    "usageTrendHint",
    intervalLabel + (completeCosts ? "" : (zh ? " · 仅展示已知成本" : " · Known costs only"))
  );

  const footer = $("usageTrendFooter");
  if (!slots.length) {
    chart.innerHTML = `<p class="usage-muted">${zh ? "该范围内暂无数据" : "No data in this range"}</p>`;
    if (footer) footer.textContent = "";
    return;
  }

  const maxCost = Math.max(...slots.map((s) => s.cost), 0);
  const scale = maxCost > 0 ? maxCost : 1;
  // 标签密度：最多约 12 个可见标签
  const labelStep = Math.max(1, Math.ceil(slots.length / 12));
  const peakIndex = completeCosts && maxCost > 0 ? slots.findIndex((s) => s.cost === maxCost) : -1;

  chart.innerHTML = slots
    .map((slot, index) => {
      const heightPct = Math.max((slot.cost / scale) * 100, slot.cost > 0 ? 2.5 : 0);
      const costState = usageCostState(slot.cost, slot);
      const title = `${slot.fullLabel} · ${costState.value}${costState.detail ? ` · ${costState.detail}` : ""} · ${formatUsageTokens(slot.tokens)} tokens · ${slot.requests} ${zh ? "次请求" : "requests"}`;
      const colClasses = ["usage-trend-col"];
      if (slot.future) colClasses.push("usage-trend-future");
      if (index === peakIndex) colClasses.push("usage-trend-peak");
      const labelHidden = index % labelStep !== 0 && index !== slots.length - 1;
      const peakTag =
        index === peakIndex
          ? `<span class="usage-trend-peak-tag">${escapeUsageHtml(formatUsageCost(slot.cost))}</span>`
          : "";
      return `
      <div class="${colClasses.join(" ")}" title="${escapeUsageHtml(title)}">
        <div class="usage-trend-bar-wrap">${peakTag}<div class="usage-trend-bar" style="height:${heightPct}%"></div></div>
        <span class="usage-trend-date${labelHidden ? " usage-trend-label-hide" : ""}">${escapeUsageHtml(slot.label)}</span>
      </div>`;
    })
    .join("");

  if (footer) {
    const totalCost = slots.reduce((sum, s) => sum + s.cost, 0);
    const totalRequests = slots.reduce((sum, s) => sum + s.requests, 0);
    const activeSlots = slots.filter((s) => s.cost > 0 || s.requests > 0).length;
    const unit = mode === "hourly" ? (zh ? "小时" : "hours") : (zh ? "天" : "days");
    const costState = usageCostState(totalCost, {
      requests: totalRequests,
      unpricedRequests: slots.reduce((sum, s) => sum + s.unpricedRequests, 0),
      partialCostRequests: slots.reduce((sum, s) => sum + s.partialCostRequests, 0),
    });
    const parts = [
      `${zh ? "合计" : "Total"} ${costState.value}`,
      ...(costState.detail ? [costState.detail] : []),
      `${formatUsageTokens(totalRequests)} ${zh ? "次请求" : "requests"}`,
      `${activeSlots}/${slots.length} ${unit}${zh ? "有用量" : " active"}`,
    ];
    if (peakIndex >= 0) {
      parts.push(`${zh ? "峰值" : "Peak"} ${slots[peakIndex].fullLabel}`);
    }
    footer.textContent = parts.join(" · ");
  }
}

function renderUsageModels(models) {
  const tbody = $("usageModelTableBody");
  if (!tbody) return;
  const zh = currentLang === "zh";
  setText("usageModelsHint", zh ? `${models.length} 个模型` : `${models.length} models`);
  if (!models.length) {
    tbody.innerHTML = `<tr><td colspan="7" class="usage-muted">${zh ? "暂无模型数据" : "No model data"}</td></tr>`;
    return;
  }
  const totalCost = models.reduce((sum, m) => sum + (Number(m.cost) || 0), 0);
  const completeCosts = models.every((m) => !usageCostState(m.cost, m).incomplete);
  tbody.innerHTML = models
    .map((m) => {
      const cost = Number(m.cost) || 0;
      const costState = usageCostState(m.cost, m);
      const sharePct = totalCost > 0 ? (cost / totalCost) * 100 : 0;
      // cacheHitRate 为 null 表示该模型没有可缓存输入，显示 “--” 与 0% 区分
      const hitRate =
        m.cacheHitRate == null ? "--" : `${(Number(m.cacheHitRate) * 100).toFixed(1)}%`;
      return `
      <tr>
        <td class="usage-td-model" title="${escapeUsageHtml(m.model)}">${escapeUsageHtml(m.model)}</td>
        <td><span class="usage-app-badge usage-app-${escapeUsageHtml(m.app)}">${escapeUsageHtml(usageAppLabel(m.app))}</span></td>
        <td>${escapeUsageHtml(formatUsageTokens(m.requests))}</td>
        <td>${escapeUsageHtml(formatUsageTokens(m.totalTokens))}</td>
        <td>${escapeUsageHtml(hitRate)}</td>
        <td class="usage-td-cost" title="${escapeUsageHtml(costState.detail)}">${escapeUsageHtml(costState.value)}</td>
        <td class="usage-td-share">${completeCosts ? `
          <div class="usage-share-track"><div class="usage-share-fill" style="width:${Math.min(sharePct, 100).toFixed(1)}%"></div></div>
          <span class="usage-share-text">${sharePct.toFixed(1)}%</span>` : "—"}
        </td>
      </tr>`;
    })
    .join("");
}

function renderUsageRecent(recent) {
  const tbody = $("usageRecentTableBody");
  if (!tbody) return;
  const zh = currentLang === "zh";
  setText(
    "usageRecentHint",
    zh ? `最近 ${recent.length} 条` : `Latest ${recent.length}`
  );
  if (!recent.length) {
    tbody.innerHTML = `<tr><td colspan="5" class="usage-muted">${zh ? "暂无记录" : "No records"}</td></tr>`;
    return;
  }
  tbody.innerHTML = recent
    .map((log) => {
      const costState = usageCostState(log.cost, log);
      return `
      <tr>
        <td class="usage-td-time" title="${escapeUsageHtml(formatUsageTime(log.time))}">${escapeUsageHtml(formatUsageRelTime(log.time))}</td>
        <td><span class="usage-app-badge usage-app-${escapeUsageHtml(log.app)}">${escapeUsageHtml(usageAppLabel(log.app))}</span></td>
        <td class="usage-td-model" title="${escapeUsageHtml(log.model)}">${escapeUsageHtml(log.model)}</td>
        <td title="${zh ? "输入" : "In"} ${escapeUsageHtml(formatUsageTokens(log.inputTokens))} / ${zh ? "输出" : "Out"} ${escapeUsageHtml(formatUsageTokens(log.outputTokens))} / ${zh ? "缓存读" : "Cache read"} ${escapeUsageHtml(formatUsageTokens(log.cacheReadTokens))} / ${zh ? "缓存写" : "Cache write"} ${escapeUsageHtml(formatUsageTokens(log.cacheCreationTokens))}">${escapeUsageHtml(formatUsageTokens(log.totalTokens))}</td>
        <td class="usage-td-cost" title="${escapeUsageHtml(costState.detail)}">${escapeUsageHtml(costState.value)}</td>
      </tr>`;
    })
    .join("");
}

function applyUsagePanelLanguage() {
  const zh = currentLang === "zh";
  setText("usageNavLabel", zh ? "用量监控" : "Usage Monitor");
  setText("usagePageTitle", zh ? "用量监控" : "Usage Monitor");
  setText(
    "usagePageSubtitle",
    zh
      ? "统计 Claude Code、Codex、Gemini CLI、Grok CLI 的本地会话用量与成本。"
      : "Track local session usage and cost across Claude Code, Codex, Gemini CLI and Grok CLI."
  );
  setText("usageRefreshBtn", zh ? "刷新" : "Refresh");
  setText("usageLoadingChipText", zh ? "正在扫描会话日志…" : "Scanning session logs…");
  setText("usageAppsTitle", zh ? "按应用" : "By App");
  setText("usageTrendTitle", zh ? "成本趋势" : "Cost Trend");
  setText("usageModelsTitle", zh ? "模型统计" : "Model Stats");
  setText("usageRecentTitle", zh ? "最近记录" : "Recent Activity");
  setText("usageThModel", zh ? "模型" : "Model");
  setText("usageThApp2", zh ? "应用" : "App");
  setText("usageThRequests", zh ? "请求数" : "Requests");
  setText("usageThTotalTokens", "Tokens");
  setText("usageThCacheHit", zh ? "缓存命中" : "Cache Hit");
  setText("usageThCost", zh ? "成本 (USD)" : "Cost (USD)");
  setText("usageThShare", zh ? "成本占比" : "Cost Share");
  setText("usageThTime", zh ? "时间" : "Time");
  setText("usageThApp", zh ? "应用" : "App");
  setText("usageThRecentModel", zh ? "模型" : "Model");
  setText("usageThTokens", "Tokens");
  setText("usageThRecentCost", zh ? "成本 (USD)" : "Cost (USD)");
  renderUsageRangeNote();
  const rangeLabels = {
    today: zh ? "今天" : "Today",
    "1d": zh ? "24 小时" : "24 hours",
    "7d": zh ? "近 7 天" : "Last 7 days",
    "14d": zh ? "近 14 天" : "Last 14 days",
    "30d": zh ? "近 30 天" : "Last 30 days",
    all: zh ? "全部" : "All time",
    custom: zh ? "自定义" : "Custom",
  };
  document.querySelectorAll("#usageRangeSeg [data-usage-range]").forEach((btn) => {
    const key = btn.getAttribute("data-usage-range");
    if (rangeLabels[key]) btn.textContent = rangeLabels[key];
  });
  setText("usageCustomStartLabel", zh ? "开始时间" : "Start");
  setText("usageCustomEndLabel", zh ? "结束时间" : "End");
  setText("usageCustomLiveEndLabel", zh ? "结束取当前时间" : "End at now");
  setText("usageCustomApplyBtn", zh ? "应用" : "Apply");
  const allAppsBtn = document.querySelector('#usageAppSeg [data-usage-app="all"]');
  if (allAppsBtn) allAppsBtn.textContent = zh ? "全部应用" : "All apps";
  const modelAllOption = document.querySelector('#usageModelFilter option[value="all"]');
  if (modelAllOption) modelAllOption.textContent = zh ? "全部模型" : "All models";
}

function bindUsageUiOnce() {
  if (window.__varswitchUsageBound) return;
  window.__varswitchUsageBound = true;
  $("usageRefreshBtn")?.addEventListener("click", () => loadUsageDashboard());
  const toDatetimeLocalValue = (date) => {
    const pad = (n) => String(n).padStart(2, "0");
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
  };
  $("usageRangeSeg")?.addEventListener("click", (event) => {
    const btn = event.target.closest("[data-usage-range]");
    if (!btn) return;
    usageRange = btn.getAttribute("data-usage-range");
    document.querySelectorAll("#usageRangeSeg [data-usage-range]").forEach((b) => {
      b.classList.toggle("active", b === btn);
    });
    const customPanel = $("usageCustomRange");
    if (customPanel) customPanel.hidden = usageRange !== "custom";
    if (usageRange === "custom") {
      const startInput = $("usageCustomStart");
      const endInput = $("usageCustomEnd");
      if (startInput && !startInput.value) {
        startInput.value = toDatetimeLocalValue(new Date(Date.now() - 86400000));
      }
      if (endInput && !endInput.value) {
        endInput.value = toDatetimeLocalValue(new Date());
      }
      syncUsageCustomLiveEnd();
    }
    loadUsageDashboard();
  });
  const syncUsageCustomLiveEnd = () => {
    const endInput = $("usageCustomEnd");
    if (endInput) endInput.disabled = $("usageCustomLiveEnd")?.checked !== false;
  };
  $("usageCustomLiveEnd")?.addEventListener("change", syncUsageCustomLiveEnd);
  $("usageCustomApplyBtn")?.addEventListener("click", () => {
    if (usageRange === "custom") loadUsageDashboard();
  });
  $("usageAppSeg")?.addEventListener("click", (event) => {
    const btn = event.target.closest("[data-usage-app]");
    if (!btn) return;
    usageAppFilter = btn.getAttribute("data-usage-app");
    // 切换应用时重置模型筛选，避免残留上一个应用的模型
    usageModelFilter = "all";
    const modelSelect = $("usageModelFilter");
    if (modelSelect) modelSelect.value = "all";
    document.querySelectorAll("#usageAppSeg [data-usage-app]").forEach((b) => {
      b.classList.toggle("active", b === btn);
    });
    loadUsageDashboard();
  });
  $("usageModelFilter")?.addEventListener("change", (event) => {
    usageModelFilter = event.target.value || "all";
    loadUsageDashboard();
  });
}

// ── 会话管理器（Sessions）────────────────────────────────
// 浏览/搜索 Claude Code 与 Codex 的本机历史会话，一键恢复。
// 懒加载：首次进入页面才扫描；切走后不轮询，靠刷新按钮/搜索/筛选重查。
let cliSessionsQuery = "";
let cliSessionsAppFilter = "all";
let cliSessionsData = [];
let cliSessionsLoadedOnce = false;
// 请求序号：只渲染最新一次请求的结果，防止慢响应覆盖新筛选
let cliSessionsRequestSeq = 0;
let cliSessionsSearchTimer = null;

function applyCliSessionsPanelLanguage() {
  setText("cliSessionsNavLabel", t("cliSessionsNavLabel"));
  setText("cliSessionsPageTitle", t("cliSessionsPageTitle"));
  setText("cliSessionsPageSubtitle", t("cliSessionsPageSubtitle"));
  setText("cliSessionsRefreshBtn", t("cliSessionsRefresh"));
  setText("cliSessionsLoadingText", t("cliSessionsLoading"));
  setPlaceholder("cliSessionsSearchInput", t("cliSessionsSearchPlaceholder"));
  const allBtn = document.querySelector('#cliSessionsAppSeg [data-cli-sessions-app="all"]');
  if (allBtn) allBtn.textContent = t("cliSessionsFilterAll");
  // 列表行里的相对时间、按钮文案与空状态都依赖语言，已加载过就重绘
  if (cliSessionsLoadedOnce) {
    renderCliSessions();
  } else {
    setText("cliSessionsEmptyTitle", t("cliSessionsEmptyTitle"));
    setText("cliSessionsEmptyText", t("cliSessionsEmptyText"));
  }
}

async function loadCliSessions() {
  const seq = ++cliSessionsRequestSeq;
  const loading = $("cliSessionsLoading");
  if (loading) loading.hidden = false;
  const errorBox = $("cliSessionsError");
  if (errorBox) errorBox.hidden = true;
  try {
    const result = await invoke("list_cli_sessions", {
      query: cliSessionsQuery || null,
      app: cliSessionsAppFilter === "all" ? null : cliSessionsAppFilter,
      limit: 200,
    });
    // 慢响应回来时用户已改筛选，丢弃本次结果
    if (seq !== cliSessionsRequestSeq) return;
    cliSessionsData = Array.isArray(result?.sessions) ? result.sessions : [];
    cliSessionsLoadedOnce = true;
    renderCliSessions();
  } catch (error) {
    if (seq !== cliSessionsRequestSeq) return;
    if (errorBox) {
      errorBox.hidden = false;
      errorBox.textContent = t("cliSessionsLoadFailed", { error: String(error) });
    }
  } finally {
    if (seq === cliSessionsRequestSeq && loading) loading.hidden = true;
  }
}

function renderCliSessions() {
  const list = $("cliSessionsList");
  const empty = $("cliSessionsEmpty");
  if (!list || !empty) return;
  setText("cliSessionsCount", t("cliSessionsCount", { count: cliSessionsData.length }));
  if (!cliSessionsData.length) {
    // 有筛选条件时的空状态与「从未用过」区分开
    const filtered = Boolean(cliSessionsQuery) || cliSessionsAppFilter !== "all";
    list.innerHTML = "";
    empty.hidden = false;
    setText("cliSessionsEmptyTitle", filtered ? t("cliSessionsEmptyFilteredTitle") : t("cliSessionsEmptyTitle"));
    setText("cliSessionsEmptyText", filtered ? t("cliSessionsEmptyFilteredText") : t("cliSessionsEmptyText"));
    return;
  }
  empty.hidden = true;
  list.innerHTML = cliSessionsData
    .map((session, index) => {
      const app = session.app === "codex" ? "codex" : "claude";
      const title = (session.title || "").trim() || String(session.id || "").slice(0, 8);
      const cwd = (session.cwd || "").trim();
      return `
      <div class="cli-session-row">
        <span class="usage-app-badge usage-app-${app} cli-session-badge">${app === "codex" ? "Codex" : "Claude"}</span>
        <div class="cli-session-main">
          <div class="cli-session-title" title="${escapeUsageHtml(session.title || session.id || "")}">${escapeUsageHtml(title)}</div>
          <div class="cli-session-cwd" title="${escapeUsageHtml(cwd)}">${cwd ? escapeUsageHtml(cwd) : escapeUsageHtml(t("cliSessionsNoCwd"))}</div>
        </div>
        <span class="cli-session-time" title="${escapeUsageHtml(formatUsageTime(session.updatedAt))}">${escapeUsageHtml(formatUsageRelTime(session.updatedAt))}</span>
        <button class="btn btn-secondary btn-sm cli-session-resume-btn" type="button" data-cli-session-index="${index}">${escapeUsageHtml(t("cliSessionsResume"))}</button>
      </div>`;
    })
    .join("");
}

async function resumeCliSession(index, button) {
  const session = cliSessionsData[index];
  if (!session) return;
  setButtonBusy(button, true, t("cliSessionsResume"));
  try {
    await invoke("resume_cli_session", {
      app: session.app,
      id: session.id,
      cwd: session.cwd || null,
    });
    showToast(t("cliSessionsResumeOpened"));
  } catch (error) {
    showToast(t("cliSessionsResumeFailed", { error: String(error) }), "error");
  } finally {
    setButtonBusy(button, false);
  }
}

function bindCliSessionsUiOnce() {
  if (window.__varswitchCliSessionsBound) return;
  window.__varswitchCliSessionsBound = true;
  $("cliSessionsRefreshBtn")?.addEventListener("click", () => loadCliSessions());
  // 搜索输入防抖 300ms 后重查（子串过滤交给后端做）
  $("cliSessionsSearchInput")?.addEventListener("input", (event) => {
    clearTimeout(cliSessionsSearchTimer);
    const value = event.target.value || "";
    cliSessionsSearchTimer = setTimeout(() => {
      cliSessionsQuery = value.trim();
      loadCliSessions();
    }, 300);
  });
  $("cliSessionsAppSeg")?.addEventListener("click", (event) => {
    const btn = event.target.closest("[data-cli-sessions-app]");
    if (!btn) return;
    cliSessionsAppFilter = btn.getAttribute("data-cli-sessions-app") || "all";
    document.querySelectorAll("#cliSessionsAppSeg [data-cli-sessions-app]").forEach((b) => {
      b.classList.toggle("active", b === btn);
    });
    loadCliSessions();
  });
  // 恢复按钮走事件委托，避免每次渲染重复绑定
  $("cliSessionsList")?.addEventListener("click", (event) => {
    const btn = event.target.closest("[data-cli-session-index]");
    if (!btn) return;
    resumeCliSession(Number(btn.getAttribute("data-cli-session-index")), btn);
  });
}

function switchConsolePage(page) {
  const next = page || "add-provider";
  // 离开 toolbox 页时停掉轮询，避免后台空转
  if (activeConsolePage === "toolbox" && next !== "toolbox") {
    stopToolboxRefresh();
  }
  // 离开 Claude 页时停掉代理健康轮询（进入时由 loadProfiles → renderProfiles 重启）
  if (activeConsolePage === "claude" && next !== "claude") {
    stopProxyHealthRefresh();
  }
  if (activeConsolePage === "claude-desktop" && next !== "claude-desktop") {
    stopClaudeDesktopHealthRefresh();
  }
  activeConsolePage = next;
  // 与旧 page 切换兼容
  if (next === "claude" || next === "codex" || next === "grok" || next === "gemini" || next === "opencode") {
    currentPage = next;
  }

  document.querySelectorAll(".sidebar-item[data-console-page]").forEach((item) => {
    const isActive = item.getAttribute("data-console-page") === next;
    item.classList.toggle("active", isActive);
    if (isActive) {
      item.setAttribute("aria-current", "page");
    } else {
      item.removeAttribute("aria-current");
    }
  });
  document.querySelectorAll("[data-console-page-panel]").forEach((panel) => {
    panel.classList.toggle("active", panel.getAttribute("data-console-page-panel") === next);
  });

  if (next === "claude") {
    loadStatus();
    loadProfiles();
  } else if (next === "claude-desktop") {
    loadClaudeDesktopPage();
  } else if (next === "codex") {
    loadCodexProfiles();
    loadCodexStatus();
  } else if (next === "grok") {
    loadGrokProfiles();
    loadGrokStatus();
  } else if (next === "gemini") {
    loadGeminiProfiles();
    loadGeminiStatus();
  } else if (next === "opencode") {
    loadOpenCodeProfiles();
    loadOpenCodeStatus();
  } else if (next === "add-provider") {
    renderUniversalProviderForm();
  } else if (next === "toolbox") {
    loadCodexToolbox();
    switchToolboxTab("session");
  } else if (next === "usage") {
    bindUsageUiOnce();
    loadUsageDashboard();
  } else if (next === "cli-sessions") {
    bindCliSessionsUiOnce();
    // 懒加载：只有首次进入才扫描，之后靠刷新按钮/搜索重查，切走不轮询
    if (!cliSessionsLoadedOnce) loadCliSessions();
  } else if (next === "settings") {
    openSettingsInline();
  }

  renderNavigationStatus();

  // 滚动到主内容顶部
  $("workspaceMain")?.scrollTo?.({ top: 0, behavior: "smooth" });
  window.scrollTo({ top: 0, behavior: "smooth" });
}

async function openSettingsInline() {
  try {
    // 复用 openSettingsPanel 的数据加载，但不打开遮罩
    if (typeof loadAppSettings === "function") await loadAppSettings();
    const paths = await invoke("get_app_paths").catch(() => null);
    appPaths = paths || appPaths;
    if (paths) {
      if ($("settingsConfigDirValue")) $("settingsConfigDirValue").textContent = paths.configDir || "--";
      if ($("settingsClaudePathValue")) $("settingsClaudePathValue").textContent = paths.claudeSettings || "--";
      if ($("settingsCodexPathValue")) $("settingsCodexPathValue").textContent = paths.codexDir || paths.codexSettings || "--";
    }
    updateSettingsSegControls();
    // 数据目录信息独立加载，失败不影响其余设置项
    refreshDataDirInfo();
  } catch (error) {
    showToast(String(error), "error");
  }
}

/**
 * A10: 四套 provider（claude / codex / grok / gemini）的差异集中描述表。
 *
 * 只抽取「行为层」共性：切换 / 删除 / 编辑的后端命令名、toast 文案、刷新函数。
 * 卡片 HTML 不参数化：四种 provider 展示的字段本就不同（grok 有 apiBackend，
 * codex 有 providerName / imageApiKey / imageBaseUrl），硬套模板只会让可读性变差。
 *
 * 注意：claude 的切换流程与其余三家差异很大（要监听 switch-progress、
 * 后端统一快照与回滚、支持进度与取消），
 * 因此 claude 的 switch 保留独立实现，这张表里只复用它的 delete / edit。
 */
const PROVIDER_CONFIG = {
  claude: {
    label: "Claude",
    getProfiles: () => profiles,
    deleteCommand: "delete_profile",
    deletedToast: () => t("toastDeleted"),
    openEditModal: (profile) => openModal(profile),
    reload: () => Promise.all([loadProfiles(), loadStatus()]),
  },
  codex: {
    label: "Codex",
    getProfiles: () => codexProfiles,
    switchCommand: "switch_codex_profile",
    deleteCommand: "delete_codex_profile",
    switchedToast: (name) => t("codexSwitchedTo", { name }),
    deletedToast: () => t("codexToastDeleted"),
    // codex 删除时额外提示「不会自动删除远程 API 服务」
    confirmDeleteMessage: (profile) =>
      currentLang === "zh"
        ? `删除配置 “${profile.name}”？\n\n删除后将无法从 VarSwitch 中恢复，但不会自动删除远程 API 服务。`
        : t("confirmDelete", { name: profile.name }),
    openEditModal: (profile) => openCodexModal(profile),
    reload: () => Promise.all([loadCodexProfiles(), loadCodexStatus()]),
    switchSettleMs: 250,
  },
  grok: {
    label: "Grok",
    getProfiles: () => grokProfiles,
    switchCommand: "switch_grok_profile",
    deleteCommand: "delete_grok_profile",
    switchedToast: (name) => t("grokSwitchedTo", { name }),
    deletedToast: () => t("grokToastDeleted"),
    openEditModal: (profile) => openGrokModal(profile),
    reload: () => Promise.all([loadGrokProfiles(), loadGrokStatus(), loadGrokDiagnostics()]),
    switchSettleMs: 250,
  },
  gemini: {
    label: "Gemini",
    getProfiles: () => geminiProfiles,
    switchCommand: "switch_gemini_profile",
    deleteCommand: "delete_gemini_profile",
    switchedToast: (name) => `Gemini 已切换到 ${name}`,
    deletedToast: () => "Gemini 配置已删除",
    openEditModal: (profile) => openGeminiModal(profile),
    reload: () => Promise.all([loadGeminiProfiles(), loadGeminiStatus()]),
    // gemini 原实现切换后没有额外停留，保持一致
    switchSettleMs: 0,
  },
  opencode: {
    label: "OpenCode",
    getProfiles: () => opencodeProfiles,
    switchCommand: "switch_opencode_profile",
    deleteCommand: "delete_opencode_profile",
    switchedToast: (name) => t("opencodeSwitchedTo", { name }),
    deletedToast: () => t("opencodeToastDeleted"),
    openEditModal: (profile) => openOpenCodeModal(profile),
    reload: () => Promise.all([loadOpenCodeProfiles(), loadOpenCodeStatus()]),
    switchSettleMs: 250,
  },
};

function findProviderProfile(type, id) {
  return PROVIDER_CONFIG[type]?.getProfiles()?.find((item) => item.id === id) || null;
}

/**
 * codex / grok / gemini 的通用切换流程（claude 不走这里，见 handleSwitch）。
 */
async function switchProviderProfile(type, id) {
  const config = PROVIDER_CONFIG[type];
  if (!config?.switchCommand) return;
  if (isSwitchingProfile) return;
  const profile = findProviderProfile(type, id);
  if (!profile) return;

  isSwitchingProfile = true;
  showSwitchOverlay(profile.name, type);
  try {
    await waitForNextPaint();
    await invoke(config.switchCommand, { id });
    completeSwitchOverlay();
    if (config.switchSettleMs) {
      await new Promise((resolve) => setTimeout(resolve, config.switchSettleMs));
    }
    showToast(config.switchedToast(profile.name || ""), "success");
  } catch (error) {
    showToast(String(error), "error");
  } finally {
    hideSwitchOverlay();
    isSwitchingProfile = false;
    await config.reload();
  }
}

/**
 * 四套 provider 通用的删除流程（确认弹窗 → 调后端 → 刷新）。
 */
async function deleteProviderProfile(type, id) {
  const config = PROVIDER_CONFIG[type];
  if (!config?.deleteCommand) return;
  const profile = findProviderProfile(type, id);
  if (!profile) return;

  const message = config.confirmDeleteMessage
    ? config.confirmDeleteMessage(profile)
    : t("confirmDelete", { name: profile.name });
  const confirmed = await appConfirm(message, {
    title: t("delete"),
    confirmText: currentLang === "zh" ? "删除配置" : "Delete",
    danger: true,
  });
  if (!confirmed) return;

  try {
    await invoke(config.deleteCommand, { id });
    showToast(config.deletedToast(), "success");
    await config.reload();
  } catch (error) {
    showToast(String(error), "error");
  }
}

function editProviderProfile(type, id) {
  const config = PROVIDER_CONFIG[type];
  const profile = findProviderProfile(type, id);
  if (config && profile) config.openEditModal(profile);
}

async function switchAnyProviderProfile(type, id) {
  // claude 的切换流程特殊，单独走 handleSwitch
  if (type === "claude") return handleSwitch(id);
  return switchProviderProfile(type, id);
}

function renderConfigurationList() {
  const host = $("configurationList");
  if (!host) return;
  const q = (configurationSearch || "").trim().toLowerCase();
  const rows = [];
  profiles.forEach((p) => rows.push({ type: "claude", profile: p }));
  codexProfiles.forEach((p) => rows.push({ type: "codex", profile: p }));
  grokProfiles.forEach((p) => rows.push({ type: "grok", profile: p }));
  geminiProfiles.forEach((p) => rows.push({ type: "gemini", profile: p }));

  const filtered = rows.filter(({ type, profile }) => {
    if (configurationFilter === "claude" && type !== "claude") return false;
    if (configurationFilter === "codex" && type !== "codex") return false;
    if (configurationFilter === "grok" && type !== "grok") return false;
    if (configurationFilter === "gemini" && type !== "gemini") return false;
    if (configurationFilter === "active" && !profile.isActive) return false;
    if (!q) return true;
    const hay = `${profile.name || ""} ${profile.baseUrl || ""} ${profile.providerName || ""} ${profile.model || ""}`.toLowerCase();
    return hay.includes(q);
  });

  if ($("configNavCount")) $("configNavCount").textContent = String(rows.length);

  if (!filtered.length) {
    host.innerHTML = `<div class="empty-inline">${currentLang === "zh" ? "没有匹配的配置" : "No matching configs"}</div>`;
    return;
  }

  host.innerHTML = filtered
    .map(({ type, profile }) => {
      const icon = type === "claude" ? "anthropic-color.svg"
        : type === "codex" ? "OpenAI-black-monoblossom.svg"
        : type === "gemini" ? "gemini-color.svg"
        : "grok-color.svg";
      const typeLabel = type === "claude" ? "Claude"
        : type === "codex" ? "Codex"
        : type === "gemini" ? "Gemini"
        : "Grok";
      const badge = profile.isActive
        ? `<span class="status-badge-console healthy">${currentLang === "zh" ? "使用中" : "Active"}</span>`
        : `<span class="status-badge-console">${currentLang === "zh" ? "未启用" : "Idle"}</span>`;
      return `<div class="configuration-row configuration-row-manager" data-config-type="${type}" data-config-id="${esc(profile.id)}">
        <div class="configuration-data">
          <div class="configuration-main"><img src="${icon}" alt=""><div><strong>${esc(profile.name)}</strong><small>${typeLabel}</small></div></div>
          <div class="configuration-meta">${esc(maskKey(profile.apiKey || ""))}<br>${esc(truncUrl(profile.baseUrl || "", 42))}</div>
          <div class="configuration-state">${badge}<div class="configuration-meta configuration-model">${esc(profile.model || profile.providerName || "--")}</div></div>
        </div>
        <div class="configuration-actions">
          ${profile.isActive
            ? `<span class="configuration-action-slot" aria-hidden="true"></span>`
            : `<button class="btn btn-secondary btn-sm" data-action="switch" type="button">${currentLang === "zh" ? "切换" : "Use"}</button>`}
          <button class="btn btn-ghost btn-sm" data-action="edit" type="button">${currentLang === "zh" ? "编辑" : "Edit"}</button>
          <button class="btn btn-ghost btn-sm" data-action="copy" type="button">${currentLang === "zh" ? "复制" : "Duplicate"}</button>
          <button class="btn btn-danger btn-sm" data-action="delete" type="button">${currentLang === "zh" ? "删除" : "Delete"}</button>
        </div>
      </div>`;
    })
    .join("");

  // A10: 容器级委托，provider 类型与 id 从卡片行的 data-* 上就近读取
  bindDelegatedActions(host, "ConfigurationList", async (action, target) => {
    const row = target.closest(".configuration-row");
    if (!row) return;
    const type = row.getAttribute("data-config-type");
    const id = row.getAttribute("data-config-id");
    if (!PROVIDER_CONFIG[type] || !id) return; // 未知类型不执行
    if (action === "switch") await switchAnyProviderProfile(type, id);
    else if (action === "edit") editProviderProfile(type, id);
    else if (action === "copy") duplicateConfiguration(type, id);
    else if (action === "delete") await deleteProviderProfile(type, id);
    else return;
    renderConfigurationList();
  });
}

function renderSessionStatusCard() {
  const summary = $("sessionStatusSummary");
  const metrics = $("sessionStatusMetrics");
  if (!summary || !metrics) return;
  const sessionMetrics = helpers.getCodexSessionMetrics?.(codexToolbox) || { count: 0, trashCount: 0, lastSyncedAt: "" };
  const { count, trashCount, lastSyncedAt } = sessionMetrics;
  const lastSyncLabel = lastSyncedAt ? formatToolboxSessionTime(lastSyncedAt) : "--";
  summary.textContent = currentLang === "zh" ? `已同步 ${count} 个会话` : `${count} sessions synced`;
  metrics.innerHTML = `
    <div class="wizard-review-item"><small>${currentLang === "zh" ? "已同步" : "Synced"}</small><strong>${count}</strong></div>
    <div class="wizard-review-item"><small>${currentLang === "zh" ? "回收站" : "Trash"}</small><strong>${trashCount}</strong></div>
    <div class="wizard-review-item"><small>${currentLang === "zh" ? "最近同步" : "Last sync"}</small><strong>${esc(lastSyncLabel)}</strong></div>
  `;
  metrics.className = "wizard-review";
  if ($("sessionNavCount")) $("sessionNavCount").textContent = String(count);
}

function renderNavigationStatus() {
  renderProviderNavigation();
  const activeClaude = profiles.find((profile) => profile.isActive);
  const activeCodex = codexProfiles.find((profile) => profile.isActive);
  const activeGrok = grokProfiles.find((profile) => profile.isActive);
  const activeGemini = geminiProfiles.find((profile) => profile.isActive);
  const activeOpenCode = opencodeProfiles.find((profile) => profile.isActive);
  const claudeLoaded = lastClaudeStatus != null || profiles.length > 0;
  const codexLoaded = lastCodexStatus != null || codexProfiles.length > 0;
  const grokLoaded = lastGrokStatus != null || grokProfiles.length > 0;
  const geminiLoaded = lastGeminiStatus != null || geminiProfiles.length > 0;
  const claudeOk = !!(lastClaudeStatus?.envVars || lastClaudeStatus?.claude || activeClaude);
  const codexOk = !!(lastCodexStatus?.accountLogin || lastCodexStatus?.apiKey || activeCodex);
  const grokOk = !!(lastGrokStatus?.apiKey || activeGrok);
  const geminiOk = !!(lastGeminiStatus?.apiKey || activeGemini);
  const opencodeLoaded = lastOpenCodeStatus != null || opencodeProfiles.length > 0;
  const opencodeOk = !!(lastOpenCodeStatus?.apiKey || activeOpenCode);

  setNavDot("claudeNavState", !claudeLoaded ? "" : claudeOk ? "healthy" : "warning");
  setNavDot("codexNavState", !codexLoaded ? "" : codexOk ? "healthy" : "warning");
  setNavDot("grokNavState", !grokLoaded ? "" : grokOk ? "healthy" : "warning");
  setNavDot("geminiNavState", !geminiLoaded ? "" : geminiOk ? "healthy" : "warning");
  setNavDot("opencodeNavState", !opencodeLoaded ? "" : opencodeOk ? "healthy" : "warning");

  const channels = codexToolbox?.mobileChannels || [];
  const mobileBound = Array.isArray(channels) && channels.some((channel) => channel.bound || channel.appId || channel.botToken);
  setNavDot("mobileNavState", mobileBound ? "healthy" : "");

}

function renderMobileTimeline() {
  const list = $("mobileTimeline");
  if (!list || !codexToolbox) return;
  const channels = codexToolbox.mobileChannels || [];
  const bound = channels.some((c) => c.bound || c.appId || c.botToken || c.qrDeviceCode);
  const hasSession = !!(selectedCodexThreadId || codexToolbox.selectedThreadId);
  const listening = !!(codexToolbox.remoteRunning || codexToolbox.isListening);
  list.querySelectorAll("li").forEach((li) => {
    const step = li.getAttribute("data-step");
    let done = false;
    if (step === "bind") done = bound;
    if (step === "session") done = hasSession;
    if (step === "listen") done = listening;
    if (step === "wait") done = listening;
    li.classList.toggle("done", done);
    li.classList.toggle("active", !done && ((step === "bind" && !bound) || (step === "session" && bound && !hasSession) || (step === "listen" && bound && hasSession && !listening) || (step === "wait" && listening)));
  });
}

function duplicateConfiguration(type, id) {
  const copySuffix = currentLang === "zh" ? "副本" : "Copy";
  if (type === "claude") {
    const profile = profiles.find((item) => item.id === id);
    if (!profile) return;
    openModal(null);
    $("profileName").value = `${profile.name} ${copySuffix}`;
    $("profileApiKey").value = profile.apiKey || "";
    $("profileBaseUrl").value = profile.baseUrl || "";
    $("profileModelId").value = profile.modelId || "";
  } else if (type === "codex") {
    const profile = codexProfiles.find((item) => item.id === id);
    if (!profile) return;
    openCodexModal(null);
    $("codexProfileName").value = `${profile.name} ${copySuffix}`;
    $("codexApiKey").value = profile.apiKey || "";
    $("codexBaseUrl").value = profile.baseUrl || "";
    $("codexModel").value = profile.model || "";
    if ($("codexWireApi")) $("codexWireApi").value = profile.wireApi || "responses";
    $("codexProvider").value = profile.providerName || "";
    $("codexImageApiKey").value = profile.imageApiKey || "";
    $("codexImageBaseUrl").value = profile.imageBaseUrl || "";
    setCodexAuthMode(profile.authMode || "auth_json");
  } else {
    const profile = grokProfiles.find((item) => item.id === id);
    if (!profile) return;
    openGrokModal(null);
    $("grokProfileName").value = `${profile.name} ${copySuffix}`;
    $("grokApiKey").value = profile.apiKey || "";
    $("grokBaseUrl").value = profile.baseUrl || "https://api.x.ai/v1";
    $("grokModel").value = profile.model || "";
    if ($("grokApiBackend")) $("grokApiBackend").value = profile.apiBackend || "chat_completions";
  }
  showToast(currentLang === "zh" ? "已创建配置副本，请确认后保存" : "Config duplicated. Review and save it.", "success");
}

// 窄窗口下侧边栏收起文字只留图标，靠原生 tooltip 说明每一项是什么。
// title 从项内的文字标签取，切换语言后重新调用即可保持同步。
function syncSidebarItemTitles() {
  document.querySelectorAll(".sidebar-item").forEach((item) => {
    const label = item.querySelector("span:not(.nav-state-dot):not(.nav-count)");
    const text = label?.textContent.trim();
    if (text) item.title = text;
  });
}

function bindConsoleUiOnce() {
  if (window.__varswitchConsoleBound) return;
  window.__varswitchConsoleBound = true;

  syncSidebarItemTitles();

  // 事件委托：侧边栏 / 指标卡 / 快捷入口一定可点
  document.addEventListener("click", (event) => {
    const nav = event.target.closest("[data-console-page]");
    if (!nav) return;
    // 忽略弹窗表单内的无关节点
    if (nav.closest(".modal-overlay")) return;
    const page = nav.getAttribute("data-console-page");
    if (!page) return;
    if (
      nav.tagName === "BUTTON" ||
      nav.classList.contains("sidebar-item") ||
      nav.classList.contains("quick-action") ||
      nav.classList.contains("sidebar-settings")
    ) {
      event.preventDefault();
      if (page === "developer-tools") openDeveloperTools("skills");
      else switchConsolePage(page);
    }
  });

  document.querySelectorAll("[data-universal-preset]").forEach((button) => {
    button.addEventListener("click", () => applyUniversalProviderPreset(button.getAttribute("data-universal-preset")));
  });
  document.querySelectorAll("[data-universal-app]").forEach((input) => {
    input.addEventListener("change", renderUniversalProviderForm);
  });
  $("universalProviderForm")?.addEventListener("submit", handleUniversalProviderSubmit);
  $("universalProviderResetBtn")?.addEventListener("click", () => resetUniversalProviderForm());
  $("universalEndpointTestBtn")?.addEventListener("click", handleUniversalEndpointTest);
  $("universalProviderBaseUrl")?.addEventListener("input", updateUniversalUrlPreviews);
  $("universalClaudeApiFormat")?.addEventListener("change", updateUniversalUrlPreviews);
  $("universalProviderApiKeyToggle")?.addEventListener("click", () => {
    const input = $("universalProviderApiKey");
    const showing = input.type === "password";
    input.type = showing ? "text" : "password";
    setText("universalProviderApiKeyToggle", showing ? t("hideKey") : t("showKey"));
  });
  $("claudePageAddBtn")?.addEventListener("click", () => openModal(null));
  $("claudePageImportBtn")?.addEventListener("click", handleImport);
  $("claudeSyncBtn")?.addEventListener("click", handleSyncNow);
  $("profileApiFormat")?.addEventListener("change", updateProxyFailoverGroupVisibility);
  $("proxyHealthResetBtn")?.addEventListener("click", handleProxyHealthReset);
  $("claudeDesktopAddBtn")?.addEventListener("click", () => openClaudeDesktopProfileDialog());
  $("claudeDesktopImportBtn")?.addEventListener("click", importClaudeProfilesToDesktop);
  $("claudeDesktopSyncBtn")?.addEventListener("click", syncClaudeDesktopProfile);
  $("claudeDesktopGatewayResetBtn")?.addEventListener("click", resetClaudeDesktopGatewayBreaker);
  $("claudeDesktopProfileConnectionMode")?.addEventListener("change", updateClaudeDesktopProfileFormState);
  $("claudeDesktopProfileModelFetchBtn")?.addEventListener("click", () => fetchClaudeDesktopModels());
  $("claudeDesktopProfileEndpointTestBtn")?.addEventListener("click", () => fetchClaudeDesktopModels({ triggerButtonId: "claudeDesktopProfileEndpointTestBtn" }));
  $("claudeDesktopProfileBaseUrl")?.addEventListener("input", () => clearProviderInlineStatus("claude-desktop"));
  $("claudeDesktopProfileApiKey")?.addEventListener("input", () => clearProviderInlineStatus("claude-desktop"));
  $("claudeDesktopProfileAddMappingBtn")?.addEventListener("click", addClaudeDesktopModelMapping);
  $("claudeDesktopProfileClose")?.addEventListener("click", closeClaudeDesktopProfileDialog);
  $("claudeDesktopProfileCancel")?.addEventListener("click", closeClaudeDesktopProfileDialog);
  $("claudeDesktopProfileForm")?.addEventListener("submit", submitClaudeDesktopProfile);
  bindOverlayDismiss("claudeDesktopProfileOverlay", closeClaudeDesktopProfileDialog);
  $("codexPageAddBtn")?.addEventListener("click", () => openCodexModal(null));
  $("codexPageImportBtn")?.addEventListener("click", handleCodexImport);
  $("codexAccountLoginBtn")?.addEventListener("click", handleCodexAccountLogin);
  $("codexSyncBtn")?.addEventListener("click", () => {
    const active = codexProfiles.find((profile) => profile.isActive);
    if (active) handleCodexSwitch(active.id);
    else showToast(currentLang === "zh" ? "暂无启用的 Codex 配置" : "No active Codex profile", "warning");
  });
  $("geminiPageAddBtn")?.addEventListener("click", () => openGeminiModal(null));
  $("geminiPageImportBtn")?.addEventListener("click", handleGeminiImport);
  // 与 Claude 的“立即同步”语义一致:重新应用当前启用的配置
  $("geminiRefreshBtn")?.addEventListener("click", () => {
    const active = geminiProfiles.find((p) => p.isActive);
    if (active) handleGeminiSwitch(active.id);
    else showToast(currentLang === "zh" ? "暂无启用的 Gemini 配置" : "No active Gemini profile", "warning");
  });
  $("sessionPageSyncBtn")?.addEventListener("click", handleToolboxSessionSync);
  $("settingsLangZh")?.addEventListener("click", () => setLanguage("zh"));
  $("settingsLangEn")?.addEventListener("click", () => setLanguage("en"));
  $("settingsThemeLight")?.addEventListener("click", () => setTheme("light"));
  $("settingsThemeDark")?.addEventListener("click", () => setTheme("dark"));
  $("settingsGuideBtn")?.addEventListener("click", () => openUsageGuide());
  $("settingsUpdateBtn")?.addEventListener("click", () => handleUpdateButton());
  $("settingsDownloadBtn")?.addEventListener("click", () => openUpdateReleasePage());
  $("settingsGithubBtn")?.addEventListener("click", () => openGitHubRepo());
  document.querySelectorAll("[data-developer-tool]").forEach((button) => {
    button.addEventListener("click", () => switchDeveloperTool(button.getAttribute("data-developer-tool")));
  });

  // Codex 表单附加控件
  $("codexSaveEnableBtn")?.addEventListener("click", async () => {
    codexEnableAfterSave = true;
    $("codexSubmitBtn")?.click();
  });
  bindProviderDialogEnhancements();
}

function enhanceAfterDataLoad() {
  renderNavigationStatus();
  renderUniversalProviderForm();
  renderSessionStatusCard();
  renderMobileTimeline();
}

let configTypeAction = "add";

function closeConfigTypeDialog() {
  $("configTypeOverlay")?.classList.remove("open");
  document.body.classList.remove("modal-open");
}

function openConfigTypeDialog(action = "add") {
  configTypeAction = action === "import" ? "import" : "add";
  if ($("configTypeTitle")) {
    $("configTypeTitle").textContent = configTypeAction === "import"
      ? (currentLang === "zh" ? "选择导入类型" : "Choose import type")
      : (currentLang === "zh" ? "选择配置类型" : "Choose config type");
  }
  if ($("configTypeMessage")) {
    $("configTypeMessage").textContent = configTypeAction === "import"
      ? (currentLang === "zh" ? "选择要从当前本机环境导入的配置类型。" : "Choose which current local configuration to import.")
      : (currentLang === "zh" ? "选择要添加的配置类型。" : "Choose the configuration type to add.");
  }
  $("configTypeOverlay")?.classList.add("open");
  document.body.classList.add("modal-open");
  setTimeout(() => $("configTypeOverlay")?.querySelector("[data-config-kind]")?.focus(), 30);
}

function runConfigTypeAction(kind) {
  closeConfigTypeDialog();
  switchConsolePage(kind);
  if (configTypeAction === "import") {
    if (kind === "claude") handleImport();
    else if (kind === "codex") handleCodexImport();
    else handleGrokImport();
    return;
  }
  if (kind === "claude") openModal(null);
  else if (kind === "codex") openCodexModal(null);
  else openGrokModal(null);
}

function bindConfigTypeDialogOnce() {
  if (window.__varswitchConfigTypeBound) return;
  window.__varswitchConfigTypeBound = true;
  $("configTypeClose")?.addEventListener("click", closeConfigTypeDialog);
  $("configTypeCancel")?.addEventListener("click", closeConfigTypeDialog);
  bindOverlayDismiss("configTypeOverlay", closeConfigTypeDialog);
  $("configTypeOverlay")?.querySelectorAll("[data-config-kind]").forEach((button) => {
    button.addEventListener("click", () => runConfigTypeAction(button.getAttribute("data-config-kind")));
  });
}


// 在应用页上触发添加时直接打开该应用的表单；其他页面进入统一供应商页
function triggerCurrentAdd() {
  if (activeConsolePage === "claude") openModal(null);
  else if (activeConsolePage === "codex") openCodexModal(null);
  else if (activeConsolePage === "grok") openGrokModal(null);
  else if (activeConsolePage === "gemini") openGeminiModal(null);
  else openProviderOnboarding(null);
}

function triggerCurrentImport() {
  if (activeConsolePage === "codex") handleCodexImport();
  else if (activeConsolePage === "grok") handleGrokImport();
  else if (activeConsolePage === "gemini") handleGeminiImport();
  else if (activeConsolePage === "claude") handleImport();
  else handleImport();
}

on("langZhBtn", "click", () => setLanguage("zh"));
on("langEnBtn", "click", () => setLanguage("en"));
on("themeLightBtn", "click", () => setTheme("light"));
on("themeDarkBtn", "click", () => setTheme("dark"));
on("cancelBtn", "click", closeModal);
on("modalClose", "click", closeModal);
on("switchCancelBtn", "click", handleCancelSwitch);
on("profileForm", "submit", handleSubmit);
on("profilePresetSelect", "change", () => applyClaudePreset(getSelectedClaudePreset()));
on("profileBaseUrl", "focus", () => tryClipboardAutoFill("url", "profileBaseUrl"));
on("profileApiKey", "focus", () => tryClipboardAutoFill("key", "profileApiKey"));
on("profileBaseUrl", "input", () => clearProviderInlineStatus("claude"));
on("profileApiKey", "input", () => clearProviderInlineStatus("claude"));
on("profileModelFetchBtn", "click", () => handleModelFetch("claude"));
on("profileEndpointTestBtn", "click", () => handleEndpointTest("claude"));
bindOverlayDismiss("modalOverlay", closeModal);

// ── Codex Modal Event Listeners ─────────────────────

on("codexCancelBtn", "click", closeCodexModal);
on("codexModalClose", "click", closeCodexModal);
on("codexProfileForm", "submit", handleCodexSubmit);
on("codexPresetSelect", "change", () => applyCodexPreset(getSelectedCodexPreset()));
on("codexBaseUrl", "input", () => syncCodexWireApiControl());
on("codexProvider", "input", () => syncCodexWireApiControl());
on("codexBaseUrl", "focus", () => tryClipboardAutoFill("url", "codexBaseUrl"));
on("codexApiKey", "focus", () => tryClipboardAutoFill("key", "codexApiKey"));
on("codexBaseUrl", "input", () => clearProviderInlineStatus("codex"));
on("codexApiKey", "input", () => clearProviderInlineStatus("codex"));
on("codexImageBaseUrl", "focus", () => tryClipboardAutoFill("url", "codexImageBaseUrl"));
on("codexImageApiKey", "focus", () => tryClipboardAutoFill("key", "codexImageApiKey"));
on("codexBaseUrl", "input", updateCodexOfficialConfigPreview);
on("codexApiKey", "input", updateCodexOfficialConfigPreview);
on("codexImageBaseUrl", "input", updateCodexOfficialConfigPreview);
on("codexImageApiKey", "input", updateCodexOfficialConfigPreview);
$("codexAuthModeDefault")?.addEventListener("change", updateCodexAuthModeUi);
$("codexAuthModeOfficial")?.addEventListener("change", updateCodexAuthModeUi);
$("codexAuthModeSaveOnly")?.addEventListener("change", updateCodexAuthModeUi);
on("codexCopyOfficialConfigBtn", "click", copyCodexOfficialConfig);
on("codexModelFetchBtn", "click", () => handleModelFetch("codex"));
on("codexEndpointTestBtn", "click", () => handleEndpointTest("codex"));
bindOverlayDismiss("codexModalOverlay", closeCodexModal);

// ── Grok Modal Event Listeners ──────────────────────

$("grokCancelBtn")?.addEventListener("click", closeGrokModal);
$("grokModalClose")?.addEventListener("click", closeGrokModal);
$("grokProfileForm")?.addEventListener("submit", handleGrokSubmit);
$("grokPresetSelect")?.addEventListener("change", () => applyGrokPreset(getSelectedGrokPreset()));
$("grokBaseUrl")?.addEventListener("focus", () => tryClipboardAutoFill("url", "grokBaseUrl"));
$("grokApiKey")?.addEventListener("focus", () => tryClipboardAutoFill("key", "grokApiKey"));
$("grokBaseUrl")?.addEventListener("input", () => clearProviderInlineStatus("grok"));
$("grokApiKey")?.addEventListener("input", () => clearProviderInlineStatus("grok"));
$("grokModelFetchBtn")?.addEventListener("click", () => handleModelFetch("grok"));
$("grokEndpointTestBtn")?.addEventListener("click", () => handleEndpointTest("grok"));
bindOverlayDismiss("grokModalOverlay", closeGrokModal);
$("grokPageAddBtn")?.addEventListener("click", () => openGrokModal(null));
// 与 Claude 的“立即同步”语义一致:重新应用当前启用的配置
$("grokRefreshBtn")?.addEventListener("click", () => {
  const active = grokProfiles.find((p) => p.isActive);
  if (active) handleGrokSwitch(active.id);
  else showToast(currentLang === "zh" ? "暂无启用的 Grok 配置" : "No active Grok profile", "warning");
});
$("grokPageImportBtn")?.addEventListener("click", handleGrokImport);

// ── Gemini Modal Event Listeners ───────────────────

$("geminiCancelBtn")?.addEventListener("click", closeGeminiModal);
$("geminiModalClose")?.addEventListener("click", closeGeminiModal);
$("geminiProfileForm")?.addEventListener("submit", handleGeminiSubmit);
$("geminiBaseUrl")?.addEventListener("focus", () => tryClipboardAutoFill("url", "geminiBaseUrl"));
$("geminiApiKey")?.addEventListener("focus", () => tryClipboardAutoFill("key", "geminiApiKey"));
$("geminiBaseUrl")?.addEventListener("input", () => clearProviderInlineStatus("gemini"));
$("geminiApiKey")?.addEventListener("input", () => clearProviderInlineStatus("gemini"));
$("geminiModelFetchBtn")?.addEventListener("click", () => handleModelFetch("gemini"));
$("geminiEndpointTestBtn")?.addEventListener("click", () => handleEndpointTest("gemini"));
bindOverlayDismiss("geminiModalOverlay", closeGeminiModal);

// ── OpenCode Modal Event Listeners ─────────────────

$("opencodeCancelBtn")?.addEventListener("click", closeOpenCodeModal);
$("opencodeModalClose")?.addEventListener("click", closeOpenCodeModal);
$("opencodeProfileForm")?.addEventListener("submit", handleOpenCodeSubmit);
$("opencodePresetSelect")?.addEventListener("change", () => applyOpenCodePreset(getSelectedOpenCodePreset()));
$("opencodeBaseUrl")?.addEventListener("focus", () => tryClipboardAutoFill("url", "opencodeBaseUrl"));
$("opencodeApiKey")?.addEventListener("focus", () => tryClipboardAutoFill("key", "opencodeApiKey"));
$("opencodeBaseUrl")?.addEventListener("input", () => clearProviderInlineStatus("opencode"));
$("opencodeApiKey")?.addEventListener("input", () => clearProviderInlineStatus("opencode"));
$("opencodeModelFetchBtn")?.addEventListener("click", () => handleModelFetch("opencode"));
$("opencodeEndpointTestBtn")?.addEventListener("click", () => handleEndpointTest("opencode"));
bindOverlayDismiss("opencodeModalOverlay", closeOpenCodeModal);
$("opencodePageAddBtn")?.addEventListener("click", () => openOpenCodeModal(null));
$("opencodePageImportBtn")?.addEventListener("click", handleOpenCodeImport);
// 与 Claude 的“立即同步”语义一致:重新应用当前启用的配置
$("opencodeRefreshBtn")?.addEventListener("click", () => {
  const active = opencodeProfiles.find((profile) => profile.isActive);
  if (active) handleOpenCodeSwitch(active.id);
  else showToast(t("opencodeNoActiveProfile"), "warning");
});
$("codexToolboxBtn")?.addEventListener("click", openCodexToolbox);
on("toolboxTabSession", "click", () => switchToolboxTab("session"));
on("toolboxTabRemote", "click", () => switchToolboxTab("remote"));
on("toolboxSessionSearchInput", "input", (event) => {
  toolboxSessionSearchQuery = event.target.value || "";
  renderToolboxSyncedThreads();
});
async function handleToolboxSessionSync() {
  if (toolboxSessionSyncBusy) return;
  startToolboxSessionProgress();
  try {
    codexToolbox = await invoke("sync_codex_sessions", {});
    finishToolboxSessionProgress(true);
    showToast(t("toolboxSessionsSynced"), "success");
    renderCodexToolbox();
    renderSessionStatusCard();
  } catch (error) {
    finishToolboxSessionProgress(false);
    showToast(String(error), "error");
  }
}
on("toolboxRemoteStartBtn", "click", async () => {
  if (toolboxRemoteBusy) return;
  mobileDebug("remote start button clicked");
  toolboxRemoteBusy = true;
  mobileBindBusyAction = "toolbox-remote-start";
  $("toolboxRemoteStartBtn").disabled = true;
  $("toolboxRemoteStopBtn").disabled = true;
  $("toolboxRemoteStartBtn").classList.add("is-busy");
  renderCodexToolbox();
  try {
    await bindCurrentMobileSelection();
    mobileDebug("start_mobile_remote invoke:start", {
      binding: getSelectedMobileBinding(),
    });
    codexToolbox = await invoke("start_mobile_remote", {});
    mobileDebug("start_mobile_remote invoke:success", {
      remote: codexToolbox?.mobileRemote,
      binding: getSelectedMobileBinding(),
    });
    startToolboxRefresh(80);
    showToast(t("toolboxRemoteStarted"), "success");
    renderCodexToolbox();
  } catch (error) {
    mobileDebugError("start_mobile_remote flow failed", error);
    showToast(String(error), "error");
  } finally {
    toolboxRemoteBusy = false;
    mobileBindBusyAction = "";
    $("toolboxRemoteStartBtn").disabled = false;
    $("toolboxRemoteStopBtn").disabled = false;
    $("toolboxRemoteStartBtn").classList.remove("is-busy");
    renderCodexToolbox();
  }
});
on("toolboxRemoteStopBtn", "click", async () => {
  if (toolboxRemoteBusy) return;
  mobileDebug("remote stop button clicked");
  toolboxRemoteBusy = true;
  mobileBindBusyAction = "toolbox-remote-stop";
  $("toolboxRemoteStartBtn").disabled = true;
  $("toolboxRemoteStopBtn").disabled = true;
  $("toolboxRemoteStopBtn").classList.add("is-busy");
  renderCodexToolbox();
  try {
    mobileDebug("stop_mobile_remote invoke:start", { source: "remote-main-button" });
    codexToolbox = await invoke("stop_mobile_remote", {});
    mobileDebug("stop_mobile_remote invoke:success", {
      source: "remote-main-button",
      remote: codexToolbox?.mobileRemote,
      binding: getSelectedMobileBinding(),
    });
    showToast(t("toolboxRemoteStopped"), "success");
    startToolboxRefresh(2);
    renderCodexToolbox();
  } catch (error) {
    mobileDebugError("stop_mobile_remote flow failed", error);
    showToast(String(error), "error");
  } finally {
    toolboxRemoteBusy = false;
    mobileBindBusyAction = "";
    $("toolboxRemoteStartBtn").disabled = false;
    $("toolboxRemoteStopBtn").disabled = false;
    $("toolboxRemoteStopBtn").classList.remove("is-busy");
    renderCodexToolbox();
  }
});

// ── Management Panel Event Listeners ────────────────

on("skillsBtn", "click", openSkillsPanel);
on("addSkillBtn", "click", () => showSkillsEdit(null, "command"));
on("skillCancelBtn", "click", hideSkillsEdit);
on("skillSaveBtn", "click", handleSaveSkill);

// Skills ZIP 安装
on("installZipBtn", "click", handlePickSkillZip);
on("zipInstallClose", "click", closeZipInstall);
on("zipInstallCancel", "click", closeZipInstall);
on("zipInstallConfirm", "click", handleZipInstallConfirm);
bindOverlayDismiss("zipInstallOverlay", closeZipInstall);

// Skills tabs
on("skillsTabInstalled", "click", () => switchSkillsTab("installed"));
on("skillsTabDiscover", "click", () => switchSkillsTab("discover"));

// Skills discover search

// Discover search and filters
on("discoverSearch", "input", (e) => {
  discoverSearchQuery = e.target.value;
  // Local filter for catalog mode
  renderDiscoverGrid();
});
on("discoverSearch", "keydown", (e) => {
  if (e.key === "Enter") {
    e.preventDefault();
    searchGitHubSkills();
  }
});
on("searchGithubSkillsBtn", "click", searchGitHubSkills);
on("backToCatalogBtn", "click", backToCatalog);
on("discoverRepoFilter", "change", (e) => {
  discoverRepoFilter = e.target.value;
  renderDiscoverGrid();
});
on("discoverStatusFilter", "change", (e) => {
  discoverStatusFilter = e.target.value;
  renderDiscoverGrid();
});

// Repo manager
on("manageReposBtn", "click", openRepoManager);
on("refreshDiscoverBtn", "click", () => {
  backToCatalog();
});
on("repoManagerClose", "click", closeRepoManager);
bindOverlayDismiss("repoManagerOverlay", closeRepoManager);
on("addRepoBtn", "click", handleAddRepo);
on("repoUrlInput", "keydown", (e) => {
  if (e.key === "Enter") handleAddRepo();
});

on("promptsBtn", "click", openPromptsPanel);
on("promptSaveBtn", "click", handleSavePrompt);
on("promptTabPresets", "click", () => switchPromptTab("presets"));
on("promptTabEditor", "click", () => switchPromptTab("editor"));
on("promptTabTemplates", "click", () => switchPromptTab("templates"));
on("addPromptPresetBtn", "click", () => showPromptPresetEditor(null));
on("promptPresetSaveBtn", "click", handleSavePromptPreset);
on("promptInsertSelect", "change", (e) => {
  const id = e.target.value;
  if (!id) return;
  const tpl = promptTemplates.find((t) => t.id === id);
  if (tpl) {
    const current = $("promptContentInput").value;
    $("promptContentInput").value = current
      ? current + "\n\n" + tpl.content
      : tpl.content;
    showToast(t("toastSnippetInserted"), "success");
  }
  e.target.value = "";
});

on("mcpBtn", "click", openMcpPanel);
on("addMcpBtn", "click", () => showMcpEdit(null));
on("mcpCancelBtn", "click", hideMcpEdit);
on("mcpSaveBtn", "click", handleSaveMcp);
on("mcpTransport", "change", updateMcpTransportFields);
document.querySelectorAll("#mcpModeTabs [data-mcp-mode]").forEach((button) => {
  button.addEventListener("click", () => setMcpEditorMode(button.dataset.mcpMode));
});
on("mcpTabInstalled", "click", () => switchMcpTab("installed"));
on("mcpTabPresets", "click", () => switchMcpTab("presets"));
on("mcpPresetSearch", "keydown", (e) => {
  if (e.key === "Enter") {
    e.preventDefault();
    searchGitHubMcp();
  }
});

on("updatePillBtn", "click", async () => {
  if (updateBusy) return;
  if (updateInfo?.hasUpdate) {
    await installAppUpdate();
  } else {
    await openUpdateReleasePage();
  }
});
on("usageGuideCloseBtn", "click", closeUsageGuide);
on("usageGuideCloseIcon", "click", closeUsageGuide);
on("usageGuideNeverBtn", "click", handleNeverShowUsageGuide);
bindOverlayDismiss("usageGuideOverlay", closeUsageGuide);

// ── Settings Panel ──────────────────────────────────

function getSettingsEditorPathInfos() {
  return Array.isArray(appPaths?.editorSettings) ? appPaths.editorSettings : [];
}

function editorPathInputId(editorId) {
  return `settingsEditorPathInput-${editorId}`;
}

function getEditorPathInput(editorId) {
  return $(editorPathInputId(editorId));
}

function getEditorPathInfo(editorId) {
  return getSettingsEditorPathInfos().find((editorInfo) => editorInfo.id === editorId) || null;
}

function getEditorPathStatusLabel(mode) {
  if (mode === "custom") return t("settingsEditorStatusCustom");
  if (mode === "detected") return t("settingsEditorStatusDetected");
  return t("settingsEditorStatusDefault");
}

function getEditorPathStatusHint(mode) {
  if (mode === "custom") return t("settingsEditorHintCustom");
  if (mode === "detected") return t("settingsEditorHintDetected");
  return t("settingsEditorHintDefault");
}

function createEditorPathButton(labelKey, className, onClick) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = className;
  button.textContent = t(labelKey);
  button.addEventListener("click", onClick);
  return button;
}

function createEditorPathRow(editorInfo) {
  const mode = getEditorPathMode(editorInfo);
  const row = document.createElement("div");
  row.className = "settings-row settings-row-editor";

  const card = document.createElement("div");
  card.className = "settings-editor-card";

  const header = document.createElement("div");
  header.className = "settings-editor-header";

  const titleBlock = document.createElement("div");
  titleBlock.className = "settings-editor-title-block";

  const label = document.createElement("div");
  label.className = "settings-row-label";
  label.textContent =
    currentLang === "zh"
      ? `${editorInfo.displayName} 设置`
      : `${editorInfo.displayName} settings`;

  const badge = document.createElement("span");
  badge.className = `settings-path-badge settings-path-badge-${mode}`;
  badge.textContent = getEditorPathStatusLabel(mode);

  const desc = document.createElement("div");
  desc.className = "settings-row-desc";
  desc.textContent = getEditorPathStatusHint(mode);

  titleBlock.appendChild(label);
  titleBlock.appendChild(desc);

  header.appendChild(titleBlock);
  header.appendChild(badge);

  const layout = document.createElement("div");
  layout.className = "settings-editor-layout";

  const currentPanel = document.createElement("div");
  currentPanel.className = "settings-path-panel settings-path-panel-current";

  const currentLabel = document.createElement("div");
  currentLabel.className = "settings-path-field-label";
  currentLabel.textContent = t("settingsCurrentPath");

  const input = document.createElement("input");
  input.className = "settings-path-input";
  input.type = "text";
  input.id = editorPathInputId(editorInfo.id);
  input.placeholder = t("settingsPathPlaceholder");
  input.value = editorInfo.settingsPath || "";
  input.spellcheck = false;
  input.autocomplete = "off";

  const actions = document.createElement("div");
  actions.className = "settings-editor-actions";
  actions.appendChild(
    createEditorPathButton("settingsBrowse", "btn btn-secondary btn-sm", () =>
      handleBrowseEditorPath(editorInfo.id)
    )
  );
  actions.appendChild(
    createEditorPathButton("settingsSavePath", "btn btn-primary btn-sm", () =>
      handleSaveEditorPath(editorInfo.id)
    )
  );
  actions.appendChild(
    createEditorPathButton("settingsReset", "btn btn-secondary btn-sm", () =>
      handleResetEditorPath(editorInfo.id)
    )
  );
  actions.appendChild(
    createEditorPathButton("settingsOpen", "btn btn-secondary btn-sm", () =>
      handleOpenEditorPath(editorInfo.id)
    )
  );

  currentPanel.appendChild(currentLabel);
  currentPanel.appendChild(input);
  currentPanel.appendChild(actions);

  const defaultPanel = document.createElement("div");
  defaultPanel.className = "settings-path-panel settings-path-panel-default";

  const defaultLabel = document.createElement("div");
  defaultLabel.className = "settings-path-field-label";
  defaultLabel.textContent = t("settingsDefaultPathLabel");

  const meta = document.createElement("div");
  meta.className = "settings-path-meta";
  meta.textContent = editorInfo.defaultPath || "--";

  defaultPanel.appendChild(defaultLabel);
  defaultPanel.appendChild(meta);

  layout.appendChild(currentPanel);
  layout.appendChild(defaultPanel);

  card.appendChild(header);
  card.appendChild(layout);
  row.appendChild(card);
  return row;
}

function renderSettingsEditorPaths(editorInfos) {
  const editorPathsContainer = $("settingsEditorPaths");
  editorPathsContainer.innerHTML = "";
  for (const editorInfo of editorInfos) {
    editorPathsContainer.appendChild(createEditorPathRow(editorInfo));
  }
}

async function refreshSettingsPanelData() {
  const [settings, paths] = await Promise.all([
    invoke("get_app_settings"),
    invoke("get_app_paths"),
  ]);

  appSettings = settings || {};
  appSettings.editorPaths = appSettings.editorPaths || {};
  appPaths = paths || {};

  $("settingsAutoStart").checked = !!appSettings.autoStart;
  $("settingsMinTray").checked = !!appSettings.minimizeToTray;
  $("settingsSilentStart").checked = !!appSettings.silentStartup;
  $("settingsHotkeyInput").value = appSettings.globalShortcut || "";
  $("settingsConfigDirValue").textContent = appPaths.configDir || "--";
  $("settingsClaudePathValue").textContent = appPaths.claudeSettings || "--";
  $("settingsCodexPathValue").textContent = appPaths.codexSettings || "--";
  renderSettingsEditorPaths(getSettingsEditorPathInfos());
  refreshDataDirInfo();
}

async function handleBrowseEditorPath(editorId) {
  try {
    const dialog = window.__TAURI_PLUGIN_DIALOG__;
    const editorInfo = getEditorPathInfo(editorId);
    const input = getEditorPathInput(editorId);
    const rawDefaultPath = (input?.value || editorInfo?.settingsPath || editorInfo?.defaultPath || "")
      .trim()
      .replace(/[\\/]settings\.json$/i, "");
    const selectedPath = await dialog.open({
      directory: true,
      multiple: false,
      defaultPath: rawDefaultPath || undefined,
    });
    if (!selectedPath || Array.isArray(selectedPath)) return;
    if (input) {
      input.value = selectedPath;
    }
  } catch (error) {
    showToast(String(error), "error");
  }
}

async function handleSaveEditorPath(editorId) {
  try {
    if (!appSettings) {
      await loadAppSettings();
    }
    const editorInfo = getEditorPathInfo(editorId);
    const input = getEditorPathInput(editorId);
    const draftValue = input ? input.value : "";
    const result = validateEditorPathInput(draftValue);
    if (!result.valid) {
      showToast(t("settingsPathEmpty"), "warning");
      input?.focus();
      return;
    }

    appSettings.editorPaths = appSettings.editorPaths || {};
    appSettings.editorPaths[editorId] = result.value;
    await persistAppSettings();
    await Promise.all([refreshSettingsPanelData(), loadStatus()]);
    showToast(
      t("toastEditorPathSaved", {
        name: editorInfo?.displayName || editorId,
      }),
      "success"
    );
  } catch (error) {
    showToast(String(error), "error");
  }
}

async function handleResetEditorPath(editorId) {
  try {
    if (!appSettings) {
      await loadAppSettings();
    }
    const editorInfo = getEditorPathInfo(editorId);
    appSettings.editorPaths = appSettings.editorPaths || {};
    delete appSettings.editorPaths[editorId];
    await persistAppSettings();
    await Promise.all([refreshSettingsPanelData(), loadStatus()]);
    showToast(
      t("toastEditorPathReset", {
        name: editorInfo?.displayName || editorId,
      }),
      "success"
    );
  } catch (error) {
    showToast(String(error), "error");
  }
}

function handleOpenEditorPath(editorId) {
  const input = getEditorPathInput(editorId);
  const editorInfo = getEditorPathInfo(editorId);
  const target = (input?.value || "").trim() || editorInfo?.settingsPath;
  if (!target) return;
  invoke("open_folder", { path: target }).catch((error) => {
    showToast(String(error), "error");
  });
}

async function openSettingsPanel() {
  // 设置统一进入左侧 Settings 页面，不再使用遮罩弹层作为主入口
  switchConsolePage("settings");
  try {
    await openSettingsInline();
    if (typeof refreshSettingsPanelData === "function") {
      await refreshSettingsPanelData();
    }
  } catch (e) {
    console.error("加载设置失败:", e);
    showToast("设置面板加载失败：" + String(e), "error");
  }
}

// ── 全局快捷键捕获 ──────────────────────────────
// 输入框只读，点击聚焦后按下的组合键即被捕获并立即保存。
// 组合键必须包含 Ctrl / Alt / Win 之一：无修饰键的全局热键会吞掉正常输入。
const HOTKEY_CODE_MAP = {
  Space: "Space", Home: "Home", End: "End", PageUp: "PageUp", PageDown: "PageDown",
  Insert: "Insert", Delete: "Delete", Backspace: "Backspace", Enter: "Enter", Tab: "Tab",
  ArrowUp: "Up", ArrowDown: "Down", ArrowLeft: "Left", ArrowRight: "Right",
  Backquote: "`", Minus: "-", Equal: "=", BracketLeft: "[", BracketRight: "]",
  Semicolon: ";", Quote: "'", Comma: ",", Period: ".", Slash: "/", Backslash: "\\",
};

// 用 event.code 而不是 event.key：组合键里的字母不受输入法和 Shift 影响
function hotkeyKeyFromEvent(event) {
  const code = event.code || "";
  if (/^Key[A-Z]$/.test(code)) return code.slice(3);
  if (/^Digit[0-9]$/.test(code)) return code.slice(5);
  if (/^Numpad[0-9]$/.test(code)) return code.slice(6);
  if (/^F([1-9]|1[0-9]|2[0-4])$/.test(code)) return code;
  return HOTKEY_CODE_MAP[code] || null;
}

async function handleHotkeyCapture(event) {
  event.preventDefault();
  event.stopPropagation();
  if (event.key === "Escape") {
    event.target.blur();
    return;
  }
  const key = hotkeyKeyFromEvent(event);
  if (!key) return; // 只按下修饰键或不支持的键：继续等待
  const mods = [];
  if (event.ctrlKey) mods.push("Ctrl");
  if (event.metaKey) mods.push("Super");
  if (event.altKey) mods.push("Alt");
  if (event.shiftKey) mods.push("Shift");
  if (!mods.some((mod) => mod !== "Shift")) {
    showToast(t("settingsHotkeyNeedModifier"), "error");
    return;
  }
  await saveGlobalShortcut([...mods, key].join("+"));
}

// 保存并注册全局快捷键；后端解析/注册失败（如与其他程序冲突）时回滚为旧值
async function saveGlobalShortcut(value) {
  if (!appSettings) await loadAppSettings();
  const previous = appSettings.globalShortcut || "";
  const input = $("settingsHotkeyInput");
  if (previous === value) {
    if (input) input.value = value;
    return;
  }
  appSettings.globalShortcut = value;
  if (input) input.value = value;
  try {
    await persistAppSettings();
    showToast(value ? t("settingsHotkeySaved", { keys: value }) : t("settingsHotkeyCleared"), "success");
  } catch (error) {
    appSettings.globalShortcut = previous;
    if (input) input.value = previous;
    showToast(String(error), "error");
  }
}

async function handleSettingsToggle() {
  if (!appSettings) return;
  appSettings.autoStart = $("settingsAutoStart").checked;
  appSettings.minimizeToTray = $("settingsMinTray").checked;
  appSettings.silentStartup = $("settingsSilentStart").checked;
  syncAppSettingsAppearance();
  try {
    await invoke("save_app_settings", { settings: appSettings });
    showToast(t("toastSettingsSaved"), "success");
  } catch (e) {
    showToast(String(e), "error");
  }
}

async function handleExportProfiles() {
  try {
    const dialog = window.__TAURI_PLUGIN_DIALOG__;
    const dest = await dialog.save({
      defaultPath: "varswitch-profiles.json",
      filters: [{ name: "JSON", extensions: ["json"] }],
    });
    if (!dest) return;
    await invoke("export_profiles", { dest });
    showToast(t("toastExported"), "success");
  } catch (e) {
    showToast(String(e), "error");
  }
}

async function handleImportProfiles() {
  try {
    const dialog = window.__TAURI_PLUGIN_DIALOG__;
    const src = await dialog.open({
      filters: [{ name: "JSON", extensions: ["json"] }],
      multiple: false,
    });
    if (!src) return;
    const count = await invoke("import_profiles", { src });
    if (count > 0) {
      showToast(t("toastImported2", { count }), "success");
      await loadProfiles();
    } else {
      showToast(t("toastImportNone"), "warning");
    }
  } catch (e) {
    showToast(String(e), "error");
  }
}

// Settings event listeners
on("settingsAutoStart", "change", handleSettingsToggle);
on("settingsMinTray", "change", handleSettingsToggle);
on("settingsSilentStart", "change", handleSettingsToggle);
on("settingsHotkeyInput", "keydown", handleHotkeyCapture);
on("settingsHotkeyClear", "click", () => saveGlobalShortcut(""));
on("settingsOpenConfigDir", "click", () => {
  if (appPaths) invoke("open_folder", { path: appPaths.configDir });
});
on("settingsOpenClaudeDir", "click", () => {
  if (appPaths) invoke("open_folder", { path: appPaths.claudeSettings });
});
on("settingsOpenCodexDir", "click", () => {
  if (appPaths) invoke("open_folder", { path: appPaths.codexSettings });
});
on("settingsOpenLogsDir", "click", () => {
  invoke("open_logs_folder").catch((error) => showToast(String(error), "error"));
});
async function copySettingsPath(pathKey) {
  const path = pathKey === "codexSettings"
    ? appPaths?.codexDir || appPaths?.codexSettings
    : appPaths?.[pathKey];
  if (!path) return;
  try {
    await copyToolboxText(path);
    showToast(t("toastCopied"), "success");
  } catch (error) {
    showToast(String(error), "error");
  }
}
document.querySelectorAll("[data-settings-copy-path]").forEach((button) => {
  button.addEventListener("click", () => copySettingsPath(button.dataset.settingsCopyPath));
});
on("settingsExportBtn", "click", handleExportProfiles);
on("settingsImportBtn", "click", handleImportProfiles);
on("settingsOpenBackupsBtn", "click", () => {
  invoke("open_backups_folder").catch((error) => showToast(String(error), "error"));
});
on("settingsViewBackupsBtn", "click", toggleBackupList);
let backupRestoreBusy = false;
on("settingsBackupList", "click", async (event) => {
  const btn = event.target.closest("[data-restore-backup]");
  if (!btn || backupRestoreBusy) return;
  const name = btn.getAttribute("data-restore-backup");
  if (!(await appConfirm(currentLang === "zh" ? "确定用这个备份覆盖当前配置吗？当前配置会先自动备份。" : "Overwrite current profiles with this backup? A safety backup will be created first.", { title: currentLang === "zh" ? "恢复备份" : "Restore backup", danger: true, confirmText: currentLang === "zh" ? "覆盖恢复" : "Restore" }))) return;
  backupRestoreBusy = true;
  setButtonBusy(btn, true, currentLang === "zh" ? "恢复中..." : "Restoring...");
  try {
    await invoke("restore_config_backup", { name });
    showToast("已从备份恢复配置", "success");
    await loadProfiles();
    await loadCodexProfiles();
    $("settingsBackupList").style.display = "none";
  } catch (error) {
    showToast(String(error), "error");
  } finally {
    backupRestoreBusy = false;
    setButtonBusy(btn, false);
  }
});

// ── 配置体检 ────────────────────────────────────────
// 后端逐个探测各应用配置的 Base URL 并给出结论，全程只读，不会改动任何配置。

// 越严重排越前，用户一眼就能看到要处理的项
const HEALTH_LEVEL_ORDER = ["dead", "bad", "warn", "skipped", "ok"];

const HEALTH_LEVEL_LABEL_KEYS = {
  ok: "healthLevelOk",
  warn: "healthLevelWarn",
  bad: "healthLevelBad",
  dead: "healthLevelDead",
  skipped: "healthLevelSkipped",
};

const HEALTH_APP_LABELS = {
  claude: "Claude",
  codex: "Codex",
  grok: "Grok",
  gemini: "Gemini",
  opencode: "OpenCode",
};

let healthCheckBusy = false;

// 后端将来新增等级时兜底为「已跳过」，免得徽标掉类名、排序落到未知位置
function healthLevelOf(item) {
  const level = String(item?.level || "");
  return HEALTH_LEVEL_LABEL_KEYS[level] ? level : "skipped";
}

function healthRowHtml(item) {
  const level = healthLevelOf(item);
  const appLabel = HEALTH_APP_LABELS[item.app] || item.app || "";
  const name = item.name || item.id || "--";
  const details = [];
  if (item.message) details.push(String(item.message));
  // 只有连通的配置延迟才有参考价值，失败项的耗时基本就是超时上限
  if (level === "ok" && Number.isFinite(item.latencyMs)) details.push(`${item.latencyMs}ms`);
  return `
      <div class="health-row">
        <span class="health-badge health-${level}">${t(HEALTH_LEVEL_LABEL_KEYS[level])}</span>
        <span class="health-name">${esc(appLabel ? `${appLabel} · ${name}` : name)}</span>
        <span class="health-host">${esc(item.host || "--")}</span>
        <span class="health-message">${esc(details.join(" · "))}</span>
      </div>`;
}

function renderProfilesHealth(list) {
  const box = $("settingsHealthResult");
  if (!box) return;
  const rows = list
    .slice()
    .sort((a, b) => HEALTH_LEVEL_ORDER.indexOf(healthLevelOf(a)) - HEALTH_LEVEL_ORDER.indexOf(healthLevelOf(b)));
  const counts = { ok: 0, warn: 0, bad: 0, dead: 0, skipped: 0 };
  for (const item of rows) counts[healthLevelOf(item)] += 1;
  box.innerHTML = `
    <div class="health-summary">${t("healthSummary", { total: rows.length, ok: counts.ok, bad: counts.bad, dead: counts.dead })}</div>
    <div class="health-list">${rows.map((item) => healthRowHtml(item)).join("")}</div>`;
  box.hidden = false;
}

async function runProfilesHealthCheck() {
  if (healthCheckBusy) return;
  const btn = $("settingsHealthCheckBtn");
  healthCheckBusy = true;
  setButtonBusy(btn, true, t("healthChecking"));
  try {
    const list = await invoke("check_profiles_health");
    renderProfilesHealth(Array.isArray(list) ? list : []);
  } catch (error) {
    showToast(String(error), "error");
    // 失败时也要盖掉结果区，否则上一轮的旧结论会被当成这次的检测结果
    const box = $("settingsHealthResult");
    if (box) {
      box.innerHTML = `<div class="health-summary">${t("healthFailed")}</div>`;
      box.hidden = false;
    }
  } finally {
    healthCheckBusy = false;
    setButtonBusy(btn, false);
  }
}

on("settingsHealthCheckBtn", "click", runProfilesHealthCheck);

// ── 数据目录（多设备同步）────────────────────────────
// 后端用指针文件把 data_dir 重定向到网盘同步文件夹，实现多设备共享配置。
let dataDirInfo = null;

function renderDataDirInfo() {
  const valueEl = $("settingsDataDirValue");
  const badge = $("settingsDataDirBadge");
  if (!valueEl || !badge) return;
  if (!dataDirInfo) {
    valueEl.textContent = "--";
    badge.style.display = "none";
    return;
  }
  valueEl.textContent = dataDirInfo.current || "--";
  badge.style.display = "";
  badge.textContent = dataDirInfo.overridden
    ? t("settingsDataDirCustom")
    : t("settingsDataDirDefault");
  badge.classList.toggle("custom", !!dataDirInfo.overridden);
}

async function refreshDataDirInfo() {
  try {
    dataDirInfo = await invoke("get_data_dir_info");
  } catch (error) {
    console.error("get_data_dir_info failed", error);
    dataDirInfo = null;
  }
  renderDataDirInfo();
}

async function handlePickDataDir() {
  const btn = $("settingsDataDirPickBtn");
  try {
    const picked = await invoke("pick_data_dir");
    if (!picked) return;
    setButtonBusy(btn, true);
    const result = await invoke("set_data_dir_override", { path: picked });
    await refreshDataDirInfo();
    const copied = (result?.copied || []).length;
    const skipped = (result?.skipped || []).length;
    // 结果摘要 + 重启提示（复制/跳过详情见后端日志）
    await openAppDialog({
      mode: "confirm",
      title: t("dataDirSwitchTitle"),
      message: `${t("dataDirSwitchSummary", { copied, skipped })} ${t("dataDirRestartHint")}`,
      confirmText: t("dataDirGotIt"),
      cancelText: t("cancel"),
    });
  } catch (error) {
    showToast(String(error), "error");
  } finally {
    setButtonBusy(btn, false);
  }
}

async function handleResetDataDir() {
  if (!dataDirInfo?.overridden) {
    showToast(t("dataDirAlreadyDefault"), "warning");
    return;
  }
  if (!(await appConfirm(t("dataDirConfirmReset"), { title: t("settingsDataDirReset") }))) return;
  try {
    await invoke("set_data_dir_override", { path: null });
    await refreshDataDirInfo();
    showToast(`${t("dataDirResetDone")} ${t("dataDirRestartHint")}`, "success");
  } catch (error) {
    showToast(String(error), "error");
  }
}

on("settingsDataDirPickBtn", "click", handlePickDataDir);
on("settingsDataDirResetBtn", "click", handleResetDataDir);

// ── Deep Link 导入确认（varswitch:// 一键导入）────────────
// 后端解析深链后 emit "deeplink-import"，这里弹确认框，用户点确认才真正写入。
let pendingDeepLinkImport = null;

function setDeepLinkRowHidden(id, hidden) {
  const row = $(id);
  if (row) row.hidden = hidden;
}

function resetDeepLinkModalContent() {
  [
    "deeplinkAppValue", "deeplinkNameValue", "deeplinkBaseUrlValue", "deeplinkApiKeyValue",
    "deeplinkModelValue", "deeplinkHaikuModelValue", "deeplinkSonnetModelValue",
    "deeplinkOpusModelValue", "deeplinkHomepageValue", "deeplinkExistingName",
    "deeplinkSuggestedName",
  ].forEach((id) => setText(id, "--"));
  setText("deeplinkConfigPreview", "");
  const rename = document.querySelector('input[name="deeplinkConflictAction"][value="rename"]');
  if (rename) rename.checked = true;
  setDeepLinkRowHidden("deeplinkBaseUrlRow", false);
  setDeepLinkRowHidden("deeplinkApiKeyRow", false);
  setDeepLinkRowHidden("deeplinkModelRow", false);
  setDeepLinkRowHidden("deeplinkHaikuModelRow", true);
  setDeepLinkRowHidden("deeplinkSonnetModelRow", true);
  setDeepLinkRowHidden("deeplinkOpusModelRow", true);
  setDeepLinkRowHidden("deeplinkHomepageRow", true);
  const configGroup = $("deeplinkConfigGroup");
  if (configGroup) configGroup.hidden = true;
  const conflictGroup = $("deeplinkConflictGroup");
  if (conflictGroup) conflictGroup.hidden = true;
}

function openDeepLinkModal(payload) {
  const overlay = $("deeplinkOverlay");
  if (!overlay || !payload) return;
  pendingDeepLinkImport = payload;
  const view = helpers.getDeepLinkImportView(payload);
  setText("deeplinkAppValue", view.appLabel);
  setText("deeplinkNameValue", view.name);
  setText("deeplinkBaseUrlValue", view.baseUrl);
  setText("deeplinkApiKeyValue", view.apiKeyMasked);
  setText("deeplinkModelValue", view.model);
  setText("deeplinkHaikuModelValue", view.haikuModel);
  setText("deeplinkSonnetModelValue", view.sonnetModel);
  setText("deeplinkOpusModelValue", view.opusModel);
  setText("deeplinkHomepageValue", view.homepage);
  setText("deeplinkExistingName", view.existingName);
  setText("deeplinkSuggestedName", view.suggestedName);
  setDeepLinkRowHidden("deeplinkBaseUrlRow", !view.showProviderDetails);
  setDeepLinkRowHidden("deeplinkApiKeyRow", !view.showProviderDetails);
  setDeepLinkRowHidden("deeplinkModelRow", !view.showProviderDetails);
  setDeepLinkRowHidden("deeplinkHaikuModelRow", !view.showClaudeModels);
  setDeepLinkRowHidden("deeplinkSonnetModelRow", !view.showClaudeModels);
  setDeepLinkRowHidden("deeplinkOpusModelRow", !view.showClaudeModels);
  setDeepLinkRowHidden("deeplinkHomepageRow", !view.showHomepage);
  const configGroup = $("deeplinkConfigGroup");
  if (configGroup) configGroup.hidden = !view.isMcp;
  setText("deeplinkConfigPreview", view.configText);
  const conflictGroup = $("deeplinkConflictGroup");
  if (conflictGroup) conflictGroup.hidden = !view.showConflict;
  const rename = document.querySelector('input[name="deeplinkConflictAction"][value="rename"]');
  if (rename) rename.checked = view.defaultConflictAction === "rename";
  overlay.classList.add("open");
  document.body.classList.add("modal-open");
}

function closeDeepLinkModal() {
  pendingDeepLinkImport = null;
  resetDeepLinkModalContent();
  $("deeplinkOverlay")?.classList.remove("open");
  document.body.classList.remove("modal-open");
}

async function confirmDeepLinkImport() {
  if (!pendingDeepLinkImport) return;
  const payload = pendingDeepLinkImport;
  const { kind, app } = payload;
  const btn = $("deeplinkConfirm");
  setButtonBusy(btn, true, t("deeplinkImporting"));
  try {
    const request = helpers.buildDeepLinkApplyRequest(
      payload,
      document.querySelector('input[name="deeplinkConflictAction"]:checked')?.value
    );
    const message = await invoke("apply_deep_link_import", request);
    closeDeepLinkModal();
    showToast(String(message), "success");
    // 刷新对应列表（新增或覆盖都不激活，无需刷新运行状态）
    if (kind === "profile") {
      if (app === "claude") await loadProfiles();
      else if (app === "codex") await loadCodexProfiles();
      else if (app === "gemini") await loadGeminiProfiles();
      else if (app === "grok") await loadGrokProfiles();
    } else {
      try { await loadMcpServers(); } catch (_) { /* MCP 面板未打开时忽略 */ }
    }
  } catch (error) {
    showToast(String(error), "error");
  } finally {
    setButtonBusy(btn, false);
  }
}

let deepLinkListenerBound = false;
async function bindDeepLinkListener() {
  if (deepLinkListenerBound) return;
  deepLinkListenerBound = true;
  on("deeplinkClose", "click", closeDeepLinkModal);
  on("deeplinkCancel", "click", closeDeepLinkModal);
  on("deeplinkConfirm", "click", confirmDeepLinkImport);
  bindOverlayDismiss("deeplinkOverlay", closeDeepLinkModal);
  on("siteTokenClose", "click", closeSiteTokenDialog);
  on("siteTokenCancel", "click", closeSiteTokenDialog);
  on("siteTokenSave", "click", handleSiteTokenSave);
  on("siteTokenDelete", "click", handleSiteTokenDelete);
  bindOverlayDismiss("siteTokenOverlay", closeSiteTokenDialog);
  try {
    await listen("deeplink-import", (event) => {
      if (event?.payload) openDeepLinkModal(event.payload);
    });
    await listen("deeplink-import-error", (event) => {
      showToast(t("deeplinkInvalid", { message: event?.payload?.message || "unknown" }), "error");
    });
  } catch (error) {
    console.error("bindDeepLinkListener failed", error);
  }
}

// 把紧凑时间戳 20260624-143025 格式化为 2026-06-24 14:30:25
function formatBackupStamp(stamp) {
  const m = /^(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})$/.exec(stamp || "");
  if (!m) return stamp || "";
  return `${m[1]}-${m[2]}-${m[3]} ${m[4]}:${m[5]}:${m[6]}`;
}

// 展开/收起备份列表，每项可一键回滚
async function toggleBackupList() {
  const box = $("settingsBackupList");
  if (box.style.display !== "none") {
    box.style.display = "none";
    return;
  }
  try {
    const backups = await invoke("list_config_backups");
    if (!backups || backups.length === 0) {
      box.innerHTML = `<div class="mgmt-item-desc">暂无备份（首次切换配置后会自动生成）</div>`;
    } else {
      box.innerHTML = backups
        .map((b) => {
          const label = formatBackupStamp(b.stamp);
          const kindLabel = b.kind === "codex" ? "Codex" : b.kind === "grok" ? "Grok" : "Claude";
          return `<div class="settings-row">
            <div class="settings-row-info">
              <div class="settings-row-label">${kindLabel} · ${esc(label)}</div>
            </div>
            <div class="settings-row-action">
              <button class="btn btn-secondary btn-sm" data-restore-backup="${esc(b.name)}">恢复</button>
            </div>
          </div>`;
        })
        .join("");
    }
    box.style.display = "block";
  } catch (error) {
    showToast(String(error), "error");
  }
}

function withTimeout(promise, ms, label) {
  let timer = null;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label || "task"} timeout after ${ms}ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

async function safeLoad(label, fn, ms = 8000) {
  try {
    await withTimeout(Promise.resolve().then(fn), ms, label);
  } catch (error) {
    console.error(`[init] ${label} failed:`, error);
  }
}

// 侧边栏版本号取自应用真实版本，避免与构建脚本同步的版本号脱节。
// 纯装饰性，任何失败都只记日志，不能影响启动。
function renderSidebarVersion() {
  const target = document.querySelector(".sidebar-version span");
  const appApi = window.__TAURI__?.app;
  if (!target || typeof appApi?.getVersion !== "function") return;
  // 保留 appApi 作为 this，Tauri 的 API 对象方法不能脱离宿主调用
  Promise.resolve(appApi.getVersion())
    .then((version) => {
      if (version) target.textContent = `v${version}`;
    })
    .catch((error) => console.error("getVersion failed", error));
}

(async function init() {
  const toolbar = document.querySelector(".toolbar");
  const appEl = document.querySelector(".app");
  const shell = document.querySelector("#workspaceShell");
  let revealed = false;

  function revealUi() {
    if (revealed) return;
    revealed = true;
    [toolbar, appEl, shell].forEach((el) => {
      if (!el) return;
      el.classList.remove("app-hidden");
      el.classList.add("app-reveal");
      el.style.pointerEvents = "auto";
      el.style.opacity = "1";
    });
    // 顶栏/主工作区始终可点
    if (toolbar) toolbar.style.pointerEvents = "auto";
    if (shell) shell.style.pointerEvents = "auto";
    const splash = $("splashScreen");
    if (splash) {
      splash.classList.add("fade-out");
      splash.style.pointerEvents = "none";
      setTimeout(() => splash.remove(), 400);
    }
  }

  // 1) 主题/文案：失败也不阻断
  try { applyTheme(); } catch (e) { console.error("applyTheme failed", e); }
  try { applyLanguage(); } catch (e) { console.error("applyLanguage failed", e); }
  try { renderSidebarVersion(); } catch (e) { console.error("renderSidebarVersion failed", e); }

  // 2) 先绑定交互，保证侧边栏/按钮立刻可点
  try {
    bindAppDialogOnce();
    bindConsoleUiOnce();
    switchConsolePage("add-provider");
    // B15: 尽早订阅后端通道状态推送，绑定流程中的状态变化不会漏收
    bindMobileChannelStatusListener();
    // 深链导入事件要尽早订阅：冷启动深链由后端延迟 2.5 秒转发，必须赶在其之前完成绑定
    bindDeepLinkListener();
  } catch (e) {
    console.error("console bind failed", e);
  }

  // 3) 启动动画：短隐藏 + 强制超时显示
  if (toolbar) toolbar.classList.add("app-hidden");
  if (appEl) appEl.classList.add("app-hidden");
  if (shell) shell.classList.add("app-hidden");
  const forceRevealTimer = setTimeout(revealUi, 1200);

  // 4) 数据加载互不阻塞，单项超时
  await Promise.allSettled([
    safeLoad("loadStatus", () => loadStatus()),
    safeLoad("loadProfiles", () => loadProfiles()),
    safeLoad("loadClaudeDesktopPage", () => loadClaudeDesktopPage()),
    safeLoad("loadCodexProfiles", () => loadCodexProfiles()),
    safeLoad("loadCodexStatus", () => loadCodexStatus()),
    safeLoad("loadGrokProfiles", () => loadGrokProfiles()),
    safeLoad("loadGrokStatus", () => loadGrokStatus()),
    safeLoad("loadGrokDiagnostics", () => loadGrokDiagnostics()),
    safeLoad("loadGeminiProfiles", () => loadGeminiProfiles()),
    safeLoad("loadGeminiStatus", () => loadGeminiStatus()),
    safeLoad("loadOpenCodeProfiles", () => loadOpenCodeProfiles()),
    safeLoad("loadOpenCodeStatus", () => loadOpenCodeStatus()),
    safeLoad("loadCodexToolbox", () => loadCodexToolbox(), 10000),
    safeLoad("loadAppSettings", () => loadAppSettings()),
    safeLoad("loadSiteTokens", () => loadSiteTokens()),
  ]);

  try {
    renderGrokPresetOptions();
    renderOpenCodePresetOptions();
    renderUpdateButton();
    enhanceAfterDataLoad();
    switchConsolePage("add-provider");
  } catch (e) {
    console.error("post-load render failed", e);
  }

  clearTimeout(forceRevealTimer);
  revealUi();

  try {
    checkForUpdatesOnStartup();
  } catch (e) {
    console.error("update check failed", e);
  }

  setTimeout(() => {
    showStartupDialogs().catch((error) => console.warn("Startup dialogs failed:", error));
  }, 250);
})();
