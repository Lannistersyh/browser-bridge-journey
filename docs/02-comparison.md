# 技术对比：源码级

所有数字都是实际统计，不是印象。统计命令附在文末。

## 一、总体规模

| | BrowserSkill | cdp-bridge-mcp | 我的 EdgeBridge |
|---|---|---|---|
| Star | 9,182 | 305 | 0 |
| 许可证 | MIT | — | MIT |
| 语言 | Rust + TypeScript | Python | JavaScript |
| 代码行数 | **~209,500** | — | **476** |
| 文件数 | 697 | — | 9 |
| 构建系统 | pnpm workspace + Cargo | uv | 无（裸 node） |
| 分发 | 商店扩展 + shell installer | pip/PyPI | 手动加载解压扩展 |

### BrowserSkill 代码分布

| 部分 | 文件数 | 行数 |
|---|---|---|
| Rust（`crates/`：bsk-cli、bsk-protocol） | 158 | 61,267 |
| TypeScript（`apps/`、`packages/`） | 539 | 148,258 |

---

## 二、架构对比

### BrowserSkill

```
Agent ──bsk CLI──> daemon(Rust) ──WebSocket ws://127.0.0.1:52800──> MV3 扩展 ──chrome.debugger──> 标签页
                        │
                        └── IPC 进程身份校验（PID 匹配）
```

- 传输层：`WSTransport`，JSON 帧
- 握手：`system.handshake`，请求体含 `client` / `version` / `protocol_version` / `instance_id` / `browser` / `min_compatible_peer` / `min_compatible_protocol`
- 重连：`DEFAULT_INITIAL_DELAY_MS = 1000`，`DEFAULT_MAX_DELAY_MS = 5000`，指数退避
- 断线处理：`explicitlyClosed` 标志位区分主动断开与意外断开

### cdp-bridge-mcp

```
Agent ──MCP──> Python server ──WebSocket ws://127.0.0.1:18765──> 扩展 ──chrome.debugger──> 标签页
                                     + HTTP :18766（remote link）
```

- 鉴权：静态 `bridgeToken`，扩展连接时在首帧带上
- 就绪广播：`{type:'ext_ready', tabs:[...], token}`
- 双向 multiplexing：一个 ws 承载多个并发请求（`data.id` 匹配）

### 我的 EdgeBridge

```
Agent ──Unix socket /tmp/edgebridge.sock (0600)──> host(node) ──stdio native messaging 帧──> MV3 扩展 ──chrome.debugger──> 标签页
```

- 传输：native messaging 帧 = 4 字节小端 uint32 长度 + UTF-8 JSON
- 握手：`__hello` 带 `v` + `protocol` + `capabilities[]`
- 重连：`RECONNECT = { initial: 500, max: 8000 }`，指数退避
- 鉴权：文件系统权限（socket 0600）

---

## 三、逐项功能对照

图例：✅ 有　❌ 没有　— 不适用

| 能力 | BrowserSkill | 我的 EdgeBridge |
|---|---|---|
| 列标签页 | ✅ `tab` | ✅ `tabs` |
| 开/关/切换标签页 | ✅ | ✅ |
| 导航（URL/历史/刷新） | ✅ `navigate` / `navigate-back` / `reload` | ⚠️ 只能 `open` |
| 执行 JS | ✅ `evaluate` | ✅ `eval` |
| 任意 CDP 透传 | ✅ | ✅ `cdp` |
| 无障碍快照 | ✅ `snapshot`（`@eN` 引用树） | ❌ |
| 语义观察 | ✅ `observe`（VOM + perception probes） | ❌ |
| 点击/悬停/滚轮 | ✅ `click` / `hover` / `wheel` | ⚠️ 只能裸 CDP |
| 填表/按键/选择 | ✅ `fill` / `press` / `select` | ⚠️ 只能裸 CDP |
| 上传/下载 | ✅ `upload` / `download` | ❌ |
| 截图（视口/全页/元素/Canvas） | ✅ 四种 | ⚠️ 视口 + 全页 |
| 等待元素/导航 | ✅ `wait-for-element` / `wait-for-navigation` | ❌ |
| 网络请求查看 | ✅ `network` | ❌ |
| Console 日志 | ✅ `console` | ❌ |
| HTML dump | ✅ `get-html` | ❌ |
| 表格/列表提取 | ✅ `extract`（含合并单元格元数据） | ❌ |
| 录屏（操作轨迹 / MP4） | ✅ `record` / `video` | ❌ |
| 人机协作（验证码） | ✅ `request-help` | ❌ |
| 移动端模拟 | ✅ `emulate` | ❌ |
| 会话管理 | ✅ `session start/stop/list` | ❌（无隔离） |
| 多浏览器实例 | ✅ `browsers` / `pair` / `devices` | ❌ |
| 版本协商 | ✅ protocol 1.3 + 兼容性检查 | ⚠️ 只报版本，不检查 |
| 进程身份校验 | ✅ PID 匹配 | ❌（靠 socket 权限） |
| 零 TCP 端口 | ❌（52800） | ✅ |
| 无需构建 | ❌ | ✅ |

---

## 四、关键设计差异（源码级）

### 差异一：UI 表达方式 —— 这是我输得最明显的地方

**BrowserSkill 的做法**（`apps/extension/src/tools/observation.ts`）：产出 aria 快照。

```
@vom 1
@view 1462x672
@layers 2 focus=L1
L1 modal cover=100%
  toolbar "titlebar"
    @e1 textbox "镇痛筛选表" [default] ="镇痛筛选表"
    @e2 button "上次修改是在3小时前进行的"
    @e7 tab "开始"
    @e8 tab "插入" [ctx: titlebar]
```

agent 看到 `@e8 tab "插入"`，直接 `click --session X @e8`。
**不需要知道 DOM 结构，不需要写选择器。**

**我的做法**：给一个 `eval`，让 agent 自己写 JS：

```js
// 我实际操作腾讯文档时写的
const A = window.SpreadsheetApp;
const v = A.view, cv = v.canvas;
cv.selectApi.select(cv.normalSelectData, {xRange:[3,10], yRange:[39,40]}, null);
```

这能用——**但只因为腾讯文档恰好暴露了 `SpreadsheetApp` 全局对象**。换一个没暴露内部 API 的页面，这套就失效了。

我把"在特定页面上碰巧能用"当成了"通用方案"。

### 差异二：会话隔离

BrowserSkill 有 `session` 概念：任务开始 `session start`，结束 `session stop`。
任务跑在独立的 **Agent Window** 里，不干扰用户正在看的标签页；需要时可以显式"借"用户的标签页，用完归还。

我的 EdgeBridge 直接操作用户当前标签页，没有隔离、没有归还概念。
在用户正在看文档的时候 agent 跳过去点东西，体验很差。

### 差异三：安全模型

| | BrowserSkill | 我的 EdgeBridge |
|---|---|---|
| 传输层访问控制 | WebSocket 绑 127.0.0.1 | Unix socket 0600 |
| 进程身份 | ✅ IPC peer PID 校验 | ❌ |
| 远程配对 | ✅ 一次性 pairing link + 可 revoke | ❌ |
| 操作审计 | ✅ 独立审计流 + 可导出 JSON | ❌ |

我原本以为"零端口"是压倒性优势。但实际上：

- 绑 127.0.0.1 的 WebSocket，外部网络本来就进不来
- 本机进程要连，还得过 PID 身份校验
- 再加 pairing 授权 + 审计

**它的安全纵深比我的深**。我的 0600 socket 只是把"本机任意进程可连"缩小到"本机同用户进程可连"——而它连同用户进程都还要验身份。

这一点我一开始判断错了。

### 差异四：错误处理粒度

BrowserSkill 的扩展里 `tools/` 目录有 51 个文件，其中一个专门文件叫 `errors.ts`，
还有 `input-readiness.ts`、`scroll-visibility.ts`、`element-geometry.ts`——
说明它把"元素能不能点"拆成了可测试的多个维度。

我的实现里，所有错误都是 `catch(e) { reply(id, false, null, e.message) }`。

---

## 五、我唯一站得住的地方

**零 TCP 端口 + 无构建 + 476 行。**

如果场景是"只需要执行 JS 和截图，且不想装 12MB 的二进制、不想跑 pnpm build"，我这版是有位置的。
但这是个很窄的场景。

---

## 六、统计命令（可复现）

```bash
# clone
git clone --depth 1 https://github.com/Tencent/BrowserSkill.git
git clone --depth 1 https://github.com/Unagi-cq/cdp-bridge-mcp.git

# BrowserSkill 规模
cd BrowserSkill
find crates -name '*.rs' | wc -l
find crates -name '*.rs' -exec cat {} + | wc -l
find apps packages \( -name '*.ts' -o -name '*.tsx' \) -exec cat {} + | wc -l

# 命令数
bsk --help | awk '/^  [a-z]/{n++} END{print n}'   # → 42

# 我的 EdgeBridge 规模
cd edgebridge && git ls-files | xargs cat | wc -l  # → 476
```
