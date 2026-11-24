// ws-frame-bridge —— WebSocket 帧类型转换中继（二进制 ⇄ 文本）
//
// 背景：OpenIDEA 宿主托管的 WebSocket 只发/收 Binary 帧
// （crates/ide-host/src/plugins/websocket.rs：发送固定 Message::Binary，
//
//	接收 match 只处理 Binary，Text 落到 `_ => {}` 丢弃）。
//
// 而 xechat 鱼塘（Java）的聊天端口是文本帧协议，二进制帧会被无视。
//
// 本程序放在 nginx 后面，把两侧帧类型翻过来：
//
//	浏览器/插件(二进制) --BIN--> 本程序 --TEXT--> 鱼塘
//	浏览器/插件(二进制) <--BIN-- 本程序 <--TEXT-- 鱼塘
//
// 目标鱼塘由 nginx 通过 X-Relay-Target 头传进来（沿用 xechat-relay-map.conf 的
// 白名单与域名映射），本程序只做协议转换，不解析域名、不做白名单（-allow 可选加固）。
//
// 只用标准库：CGO_ENABLED=0 go build -trimpath -ldflags "-s -w"
package main

import (
	"bufio"
	"crypto/rand"
	"crypto/sha1"
	"encoding/base64"
	"encoding/binary"
	"errors"
	"flag"
	"fmt"
	"io"
	"log"
	"net"
	"net/http"
	"regexp"
	"strings"
	"sync"
	"time"
)

const (
	opText   = 0x1
	opBinary = 0x2
	opClose  = 0x8
	opPing   = 0x9
	opPong   = 0xA

	wsGUID    = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"
	maxFrame  = 16 << 20
	maxQueued = 256
	dialLimit = 10 * time.Second
)

var (
	targetRe = regexp.MustCompile(`^[A-Za-z0-9._-]{1,253}:\d{1,5}$`)
	pathRe   = regexp.MustCompile(`/relay/([^/]+)/(\d+)`)
)

func main() {
	listen := flag.String("listen", "127.0.0.1:9700", "监听地址")
	allow := flag.String("allow", "", "目标白名单（host:port，逗号分隔）；为空表示信任 nginx")
	verbose := flag.Bool("v", false, "打印每帧摘要")
	flag.Parse()

	allowed := map[string]bool{}
	for _, s := range strings.Split(*allow, ",") {
		if s = strings.TrimSpace(s); s != "" {
			allowed[s] = true
		}
	}

	mux := http.NewServeMux()
	mux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		target := r.Header.Get("X-Relay-Target")
		if target == "" {
			if m := pathRe.FindStringSubmatch(r.URL.Path); m != nil {
				target = m[1] + ":" + m[2]
			}
		}
		if !targetRe.MatchString(target) {
			http.Error(w, "bad relay target", http.StatusForbidden)
			return
		}
		if len(allowed) > 0 && !allowed[target] {
			http.Error(w, "pond not in relay whitelist", http.StatusForbidden)
			return
		}
		if !strings.EqualFold(r.Header.Get("Upgrade"), "websocket") {
			http.Error(w, "expect websocket upgrade", http.StatusBadRequest)
			return
		}
		serve(w, r, target, *verbose)
	})

	log.Printf("监听 %s（白名单 %d 条，verbose=%v）", *listen, len(allowed), *verbose)
	srv := &http.Server{Addr: *listen, Handler: mux, ReadHeaderTimeout: 10 * time.Second}
	if err := srv.ListenAndServe(); err != nil {
		log.Fatal(err)
	}
}

func serve(w http.ResponseWriter, r *http.Request, target string, verbose bool) {
	hj, ok := w.(http.Hijacker)
	if !ok {
		http.Error(w, "hijack unsupported", http.StatusInternalServerError)
		return
	}
	raw, rw, err := hj.Hijack()
	if err != nil {
		return
	}
	defer raw.Close()

	key := r.Header.Get("Sec-WebSocket-Key")
	resp := "HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n" +
		"Sec-WebSocket-Accept: " + acceptKey(key) + "\r\n\r\n"
	if _, err := rw.WriteString(resp); err != nil {
		return
	}
	if err := rw.Flush(); err != nil {
		return
	}

	// 真实客户端 IP：nginx 用 X-Real-IP 传进来（Go 只是本机中转，原样带给上游）
	clientIP := r.Header.Get("X-Real-IP")
	if clientIP == "" {
		if host, _, err := net.SplitHostPort(r.RemoteAddr); err == nil {
			clientIP = host
		}
	}

	client := &conn{rw: rw, masked: false, verbose: verbose, tag: "↓"}
	var (
		upMu    sync.Mutex
		up      *conn
		pending []frameMsg
	)

	sendUp := func(m frameMsg) {
		upMu.Lock()
		defer upMu.Unlock()
		if up == nil { // 上游还没握完手：先攒着（LOGIN 不能丢）
			if len(pending) < maxQueued {
				pending = append(pending, m)
			}
			return
		}
		if err := up.write(opText, m.data); err != nil { // 上行统一转文本帧
			raw.Close()
		}
	}

	// 上游握手放后台：客户端已经 101，不会等
	go func() {
		upRaw, err := dialUpstream(target, clientIP)
		if err != nil {
			log.Printf("[%s] 上游连接失败: %v", target, err)
			raw.Close()
			return
		}
		upstream := &conn{rw: upRaw.rw, masked: true, verbose: verbose, tag: "↑"}

		upMu.Lock()
		backlog := pending
		pending = nil
		up = upstream
		for _, m := range backlog {
			_ = upstream.write(opText, m.data) // 上行统一转文本帧
		}
		upMu.Unlock()
		log.Printf("[%s] 上游已连接（补发 %d 帧）", target, len(backlog))

		for {
			op, data, err := upstream.read()
			if err != nil {
				raw.Close()
				return
			}
			switch op {
			case opText, opBinary:
				upstream.logFrame(op, data)
				downOp := byte(opText)
				if client.wantBinary {
					downOp = opBinary
				}
				if err := client.write(downOp, data); err != nil {
					raw.Close()
					return
				}
			case opPing:
				_ = upstream.write(opPong, data)
			case opClose:
				_ = client.write(opClose, data)
				raw.Close()
				return
			}
		}
	}()

	for {
		op, data, err := client.read()
		if err != nil {
			raw.Close()
			return
		}
		switch op {
		case opText, opBinary:
			client.logFrame(op, data)
			client.wantBinary = op == opBinary       // 首个数据帧决定下行风格
			sendUp(frameMsg{op: opText, data: data}) // 上行统一文本帧
		case opPing:
			_ = client.write(opPong, data)
		case opClose:
			_ = client.write(opClose, data)
			raw.Close()
			return
		}
	}
}

type frameMsg struct {
	op   byte
	data []byte
}

type conn struct {
	rw      *bufio.ReadWriter
	masked  bool // 写出去时是否加掩码（作为客户端连上游时必须）
	verbose bool
	tag     string
	wmu     sync.Mutex // 同一连接可能有两个写入者（上行写、pong）

	// 客户端用什么帧风格，下行就回什么风格：
	// 浏览器发文本帧（收 Blob 会炸），OpenIDEA 宿主只发二进制帧（收文本帧会被丢弃）。
	wantBinary bool
}

func (c *conn) logFrame(op byte, data []byte) {
	if !c.verbose {
		return
	}
	kind := "TXT"
	if op == opBinary {
		kind = "BIN"
	}
	s := string(data)
	if len(s) > 120 {
		s = s[:120]
	}
	log.Printf("%s %s %s", c.tag, kind, s)
}

func (c *conn) read() (byte, []byte, error) {
	r := c.rw.Reader
	var hdr [2]byte
	if _, err := io.ReadFull(r, hdr[:]); err != nil {
		return 0, nil, err
	}
	fin := hdr[0]&0x80 != 0
	op := hdr[0] & 0x0f
	masked := hdr[1]&0x80 != 0
	length := int64(hdr[1] & 0x7f)

	switch length {
	case 126:
		var b [2]byte
		if _, err := io.ReadFull(r, b[:]); err != nil {
			return 0, nil, err
		}
		length = int64(binary.BigEndian.Uint16(b[:]))
	case 127:
		var b [8]byte
		if _, err := io.ReadFull(r, b[:]); err != nil {
			return 0, nil, err
		}
		length = int64(binary.BigEndian.Uint64(b[:]))
	}
	if length < 0 || length > maxFrame {
		return 0, nil, errors.New("帧过大")
	}
	var mask [4]byte
	if masked {
		if _, err := io.ReadFull(r, mask[:]); err != nil {
			return 0, nil, err
		}
	}
	payload := make([]byte, length)
	if _, err := io.ReadFull(r, payload); err != nil {
		return 0, nil, err
	}
	if masked {
		for i := range payload {
			payload[i] ^= mask[i%4]
		}
	}
	if !fin {
		// 客户端（Chrome 等）会把大消息拆成分片，递归读完后续 Continuation 再拼起来
		_, rest, err := c.read()
		if err != nil {
			return 0, nil, err
		}
		return op, append(payload, rest...), nil
	}
	return op, payload, nil
}

// maxFrameChunk 单帧最大 payload。Netty 默认 64KB，这里留余量取 60000，
// 超过就拆成 Text + Continuation 帧，让大消息（图片 base64）能整体通过。
const maxFrameChunk = 60000

// write 按 ≤maxFrameChunk 分片发送一条消息：首帧带原 opcode，后续用 continuation(0x0)。
func (c *conn) write(op byte, payload []byte) error {
	for off := 0; ; {
		end := off + maxFrameChunk
		fin := true
		if end >= len(payload) {
			end = len(payload)
		} else {
			fin = false
		}
		frameOp := op
		if off > 0 {
			frameOp = 0x0
		}
		if err := c.writeFrame(fin, frameOp, payload[off:end]); err != nil {
			return err
		}
		if fin {
			return nil
		}
		off = end
	}
}

func (c *conn) writeFrame(fin bool, op byte, payload []byte) error {
	c.wmu.Lock()
	defer c.wmu.Unlock()

	n := len(payload)
	hdr := make([]byte, 0, 14)
	b0 := op
	if fin {
		b0 |= 0x80 // FIN=1
	}
	hdr = append(hdr, b0)

	var b2 byte
	if c.masked {
		b2 = 0x80
	}
	switch {
	case n < 126:
		hdr = append(hdr, b2|byte(n))
	case n <= 0xffff:
		hdr = append(hdr, b2|126, byte(n>>8), byte(n))
	default:
		hdr = append(hdr, b2|127)
		var b [8]byte
		binary.BigEndian.PutUint64(b[:], uint64(n))
		hdr = append(hdr, b[:]...)
	}

	if c.masked {
		var mask [4]byte
		if _, err := rand.Read(mask[:]); err != nil {
			return err
		}
		hdr = append(hdr, mask[:]...)
		for i := range payload {
			payload[i] ^= mask[i%4]
		}
	}
	if _, err := c.rw.Write(hdr); err != nil {
		return err
	}
	if _, err := c.rw.Write(payload); err != nil {
		return err
	}
	return c.rw.Flush()
}

type upConn struct{ rw *bufio.ReadWriter }

func dialUpstream(target, clientIP string) (*upConn, error) {
	raw, err := net.DialTimeout("tcp", target, dialLimit)
	if err != nil {
		return nil, err
	}
	rw := bufio.NewReadWriter(bufio.NewReader(raw), bufio.NewWriter(raw))
	kb := make([]byte, 16)
	if _, err := rand.Read(kb); err != nil {
		raw.Close()
		return nil, err
	}
	ff := ""
	if clientIP != "" {
		// 服务端若支持（读握手头），就能显示真实来源 IP 而不是本机中转地址
		ff = "X-Real-IP: " + clientIP + "\r\nX-Forwarded-For: " + clientIP + "\r\n"
	}
	req := "GET /xechat HTTP/1.1\r\nHost: " + target + "\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n" +
		ff +
		"Sec-WebSocket-Key: " + base64.StdEncoding.EncodeToString(kb) + "\r\nSec-WebSocket-Version: 13\r\n\r\n"
	if _, err := rw.WriteString(req); err != nil {
		raw.Close()
		return nil, err
	}
	if err := rw.Flush(); err != nil {
		raw.Close()
		return nil, err
	}
	status, err := rw.ReadString('\n')
	if err != nil {
		raw.Close()
		return nil, err
	}
	if !strings.Contains(status, "101") {
		raw.Close()
		return nil, fmt.Errorf("上游握手失败: %s", strings.TrimSpace(status))
	}
	for {
		line, err := rw.ReadString('\n')
		if err != nil {
			raw.Close()
			return nil, err
		}
		if line == "\r\n" || line == "\n" {
			break
		}
	}
	return &upConn{rw: rw}, nil
}

func acceptKey(key string) string {
	h := sha1.Sum([]byte(key + wsGUID))
	return base64.StdEncoding.EncodeToString(h[:])
}
