//! xechat 摸鱼 —— OpenIDEA 插件（WASM 侧）
//!
//! 前端是网页视图（`web/index.html`，由 xechat-web 构建而来）。网页视图运行在不透明源的
//! 沙箱 iframe 里：没有网络、没有 cookie/storage，所以 WebSocket 与 HTTP 都由本插件代跑：
//!
//! - 网页 → 插件：`{"id":1,"op":"http"|"ws.connect"|"ws.send"|"ws.close", ...}`
//! - 插件 → 网页：`{"id":1,"ok":true|false,"conn":<n>,...}` 作为应答；
//!   `{"event":"ws.message"|"ws.close"|"ws.error","conn":<n>,...}` 作为推送。
//!
//! WebSocket 用 API 1.6 的宿主托管 WSS（`host::WebSocket`）：收到帧时 IDE 发
//! `websocket-ready` 事件（带 connection id）唤醒插件，插件 `drain` 后转发给网页。
//!
//! **必须支持多条连接**：前端会同时探测一批鱼塘（实测一次开 6 条），
//! 每条都用一个 `conn` 编号区分。早期版本只存一个全局句柄，新连接会把旧句柄顶掉，
//! 帧没有归属，页面就永远「登录中」。
//!
//! 句柄放在进程级静态里：网页视图的 `Views::handle` 可能每次都跑在新实例上，
//! 句柄放在 `self` 会导致「连接建立成功、下一次 send 却说未连接」。

use base64::engine::general_purpose::STANDARD as B64;
use base64::Engine as _;
use openidea_plugin::host::{self, WebSocket, WebSocketRequest};
use openidea_plugin::views::{View, ViewEvent, Viewport, Views};
use openidea_plugin::{
    register_plugin, Context, Error, Event, EventKind, HttpRequest, Invocation, LogLevel, Plugin,
};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, AtomicI64, Ordering};
use std::sync::Mutex;

/// 网页视图的 id，与 plugin.toml 中 `[[contributes.views]] id` 一致
const VIEW: &str = "chat";
/// 每次 drain 最多取多少帧。
/// **不能超过宿主的 DRAIN_BATCH（=32）**，否则 `drain` 直接返回
/// `invalid drain limit` —— 表现为收不到任何帧、句柄被丢弃、前端无限重连。
const DRAIN_LIMIT: u32 = 32;
/// 宿主允许一个插件同时持有的连接数上限
const MAX_CONNS: usize = 8;

/// 进程级的连接表：connection id → 句柄
static WS: Mutex<Option<HashMap<u64, WebSocket>>> = Mutex::new(None);
/// 落盘用的日志缓冲（保留最近 MAX_LOG_LINES 行）
const MAX_LOG_LINES: usize = 800;
static LOG: Mutex<Vec<String>> = Mutex::new(Vec::new());
static DIRTY: AtomicBool = AtomicBool::new(false);
static LOG_FAILED: AtomicBool = AtomicBool::new(false);
/// 页面所在时区相对 UTC 的分钟偏移（由网页上报，缺省 0=UTC）
static TZ_OFFSET_MIN: AtomicI64 = AtomicI64::new(0);
/// 可选落盘的开关（插件设置项）与相对路径（相对**当前项目根**，不写死任何绝对路径）
const LOG_SETTING: &str = "logFile";
const LOG_PATH: &str = ".xechat/logs/bridge.log";
/// 每条连接已收帧数
static FRAMES: Mutex<Option<HashMap<u64, usize>>> = Mutex::new(None);
/// 每条连接已发帧数
static SENDS: Mutex<Option<HashMap<u64, usize>>> = Mutex::new(None);

fn lock() -> std::sync::MutexGuard<'static, Option<HashMap<u64, WebSocket>>> {
    WS.lock().unwrap_or_else(|e| e.into_inner())
}

/// 推一条消息给网页视图
fn post(value: Value) {
    let _ = host::post_view_message(VIEW, &value.to_string());
}

/// 写一条到 IDE 日志（`<IDE 数据目录>/logs/openidea.<日期>.log`，所有用户都适用）。
/// 网页视图里看不到控制台，这是排查桥接问题的主要出口。
///
/// 只写连接 id、帧类型/计数/字节数、错误等**元信息**，不写消息正文。
/// 同时攒进内存缓冲；若用户打开了设置项 `logFile`，再由 [`flush_log`] 落一份到
/// **当前项目根**下的 `.xechat/logs/bridge.log`（路径相对项目，不写死绝对路径）。
fn note(level: LogLevel, msg: &str) {
    host::log(level, &format!("[xechat-bridge] {msg}"));
    let mut buf = LOG.lock().unwrap_or_else(|e| e.into_inner());
    buf.push(format!("{} {}", stamp(), msg));
    if buf.len() > MAX_LOG_LINES {
        let drop_to = buf.len() - MAX_LOG_LINES;
        buf.drain(0..drop_to);
    }
    DIRTY.store(true, Ordering::Relaxed);
}

/// 帧元信息：只记「动作名 / 字节数」，**绝不记消息正文**。
///
/// 聊天内容属于用户与他人之间的对话，写进 IDE 日志或项目日志都会被误分享
/// （贴日志、提交仓库）。所以这里只保留排查必需的元数据。
fn frame_kind(text: &str) -> Option<&'static str> {
    // 协议里的 `action` 只有固定几个取值，属于帧类型，不是消息内容
    let value: Value = serde_json::from_str(text).ok()?;
    match value.get("action").and_then(Value::as_str)? {
        "LOGIN" => Some("LOGIN"),
        "HEARTBEAT" => Some("HEARTBEAT"),
        "CHAT" => Some("CHAT"),
        "REACT" => Some("REACT"),
        _ => Some("OTHER"),
    }
}

/// 每帧都追加会刷屏，只对前几帧和每第 N 帧留记录
fn note_frame(conn: u64, text: &str) {
    let n = {
        let mut counts = FRAMES.lock().unwrap_or_else(|e| e.into_inner());
        let c = counts.get_or_insert_with(HashMap::new).entry(conn).or_insert(0);
        *c += 1;
        *c
    };
    if n <= 3 || n % 25 == 0 {
        let kind = frame_kind(text).unwrap_or("BINARY?");
        note(LogLevel::Info, &format!("recv#{conn} 第{n}帧 {kind} {} 字节", text.len()));
    }
}

/// 把缓冲写进**当前项目**的 `.xechat/logs/bridge.log`。
///
/// 只有用户显式打开设置项 `logFile` 才会写：默认不落地，避免往别人的仓库里扔文件。
fn flush_log(ctx: &Invocation) {
    if !DIRTY.swap(false, Ordering::Relaxed) {
        return;
    }
    if !host::setting_bool(LOG_SETTING).unwrap_or(false) {
        return;
    }
    let Some(project) = ctx.project() else { return };
    if project.root().is_err() {
        return;
    }
    let text = {
        let buf = LOG.lock().unwrap_or_else(|e| e.into_inner());
        buf.join("\n") + "\n"
    };
    if let Err(e) = project.write_file(LOG_PATH, &text) {
        // 只报一次，避免刷屏
        if !LOG_FAILED.swap(true, Ordering::Relaxed) {
            host::log(
                LogLevel::Warn,
                &format!("[xechat-bridge] 写 {LOG_PATH} 失败: {e}（缺少 project.write？）"),
            );
        }
    }
}

/// 本地时间的 HH:MM:SS：UTC 秒 + 网页上报的时区偏移
fn stamp() -> String {
    let utc = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0);
    let local = utc + TZ_OFFSET_MIN.load(Ordering::Relaxed) * 60;
    let t = local.rem_euclid(86_400);
    format!("{:02}:{:02}:{:02}", t / 3600, (t % 3600) / 60, t % 60)
}

/// 网页请求里带的连接编号；只有一条连接时允许省略
fn resolve_conn(msg: &Value) -> Option<u64> {
    if let Some(c) = msg.get("conn").and_then(Value::as_u64) {
        return Some(c);
    }
    let guard = lock();
    let map = guard.as_ref()?;
    if map.len() == 1 {
        map.keys().next().copied()
    } else {
        None
    }
}

/// 排空**某一条**连接的队列并转发给网页。
///
/// 一帧可能触发一次 `websocket-ready`，但批量窗口里往往不止一帧，所以循环取到不满一批为止
/// （最多 PUMP_ROUNDS 轮，防止被洪水帧卡死）。
fn pump(conn: u64) {
    const PUMP_ROUNDS: usize = 8;
    for _ in 0..PUMP_ROUNDS {
        let drained = {
            let mut guard = lock();
            let Some(map) = guard.as_mut() else { return };
            let Some(ws) = map.get(&conn) else {
                note(LogLevel::Debug, &format!("pump#{conn}: 无此连接"));
                return;
            };
            match ws.drain(DRAIN_LIMIT) {
                Ok(batch) => {
                    let texts: Vec<String> = batch
                        .messages
                        .iter()
                        .map(|b| String::from_utf8_lossy(b).into_owned())
                        .collect();
                    Ok((texts, batch.closed))
                }
                Err(e) => Err(e.to_string()),
            }
        };

        let (texts, closed) = match drained {
            Ok(v) => v,
            Err(e) => {
                // 不要因为一次 drain 失败就丢句柄：那样下一条 send 会报「尚未连接」
                note(LogLevel::Error, &format!("drain#{conn} 失败: {e}"));
                return;
            }
        };

        let full = texts.len() as u32 >= DRAIN_LIMIT;
        for text in texts {
            note_frame(conn, &text);
            post(json!({ "event": "ws.message", "conn": conn, "data": text }));
        }

        if closed {
            note(LogLevel::Info, &format!("连接 #{conn} 对端关闭"));
            if let Some(map) = lock().as_mut() {
                map.remove(&conn);
            }
            post(json!({ "event": "ws.close", "conn": conn }));
            return;
        }
        if !full {
            return;
        }
    }
}

/// 发帧同理：前 5 帧和每第 10 帧留记录（LOGIN 就在前几帧里），同样只记元信息
fn note_send(conn: u64, data: &str) {
    let n = {
        let mut counts = SENDS.lock().unwrap_or_else(|e| e.into_inner());
        let c = counts.get_or_insert_with(HashMap::new).entry(conn).or_insert(0);
        *c += 1;
        *c
    };
    if n <= 5 || n % 10 == 0 {
        let kind = frame_kind(data).unwrap_or("BINARY?");
        note(LogLevel::Info, &format!("send#{conn} 第{n}帧 {kind} {} 字节", data.len()));
    }
}

/// 兜底：不等 ready 事件，把所有连接都排空一遍。
/// ready 事件理论上每帧都会来，但真机上出现过「帧到了事件没到」的情况，
/// 所以每次页面发消息过来都顺手排一遍。
fn pump_all() {
    let ids: Vec<u64> = {
        let guard = lock();
        match guard.as_ref() {
            Some(map) => map.keys().copied().collect(),
            None => return,
        }
    };
    for id in ids {
        pump(id);
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
                let conn = resolve_conn(&msg);
                if let Some(conn) = conn {
                    if let Some(map) = lock().as_mut() {
                        map.remove(&conn);
                    }
                    note(LogLevel::Info, &format!("网页请求关闭连接 #{conn}"));
                }
                post(json!({ "id": id, "ok": true }));
            }
            "log" => self.op_log(&id, &msg),
            "tz" => {
                // 网页上报本地时区偏移（分钟，东八区=480），插件侧日志用本地时间
                let off = msg.get("offset").and_then(Value::as_i64).unwrap_or(0);
                let off = off.clamp(-24 * 60, 24 * 60);
                TZ_OFFSET_MIN.store(off, Ordering::Relaxed);
                note(LogLevel::Debug, &format!("页面时区偏移 {off} 分钟"));
                post(json!({ "id": id, "ok": true }));
            }
            other => self.reply_error(&id, &format!("未知操作: {other}")),
        }
        // ready 事件不可靠时这里能兜住；顺带把日志刷进项目目录
        pump_all();
        flush_log(ctx);
    }

    /// 网页侧日志转写进 IDE 日志：网页视图没有控制台，只能这样把 JS 侧信息带出来
    fn op_log(&mut self, id: &Value, msg: &Value) {
        let level = match msg.get("level").and_then(Value::as_str).unwrap_or("info") {
            "error" => LogLevel::Error,
            "warn" => LogLevel::Warn,
            "debug" => LogLevel::Debug,
            _ => LogLevel::Info,
        };
        let text = msg.get("msg").and_then(Value::as_str).unwrap_or_default();
        note(level, &format!("[web] {text}"));
        post(json!({ "id": id, "ok": true }));
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
                let conn = ws.id();
                note(LogLevel::Info, &format!("ws.connect 成功 #{conn}: {url}"));
                let over = {
                    let mut guard = lock();
                    let map = guard.get_or_insert_with(HashMap::new);
                    let over = map.len() >= MAX_CONNS;
                    map.insert(conn, ws);
                    over
                };
                if over {
                    note(LogLevel::Warn, &format!("连接数已达上限 {MAX_CONNS}，旧连接可能被宿主拒绝"));
                }
                post(json!({ "id": id, "ok": true, "conn": conn }));
                // 订阅生效前可能已经有帧堆在宿主队列里，立刻排空一次
                pump(conn);
            }
            Err(e) => {
                note(LogLevel::Error, &format!("ws.connect 失败: {url} -> {e}"));
                self.reply_error(id, &e.to_string());
            }
        }
    }

    fn op_ws_send(&mut self, id: &Value, msg: &Value) {
        let data = msg.get("data").and_then(Value::as_str).unwrap_or_default().to_owned();
        let Some(conn) = resolve_conn(msg) else {
            return self.reply_error(id, "WebSocket 尚未连接（缺少连接编号）");
        };
        let sent = {
            let guard = lock();
            let map = match guard.as_ref() {
                Some(map) => map,
                None => return self.reply_error(id, "WebSocket 尚未连接"),
            };
            let Some(ws) = map.get(&conn) else {
                return self.reply_error(id, "WebSocket 尚未连接");
            };
            ws.send(data.as_bytes()).map_err(|e| e.to_string())
        };
        match sent {
            Ok(()) => {
                note_send(conn, &data);
                post(json!({ "id": id, "ok": true }));
            }
            Err(e) => {
                note(LogLevel::Error, &format!("send#{conn} 失败: {e}"));
                self.reply_error(id, &e);
            }
        }
    }
}

impl Plugin for Moyu {
    fn activate(&mut self, _ctx: &Context) -> Result<(), Error> {
        host::subscribe(EventKind::WebsocketReady)?;
        note(LogLevel::Info, "插件激活，已订阅 websocket-ready");
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

    fn handle_events(&mut self, events: &[Event], ctx: &Invocation) {
        for event in events {
            if let Event::WebSocketReady(ready) = event {
                note(LogLevel::Info, &format!("ready #{}", ready.connection));
                pump(ready.connection);
            }
        }
        flush_log(ctx);
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
