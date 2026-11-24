/**
 * ws-frame-bridge.mjs —— WebSocket 帧类型转换器（二进制 ⇄ 文本）
 *
 * ## 为什么需要它
 *
 * OpenIDEA 宿主托管的 WebSocket 只会发/收 **Binary** 帧：
 *   crates/ide-host/src/plugins/websocket.rs
 *     · 发送：writer.send(Message::Binary(...))        —— 只有 Binary
 *     · 接收：match 里只处理 Message::Binary，Text 落到 `_ => {}` 被丢弃
 *
 * 而 xechat 鱼塘（Java 服务端）的聊天端口是**文本帧**协议。实测：
 *     TEXT  帧 → 386ms 收到 5 帧
 *     BINARY 帧 → 6s 内 0 帧（服务端直接无视，不报错也不断开）
 *
 * 于是必须有一层把帧类型翻过来：
 *     客户端(二进制) --BIN--> 本进程 --TEXT--> 上游鱼塘
 *     上游(文本)     --TEXT--> 本进程 --BIN--> 客户端
 *
 * ## 两种用法
 *
 * 1) 本地模式（不改服务器，立刻能用）：
 *      npm i ws
 *      node ws-frame-bridge.mjs --listen 33860 \
 *        --upstream wss://xechat.lesscoding.net/xechat/relay/101.42.19.160/33859
 *    然后在 openIdea 里用 `-h 127.0.0.1 -p 33859` 登录（前端会连 127.0.0.1:33860）。
 *
 * 2) 中继模式（部署到 xechat.lesscoding.net，替掉 nginx 的 /xechat/relay/）：
 *      node ws-frame-bridge.mjs --listen 9700 --allow 101.42.19.160:33859
 *    上游由路径决定：/xechat/relay/<host>/<port> → ws://<host>:<port>/xechat
 *    `--allow` 是白名单，避免变成开放代理（SSRF）。
 */
import { WebSocketServer, WebSocket } from 'ws'

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`)
  return i > 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback
}

const LISTEN = Number(arg('listen', 33860))
const FIXED_UPSTREAM = arg('upstream', '')
const ALLOW = String(arg('allow', '101.42.19.160:33859'))
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean)

const ts = () => new Date().toISOString().slice(11, 23)

/** 从 /xechat/relay/<host>/<port> 解析上游；路径不匹配时返回 null */
function upstreamFromPath(url) {
  const m = /\/relay\/([^/]+)\/(\d+)/.exec(url || '')
  if (!m) return null
  const host = decodeURIComponent(m[1])
  const port = Number(m[2])
  if (!ALLOW.includes(`${host}:${port}`)) return { denied: `${host}:${port}` }
  return { url: `ws://${host}:${port}/xechat` }
}

const wss = new WebSocketServer({ port: LISTEN, host: '0.0.0.0' })

wss.on('listening', () => {
  console.log(`${ts()} 监听 :${LISTEN}  固定上游=${FIXED_UPSTREAM || '(按路径解析)'}  白名单=${ALLOW.join(',')}`)
})

wss.on('connection', (client, req) => {
  let upstreamUrl = FIXED_UPSTREAM
  if (!upstreamUrl) {
    const picked = upstreamFromPath(req.url)
    if (!picked || picked.denied) {
      console.log(`${ts()} 拒绝 ${req.url}（${picked ? '不在白名单' : '路径不匹配'}）`)
      client.close(1008, 'pond not in relay whitelist')
      return
    }
    upstreamUrl = picked.url
  }

  console.log(`${ts()} 客户端接入 → ${upstreamUrl}`)
  const upstream = new WebSocket(upstreamUrl)
  const pending = [] // 上游握手完成前先攒着，否则 LOGIN 会丢
  let up = 0
  let down = 0

  client.on('message', (data, isBinary) => {
    const text = data.toString('utf8')
    up++
    if (up <= 5 || up % 20 === 0) {
      console.log(`${ts()} ↑ ${isBinary ? 'BIN' : 'TXT'}→TXT ${up}: ${text.slice(0, 120)}`)
    }
    if (upstream.readyState === WebSocket.OPEN) upstream.send(text) // 默认 text 帧
    else pending.push(text)
  })

  upstream.on('open', () => {
    console.log(`${ts()} 上游已连接，补发 ${pending.length} 帧`)
    while (pending.length) upstream.send(pending.shift())
  })

  upstream.on('message', (data) => {
    const text = data.toString('utf8')
    down++
    if (down <= 5 || down % 20 === 0) console.log(`${ts()} ↓ TXT→BIN ${down}: ${text.slice(0, 120)}`)
    if (client.readyState === WebSocket.OPEN) client.send(Buffer.from(text, 'utf8'), { binary: true })
  })

  let closed = false
  const closeBoth = (why) => {
    if (closed) return
    closed = true
    console.log(`${ts()} 关闭 (${why}) 上行 ${up} 下行 ${down}`)
    try { client.close() } catch {}
    try { upstream.close() } catch {}
  }
  client.on('close', () => closeBoth('client'))
  client.on('error', (e) => closeBoth('client error: ' + e.message))
  upstream.on('close', () => closeBoth('upstream'))
  upstream.on('error', (e) => closeBoth('upstream error: ' + e.message))
})
