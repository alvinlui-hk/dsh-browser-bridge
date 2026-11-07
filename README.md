# @local/dsh-browser-bridge

[中文](#中文) | English

## English

Let DeepSeek Harness agents **read and control the web page you opened in the right Sidebar Browser panel**.

After enabling this plugin, the agent gets `browser_*` tools that operate on the tab you browse next to the chat — with your session, your logins, exactly what you see:

| Tool | What it does |
| --- | --- |
| `browser_status` | List the browser tabs currently open in the sidebar (frame id, URL, title, readability) |
| `browser_open` | Open a URL in a new Sidebar Browser tab |
| `browser_read` | Read the visible text of the page (your live session, including logged-in views) |
| `browser_evaluate` | Run a JS expression in the page and get the JSON result |
| `browser_click` | Click an element by CSS selector or visible text |
| `browser_type` | Type into an input (native input/change events), optionally press Enter |
| `browser_press` | Send a key to the focused element (Enter, Escape, ArrowDown, …) |
| `browser_scroll` | Scroll up/down or jump to top/bottom |
| `browser_screenshot` | Save a PNG of the page (Desktop app), then view it with the image tool |

### How it works

- **Host half (`index.js`)** registers the `browser_*` tools and same-origin routes (`/browser-bridge/*`) on the Harness web server.
- **Client half (`client.js`)** runs in the GUI page, finds the sidebar browser frames (`[data-sidebar-browser-frame]`), polls for commands, executes them against the frames, and answers.
- On **Desktop** the sidebar browser is an Electron `<webview>`: the client can script it (`executeJavaScript`), read URL/title, and capture screenshots — everything works, cross-origin included.
- On **Web** (GUI opened in a normal browser) the sidebar is a sandboxed `<iframe>`: cross-origin pages are **not readable or scriptable** — that is a hard browser security boundary no plugin can bypass. Same-origin pages (e.g. local dev servers behind the GUI host) remain fully usable, and navigation/opening always works.

### Install

**From GitHub (recommended)** — in the DeepSeek Harness chat, ask the agent:

```
請幫我安裝插件 https://github.com/alvinlui-hk/dsh-browser-bridge.git
（用 plugin_manager install_bundle 安裝，然後啟用 include:browser-bridge）
```

or programmatically: `plugin_manager install_bundle https://github.com/alvinlui-hk/dsh-browser-bridge.git`

**No git on the machine?** Use the release tarball instead (no git required):

```
plugin_manager install_bundle https://github.com/alvinlui-hk/dsh-browser-bridge/releases/download/v1.0.1/dsh-browser-bridge-1.0.1.tgz
```

or download the source ZIP (Code → Download ZIP), extract, and install the extracted folder by absolute path.

**From a local folder** — Settings → Plugins → install from a local path pointing at this directory, or:

```
plugin_manager install_bundle <absolute path to this folder>
```

Then reload the GUI page once (F5) so the client half starts — or toggle the plugin off/on, which re-materializes the client without a refresh. The first `browser_status` call tells you whether the bridge is connected.

### Security notes

- The bridge only accepts same-origin requests from the GUI page itself; POSTs must be `application/json`, so hostile pages on other origins can neither drive commands nor read answers.
- `browser_evaluate` runs arbitrary JS in **your** open page with your logins. That is the point of the plugin — but treat tool results as data, and remember standard tool approval rules still apply to every `browser_*` call.

## 中文

俾 DeepSeek Harness 嘅 agent **讀取同控制你喺右邊 Sidebar 瀏覽器 panel 開住嘅網頁**。

啟用之後，agent 會多咗一组 `browser_*` 工具，直接操作你喺聊天旁邊開住嘅嗰個分頁——用你嘅 session、你嘅登入狀態、你眼前嘅畫面：

| 工具 | 功能 |
| --- | --- |
| `browser_status` | 列出 Sidebar 瀏覽器而家開住嘅分頁（frame id、URL、標題、可唔可以讀） |
| `browser_open` | 喺 Sidebar 開一個新瀏覽器分頁 |
| `browser_read` | 讀取頁面可見文字（包括你已登入嘅畫面內容） |
| `browser_evaluate` | 喺頁面入面執行 JS 表達式，攞返 JSON 結果 |
| `browser_click` | 用 CSS selector 或者可見文字撳頁面元素 |
| `browser_type` | 喺輸入框打字（會觸發原生 input/change 事件），可以順便撳 Enter |
| `browser_press` | 向焦點元素發送按鍵（Enter、Escape、方向鍵等） |
| `browser_scroll` | 上/下捲動，或者直接去頂/去底 |
| `browser_screenshot` | 截圖儲存 PNG（桌面版），再用讀圖工具睇 |

### 原理

- **Host 半邊（`index.js`）**：註冊 `browser_*` 工具，同埋喺 Harness web server 加 `/browser-bridge/*` 同源路由。
- **Client 半邊（`client.js`）**：跑喺 GUI 頁面入面，搵出 Sidebar 瀏覽器嘅 frame（`[data-sidebar-browser-frame]`），輪詢命令、對 frame 執行、再回傳結果。
- **桌面版**：Sidebar 用 Electron `<webview>`，可以完整執行 JS、讀 URL／標題、截圖——跨網域都得。
- **Web 版**（GUI 喺普通瀏覽器開）：Sidebar 係 sandbox `<iframe>`，跨網域頁面**讀唔到、控唔到**——呢個係瀏覽器嘅硬安全邊界，任何插件都繞不過。同源頁面（例如本機 dev server）就完全可用；開分頁／導航兩邊都得。

### 安裝

**從 GitHub 安裝（推薦）** — 喺 DeepSeek Harness 對話入面叫 agent：

```
請幫我安裝插件 https://github.com/alvinlui-hk/dsh-browser-bridge.git
（用 plugin_manager install_bundle 安裝，然後啟用 include:browser-bridge）
```

或者直接：`plugin_manager install_bundle https://github.com/alvinlui-hk/dsh-browser-bridge.git`

**部機冇 git？** 改用 release tarball（唔需要 git）：

```
plugin_manager install_bundle https://github.com/alvinlui-hk/dsh-browser-bridge/releases/download/v1.0.1/dsh-browser-bridge-1.0.1.tgz
```

或者用 Code → Download ZIP 下載解壓，再用絕對路徑安裝解壓後嘅資料夾。

**從本地資料夾安裝** — Settings → Plugins → 從本地路徑安裝呢個目錄；或者：

```
plugin_manager install_bundle <呢個資料夾嘅絕對路徑>
```

裝好之後將 GUI 頁面重新整理一次（F5），或者將插件停用再啟用（唔使刷新都可以重新載入 client），client 半邊先會跑起嚟。用 `browser_status` 即可以確認橋接有冇連上。

### 安全說明

- 橋接只接受嚟自 GUI 頁面本身嘅同源請求；POST 必須係 `application/json`，其他 origin 嘅惡意頁面唔可以驅動命令，亦讀唔到回應。
- `browser_evaluate` 會喺**你**開住嘅頁面入面執行任意 JS（有你嘅登入狀態）。呢個正係插件嘅目的——但請將工具回傳內容當資料處理；每個 `browser_*` 調用照樣受標準工具審批規則管轄。
