/**
 * openidea-bridge.js —— 网页视图 ↔ 插件（Rust/WASM）的桥
 *
 * 网页视图跑在不透明源沙箱 iframe 里：没有网络，也没有 localStorage（会失败）。
 * 这里把 WebSocket / fetch / XMLHttpRequest 换成 postMessage 通道，由插件用
 * host::WebSocket（WSS）和 host::fetch（HTTPS）代跑。
 *
 * **每条连接都有编号（conn）**：前端会同时探测多个鱼塘，只用一个全局句柄会互相覆盖，
 * 帧没有归属 → 页面永远「登录中」。所以连接表、监听器、收发都要按 conn 区分。
 *
 * 必须在 xechat-web 的应用脚本之前加载（放 <head> 里、defer 之前）。
 */
(function () {
  var api = window.openidea
  if (!api || typeof api.postMessage !== 'function') {
    // 不在 OpenIDEA 里：什么都不做，交回浏览器原生实现。
    return
  }

  var seq = 1
  var VERSION = '0.3.3'

  function post(payload) {
    try {
      api.postMessage(JSON.stringify(payload))
    } catch (e) {}
  }

  // 关键事件转进 IDE 日志：网页视图没有控制台，出问题时靠它定位
  function blog(level, msg) {
    try {
      post({ op: 'log', level: level, msg: String(msg).slice(0, 400) })
    } catch (e) {}
  }

  // 插件侧日志用本地时间：把本机时区偏移告诉 Rust（分钟，东八区=480）
  post({ op: 'tz', offset: -new Date().getTimezoneOffset() })

  var pending = new Map()

  // conn -> { open: [], message: [], close: [], error: [] }
  var conns = new Map()

  function call(op) {
    return new Promise(function (resolve, reject) {
      var id = seq++
      pending.set(id, { resolve: resolve, reject: reject })
      op.id = id
      post(op)
    })
  }

  // ===== 宿主能力：IDE 状态栏 + 插件级持久存储 =====
  // 沙箱里既没有 IndexedDB 也没有真正的 localStorage，小说正文只能存到宿主的
  // 插件级 KV（host::storage），状态栏则走 ui.set_status_item。
  window.__xechatHost = {
    status: function (text, tooltip) {
      return call({ op: 'status', text: String(text || ''), tooltip: tooltip == null ? '' : String(tooltip) })
    },
    clearStatus: function () {
      return call({ op: 'status.clear' })
    },
    kvGet: function (key) {
      return call({ op: 'kv.get', key: String(key) }).then(function (r) { return r && r.value != null ? r.value : null })
    },
    kvSet: function (key, value) {
      return call({ op: 'kv.set', key: String(key), value: String(value) })
    },
    kvDel: function (key) {
      return call({ op: 'kv.del', key: String(key) })
    }
  }

  // 沙箱里 localStorage 会抛异常；xechat-web 会读写它（satoken、主题、草稿）。
  // 用内存实现顶上，保证页面不崩；刷新后丢失是预期行为。
  try {
    window.localStorage.getItem('__probe__')
  } catch (e) {
    var mem = {}
    Object.defineProperty(window, 'localStorage', {
      value: {
        getItem: function (k) { return Object.prototype.hasOwnProperty.call(mem, k) ? mem[k] : null },
        setItem: function (k, v) { mem[k] = String(v) },
        removeItem: function (k) { delete mem[k] },
        clear: function () { mem = {} },
        key: function (i) { return Object.keys(mem)[i] || null },
        get length() { return Object.keys(mem).length }
      },
      configurable: true
    })
  }

  api.onMessage(function (text) {
    var msg
    try {
      msg = JSON.parse(text)
    } catch (e) {
      return
    }
    if (msg && msg.id != null && pending.has(msg.id)) {
      var p = pending.get(msg.id)
      pending.delete(msg.id)
      if (msg.ok) p.resolve(msg)
      else p.reject(new Error(msg.error || '插件返回失败'))
      return
    }
    if (!msg || !msg.event) return
    if (msg.event === 'bridge.error') {
      blog('warn', 'bridge.error: ' + msg.error)
      return
    }
    // 二进制帧（图片等）由插件以 base64 下发：解码成文本后走同一条消息通道
    if (msg.event === 'ws.message.bin') {
      try {
        var bytes = b64ToBytes(msg.b64)
        msg = { event: 'ws.message', conn: msg.conn, data: new TextDecoder('utf-8').decode(bytes) }
      } catch (e) {
        blog('warn', 'binary frame decode failed, len=' + (msg.b64 ? msg.b64.length : 0))
        return
      }
    }
    var kind = String(msg.event).replace('ws.', '')
    var set = msg.conn != null ? conns.get(msg.conn) : null
    if (!set || !set[kind]) {
      blog('warn', msg.event + ' 无主 conn=' + msg.conn)
      return
    }
    for (var i = 0; i < set[kind].length; i++) {
      try { set[kind][i](msg) } catch (e) {}
    }
  })

  function b64ToBytes(b64) {
    var bin = atob(b64 || '')
    var out = new Uint8Array(bin.length)
    for (var i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
    return out
  }

  function bytesToB64(bytes) {
    var bin = ''
    var chunk = 0x8000
    for (var i = 0; i < bytes.length; i += chunk) {
      bin += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk))
    }
    return btoa(bin)
  }

  function headersToObject(h) {
    var out = {}
    if (!h) return out
    if (typeof h.forEach === 'function' && !Array.isArray(h)) {
      h.forEach(function (v, k) { out[k] = v })
      return out
    }
    Object.keys(h).forEach(function (k) {
      if (h[k] != null) out[k] = String(h[k])
    })
    return out
  }

  /**
   * 鱼塘的聊天端口是**明文 WS**，而宿主托管的 WebSocket 在非回环地址只接受 wss。
   * 所以非回环目标一律改走本站已有的按塘中继：
   *   ws://<pond>:33859/xechat  →  wss://xechat.lesscoding.net/xechat/relay/<pond>/33859
   * 中继端有白名单（未登记的塘会 403），不是开放代理。
   */
  var RELAY_ORIGIN_DEFAULT = 'wss://xechat.lesscoding.net'
  var RELAY_BASE = '/xechat/relay/'

  /**
   * 用户是否希望经中继：localStorage['xechat_ws_relay_base']
   *   未设置 → 默认开启（用默认中继站点）
   *   ''     → 关闭中继，直连目标
   *   其他值 → 自定义中继站点
   */
  function relayOrigin() {
    try {
      var v = localStorage.getItem('xechat_ws_relay_base')
      if (v === null || v === undefined) return RELAY_ORIGIN_DEFAULT
      return v
    } catch (e) {
      return RELAY_ORIGIN_DEFAULT
    }
  }

  /**
   * 解析最终连接地址。
   * @returns {{url: string, error: (string|null)}}
   *
   * 开关必须贯穿到这里：关闭后不能再把普通 ws:// 目标静默改写成中继地址，
   * 否则用户的隐私选择会被桥接层覆盖（见 PR 复核意见）。
   * 关闭时若目标是宿主无法直连的「非回环明文 ws://」，直接给出明确错误，
   * 而不是偷偷回落到中继。
   */
  function routeWsResolve(url) {
    try {
      var u = new URL(url, location.href)
      var loopback = ['localhost', '127.0.0.1', '::1', '[::1]'].indexOf(u.hostname) >= 0
      if (loopback) return { url: u.toString(), error: null }
      // 目标自带 TLS：无论如何都直连
      if (u.protocol === 'wss:') return { url: u.toString(), error: null }

      var origin = relayOrigin()
      if (!origin) {
        return {
          url: u.toString(),
          error: '已关闭「中继连接」，但 OpenIDEA 宿主的 WebSocket 只允许非回环地址使用 wss://。' +
            '当前目标 ' + u.host + ' 是明文 ws://，无法直连。请改用带 TLS 的 wss:// 地址，或在设置中重新开启中继。'
        }
      }
      var port = u.port || '80'
      return { url: origin + RELAY_BASE + encodeURIComponent(u.hostname) + '/' + port, error: null }
    } catch (e) {
      return { url: url, error: null }
    }
  }

  /** 兼容旧调用点：只取地址 */
  function routeWs(url) {
    return routeWsResolve(url).url
  }

  // ===== fetch =====
  window.fetch = function (input, init) {
    init = init || {}
    var url = typeof input === 'string' ? input : input && input.url
    var method = (init.method || (input && input.method) || 'GET').toUpperCase()
    var headers = headersToObject(init.headers || (input && input.headers))

    var bodyPromise
    if (init.body != null) {
      if (typeof init.body === 'string') {
        bodyPromise = Promise.resolve(new TextEncoder().encode(init.body))
      } else if (init.body instanceof Uint8Array) {
        bodyPromise = Promise.resolve(init.body)
      } else if (init.body instanceof ArrayBuffer) {
        bodyPromise = Promise.resolve(new Uint8Array(init.body))
      } else {
        bodyPromise = Promise.resolve(new TextEncoder().encode(String(init.body)))
      }
    } else {
      bodyPromise = Promise.resolve(null)
    }

    return bodyPromise.then(function (bytes) {
      return call({
        op: 'http',
        url: new URL(url, location.href).toString(),
        method: method,
        headers: headers,
        body: bytes ? bytesToB64(bytes) : null
      }).then(function (res) {
        var data = b64ToBytes(res.body)
        return new Response(data, {
          status: res.status,
          headers: res.headers || {}
        })
      })
    })
  }

  // ===== XMLHttpRequest（axios 默认走 XHR）=====
  function ShimXHR() {
    this.readyState = 0
    this.status = 0
    this.statusText = ''
    this.response = null
    this.responseText = ''
    this.responseType = ''
    this.timeout = 0
    this.withCredentials = false
    this.onreadystatechange = null
    this.onload = null
    this.onerror = null
    this.ontimeout = null
    this._headers = {}
    this._aborted = false
  }
  ShimXHR.UNSENT = 0
  ShimXHR.OPENED = 1
  ShimXHR.HEADERS_RECEIVED = 2
  ShimXHR.LOADING = 3
  ShimXHR.DONE = 4

  ShimXHR.prototype.open = function (method, url) {
    this._method = method || 'GET'
    this._url = url
    this.readyState = 1
    if (this.onreadystatechange) this.onreadystatechange()
  }
  ShimXHR.prototype.setRequestHeader = function (k, v) {
    this._headers[k] = v
  }
  ShimXHR.prototype.getAllResponseHeaders = function () {
    var self = this
    return Object.keys(this._responseHeaders || {})
      .map(function (k) { return k + ': ' + self._responseHeaders[k] })
      .join('\r\n')
  }
  ShimXHR.prototype.getResponseHeader = function (k) {
    var h = this._responseHeaders || {}
    var hit = Object.keys(h).find(function (name) { return name.toLowerCase() === String(k).toLowerCase() })
    return hit ? h[hit] : null
  }
  ShimXHR.prototype.abort = function () {
    this._aborted = true
  }
  ShimXHR.prototype.send = function (body) {
    var self = this
    var bytes = null
    if (body != null) {
      if (typeof body === 'string') bytes = new TextEncoder().encode(body)
      else if (body instanceof Uint8Array) bytes = body
      else if (body instanceof ArrayBuffer) bytes = new Uint8Array(body)
      else bytes = new TextEncoder().encode(String(body))
    }
    call({
      op: 'http',
      url: new URL(this._url, location.href).toString(),
      method: this._method,
      headers: this._headers,
      body: bytes ? bytesToB64(bytes) : null
    })
      .then(function (res) {
        if (self._aborted) return
        self.status = res.status
        self._responseHeaders = res.headers || {}
        var data = b64ToBytes(res.body)
        if (self.responseType === 'arraybuffer') {
          self.response = data.buffer
          self.responseText = ''
        } else if (self.responseType === 'blob') {
          self.response = new Blob([data])
          self.responseText = ''
        } else {
          self.responseText = new TextDecoder().decode(data)
          self.response = self.responseType === 'json' ? JSON.parse(self.responseText || 'null') : self.responseText
        }
        self.readyState = 4
        if (self.onreadystatechange) self.onreadystatechange()
        if (self.onload) self.onload()
      })
      .catch(function (err) {
        if (self._aborted) return
        self.readyState = 4
        self.status = 0
        if (self.onreadystatechange) self.onreadystatechange()
        if (self.onerror) self.onerror(err)
      })
  }
  window.XMLHttpRequest = ShimXHR

  // ===== WebSocket（每条连接独立编号与监听器）=====
  function ShimWebSocket(url, protocols) {
    var self = this
    this.url = url
    this.readyState = 0 // CONNECTING
    this.protocol = Array.isArray(protocols) ? protocols[0] || '' : protocols || ''
    this.onopen = null
    this.onmessage = null
    this.onclose = null
    this.onerror = null
    this._queue = []
    this._conn = null
    this._set = { open: [], message: [], close: [], error: [] }

    this._set.open.push(function () {
      self.readyState = 1
      if (self.onopen) self.onopen({ type: 'open' })
      while (self._queue.length) {
        self._sendNow(self._queue.shift())
      }
    })
    this._set.message.push(function (msg) {
      if (self.onmessage) self.onmessage({ type: 'message', data: msg.data })
    })
    this._set.close.push(function () {
      self.readyState = 3
      blog('warn', 'ws 对端关闭 #' + self._conn)
      if (self.onclose) self.onclose({ type: 'close', wasClean: true })
    })
    this._set.error.push(function (msg) {
      self.readyState = 3
      blog('error', 'ws error #' + self._conn + ': ' + msg.error)
      if (self.onerror) self.onerror({ type: 'error', message: msg.error })
    })

    var routed = routeWsResolve(url)
    if (routed.error) {
      // 明确提示，不静默回落中继
      self.readyState = 3
      blog('error', routed.error)
      try { window.dispatchEvent(new CustomEvent('xechat:ws-route-error', { detail: routed.error })) } catch (e) {}
      setTimeout(function () {
        if (self.onerror) self.onerror({ type: 'error', message: routed.error })
        if (self.onclose) self.onclose({ type: 'close', wasClean: false })
      }, 0)
      return
    }

    call({ op: 'ws.connect', url: routed.url, headers: {} })
      .then(function (res) {
        self._conn = res.conn
        conns.set(res.conn, self._set)
        self.readyState = 1
        blog('info', 'ws 已连接 #' + res.conn + ': ' + routed.url)
        for (var i = 0; i < self._set.open.length; i++) {
          try { self._set.open[i]({}) } catch (e) {}
        }
      })
      .catch(function (e) {
        self.readyState = 3
        blog('error', 'ws 连接失败: ' + routed.url + ' -> ' + e.message)
        if (self.onerror) self.onerror({ type: 'error', message: e.message })
        if (self.onclose) self.onclose({ type: 'close', wasClean: false })
      })
  }
  ShimWebSocket.CONNECTING = 0
  ShimWebSocket.OPEN = 1
  ShimWebSocket.CLOSING = 2
  ShimWebSocket.CLOSED = 3

  ShimWebSocket.prototype._sendNow = function (data) {
    var self = this
    call({ op: 'ws.send', conn: this._conn, data: String(data) }).catch(function (e) {
      blog('error', 'ws 发送失败 #' + self._conn + ': ' + e.message)
      if (self.onerror) self.onerror({ type: 'error', message: e.message })
    })
  }

  ShimWebSocket.prototype.send = function (data) {
    if (this.readyState === 1) {
      this._sendNow(data)
    } else if (this.readyState === 0) {
      this._queue.push(String(data))
    }
  }
  ShimWebSocket.prototype.close = function () {
    this.readyState = 2
    var conn = this._conn
    if (conn != null) {
      conns.delete(conn)
      call({ op: 'ws.close', conn: conn }).catch(function () {})
    }
  }
  ShimWebSocket.prototype.addEventListener = function (type, fn) {
    var key = type.replace('ws.', '')
    if (this._set[key]) this._set[key].push(function (msg) { fn(msg) })
  }
  ShimWebSocket.prototype.removeEventListener = function () {}

  window.WebSocket = ShimWebSocket

  console.log('[xechat] bridge ' + VERSION + ' ready (relay: ' + RELAY_ORIGIN + RELAY_BASE + ')')
  blog('info', 'bridge ' + VERSION + ' ready')
})()
