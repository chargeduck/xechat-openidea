/**
 * openidea-bridge.js —— 网页视图 ↔ 插件（Rust/WASM）的桥
 *
 * 网页视图跑在不透明源沙箱 iframe 里：没有网络，也没有 localStorage（会失败）。
 * 这里把 WebSocket / fetch / XMLHttpRequest 换成 postMessage 通道，由插件用
 * host::WebSocket（WSS）和 host::fetch（HTTPS）代跑。
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
  // ---- 诊断条：把桥接层的关键事件直接画在页面上，方便不开控制台也能定位 ----
  var diag = { open: 0, sent: 0, recv: 0, err: '', last: '' }
  function diagRender() {
    try {
      var el = document.getElementById('__xechat_diag')
      if (!el) {
        el = document.createElement('div')
        el.id = '__xechat_diag'
        el.style.cssText = 'position:fixed;right:6px;bottom:6px;z-index:2147483647;font:11px/1.5 Consolas,monospace;' +
          'background:rgba(0,0,0,.72);color:#8ef;padding:4px 8px;border-radius:6px;pointer-events:none;' +
          'max-width:60vw;white-space:pre-wrap;opacity:.85'
        document.body.appendChild(el)
      }
      el.textContent = 'bridge 0.1.5  open=' + diag.open + ' sent=' + diag.sent + ' recv=' + diag.recv +
        (diag.err ? '\nerr=' + diag.err : '') + (diag.last ? '\nlast=' + diag.last : '')
    } catch (e) {}
  }
  function diagSet(err) {
    if (err) diag.err = String(err).slice(0, 120)
    diagRender()
  }
  var pending = new Map()
  var wsListeners = { open: [], message: [], close: [], error: [] }
  var ws = null

  function post(payload) {
    api.postMessage(JSON.stringify(payload))
  }

  function call(op) {
    return new Promise(function (resolve, reject) {
      var id = seq++
      pending.set(id, { resolve: resolve, reject: reject })
      op.id = id
      post(op)
    })
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
      if (msg.ok) {
        p.resolve(msg)
      } else {
        p.reject(new Error(msg.error || '插件返回失败'))
      }
      return
    }
    if (msg && msg.event) {
      ;(wsListeners[msg.event.replace('ws.', '')] || []).forEach(function (fn) {
        try { fn(msg) } catch (e) {}
      })
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
  var RELAY_ORIGIN = 'wss://xechat.lesscoding.net'
  var RELAY_BASE = '/xechat/relay/'

  function routeWs(url) {
    try {
      var u = new URL(url, location.href)
      var loopback = ['localhost', '127.0.0.1', '::1', '[::1]'].indexOf(u.hostname) >= 0
      if (loopback) return u.toString()
      // 已经是 wss 的（目标塘自己有 TLS）就直接用
      if (u.protocol === 'wss:') return u.toString()
      var port = u.port || '80'
      return RELAY_ORIGIN + RELAY_BASE + encodeURIComponent(u.hostname) + '/' + port
    } catch (e) {
      return url
    }
  }

  // ===== fetch =====
  var nativeFetch = window.fetch ? window.fetch.bind(window) : null
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

  // ===== WebSocket =====
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
    ws = this

    wsListeners.open.length = 0
    wsListeners.message.length = 0
    wsListeners.close.length = 0
    wsListeners.error.length = 0

    wsListeners.open.push(function () {
      self.readyState = 1
      if (self.onopen) self.onopen({ type: 'open' })
      while (self._queue.length) {
        var item = self._queue.shift()
        call({ op: 'ws.send', data: item }).catch(function (e) {
          if (self.onerror) self.onerror({ type: 'error', message: e.message })
        })
      }
    })
    wsListeners.message.push(function (msg) {
      diag.recv++
      diag.last = 'recv ' + String(msg.data || '').slice(0, 60)
      diagRender()
      if (self.onmessage) self.onmessage({ type: 'message', data: msg.data })
    })
    wsListeners.close.push(function () {
      self.readyState = 3
      diagSet('closed')
      if (self.onclose) self.onclose({ type: 'close', wasClean: true })
    })
    wsListeners.error.push(function (msg) {
      self.readyState = 3
      if (self.onerror) self.onerror({ type: 'error', message: msg.error })
    })

    call({ op: 'ws.connect', url: routeWs(url), headers: {} })
      .then(function () {
        // 握手成功：宿主不再额外发事件，这里直接把 open 派发出去，
        // 否则前端永远等不到 onopen（表现为「10s 内未完成握手」超时）。
        self.readyState = 1
        diag.open = 1
        diagRender()
        wsListeners.open.forEach(function (fn) { try { fn({}) } catch (e) {} })
      })
      .catch(function (e) {
        self.readyState = 3
        diagSet('connect failed: ' + e.message)
        if (self.onerror) self.onerror({ type: 'error', message: e.message })
        if (self.onclose) self.onclose({ type: 'close', wasClean: false })
      })
  }
  ShimWebSocket.CONNECTING = 0
  ShimWebSocket.OPEN = 1
  ShimWebSocket.CLOSING = 2
  ShimWebSocket.CLOSED = 3

  ShimWebSocket.prototype.send = function (data) {
    if (this.readyState === 1) {
      diag.sent++
      diag.last = 'send ' + String(data).slice(0, 60)
      diagRender()
      call({ op: 'ws.send', data: String(data) }).catch(function (e) {
        diagSet('send failed: ' + e.message)
        if (this.onerror) this.onerror({ type: 'error', message: e.message })
      })
    } else if (this.readyState === 0) {
      this._queue.push(String(data))
    }
  }
  ShimWebSocket.prototype.close = function () {
    this.readyState = 2
    call({ op: 'ws.close' }).catch(function () {})
  }
  ShimWebSocket.prototype.addEventListener = function (type, fn) {
    var key = type.replace('ws.', '')
    if (wsListeners[key]) wsListeners[key].push(function (msg) { fn(msg) })
  }
  ShimWebSocket.prototype.removeEventListener = function () {}

  window.WebSocket = ShimWebSocket

  console.log('[xechat-openidea] bridge 0.1.6 ready (relay: ' + RELAY_ORIGIN + RELAY_BASE + ')')
})()
