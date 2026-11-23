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
| `plugin.toml` | 清单：视图 `chat`（右侧工具窗口，网页视图）、命令 `XEChat: 打开摸鱼聊天室`、能力声明 |
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

然后在 **设置 › 插件 › 为开发而链接** 里选中 `XEChat Moyu` → **查看权限…** → 允许
（`events` 是必需的；`net:dld.lesscoding.net` 等是可选，拒绝也能开界面但连不上）。
改完代码 `openidea-plugin build`，插件详情里点 **从磁盘重新加载**。

## 已知限制

- **必须先打开一个项目**：宿主托管的 WSS 绑定到项目，没有项目时建连会返回明确错误。
- 网页视图无持久化：`satoken`、主题、草稿都只在当前会话内存里。
- 只代理了 `http(s)` 与 `wss`；页面里其它协议的请求（如 `file://`）不支持。
- 单连接：一个视图对应一条鱼塘连接，多开视图会互相抢占（与其它端行为一致）。
