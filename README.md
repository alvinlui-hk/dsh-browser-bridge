# @alvinlui-hk/dsh-browser-bridge

[中文](#中文) | English

Let DeepSeek Harness agents **read and control the web page you opened in the right Sidebar Browser panel**.

After enabling this plugin, the agent gets `browser_*` tools that operate on the tab you browse next to the chat — with your session, your logins, exactly what you see:

| Tool | What it does |
| --- | --- |
| `browser_status` | List the browser tabs currently open in the sidebar (frame id, URL, title, readability) |
| `browser_open` | Open a URL in a new Sidebar Browser tab and return the new tab's frame id |
| `browser_read` | Read the page as visible text, markdown (links, headings, tables, JSON-LD), or cleaned HTML |
| `browser_evaluate` | Run a JS expression in the page and get the JSON result; a statement or a page exception comes back as the real error, not a generic script failure |
| `browser_click` | Click by CSS selector, visible text, match index, or viewport coordinates from a screenshot (HTML and SVG) |
| `browser_type` | Type into an input (native input/change events), optionally press Enter; a non-input target is an error, not a silent miss |
| `browser_press` | Send a key to the focused element (Enter, Escape, ArrowDown, …) |
| `browser_scroll` | Scroll up/down or jump to top/bottom |
| `browser_wait` | Wait until a selector exists, the URL contains a string, or the page text contains a string |
| `browser_screenshot` | Save a PNG of the page (Desktop app), including a background tab, then view it with the image tool |

### How it works

- **Host half (`index.js`)** registers the `browser_*` tools and same-origin routes (`/browser-bridge/*`) on the Harness web server.
- **Client half (`client.js`)** runs in the GUI page, finds the sidebar browser frames (`[data-sidebar-browser-frame]`), polls for commands, executes them against the frames, and answers.
- On **Desktop** the sidebar browser is an Electron `<webview>`: the client can script it (`executeJavaScript`), read URL/title, and capture screenshots — everything works, cross-origin included. If the value relay ever drops results, the client relays them through the page `<title>` channel automatically.
- On **Web** (GUI opened in a normal browser) the sidebar is a sandboxed `<iframe>`: cross-origin pages are **not readable or scriptable** — that is a hard browser security boundary no plugin can bypass. Same-origin pages (e.g. local dev servers behind the GUI host) remain fully usable, and navigation/opening always works.

### Install

**From the npm registry (recommended — no git needed):**

```
plugin_manager install_bundle @alvinlui-hk/dsh-browser-bridge
```

**From GitHub (git required):**

```
plugin_manager install_bundle https://github.com/alvinlui-hk/dsh-browser-bridge.git
```

**No git and no npm?** Use the release tarball:

```
plugin_manager install_bundle https://github.com/alvinlui-hk/dsh-browser-bridge/releases/latest — download the attached .tgz asset, then `plugin_manager install_bundle <the asset URL>`
```

or download the source ZIP (Code → Download ZIP), extract, and install the extracted folder by absolute path.

### Plugin Market

This plugin is also available through a DSH **plugin market index** (the experimental Discover tab). Enable the official optional bundle **Plugin Market / 插件市場** first (Settings → Plugins), then add the index URL:

```
https://raw.githubusercontent.com/alvinlui-hk/dsh-plugin-index/main/index.json
```

The index installs the npm package `@alvinlui-hk/dsh-browser-bridge` — no git required, and updates show as `update-available`.

### Troubleshooting

**`ERR_PNPM_EPERM ... rename ...dsh-browser-bridge` during install** — a previous link/ZIP install left a junction or folder at `node_modules\@alvinlui-hk\dsh-browser-bridge` in the profile. Fix: `plugin_manager` remove_bundle first, delete that leftover folder manually (PowerShell: `cmd /c rmdir "<profile>\node_modules\@alvinlui-hk\dsh-browser-bridge"` — removes the junction only, never your files), then install again.

**Bridge not connecting** — the client half needs to re-materialize after install/update: toggle the entry off and on (`set_plugin include:browser-bridge` false → true). If still not connected, reload the GUI page (F5).

### Security notes

- The bridge only accepts same-origin requests from the GUI page itself; POSTs must be `application/json`, so hostile pages on other origins can neither drive commands nor read answers.
- `browser_evaluate` runs arbitrary JS in **your** open page with your logins. That is the point of the plugin — but treat tool results as data, and remember standard tool approval rules still apply to every `browser_*` call.

-----

<a id="中文"></a>

# 中文（@alvinlui-hk/dsh-browser-bridge）

俾 DeepSeek Harness 嘅 agent **讀取同控制你喺右邊 Sidebar 瀏覽器 panel 開住嘅網頁**。

啟用之後，agent 會多咗一组 `browser_*` 工具，直接操作你喺聊天旁邊開住嘅嗰個分頁——用你嘅 session、你嘅登入狀態、你眼前嘅畫面：

| 工具 | 功能 |
| --- | --- |
| `browser_status` | 列出 Sidebar 瀏覽器而家開住嘅分頁（frame id、URL、標題、可唔可以讀） |
| `browser_open` | 喺 Sidebar 開一個新瀏覽器分頁，並回傳新分頁嘅 frame id |
| `browser_read` | 讀取頁面：可見文字、markdown（連結、標題、表格、JSON-LD）或清理後嘅 HTML |
| `browser_evaluate` | 喺頁面入面執行 JS 表達式，攞返 JSON 結果；statement 或頁面例外會回傳真正嘅錯誤，唔再係含糊嘅 script failure |
| `browser_click` | 用 CSS selector、可見文字、第幾個匹配，或者截圖上嘅座標撳元素（HTML 同 SVG 都得） |
| `browser_type` | 喺輸入框打字（會觸發原生 input/change 事件），可以順便撳 Enter；目標唔係輸入框會回傳錯誤，唔會靜靜失敗 |
| `browser_press` | 向焦點元素發送按鍵（Enter、Escape、方向鍵等） |
| `browser_scroll` | 上/下捲動，或者直接去頂/去底 |
| `browser_wait` | 等到 selector 出現、URL 包含指定字串，或者頁面文字包含指定字串 |
| `browser_screenshot` | 截圖儲存 PNG（桌面版），會先將分頁帶到畫面，再用讀圖工具睇 |

### 原理

- **Host 半邊（`index.js`）**：註冊 `browser_*` 工具，同埋喺 Harness web server 加 `/browser-bridge/*` 同源路由。
- **Client 半邊（`client.js`）**：跑喺 GUI 頁面入面，搵出 Sidebar 瀏覽器嘅 frame（`[data-sidebar-browser-frame]`），輪詢命令、對 frame 執行、再回傳結果。
- **桌面版**：Sidebar 用 Electron `<webview>`，可以完整執行 JS、讀 URL／標題、截圖——跨網域都得。若果數值通道失效，client 會自動改用頁面 `<title>` 通道回傳結果。
- **Web 版**（GUI 喺普通瀏覽器開）：Sidebar 係 sandbox `<iframe>`，跨網域頁面**讀唔到、控唔到**——呢個係瀏覽器嘅硬安全邊界，任何插件都繞不過。同源頁面（例如本機 dev server）就完全可用；開分頁／導航兩邊都得。

### 安裝

**從 npm 安裝（推薦 — 唔需要 git）：**

```
plugin_manager install_bundle @alvinlui-hk/dsh-browser-bridge
```

**從 GitHub 安裝（需要 git）：**

```
plugin_manager install_bundle https://github.com/alvinlui-hk/dsh-browser-bridge.git
```

**冇 git 又想用 GitHub？** 用 release tarball：

```
plugin_manager install_bundle https://github.com/alvinlui-hk/dsh-browser-bridge/releases/latest — download the attached .tgz asset, then `plugin_manager install_bundle <the asset URL>`
```

或者用 Code → Download ZIP 下載解壓，再用絕對路徑安裝解壓後嘅資料夾。

**v2.2.0**：背景分頁都可以截圖——先聚焦，仍然離屏就短暫解除隱藏祖先並固定 webview，擷取後即時還原；`browser_evaluate` 會講出真正嘅 syntax 或頁面錯誤；`browser_open` 回傳新 frame id；新增 `browser_wait`、markdown/HTML 讀取、座標點擊同第幾個匹配。

**v2.1.0 安全強化**：所有橋接路由而家行喺 DSH 平台嘅 connection 防護欄之後（Host 綁定 loopback、Origin 檢查、瀏覽器登入 cookie）— DNS rebinding、跨站調用同本機進程存取都被擋；命令 ID 改用隨機 token 防偽冒；title 通道加 per-command nonce 防頁面偽造，並保證每個命令單次執行。

### 插件市場

呢個插件亦收錄喺 DSH **插件市場索引**（實驗性發現分頁）。先喺 Settings → Plugins 啟用官方可選組合包「Plugin Market / 插件市場」，然後加入索引 URL：

```
https://raw.githubusercontent.com/alvinlui-hk/dsh-plugin-index/main/index.json
```

索引會安裝 npm 包 `@alvinlui-hk/dsh-browser-bridge`——唔需要 git，出新版時會顯示 `update-available`。

### 疑難排解

**安裝時 `ERR_PNPM_EPERM ... rename ...dsh-browser-bridge`** — 之前用 link/ZIP 安裝殘留咗 junction 或資料夾喺 profile 嘅 `node_modules\@alvinlui-hk\dsh-browser-bridge`。處理：先 `remove_bundle`，再手動刪走嗰個殘留資料夾（PowerShell：`cmd /c rmdir "<profile>\node_modules\@alvinlui-hk\dsh-browser-bridge"` — 只會刪 junction，唔會刪到你嘅檔案），然後重新安裝。

**橋接連唔上** — client 半邊喺安裝／更新後要重新 materialize：將條目停用再啟用（`set_plugin include:browser-bridge` false → true）。仲係連唔上就刷新一次 GUI 頁面（F5）。

### 安全說明

- 橋接只接受嚟自 GUI 頁面本身嘅同源請求；POST 必須係 `application/json`，其他 origin 嘅惡意頁面唔可以驅動命令，亦讀唔到回應。
- `browser_evaluate` 會喺**你**開住嘅頁面入面執行任意 JS（有你嘅登入狀態）。呢個正係插件嘅目的——但請將工具回傳內容當資料處理；每個 `browser_*` 調用照樣受標準工具審批規則管轄。
