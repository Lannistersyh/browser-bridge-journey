# 浏览器桥：一次"重新发明轮子"的完整记录

> 我想让 AI 直接操作我正在用的浏览器——带登录态、不开调试端口、不弹授权框。
> 花了大半天从零做了一个。做完之后一查 GitHub，发现腾讯早就做完了，9182 星，做得比我的好得多。
>
> 这个仓库是留个纪念：**有个想法，先查一遍前人做过没有。**

---

## 一、我原本想解决的问题

科研数据录入要在腾讯文档里填表。手工格子太多、易错，想让 agent 替我做。但直接给 agent 浏览器权限，有几件事不能接受：

1. **不能开 `--remote-debugging-port`** —— 那等于把浏览器完全交出去，本机任何程序都能连上，读走所有 Cookie 和登录态。
2. **不能每次都点授权弹窗** —— Edge 的远程调试开关每次新连接都要确认，很吵。
3. **要能用我现在的登录态** —— 重新起一个干净的浏览器实例没用，因为腾讯文档要登录。

于是我自己设计了一套：**扩展 + 原生消息宿主 + Unix socket**，零 TCP 端口。

---

## 二、我做出来的东西

`my-attempt/` 是完整代码，476 行，9 个文件。

```
Agent → Unix socket(/tmp/edgebridge.sock, 0600) → 宿主(node) → stdio native messaging → Edge MV3 扩展 → chrome.debugger → 标签页
```

| 命令 | 作用 |
|---|---|
| `tabs` | 列标签页 |
| `open <url>` | 开标签页 |
| `activate` / `close` | 切换 / 关闭 |
| `eval '<js>'` | 执行 JS |
| `cdp <method> <json>` | 任意 CDP 透传 |
| `shot [file]` | 截图 |
| `watch` | 事件流 |
| `detach` | 解除附加 |

**它确实能跑**：导航到腾讯文档、读到表格数据、截图 2924×1346、用真实 Cmd+V 粘贴写入单元格、再用 Delete 键清除——全链路验过。

按"零端口"这个目标，它其实达标了：唯一通道是 0600 权限的 Unix socket，比开端口安全。

---

## 三、然后我查了 GitHub

搜"浏览器 + 扩展 + CDP + agent"，按 star 排序，结果是这样：

### 第一名：Tencent/BrowserSkill —— 9182 星，MIT

> *"Let AI agents use your real, logged-in browser without interrupting your work."*

我当时就愣住了：**它解决的问题和我一模一样**，连"用你已登录的浏览器"这句话都几乎是我想法的复述。

而且它早在 2026 年 6 月就开源了，我 10 月还在自己造。

### 第二名：Unagi-cq/cdp-bridge-mcp —— 305 星

同样是扩展 + 本地 daemon + WebSocket，做 MCP 桥接。

---

## 四、硬碰硬的对比（都是实际统计，不是印象）

| 维度 | **BrowserSkill** | **我的 EdgeBridge** |
|---|---|---|
| Star | **9,182** | 0 |
| 代码量 | **~209,500 行**（Rust 61,267 + TS 148,258） | **476 行** |
| 语言/构建 | Rust + TypeScript，pnpm workspace | 纯 JS，无构建 |
| 命令数 | **42 个** | 9 个 |
| 扩展权限 | 12 个 | 5 个 |
| 协议版本 | 1.3（有版本协商 + 兼容性检查） | 无版本协商 |
| Agent 通道 | WebSocket `127.0.0.1:52800` + **IPC 进程身份校验** | Unix socket 0600 |
| TCP 端口 | 1 个（**仅 localhost**） | **0 个** |
| 分发 | npm/商店扩展，跨 macOS/Linux/Windows | 需手动加载解压扩展 |
| 调试能力 | network / console / HAR 导出 / 请求重放 | 无 |
| 数据提取 | `extract` 导出表格列表（含合并单元格元数据） | 无 |
| 录屏 | `record`（操作轨迹）/ `video`（MP4） | 无 |
| 人机协作 | `request-help`（验证码/登录时喊人） | 无 |
| 文件交互 | `upload` / `download` | 无 |
| 等待机制 | `wait-for-element` / `wait-for-navigation` | 无 |
| 无障碍快照 | `snapshot` 生成带 `@eN` 引用的 aria 树 | 只有裸 DOM |

### 我需要承认的三件事

**1. 我只赢了一项，而且赢得很勉强。**

零 TCP 端口确实比它彻底。但它的 `bsk doctor` 里有一条：

```
ok  daemon local process identity    IPC peer PID matches daemon identity
```

它在 WebSocket 之外还做了**进程身份校验**——不是只靠端口绑 localhost，而是验证连进来的进程 PID 就是 daemon 自己。这已经把我引以为傲的那点优势补掉大半。

**2. 它的 `snapshot` 比我的 `eval` 高明一个层次。**

我的思路是"给 agent 一个 eval，让它自己写 JS 操作 DOM"。这在腾讯文档这种有内部 API 的页面上刚好能用，但换个页面就得重写选择器。

它是先产出一份带 `@eN` 引用的无障碍树：

```
@vom 1
@view 1462x672
L1 modal cover=100%
  toolbar "titlebar"
    @e1 textbox "镇痛筛选表" ="镇痛筛选表"
    @e5 button "3"
    @e7 tab "开始"
```

agent 看着这个结构决定点 `@e12`，**不需要知道 DOM 长什么样**。这才是通用解。我做了个能用的特解，还以为自己找到了通法。

**3. 我踩的每个坑，它都已经填平了。**

| 我踩的坑 | 它的做法 |
|---|---|
| Edge 缓存 Service Worker，改了代码不生效（我换了 3 次密钥） | 版本协商 + 兼容性检查 |
| MV3 服务进程 30 秒被回收 | alarms + 端口长连接双保活 |
| 断线后要手动重连 | 指数退避 0.5s→8s |
| 连接建立时不知道状态 | `ext_ready` 就绪广播 |
| 截图只有视口 | 视口/全页/元素/Canvas 区域四种 |
| 目标是 `edge://` 页面时 attach 报错 | 自动过滤不可附加的页面 |

---

## 五、最讽刺的一点

我用 CDP 打开 `edge://extensions`，调 `chrome.developerPrivate.getExtensionsInfo()` 列了 21 个扩展——

**第 3 个就是 BrowserSkill。商店版，早就装在我浏览器里了。**

也就是说，在我从零写桥的那几个小时里，我需要的那个东西一直装在我自己的浏览器里，只是我没注意到。后来装上 `bsk` CLI 跑 `bsk doctor`，八项全绿，一次就通——导航、快照、截图、`evaluate` 全部正常。

我造了半天的东西，人家一个 `curl | sh` 就装好了。

---

## 六、留在这里的三条结论

**1. 动手之前，先认真地搜一遍。**

我搜过，但搜的是"browser bridge""chrome debugger native messaging"这类**描述我自己的实现方式**的词——当然搜不到，因为人家叫 BrowserSkill。**应该搜的是问题，不是解法。** "让 AI 操作我登录着的浏览器"这句话搜下去，第一条就是。

**2. "我以前没见过"不等于"这东西不存在"。**

9182 星不是小数目。我看不到它，只说明我的信息源有盲区，不说明我在创新。

**3. 重新发明的价值不在成品，在理解。**

虽然白做了，但这一趟让我真的搞懂了：native messaging 帧格式、`chrome.debugger` 的附加限制、MV3 服务进程的生命周期、腾讯文档两套写入通道的区别（内部 API 只改本地模型不落云，只有 UI 操作才会保存）、macOS TCC 怎么挡你读浏览器 profile。

这些知识在后面用 BrowserSkill 的时候全都用上了——知道它为什么这么设计，遇到问题能定位。

如果一开始直接抄官网文档，我能用，但不会懂。

---

## 七、仓库结构

```
├── README.md               ← 你在这里
├── docs/
│   ├── 01-timeline.md      时间线：从需求到发现的完整经过
│   ├── 02-comparison.md    详细技术对比（含源码级差异）
│   └── 03-lessons.md       踩坑清单与可复用的知识
└── my-attempt/             我自己做的那一版（476 行，可运行但不必运行）
```

## 八、现在到底用什么

**用 [BrowserSkill](https://github.com/Tencent/BrowserSkill)。** 官方版，MIT，已装好可用。

我自己的那一版留在 `my-attempt/`，代码是完整的，能跑，但没必要跑。它的意义是这份记录本身。

---

## Credits

- [Tencent/BrowserSkill](https://github.com/Tencent/BrowserSkill) —— MIT License, Copyright (c) 2026 Tencent
- [Unagi-cq/cdp-bridge-mcp](https://github.com/Unagi-cq/cdp-bridge-mcp) —— 同期调研对象

本仓库中的 `my-attempt/` 为本人原创代码，同样以 MIT 发布。
