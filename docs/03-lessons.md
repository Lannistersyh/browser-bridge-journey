# 踩坑清单与可复用知识

这一趟虽然白做了，但踩出来的坑是真知识。以 BrowserSkill 作为对照，标出"它怎么处理的"。

---

## 一、MV3 扩展开发

### 1. Service Worker 会被缓存，改代码不生效 ⚠️ 最坑

**现象**：改了 `background.js`，重启浏览器，行为还是旧的。

**无效尝试**：改 `manifest.json` 的 `version`、删 Edge 缓存目录（macOS TCC 挡着，读不到）。

**有效解法**：换 `manifest.json` 的 `key`（RSA 公钥 → 扩展 ID 随之改变），等于装了个全新扩展。
我为此换了三次密钥。

**BrowserSkill 的处理**：`protocol_version` + `min_compatible_protocol` 双向校验，
版本对不上直接拒绝连接，而不是静默跑旧代码。

---

### 2. `--load-extension` 不持久

命令行加载的扩展，浏览器正常重启后就没了。

**正式安装唯一路径**：`edge://extensions` → 开发人员模式 → **「加载解压缩的扩展」按钮** → 选文件夹。

**别拖拽！** 拖文件夹进扩展页会被 Edge 当成**下载**处理，出现 `0/0` 的失败条目。
用按钮弹出的原生选择框，按 `⌘⇧G` 可以直接粘绝对路径。

---

### 3. 扩展 ID 可以由 `key` 固定

在 `manifest.json` 里放一个固定的 RSA 公钥，扩展 ID 就固定了，不会因为路径变化而变。
这对**原生消息清单要写 `allowed_origins`** 的场景是必须的。

```js
// 计算扩展 ID
const der = fs.readFileSync('pub.der');                    // DER 格式公钥
const hash = crypto.createHash('sha256').update(der).digest('hex').slice(0, 32);
const id = [...hash].map(c => String.fromCharCode(97 + parseInt(c, 16))).join('');
// manifest.key = der.toString('base64')
```

---

### 4. MV3 服务进程空闲约 30 秒被回收

**双保活**：

```js
// ① native messaging 端口长连接（打开期间不回收）
port = chrome.runtime.connectNative(HOST);

// ② alarms 兜底（需要 "alarms" 权限）
chrome.alarms.create('keepalive', { periodInMinutes: 0.5 });
chrome.alarms.onAlarm.addListener(() => ensurePort());
```

---

### 5. `chrome.debugger` 附加的限制

- **不能附加 `chrome://` / `edge://` 页面**（报 `Cannot access chrome:// and edge:// URLs`）。选目标标签页时必须先过滤：

  ```js
  const usable = tabs.filter(t => /^(https?|file):/i.test(t.url || ''));
  ```

- 同一标签页只能被一个调试器附加。DevTools 已打开时会失败。
- 附加后浏览器会在该页顶部显示一条**"正在调试"提示条**——Chromium 硬性行为，扩展绕不过去，不是弹窗但会一直挂着。

---

### 6. 选择会被合并单元格撑开

在表格应用里用 API 设置选区 `{yRange:[38,39]}`，如果这一行里有多行合并的单元格，
选区会被自动扩展到整个合并区域（变成 38-42）。

**解法**：选中时避开合并列，选 `xRange` 从第 2 列开始。

---

## 二、原生消息（Native Messaging）

### 1. 帧格式

```
[4 字节小端 uint32 长度][UTF-8 JSON 主体]
```

读的时候要注意粘包：

```js
let inbuf = Buffer.alloc(0);
process.stdin.on('data', chunk => {
  inbuf = Buffer.concat([inbuf, chunk]);
  while (inbuf.length >= 4) {
    const len = inbuf.readUInt32LE(0);
    if (inbuf.length < 4 + len) break;          // 还没收完
    const body = inbuf.subarray(4, 4 + len).toString('utf8');
    inbuf = inbuf.subarray(4 + len);
    // 处理 body
  }
});
```

### 2. 宿主进程的 PATH 可能没有 node

浏览器拉起原生宿主时，PATH 通常是 launchd 的精简版（`/usr/bin:/bin:/usr/sbin:/sbin`），
**不含 `/usr/local/bin`**，`#!/usr/bin/env node` 会找不到解释器。

**解法**：用一个 shell wrapper 显式写绝对路径。

```bash
#!/bin/bash
exec "/usr/local/bin/node" "$(cd "$(dirname "$0")" && pwd)/host.js" "$@"
```

### 3. 清单必须绝对路径

`~/Library/Application Support/Microsoft Edge/NativeMessagingHosts/<name>.json`：

```json
{
  "name": "com.example.bridge",
  "path": "/绝对/路径/host.sh",
  "type": "stdio",
  "allowed_origins": ["chrome-extension://<扩展ID>/"]
}
```

Chrome 换成 `~/Library/Application Support/Google/Chrome/NativeMessagingHosts/`。

---

## 三、macOS 系统限制

### TCC 会挡你读浏览器 profile

以下操作都会 `Operation not permitted`：

- 读 `~/Library/Application Support/Microsoft Edge/Default/Preferences`
- 读 `.../Default/History`（SQLite）
- 读 `.../DevToolsActivePort`
- `cp` 这些文件出来

**绕法**：不要硬读 profile 文件。要么走浏览器自身（CDP / 扩展 API），要么给终端授权「完全磁盘访问权限」。

### `security find-internet-password -w` 会挂起

读钥匙串密码时如果权限不足，命令会**卡住等 GUI 授权弹窗**，
在非交互场景（agent 自动执行）会直接超时。用 `git credential fill` 更安全：

```bash
printf "protocol=https\nhost=github.com\n" | git credential fill
```

---

## 四、网络

### 直连 GitHub 不通时的症状

- `fatal: unable to access '...': Error in the HTTP2 framing layer`
- `fatal: unable to access '...': Empty reply from server`
- `curl https://github.com` 返回 `000`

**解法**：走代理 + 降级 HTTP/1.1

```bash
git -c http.proxy=http://127.0.0.1:7897 -c http.version=HTTP/1.1 push -u origin main
```

⚠️ 代理端口要实际探测，不要假设 7890。用：

```bash
lsof -nP -iTCP -sTCP:LISTEN | grep -i clash
for p in 7890 7897 7899; do nc -z -w 1 127.0.0.1 $p && echo "port $p 开放"; done
```

### GitHub API 用 token 建仓库

```bash
CREDS=$(printf "protocol=https\nhost=github.com\n" | git credential fill | grep "^password=" | cut -d= -f2-)
curl -X POST -H "Authorization: token $CREDS" -H "Accept: application/vnd.github+json" \
  https://api.github.com/user/repos \
  -d '{"name":"my-repo","description":"...","private":false}'
```

---

## 五、腾讯文档（或类似的 canvas 表格应用）

### 两套写入通道，只有一套会保存

| 通道 | 落云？ |
|---|---|
| 内部 API `setCellDataAtPosition(...)` / `insertDimension(...)` | ❌ **只改本地模型，刷新即丢** |
| UI 操作（真实鼠标 / 键盘 / 剪贴板 Cmd+V） | ✅ 走协作管线，会保存 |

**这个坑值得单独记**：改完数据、读回来看着是对的，**刷新页面全没了**。
必须先验证"刷新后还在"，才算真写完。

### 真实粘贴的正确姿势

```js
// 1) 先给表格焦点（必须有真实鼠标点击）
Input.dispatchMouseEvent({type:'mousePressed', x, y, button:'left'})
Input.dispatchMouseEvent({type:'mouseReleased', x, y, button:'left'})

// 2) 设置选区
spreadsheetApp.view.canvas.selectApi.select(...)

// 3) 系统剪贴板写入 TSV
//    printf 'a\tb\nc\td' | pbcopy

// 4) 发真实的粘贴命令（注意 commands:['paste'] 这一项）
Input.dispatchKeyEvent({
  type: 'keyDown', key: 'v', code: 'KeyV',
  windowsVirtualKeyCode: 86, nativeVirtualKeyCode: 9,
  modifiers: 4,                 // Meta (macOS Cmd)
  commands: ['paste']           // ← 关键，不加这个不会触发粘贴
})
Input.dispatchKeyEvent({ type: 'keyUp', ... })
```

**为什么合成 ClipboardEvent 不行**：`new ClipboardEvent('paste', {clipboardData: dt})` 派发到页面
不会走浏览器的粘贴管线，应用收不到。必须用 CDP 的 `commands:['paste']`。

---

## 六、失败的经验

### 搜索关键词决定了能不能搜到

我搜的是 `chrome debugger native messaging bridge`——**这是我的实现方式**。
搜出来全是零散小项目。

正确搜法是搜**问题**：`AI agent control my logged-in browser`。
第一条就是 BrowserSkill。

**搜解法得到同类，搜问题得到答案。**

### 9182 星意味着"不是冷门"

我如果在动手前查过 "browser agent" 这个方向，三分钟就能看到。
看不到只说明信息源有盲区，不说明前面没人。

### 自己实现一遍的收益

虽然白做，但换来的是真理解：

- native messaging 帧为什么要带长度前缀（stdio 是字节流，没有消息边界）
- 为什么 MV3 需要 alarms 保活（Service Worker 不是常驻进程）
- 为什么 `chrome.debugger` 不能碰 `edge://`（权限模型）
- 为什么 WebSocket 方案要额外做 PID 校验（127.0.0.1 挡不住本机进程）

这些在**用 BrowserSkill 的时候全用上了**——遇到问题能猜到是它哪一层在挡着。

---

## 七、一句话总结

> 造轮子的价值不在轮子，在于你知道轮子为什么是圆的。
> 但前提是——**先确认路上已经有车了**。
