//! xechat 摸鱼 —— OpenIDEA 插件（WASM 侧）
//!
//! 前端是网页视图（`web/index.html`，由 xechat-web 构建而来）。网页视图运行在不透明源的
//! 沙箱 iframe 里：没有网络、没有 cookie/storage，所以 WebSocket 与 HTTP 都由本插件代跑：
//!
//! - 网页 → 插件：`{"id":1,"op":"http"|"ws.connect"|"ws.send"|"ws.close", ...}`
//! - 插件 → 网页：`{"id":1,"ok":true|false, ...}` 作为应答；
//!   `{"event":"ws.message"|"ws.close"|"ws.error", ...}` 作为推送。
//!
//! WebSocket 用 API 1.6 的宿主托管 WSS（`host::WebSocket`）：收到帧时 IDE 发
//! `websocket-ready` 事件唤醒插件，插件 `drain` 后转发给网页。
//!
//! **连接句柄放在进程级静态里**：网页视图的 `Views::handle` 可能每次都跑在新实例上，
//! 句柄放在 `self` 会导致「连接建立成功、下一次 send 却说未连接」（实例一换，旧句柄被 Drop）。

use base64::engine::general_purpose::STANDARD as B64;
use base64::Engine as _;
use openidea_plugin::host::{self, WebSocket, WebSocketRequest};
use openidea_plugin::views::{View, ViewEvent, Viewport, Views};
use openidea_plugin::{
    register_plugin, Context, Error, Event, EventKind, HttpRequest, Invocation, Plugin,
};
use serde_json::{json, Value};
use std::sync::Mutex;

/// 网页视图的 id，与 plugin.toml 中 `[[contributes.views]] id` 一致
const VIEW: &str = "chat";
/// 每次 drain 最多取多少帧
const DRAIN_LIMIT: u32 = 64;

/// 进程级连接句柄（见模块注释）
static WS: Mutex<Option<WebSocket>> = Mutex::new(None);

fn lock() -> std::sync::MutexGuard<'static, Option<WebSocket>> {
    WS.lock().unwrap_or_else(|e| e.into_inner())
}

/// 推一条消息给网页视图
fn post(value: Value) {
    let _ = host::post_view_message(VIEW, &value.to_string());
}

/// 排空宿主队列并转发给网页（不依赖插件实例）
fn pump() {
    let batch = {
        let guard = lock();
        let Some(ws) = guard.as_ref() else { return };
        match ws.drain(DRAIN_LIMIT) {
            Ok(batch) => batch,
            Err(e) => {
                drop(guard);
                post(json!({ "event": "ws.error", "error": e.to_string() }));
                *lock() = None;
                return;
            }
        }
    };

    for bytes in batch.messages {
        let text = String::from_utf8_lossy(&bytes).into_owned();
        post(json!({ "event": "ws.message", "data": text }));
    }

    if batch.closed {
        *lock() = None;
        post(json!({ "event": "ws.close" }));
    }
}

#[derive(Default)]
pub struct Moyu;

impl Moyu {
    fn reply_error(&self, id: &Value, message: &str) {
        post(json!({ "id": id, "ok": false, "error": message }));
    }

    /// 处理网页发来的一条桥接请求
    fn on_bridge(&mut self, text: &str, ctx: &Invocation) {
        let msg: Value = match serde_json::from_str(text) {
            Ok(v) => v,
            Err(e) => {
                post(json!({ "event": "bridge.error", "error": format!("桥接消息不是合法 JSON: {e}") }));
                return;
            }
        };
        let id = msg.get("id").cloned().unwrap_or(Value::Null);
        let op = msg.get("op").and_then(Value::as_str).unwrap_or_default();

        match op {
            "http" => self.op_http(&id, &msg),
            "ws.connect" => self.op_ws_connect(&id, &msg, ctx),
            "ws.send" => self.op_ws_send(&id, &msg),
            "ws.close" => {
                *lock() = None;
                post(json!({ "id": id, "ok": true }));
            }
            other => self.reply_error(&id, &format!("未知操作: {other}")),
        }
    }

    fn op_http(&mut self, id: &Value, msg: &Value) {
        let url = msg.get("url").and_then(Value::as_str).unwrap_or_default();
        if url.is_empty() {
            return self.reply_error(id, "http 请求缺少 url");
        }
        let method = msg.get("method").and_then(Value::as_str).unwrap_or("GET").to_uppercase();

        let mut req = HttpRequest::get(url);
        req.method = method;
        if let Some(headers) = msg.get("headers").and_then(Value::as_object) {
            for (k, v) in headers {
                if let Some(v) = v.as_str() {
                    req.headers.push((k.clone(), v.to_owned()));
                }
            }
        }
        if let Some(body) = msg.get("body").and_then(Value::as_str) {
            if let Ok(bytes) = B64.decode(body) {
                req.body = Some(bytes);
            }
        }

        match host::fetch(&req) {
            Ok(resp) => {
                let headers: serde_json::Map<String, Value> = resp
                    .headers
                    .iter()
                    .map(|(k, v)| (k.clone(), Value::String(v.clone())))
                    .collect();
                post(json!({
                    "id": id,
                    "ok": true,
                    "status": resp.status,
                    "headers": headers,
                    "body": B64.encode(&resp.body),
                }));
            }
            Err(e) => self.reply_error(id, &e.to_string()),
        }
    }

    fn op_ws_connect(&mut self, id: &Value, msg: &Value, ctx: &Invocation) {
        let url = msg.get("url").and_then(Value::as_str).unwrap_or_default();
        if url.is_empty() {
            return self.reply_error(id, "ws.connect 缺少 url");
        }
        // 宿主托管的 WSS 必须绑定到一个项目；没有打开项目时无法建连。
        let Some(project) = ctx.project() else {
            return self.reply_error(id, "请先打开一个项目再连接鱼塘（OpenIDEA 的 WebSocket 必须绑定项目）");
        };

        let mut req = WebSocketRequest { url: url.to_owned(), ..Default::default() };
        if let Some(headers) = msg.get("headers").and_then(Value::as_object) {
            for (k, v) in headers {
                if let Some(v) = v.as_str() {
                    req.headers.push((k.clone(), v.to_owned()));
                }
            }
        }

        match WebSocket::connect(&project, &req) {
            Ok(ws) => {
                *lock() = Some(ws);
                post(json!({ "id": id, "ok": true }));
                // 订阅生效前可能已经有帧堆在宿主队列里，立刻排空一次
                pump();
            }
            Err(e) => self.reply_error(id, &e.to_string()),
        }
    }

    fn op_ws_send(&mut self, id: &Value, msg: &Value) {
        let data = msg.get("data").and_then(Value::as_str).unwrap_or_default().to_owned();
        let guard = lock();
        let Some(ws) = guard.as_ref() else {
            drop(guard);
            return self.reply_error(id, "WebSocket 尚未连接");
        };
        match ws.send(data.as_bytes()) {
            Ok(()) => {
                drop(guard);
                post(json!({ "id": id, "ok": true }));
            }
            Err(e) => {
                drop(guard);
                self.reply_error(id, &e.to_string());
            }
        }
    }
}

impl Plugin for Moyu {
    fn activate(&mut self, _ctx: &Context) -> Result<(), Error> {
        host::subscribe(EventKind::WebsocketReady)?;
        Ok(())
    }

    fn run_command(
        &mut self,
        id: &str,
        _ctx: &Invocation,
        _arg: Option<&str>,
    ) -> Result<Option<String>, Error> {
        match id {
            "open" => {
                host::reveal_view(VIEW)?;
                Ok(None)
            }
            other => Err(format!("未知命令: {other}").into()),
        }
    }

    fn handle_events(&mut self, events: &[Event], _ctx: &Invocation) {
        if events.iter().any(|e| matches!(e, Event::WebSocketReady(_))) {
            pump();
        }
    }
}

impl Views for Moyu {
    fn render(
        &mut self,
        _view: &str,
        _viewport: Option<Viewport>,
        _ctx: &Invocation,
    ) -> Result<View, Error> {
        // 网页视图的内容由 web/index.html 自己绘制，这里只兜底一个空消息。
        Ok(View::message(""))
    }

    fn handle(&mut self, _view: &str, event: ViewEvent, ctx: &Invocation) -> Result<(), Error> {
        if let ViewEvent::Message(text) = event {
            self.on_bridge(&text, ctx);
        }
        Ok(())
    }
}

register_plugin!(Moyu, views);
