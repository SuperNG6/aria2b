'use strict'
/**
 * makeRpcClient / httpJsonPost 的契约测试。
 *
 * 重点：保证我们用 Node 原生 http.request 写的 RPC 客户端，
 * 错误形态与 sanitizeError 的兼容契约保持一致：
 *   e.code = ECONNREFUSED / ECONNABORTED / EMSGSIZE / EBADRESPONSE
 *   e.response = { status, statusText } 对应 HTTP 非 2xx
 * 这些是替换 axios 时唯一需要锁住的契约。
 */
const test = require('node:test')
const assert = require('node:assert/strict')
const http = require('node:http')
const net = require('node:net')
const { _internal } = require('../app.js')

const { config, sanitizeError, _reset, _makeRpcClient, httpJsonPost } = _internal

test.beforeEach(() => _reset())

function startServer(handler) {
    return new Promise(resolve => {
        const server = http.createServer(handler)
        server.listen(0, '127.0.0.1', () => {
            const { port } = server.address()
            resolve({
                server,
                url: `http://127.0.0.1:${port}/jsonrpc`,
                close: () => new Promise(r => server.close(r))
            })
        })
    })
}

async function withFreePort(fn) {
    // 拿一个临时绑过又释放掉的端口，用于测试 ECONNREFUSED
    const s = net.createServer()
    await new Promise(r => s.listen(0, '127.0.0.1', r))
    const { port } = s.address()
    await new Promise(r => s.close(r))
    return fn(port)
}

// ---------- 正常路径 ----------

test('makeRpcClient: 正常 JSON POST → 解析 data', async (t) => {
    let receivedBody = null
    let receivedContentType = null
    const mock = await startServer((req, res) => {
        receivedContentType = req.headers['content-type']
        const chunks = []
        req.on('data', c => chunks.push(c))
        req.on('end', () => {
            receivedBody = JSON.parse(Buffer.concat(chunks).toString('utf8'))
            res.writeHead(200, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({ ok: true, echo: receivedBody.id }))
        })
    })
    t.after(() => mock.close())

    const client = _makeRpcClient()
    t.after(() => client.destroy())

    const r = await client.post(mock.url, { jsonrpc: '2.0', id: 'x1', method: 'ping' })
    assert.equal(receivedContentType, 'application/json')
    assert.equal(receivedBody.method, 'ping')
    assert.deepEqual(r.data, { ok: true, echo: 'x1' })
    assert.equal(r.status, 200)
})

test('makeRpcClient: keep-alive 复用 socket（基础健壮性）', async (t) => {
    let connections = 0
    const mock = await startServer((req, res) => {
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ ok: true }))
    })
    mock.server.on('connection', () => connections++)
    t.after(() => mock.close())

    const client = _makeRpcClient()
    t.after(() => client.destroy())

    await client.post(mock.url, { a: 1 })
    await client.post(mock.url, { a: 2 })
    await client.post(mock.url, { a: 3 })
    assert.equal(connections, 1, '三次 POST 应复用同一个连接')
})

// ---------- 错误形态 ----------

test('makeRpcClient: HTTP 4xx → 抛带 e.response.{status, statusText} 的错误', async (t) => {
    const mock = await startServer((req, res) => {
        res.writeHead(401, 'Unauthorized')
        res.end('nope')
    })
    t.after(() => mock.close())

    const client = _makeRpcClient()
    t.after(() => client.destroy())

    await assert.rejects(
        () => client.post(mock.url, {}),
        (e) => {
            assert.ok(e.response, 'error 必须带 response')
            assert.equal(e.response.status, 401)
            assert.equal(e.response.statusText, 'Unauthorized')
            // 兼容 sanitizeError
            assert.match(sanitizeError(e), /401/)
            return true
        }
    )
})

test('makeRpcClient: HTTP 500 同样抛 e.response.status', async (t) => {
    const mock = await startServer((req, res) => {
        res.writeHead(500)
        res.end()
    })
    t.after(() => mock.close())
    const client = _makeRpcClient()
    t.after(() => client.destroy())

    await assert.rejects(() => client.post(mock.url, {}),
        (e) => e.response && e.response.status === 500)
})

test('makeRpcClient: HTTP 3xx 不能被当成成功（C2 回归）', async (t) => {
    // 旧版只对 >=400 抛错，3xx 会进 JSON.parse → 空体 → data=undefined
    // → cron 把 tellActive 当空数组 → 静默扫了个寂寞。
    const mock = await startServer((req, res) => {
        res.writeHead(302, { Location: 'http://elsewhere/' })
        res.end()
    })
    t.after(() => mock.close())
    const client = _makeRpcClient()
    t.after(() => client.destroy())

    await assert.rejects(
        () => client.post(mock.url, {}),
        (e) => {
            assert.ok(e.response, '3xx 也必须有 e.response')
            assert.equal(e.response.status, 302)
            return true
        }
    )
})

test('makeRpcClient: HTTP 304 也抛（防止静默扫空）', async (t) => {
    const mock = await startServer((req, res) => {
        res.writeHead(304)
        res.end()
    })
    t.after(() => mock.close())
    const client = _makeRpcClient()
    t.after(() => client.destroy())

    await assert.rejects(() => client.post(mock.url, {}),
        (e) => e.response && e.response.status === 304)
})

test('makeRpcClient: ECONNREFUSED → e.code 透传', async (t) => {
    const client = _makeRpcClient()
    t.after(() => client.destroy())

    await withFreePort(async (port) => {
        await assert.rejects(
            () => client.post(`http://127.0.0.1:${port}/jsonrpc`, {}),
            (e) => {
                assert.equal(e.code, 'ECONNREFUSED', `期望 ECONNREFUSED，实际：${e.code}`)
                assert.match(sanitizeError(e), /拒绝连接/)
                return true
            }
        )
    })
})

test('makeRpcClient: 响应不是合法 JSON → e.code=EBADRESPONSE', async (t) => {
    const mock = await startServer((req, res) => {
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end('<html>not json</html>')
    })
    t.after(() => mock.close())
    const client = _makeRpcClient()
    t.after(() => client.destroy())

    await assert.rejects(
        () => client.post(mock.url, {}),
        (e) => {
            assert.equal(e.code, 'EBADRESPONSE')
            return true
        }
    )
})

test('httpJsonPost: 请求超时 → e.code=ECONNABORTED（与 axios 风格对齐）', async (t) => {
    // 服务器接到请求就挂起不回，确保走超时分支
    const mock = await startServer((req, res) => {
        // 永不响应，让 client 触发超时
        void req; void res
    })
    t.after(() => mock.close())

    const http = require('node:http')
    const httpsLib = require('node:https')
    const opts = {
        timeout: 80,
        httpAgent: new http.Agent({ keepAlive: false }),
        httpsAgent: new httpsLib.Agent({ keepAlive: false })
    }
    t.after(() => { opts.httpAgent.destroy(); opts.httpsAgent.destroy() })

    await assert.rejects(
        () => httpJsonPost(opts, mock.url, { a: 1 }),
        (e) => {
            assert.equal(e.code, 'ECONNABORTED', `期望 ECONNABORTED，实际：${e.code}`)
            assert.match(sanitizeError(e), /请求超时/)
            return true
        }
    )
})

test('httpJsonPost: 绝对超时覆盖 connect 阶段（C1 回归）', async (t) => {
    // TEST-NET-1 (192.0.2.0/24) RFC 5737：保证不可路由，connect 永远不通。
    // 旧版用 req.setTimeout 只在 socket 分配后才生效，connect 卡住时
    // 会被 TCP 默认 ~2 分钟超时拖死。我们的绝对超时必须在 80ms 触发。
    const http = require('node:http')
    const httpsLib = require('node:https')
    const opts = {
        timeout: 200,
        httpAgent: new http.Agent({ keepAlive: false }),
        httpsAgent: new httpsLib.Agent({ keepAlive: false })
    }
    t.after(() => { opts.httpAgent.destroy(); opts.httpsAgent.destroy() })

    const t0 = Date.now()
    await assert.rejects(
        () => httpJsonPost(opts, 'http://192.0.2.1:6800/jsonrpc', {}),
        (e) => {
            // connect 阶段可能直接被 OS 拒绝（少见），也可能被我们的绝对超时切断
            // 但绝对不该等到 TCP 默认超时（>30s）才返回
            assert.ok(e.code, '应至少有 e.code')
            return true
        }
    )
    const elapsed = Date.now() - t0
    assert.ok(elapsed < 3000,
        `绝对超时必须在数秒内触发，实际花了 ${elapsed}ms（旧版 req.setTimeout 不覆盖 connect 会等 ~120s）`)
})

test('httpJsonPost: 响应体超过 RPC_MAX_BODY_BYTES → e.code=EMSGSIZE', async (t) => {
    // 直接发回一个超大响应；我们把上限通过私有 const RPC_MAX_BODY_BYTES 覆盖太麻烦，
    // 改为用一个 hang 着不停发数据的服务器 + 检查 EMSGSIZE 文案。
    // 简化版：发一个比 64MB 略小的响应不够触发；直接发 65MB+1 字节。这测试比较慢。
    // 改为更聪明的做法：暴露 httpJsonPost 后用一个会无限输出的 server，并设 timeout=1s 防卡。
    // 这里走真实路径，但用 chunked 输出 + close 来加速。

    const oversize = Buffer.alloc(1024 * 1024).fill('x')  // 1MB 一块
    const mock = await startServer((req, res) => {
        // 一直推到 client abort
        res.writeHead(200, { 'Content-Type': 'application/json' })
        let stopped = false
        res.on('close', () => { stopped = true })
        function loop() {
            if (stopped) return
            if (!res.write(oversize)) {
                res.once('drain', loop)
            } else {
                setImmediate(loop)
            }
        }
        loop()
    })
    t.after(() => mock.close())

    const http = require('node:http')
    const httpsLib = require('node:https')
    const opts = {
        timeout: 5000,
        httpAgent: new http.Agent({ keepAlive: false }),
        httpsAgent: new httpsLib.Agent({ keepAlive: false })
    }
    t.after(() => { opts.httpAgent.destroy(); opts.httpsAgent.destroy() })

    await assert.rejects(
        () => httpJsonPost(opts, mock.url, {}),
        (e) => {
            assert.equal(e.code, 'EMSGSIZE', `期望 EMSGSIZE，实际：${e.code}`)
            assert.match(sanitizeError(e), /响应体超出上限/)
            return true
        }
    )
})

test('makeRpcClient: 服务器中途断开 → 错误码合理 + 不挂死', async (t) => {
    const mock = await startServer((req, res) => {
        // 接到请求后立刻销毁 socket
        req.socket.destroy()
    })
    t.after(() => mock.close())
    const client = _makeRpcClient()
    t.after(() => client.destroy())

    await assert.rejects(
        () => client.post(mock.url, {}),
        (e) => {
            // ECONNRESET 或 socket hang up 都可接受
            assert.ok(e.code || e.message, '应至少有 code 或 message')
            return true
        }
    )
})

test('makeRpcClient: 服务器响应空体 → data = undefined（不抛）', async (t) => {
    const mock = await startServer((req, res) => {
        res.writeHead(200)
        res.end()  // 空体
    })
    t.after(() => mock.close())
    const client = _makeRpcClient()
    t.after(() => client.destroy())

    const r = await client.post(mock.url, {})
    assert.equal(r.status, 200)
    assert.equal(r.data, undefined)
})

test('makeRpcClient: 非法 URL → 拒绝（不崩溃）', async () => {
    const client = _makeRpcClient()
    try {
        await assert.rejects(() => client.post('http://[::invalid', {}),
            /url 格式不正确|Invalid URL/)
    } finally {
        client.destroy()
    }
})

// ---------- TLS 选项透传：用自签证书实测一次 ----------

test('makeRpcClient: destroy() 释放所有 keep-alive sockets', async (t) => {
    const mock = await startServer((req, res) => {
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ ok: true }))
    })
    t.after(() => mock.close())

    const client = _makeRpcClient()
    await client.post(mock.url, { a: 1 })

    // destroy() 不应抛
    assert.doesNotThrow(() => client.destroy())
    // 多次 destroy 也不应抛
    assert.doesNotThrow(() => client.destroy())
})

test('makeRpcClient: destroy() 中断飞行中的请求（C3 回归 — 让 stop() 能快速关停）', async (t) => {
    let serverGotRequest = false
    const mock = await startServer((req, res) => {
        serverGotRequest = true
        // 永不响应；让 client.destroy() 把 socket 切断
        void res
    })
    t.after(() => mock.close())

    const client = _makeRpcClient()
    const pending = client.post(mock.url, { a: 1 })

    // 等服务器至少看到请求再 destroy，避免 destroy 跑在 connect 完成之前
    await new Promise((resolve) => {
        const check = () => serverGotRequest ? resolve() : setTimeout(check, 5)
        check()
    })

    const t0 = Date.now()
    client.destroy()

    await assert.rejects(pending, (e) => {
        assert.ok(e.code || e.message, '应抛错而不是挂死')
        return true
    })
    const elapsed = Date.now() - t0
    assert.ok(elapsed < 1000,
        `destroy() 必须迅速中断 in-flight 请求，实际花了 ${elapsed}ms`)
})

// ---------- TLS 选项透传：用自签证书实测一次 ----------

test('makeRpcClient: TLS rejectUnauthorized=false 时能连自签 https 服务器', async (t) => {
    const tls = require('node:tls')
    const httpsLib = require('node:https')
    void tls
    // Node 没有内置自签证书工具；用一段固定的自签 PEM（仅用于本测，已过期也没关系，
    // 因为我们 rejectUnauthorized=false）。为避免维护长期固定证书，用 selfsigned 包略重，
    // 这里改走更简单的路径：起一个 https 服务，让 Node 自带 ALPN 直接拒绝默认 CA 校验。
    //
    // 简化方案：rejectUnauthorized=false 时即便服务端证书是自签的也应能连通。
    // 我们用 Node 自带的 X509 自签证书生成（Node 20+ 支持）。
    // 如果生成失败，跳过本测，仅验证 config.rpc_options 透传到 agent 不抛。

    let cert, key
    try {
        const { execFileSync } = require('node:child_process')
        const path = require('node:path')
        const fs = require('node:fs')
        const os = require('node:os')
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aria2b-tls-'))
        t.after(() => { fs.rmSync(dir, { recursive: true, force: true }) })
        execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes',
            '-keyout', `${dir}/k.pem`, '-out', `${dir}/c.pem`,
            '-days', '1', '-subj', '/CN=localhost'], { stdio: 'ignore', timeout: 5000 })
        cert = fs.readFileSync(`${dir}/c.pem`)
        key = fs.readFileSync(`${dir}/k.pem`)
    } catch (_) {
        t.skip('openssl 不可用，跳过 TLS 实测')
        return
    }

    const server = httpsLib.createServer({ cert, key }, (req, res) => {
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ tls: true }))
    })
    await new Promise(r => server.listen(0, '127.0.0.1', r))
    const url = `https://127.0.0.1:${server.address().port}/jsonrpc`
    t.after(() => new Promise(r => server.close(r)))

    // 1) 默认 rejectUnauthorized=true → 自签会被拒
    _reset()
    const strict = _makeRpcClient()
    t.after(() => strict.destroy())
    await assert.rejects(() => strict.post(url, {}),
        (e) => {
            // Node 错误码可能是 'DEPTH_ZERO_SELF_SIGNED_CERT' / 'SELF_SIGNED_CERT_IN_CHAIN' 等
            assert.ok(e.code || e.message, '应抛 TLS 错误')
            return true
        })

    // 2) rejectUnauthorized=false → 能正常连通（B3 修复后这就是本地 https 的默认行为）
    _reset()
    config.rpc_options.rejectUnauthorized = false
    const lax = _makeRpcClient()
    t.after(() => lax.destroy())
    const r = await lax.post(url, {})
    assert.equal(r.status, 200)
    assert.deepEqual(r.data, { tls: true })
})
