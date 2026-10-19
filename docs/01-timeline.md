# 时间线：从一个需求到"原来早就有了"

全部发生在 **2026-10-19**，一天之内。

## 起因

上午在给科研项目做数据录入，要在腾讯文档「行为学原始数据」表里填 6 组溶剂对照数据。
手工填格子容易错，想让 agent 代劳。但直接操作浏览器有几条硬要求：

- 要带我的登录态（腾讯文档要登录）
- 不能开 `--remote-debugging-port`（等于把浏览器交出去）
- 不能每次弹授权框

于是决定自己做一个。

---

## 阶段一：造桥（约 1 小时）

### 第一版 v1.0

设计：

```
Agent → Unix socket → 原生宿主(node) → stdio native messaging → Edge MV3 扩展 → chrome.debugger
```

关键决策：**不开任何 TCP 端口**。唯一通道是 `/tmp/vonfrey_bridge.sock`，权限 0600。
比开调试端口安全——文件系统权限就是鉴权。

实现：
- `extension/manifest.json` + `background.js`：MV3 扩展，`debugger` + `nativeMessaging` 权限
- `native/host.js`：原生消息帧（4 字节小端长度前缀 + JSON），双向桥接
- `client.mjs`：agent 侧客户端

第一次测就通了：host 进程被 Edge 拉起，socket 出现，`tabs` 命令拿到标签页列表。

### 踩坑一：Edge 缓存 Service Worker

改完 `background.js` 重启 Edge，行为还是旧的。查出来是 MV3 的 Service Worker 脚本被缓存了。

试过：改版本号（无效）、删缓存目录（TCC 挡着）、最终解法是**换 manifest 的 `key` → 换扩展 ID → 强制重读**。
为此换了三次密钥。

### 踩坑二：`--load-extension` 不持久

`open -a "Microsoft Edge" --args --load-extension=...` 能加载，但**正常重启后扩展消失**。

正式安装必须走 `edge://extensions` 的「加载解压缩的扩展」按钮。
中途试过拖拽文件夹进扩展页——Edge 把它当**下载**处理，出现 `0/0` 的失败条目。

### 阶段一成果

v1.1 完整可用：列表、开页、eval、选区、真实 Cmd+V 粘贴、Delete 清除，全链路验过。

---

## 阶段二：查同类项目（约 30 分钟）

用户要求：查 GitHub 上最热的同类项目，对比源码，合并成一个更好的，传到自己 GitHub。

按 star 排序搜出来的结果：

| 项目 | Star | 通道 |
|---|---|---|
| Tencent/**BrowserSkill** | **9,182** | WebSocket `127.0.0.1:52800` + Rust daemon |
| Unagi-cq/**cdp-bridge-mcp** | 305 | WebSocket `127.0.0.1:18765` + Python |

两个都 clone 下来读了源码：

**BrowserSkill**（158 个 Rust 文件 / 61,267 行 + 539 个 TS 文件 / 148,258 行）
- `handshake.ts`：`system.handshake` 协议握手，带版本 + 能力清单协商
- `ws-transport.ts`：指数退避重连 0.5s→2s→4s→5s 封顶
- `observation.ts`：`Page.captureScreenshot` + `captureBeyondViewport` 做全页截图
- 42 个 CLI 子命令

**cdp-bridge-mcp**（Python）
- `background.js` 里 `ext_ready` 广播：连接建立即上报标签页清单
- 静态 token 鉴权

### 阶段二成果：EdgeBridge v2.0

把学到的模式合进自己的架构：
- 握手（版本 + capabilities 数组）
- 指数退避重连
- `ext_ready` 就绪广播
- 视口 / 全页截图
- 事件广播帧（无 `ok` 字段走广播，有则走 RPC 回路）

476 行，9 个文件。验证通过后推到 GitHub：
**https://github.com/Lannistersyh/edgebridge**

---

## 阶段三：真相（约 10 分钟）

推完仓库，继续折腾"扩展怎么装才持久"的问题。用 CDP 打开 `edge://extensions`，
调 `chrome.developerPrivate.getExtensionsInfo()` 想看看有没有装歪——

```
已装扩展: 21
  [ENABLED] CodexLedger            id=gkenpcmnoana… loc=FROM_MICROSOFT_STORE
  [ENABLED] codebox-AI下载文章       id=cfpdbfmncaam… loc=FROM_MICROSOFT_STORE
  [ENABLED] BrowserSkill           id=emacgiaaaioj… loc=FROM_MICROSOFT_STORE   ← 这个
  ...
```

**第 3 个就是 BrowserSkill。商店版。早就装在浏览器里了。**

也就是说，我花几个小时重造的东西，**一直装在我自己的浏览器里**，我只是没注意到。

---

## 阶段四：装官方版（约 15 分钟）

```bash
curl -fsSL https://raw.githubusercontent.com/Tencent/BrowserSkill/main/install.sh | sh
```

装上 `bsk` CLI 0.3.3，跑 `bsk doctor`：

```
ok    bsk home writable                /Users/admin/.bsk
ok    agent skill matches bundled CLI  codex, claude-code, cursor
ok    daemon running                   pid 3771 at ws://127.0.0.1:52800
ok    daemon local process identity    IPC peer PID matches daemon identity
ok    protocol compatible              daemon protocol 1.3 (app 0.3.3)
ok    auto-update                      no update attempt recorded
ok    extension connected              1 browser(s) connected
ok    browser protocol compatible      all 1 online browser(s) are compatible
```

**八项全绿，一次就通。**

实测：
- `bsk session start` → 拿 session id
- `bsk navigate --session lmqc <腾讯文档>` → 到达 load
- `bsk snapshot --session lmqc` → 带 `@eN` 引用的 aria 树
- `bsk screenshot --session lmqc --out /tmp/x.png` → 2924×1344
- `bsk evaluate --session lmqc '<js>'` → 读到 `SpreadsheetApp`

然后 `bsk install-skill --all --yes`，一键装进 codex / claude-code / cursor 三个 harness。

---

## 尾声

从"我要做个浏览器桥"到"原来官方版早就装在我机器上"，一天。

自建的 476 行还在 GitHub 上（`Lannistersyh/edgebridge`），作为这一段路的物证。
