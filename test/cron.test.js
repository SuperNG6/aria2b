'use strict'
/**
 * 集成测试：把 axios 的 RPC 后端指向一个 mock http server，
 * 把 ipset/iptables 调用 monkey-patch 成 spy，验证 cron 的端到端行为。
 */
const test = require('node:test')
const assert = require('node:assert/strict')
const http = require('node:http')
const { _internal } = require('../app.js')

const {
    config, blockedIps, peerState, runtime,
    cron, isBlocked,
    _reset, _setRpcClient, _makeRpcClient
} = _internal

// ---------- 测试基础设施 ----------

function startMockAria2(handler) {
    return new Promise(resolve => {
        const server = http.createServer((req, res) => {
            let body = ''
            req.on('data', c => { body += c })
            req.on('end', () => {
                try {
                    const json = JSON.parse(body)
                    const reply = handler(json)
                    res.writeHead(200, { 'Content-Type': 'application/json' })
                    res.end(JSON.stringify({ jsonrpc: '2.0', id: json.id, ...reply }))
                } catch (e) {
                    res.writeHead(500)
                    res.end(String(e))
                }
            })
        })
        server.listen(0, '127.0.0.1', () => {
            const { port } = server.address()
            resolve({ server, url: `http://127.0.0.1:${port}/jsonrpc`,
                     close: () => new Promise(r => server.close(r)) })
        })
    })
}

// 把 runtime.execFile 替换成一个 spy
function spyExecFile() {
    const calls = []
    const original = runtime.execFile
    runtime.execFile = async (file, args) => {
        calls.push({ file, args: [...args] })
        return { stdout: '', stderr: '' }
    }
    return {
        calls,
        restore() { runtime.execFile = original }
    }
}

// ---------- cron: 关键字命中 → ban ----------

test('cron: 关键字命中（XL）→ ipset add 调用', async (t) => {
    _reset()
    const mock = await startMockAria2((req) => {
        if (req.method === 'aria2.tellActive') {
            return { result: [{ gid: 'gid-1' }] }
        }
        if (req.method === 'system.multicall') {
            const calls = req.params[0]
            const results = calls.map(c => {
                if (c.methodName === 'aria2.tellStatus') {
                    return [{ numPieces: 100, pieceLength: 1048576 }]
                }
                if (c.methodName === 'aria2.getPeers') {
                    return [[
                        {
                            peerId: '%2DXL0012%2Dabcdef012345',  // XL = 迅雷
                            ip: '203.0.113.5',
                            uploadSpeed: 2048,
                            downloadSpeed: 0,
                            bitfield: '00'
                        }
                    ]]
                }
                return [null]
            })
            return { result: results }
        }
        return { result: [] }
    })
    t.after(() => mock.close())

    config.rpc_url = mock.url
    config.secret = 'test-secret'
    config.ipv6 = false
    _setRpcClient(_makeRpcClient())

    const spy = spyExecFile()
    t.after(() => spy.restore())

    await cron()

    // 应该有 1 次 ipset add 调用
    const adds = spy.calls.filter(c => c.file === 'ipset' && c.args[0] === 'add')
    assert.equal(adds.length, 1, `期望 1 次 ipset add，实际：${JSON.stringify(spy.calls)}`)
    assert.equal(adds[0].args[1], '-exist', '必须用 -exist 让重复添加刷新 timeout')
    assert.equal(adds[0].args[2], 'bt_blacklist')
    assert.equal(adds[0].args[3], '203.0.113.5')
    assert.equal(isBlocked('203.0.113.5'), true, 'IP 应进入本地缓存')
})

// ---------- cron: B2 回归 — block_keywords 含 Unknown 必须直接屏蔽未知客户端 ----------

test('cron: block_keywords 含 Unknown 时直接屏蔽未知客户端（B2 回归）', async (t) => {
    _reset()
    config.block_keywords = ['Unknown']
    config.noprogress_keywords = ['NEVER']   // 关掉 noprogress 通道，确保命中只能来自 block 路径

    const mock = await startMockAria2((req) => {
        if (req.method === 'aria2.tellActive') return { result: [{ gid: 'g' }] }
        if (req.method === 'system.multicall') {
            const calls = req.params[0]
            const results = calls.map(c => {
                if (c.methodName === 'aria2.tellStatus') return [{ numPieces: 100, pieceLength: 16384 }]
                if (c.methodName === 'aria2.getPeers') return [[
                    {
                        // 一段不符合任何已知客户端格式的 peerId → getPeerName 返回 { client: 'unknown' }
                        peerId: '%2D%2D%2D%2D%2D%2D%2D%2Ddeadbeefcafe',
                        ip: '198.51.100.5',
                        uploadSpeed: 1,         // 即使速度极低也要 ban（不走 noprogress 通道）
                        downloadSpeed: 999,     // 即使在下载也要 ban
                        bitfield: 'ff'           // 有进度也要 ban
                    }
                ]]
                return [null]
            })
            return { result: results }
        }
        return { result: [] }
    })
    t.after(() => mock.close())

    config.rpc_url = mock.url
    _setRpcClient(_makeRpcClient())
    const spy = spyExecFile()
    t.after(() => spy.restore())

    await cron()
    const adds = spy.calls.filter(c => c.file === 'ipset' && c.args[0] === 'add')
    assert.equal(adds.length, 1, 'block_keywords=[Unknown] 必须直接 ban 未知客户端，不经过 noprogress 通道')
    assert.equal(adds[0].args[3], '198.51.100.5')
})

test('cron: block_keywords 不含 Unknown 时不会误封未知客户端（B2 反向）', async (t) => {
    _reset()
    config.block_keywords = ['XL']           // 不含 Unknown
    config.noprogress_keywords = ['NEVER']   // noprogress 也关掉

    const mock = await startMockAria2((req) => {
        if (req.method === 'aria2.tellActive') return { result: [{ gid: 'g' }] }
        if (req.method === 'system.multicall') {
            const calls = req.params[0]
            const results = calls.map(c => {
                if (c.methodName === 'aria2.tellStatus') return [{ numPieces: 100, pieceLength: 16384 }]
                if (c.methodName === 'aria2.getPeers') return [[
                    {
                        peerId: '%2D%2D%2D%2D%2D%2D%2D%2Ddeadbeefcafe',
                        ip: '198.51.100.6',
                        uploadSpeed: 1, downloadSpeed: 999, bitfield: 'ff'
                    }
                ]]
                return [null]
            })
            return { result: results }
        }
        return { result: [] }
    })
    t.after(() => mock.close())

    config.rpc_url = mock.url
    _setRpcClient(_makeRpcClient())
    const spy = spyExecFile()
    t.after(() => spy.restore())

    await cron()
    const adds = spy.calls.filter(c => c.file === 'ipset' && c.args[0] === 'add')
    assert.equal(adds.length, 0, '未配置 Unknown 时不应误封未知客户端')
})

// ---------- cron: noprogress 流程 ----------

test('cron: noprogress 计数器累积、不重置（部分 RPC 失败时）', async (t) => {
    _reset()
    config.noprogress_piece = 1
    config.noprogress_wait = 2
    config.scan_interval = 1000
    config.noprogress_keywords = ['XL']
    config.block_keywords = ['NEVER_MATCH']  // 让 noprogress 通道生效

    let mode = 'ok'
    const mock = await startMockAria2((req) => {
        if (req.method === 'aria2.tellActive') {
            return { result: [{ gid: 'gid-1' }] }
        }
        if (req.method === 'system.multicall') {
            if (mode === 'fail') {
                // 模拟 aria2 临时不通，业务错误
                return { error: { code: 1, message: 'simulated transient error' } }
            }
            const calls = req.params[0]
            const results = calls.map(c => {
                if (c.methodName === 'aria2.tellStatus') {
                    return [{ numPieces: 10, pieceLength: 1024 }]
                }
                if (c.methodName === 'aria2.getPeers') {
                    return [[
                        {
                            peerId: '%2DXL0012%2Dabcdef012345',
                            ip: '203.0.113.6',
                            uploadSpeed: 10240,    // 10KB/s
                            downloadSpeed: 0,
                            bitfield: '00'
                        }
                    ]]
                }
                return [null]
            })
            return { result: results }
        }
        return { result: [] }
    })
    t.after(() => mock.close())

    config.rpc_url = mock.url
    _setRpcClient(_makeRpcClient())
    const spy = spyExecFile()
    t.after(() => spy.restore())

    // 第一轮：累积上传 10240B，1024B/piece → 10 pieces，超过 noprogress_piece=1，wait += 1
    await cron()
    let banCalls = spy.calls.filter(c => c.file === 'ipset' && c.args[0] === 'add')
    assert.equal(banCalls.length, 0, '第 1 轮还不应该 ban')
    // 找 peer 状态
    const states = [...peerState.values()]
    assert.equal(states.length, 1)
    assert.equal(states[0].wait, 1)

    // 模拟一次 RPC 失败 —— wait 不应被重置
    mode = 'fail'
    await cron()
    const statesAfterFail = [...peerState.values()]
    assert.equal(statesAfterFail.length, 1, 'RPC 失败时不应清空 peerState')
    assert.equal(statesAfterFail[0].wait, 1, 'RPC 失败时 wait 计数必须保留（否则吸血 peer 永远封不上）')

    // 恢复，再扫一轮 → wait 应再 +1 = 2，仍未超阈值
    mode = 'ok'
    await cron()
    const states2 = [...peerState.values()]
    assert.equal(states2[0].wait, 2)
    banCalls = spy.calls.filter(c => c.file === 'ipset' && c.args[0] === 'add')
    assert.equal(banCalls.length, 0, '第 3 轮仍不应 ban（wait=2，阈值是 > 2）')

    // 再一轮 → wait=3，触发 ban
    await cron()
    banCalls = spy.calls.filter(c => c.file === 'ipset' && c.args[0] === 'add')
    assert.equal(banCalls.length, 1, '第 4 轮应触发 ban')
    assert.equal(banCalls[0].args[3], '203.0.113.6')
})

// ---------- cron: bitfield 有进度 → 不 ban ----------

test('cron: 上传中且 bitfield 有进度 → 不 ban', async (t) => {
    _reset()
    config.noprogress_keywords = ['XL']
    config.block_keywords = ['NEVER_MATCH']

    const mock = await startMockAria2((req) => {
        if (req.method === 'aria2.tellActive') return { result: [{ gid: 'g' }] }
        if (req.method === 'system.multicall') {
            const calls = req.params[0]
            const results = calls.map(c => {
                if (c.methodName === 'aria2.tellStatus') return [{ numPieces: 100, pieceLength: 1024 }]
                if (c.methodName === 'aria2.getPeers') return [[
                    {
                        peerId: '%2DXL0012%2Dabcdef012345',
                        ip: '203.0.113.7',
                        uploadSpeed: 99999,
                        downloadSpeed: 1024,
                        bitfield: 'ff'   // 8 pieces 已有
                    }
                ]]
                return [null]
            })
            return { result: results }
        }
        return { result: [] }
    })
    t.after(() => mock.close())

    config.rpc_url = mock.url
    _setRpcClient(_makeRpcClient())
    const spy = spyExecFile()
    t.after(() => spy.restore())

    await cron()
    const adds = spy.calls.filter(c => c.file === 'ipset' && c.args[0] === 'add')
    assert.equal(adds.length, 0, '对方有进度，绝不能 ban')
})

// ---------- cron: pieceLength 不可知 → 不 ban ----------

test('cron: pieceLength=0 → 跳过 noprogress 判定（避免兜底为 1 的灾难）', async (t) => {
    _reset()
    config.noprogress_keywords = ['XL']
    config.block_keywords = ['NEVER_MATCH']
    config.noprogress_piece = 5
    config.noprogress_wait = 1

    const mock = await startMockAria2((req) => {
        if (req.method === 'aria2.tellActive') return { result: [{ gid: 'g' }] }
        if (req.method === 'system.multicall') {
            const calls = req.params[0]
            const results = calls.map(c => {
                if (c.methodName === 'aria2.tellStatus') return [{ numPieces: 100 /* pieceLength 缺失 */ }]
                if (c.methodName === 'aria2.getPeers') return [[
                    {
                        peerId: '%2DXL0012%2Dabcdef012345',
                        ip: '203.0.113.8',
                        uploadSpeed: 999999,
                        downloadSpeed: 0,
                        bitfield: '00'
                    }
                ]]
                return [null]
            })
            return { result: results }
        }
        return { result: [] }
    })
    t.after(() => mock.close())

    config.rpc_url = mock.url
    _setRpcClient(_makeRpcClient())
    const spy = spyExecFile()
    t.after(() => spy.restore())

    // 多扫几轮，pieceLength 不可知时绝不应 ban
    for (let i = 0; i < 5; i++) await cron()
    const adds = spy.calls.filter(c => c.file === 'ipset' && c.args[0] === 'add')
    assert.equal(adds.length, 0)
})

// ---------- cron: isBlocked 命中 → 不发起 ipset add ----------

test('cron: 已在本地缓存中的 IP 不再调 ipset add（防 fork 风暴）', async (t) => {
    _reset()
    config.block_keywords = ['XL']
    config.timeout = 60

    // 预先 mark 这个 IP
    blockedIps.set('203.0.113.9', Date.now() + 60_000)

    const mock = await startMockAria2((req) => {
        if (req.method === 'aria2.tellActive') return { result: [{ gid: 'g' }] }
        if (req.method === 'system.multicall') {
            const calls = req.params[0]
            const results = calls.map(c => {
                if (c.methodName === 'aria2.tellStatus') return [{ numPieces: 100, pieceLength: 1024 }]
                if (c.methodName === 'aria2.getPeers') return [[
                    {
                        peerId: '%2DXL0012%2Dabcdef012345',
                        ip: '203.0.113.9',
                        uploadSpeed: 9999,
                        downloadSpeed: 0,
                        bitfield: '00'
                    }
                ]]
                return [null]
            })
            return { result: results }
        }
        return { result: [] }
    })
    t.after(() => mock.close())

    config.rpc_url = mock.url
    _setRpcClient(_makeRpcClient())
    const spy = spyExecFile()
    t.after(() => spy.restore())

    await cron()
    const adds = spy.calls.filter(c => c.file === 'ipset' && c.args[0] === 'add')
    assert.equal(adds.length, 0, '本地缓存命中时不应调 ipset')
})

// ---------- cron: 错误 secret → 业务错误正确抛出，不卡死 ----------

test('cron: RPC 业务错误（如 secret 错误）→ 重试计数 +1 但不崩', async (t) => {
    _reset()
    const mock = await startMockAria2(() => ({
        error: { code: 1, message: 'Unauthorized' }
    }))
    t.after(() => mock.close())

    config.rpc_url = mock.url
    config.secret = 'wrong'
    _setRpcClient(_makeRpcClient())
    const spy = spyExecFile()
    t.after(() => spy.restore())

    await cron()
    assert.equal(_internal._getFailures(), 1)
    await cron()
    assert.equal(_internal._getFailures(), 2)
    // 不应有 ipset 调用
    assert.equal(spy.calls.length, 0)
})

// ---------- cron: 没有活跃任务 → 不调 multicall ----------

test('cron: tellActive 返回空 → 不调 multicall、不 ban', async (t) => {
    _reset()
    let multicallCalls = 0
    const mock = await startMockAria2((req) => {
        if (req.method === 'aria2.tellActive') return { result: [] }
        if (req.method === 'system.multicall') { multicallCalls++; return { result: [] } }
        return { result: [] }
    })
    t.after(() => mock.close())

    config.rpc_url = mock.url
    _setRpcClient(_makeRpcClient())
    const spy = spyExecFile()
    t.after(() => spy.restore())

    await cron()
    assert.equal(multicallCalls, 0)
    assert.equal(spy.calls.length, 0)
    assert.equal(_internal._getFailures(), 0, '空任务不是失败')
})

// ---------- backoffDelay ----------

test('backoffDelay: 成功时 = scan_interval，失败时指数退避到上限', () => {
    _reset()
    config.scan_interval = 5000
    _internal._setFailures(0)
    assert.equal(_internal.backoffDelay(), 5000)
    _internal._setFailures(1)
    assert.equal(_internal.backoffDelay(), 10000)
    _internal._setFailures(2)
    assert.equal(_internal.backoffDelay(), 20000)
    _internal._setFailures(3)
    assert.equal(_internal.backoffDelay(), 40000)
    _internal._setFailures(10)  // 远超上限
    assert.equal(_internal.backoffDelay(), 60000, '应被 MAX_BACKOFF_DELAY 截断')
})

// ---------- scheduleNext: 回归测试 ----------

test('scheduleNext: 装的 timer 必须保持 refed（否则进程会静默退出被 s6 反复拉起）', () => {
    _reset()
    config.scan_interval = 5000
    try {
        _internal.scheduleNext()
        const t = _internal._getScanTimer()
        assert.ok(t, 'scheduleNext 应当装上 timer')
        // hasRef() 自 Node 11 起就有；如果将来真要 unref 必须把这条注释一起改了
        assert.equal(typeof t.hasRef, 'function')
        assert.equal(t.hasRef(), true,
            'scanTimer 不能 unref —— http.Agent 的 keep-alive idle socket 自带 unref，' +
            '若 scanTimer 再 unref，事件循环无 refed handle，Node 会安静 exit(0)，' +
            '在 docker s6 之类的进程管理器下会被反复拉起。')
    } finally {
        _internal._clearScanTimer()
    }
})

