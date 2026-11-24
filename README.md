# xechat-openidea

xechat 摸鱼聊天室的 **OpenIDEA 插件**（第四端）。

前三个端（`xechat-idea-webview` / `xechat-vscode-extension` / `xechat-dsh`）都是「宿主内嵌浏览器 + JSBridge/WebSocket」，
OpenIDEA 不一样：它的插件是 **Rust → WebAssembly（wasm32-wasip2）**，界面是**沙箱网页视图**。

## 架构

```
OpenIDEA
├── 网页视图 web/index.html        ← 由 xechat-web 构建（base:'./'），加一层 openidea-bridge.js
│      │ postMessage（无网络、无 storage 的沙箱）
│      ▼
└── 插件 dist/plugin.wasm（src/lib.rs）
       ├── host::WebSocket  → wss://<鱼塘>/xechat      （API 1.6 宿主托管 WSS）
       ├── host::fetch      → https://dld.lesscoding.net/api/...
       └── host::post_view_message → 把收到的帧推回网页
```

网页视图跑在不透明源 iframe 里：**没有网络、没有 cookie/localStorage**。所以：

- `WebSocket` / `fetch` / `XMLHttpRequest` 全部被 `web/openidea-bridge.js` 换成 postMessage 通道；
- 真正的连接由 WASM 插件用宿主能力代跑；
- `localStorage` 被替换成内存实现（刷新即失，属预期）。

## 目录

| 路径 | 说明 |
| --- | --- |
| `plugin.toml` | 清单：视图 `chat`（右侧工具窗口，网页视图）、命令 `xechat: Open Chat`、能力声明、设置页 `logFile` |
| `src/lib.rs` | WASM 侧桥：`http` / `ws.connect` / `ws.send` / `ws.close` 四个 op + `websocket-ready` 事件转发 |
| `web/` | 前端产物：`index.html` + `js/index.js`（xechat-web 构建）+ `openidea-bridge.js`（自研桥） |
| `vendor/openidea-plugin/` | OpenIDEA 官方 SDK 源码快照（886K），离线可构建；更新时整目录替换 |
| `dist/plugin.wasm` | 构建产物（`openidea-plugin build` 生成） |

## 构建

前置：Rust + `wasm32-wasip2` target。

```bash
rustup target add wasm32-wasip2
cargo install --path <openidea 仓库>/crates/ide-host --bin openidea-plugin   # 或 --git 安装
```

1) 前端（在 `xechat-web` 里构建，产物直接落到本插件目录，**不改 xechat-web 源码**）：

```bash
cd ../xechat-web
npx vite build --base ./ --outDir ../xechat-openidea/web-build --emptyOutDir
cp -r ../xechat-openidea/web-build/. ../xechat-openidea/web/
```

2) 给 `web/index.html` 的 `<head>` 第一行加：

```html
<script src="./openidea-bridge.js"></script>
```

3) 插件本体：

```bash
cd ../xechat-openidea
openidea-plugin build          # = cargo build --release --target wasm32-wasip2 + 拷贝 + check
```

## 开发调试

```bash
openidea-plugin link           # 把当前目录写进 IDE 的 links.json
```

然后在 **设置 › 插件 › 为开发而链接** 里选中 `xechat` → **查看权限…** → 允许
（`events` 是必需的；`net:dld.lesscoding.net` 等是可选，拒绝也能开界面但连不上）。
改完代码 `openidea-plugin build`，插件详情里点 **从磁盘重新加载**。

## 日志与隐私

插件只记**元信息**，不记消息正文：

| 记什么 | 例子 |
| --- | --- |
| 连接 id、URL、建立/关闭原因 | `ws.connect 成功 #3: wss://…/relay/101.42.19.160/33859` |
| 帧的序号、类型、字节数 | `send#3 第1帧 LOGIN 312 字节`、`recv#3 第2帧 CHAT 480 字节` |
| 错误 | `drain#3 失败: …`、`send#3 失败: WebSocket 尚未连接` |

**不记**聊天内容、用户名、token 或任何帧正文。聊天内容属于用户与其他参与者之间的对话，
写进日志后会随「贴日志求助」或「提交仓库」被误分享，所以代码层面就直接不采集
（`note_frame` / `note_send` 只取 `action` 与长度）。

日志有**两个去处**，内容完全一致：

1. **IDE 日志**（默认开启，无法关闭——这是插件唯一能被支持人员看到问题的通道）；
   文件在 OpenIDEA 的数据目录下，例如 Windows：
   `%LOCALAPPDATA%\ai.l0ng.openidea\logs\openidea.<日期>.log`，搜索 `[xechat-bridge]`。
2. **项目内文件**（默认关闭，需手动开启）：设置 › 插件 › xechat › **把桥接日志写入当前项目**，
   开启后写到 `<当前打开的项目>/.xechat/logs/bridge.log`。用于排查「这个项目里连不上」这类
   与项目相关的问题，方便直接 `tail`。

### 为什么需要 `project.write`

只有第 2 项需要：把上面那份日志写到当前项目目录下的 `.xechat/logs/`。这是一个**可选**能力：

- 关闭时（默认）插件不会调用任何写文件 API，`project.read` 也不会用到；
- 拒绝授权不影响聊天功能，只是无法落盘日志；
- 写入路径固定为 `<项目根>/.xechat/logs/bridge.log`，不会碰项目里的其它文件；
- 建议把 `.xechat/` 加进项目的 `.gitignore`，避免日志被提交。

## 已知限制

- **必须先打开一个项目**：宿主托管的 WSS 绑定到项目，没有项目时建连会返回明确错误。
- 网页视图无持久化：`satoken`、主题、草稿都只在当前会话内存里。
- 只代理了 `http(s)` 与 `wss`；页面里其它协议的请求（如 `file://`）不支持。
- 多连接：前端会同时探测多个鱼塘，插件按连接编号（宿主 `websocket-ready` 事件的 `connection`）
  分别收发，宿主上限是 8 条。
- **不能内嵌外部网页**：宿主给网页视图注入的 CSP 没有 `frame-src`，落到 `default-src 'none'`，
  所以游戏大厅里的游戏页（`<iframe src="https://…">`）会被拦，只能改为在系统浏览器打开。
- 帧类型转换：宿主托管的 WebSocket 只收发**二进制帧**，而鱼塘是**文本帧**协议，
  跨网访问需要中继侧做转换，见 `tools/ws-frame-bridge-go/`。
