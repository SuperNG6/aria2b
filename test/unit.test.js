'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const { _internal } = require('../app.js')

const {
    decodePercentEncodedString, decodeClient, countOnes,
    parseList, parsePositiveInteger, parseBoolean,
    hasUnknownKeyword, keywordMatches,
    peerStateKey, parseConfigLine,
    isLocalHttpsRpcUrl, hasIpset,
    sanitizeError, maskSecret,
    isBlocked, rememberBlocked, cleanupBlockedIps,
    getPeerState, cleanupPeerState,
    syncBlockedIpsFromIpset,
    blockedIps, peerState, config,
    _reset
} = _internal

test.beforeEach(() => _reset())

// ---------- parseList ----------
test('parseList: 切分、去空白、过滤空项', () => {
    assert.deepEqual(parseList('a,b , c,,'), ['a', 'b', 'c'])
    assert.deepEqual(parseList('  XL ,SD'), ['XL', 'SD'])
    assert.deepEqual(parseList(''), [])
    assert.deepEqual(parseList(null), [])
    assert.deepEqual(parseList(undefined), [])
})

// ---------- parsePositiveInteger ----------
test('parsePositiveInteger: 仅接受正整数，其他返回 fallback', () => {
    assert.equal(parsePositiveInteger('10', 1), 10)
    assert.equal(parsePositiveInteger(10, 1), 10)
    assert.equal(parsePositiveInteger('0', 7), 7)
    assert.equal(parsePositiveInteger('-1', 7), 7)
    assert.equal(parsePositiveInteger('1.5', 7), 7)
    assert.equal(parsePositiveInteger('abc', 7), 7)
    assert.equal(parsePositiveInteger(undefined, 7), 7)
    assert.equal(parsePositiveInteger(null, 7), 7)
})

// ---------- parseBoolean ----------
test('parseBoolean: 兼容常见真假表示，否则 fallback', () => {
    assert.equal(parseBoolean('true'), true)
    assert.equal(parseBoolean('TRUE'), true)
    assert.equal(parseBoolean('1'), true)
    assert.equal(parseBoolean('on'), true)
    assert.equal(parseBoolean('yes'), true)
    assert.equal(parseBoolean('false'), false)
    assert.equal(parseBoolean('0'), false)
    assert.equal(parseBoolean('off'), false)
    assert.equal(parseBoolean('no'), false)
    assert.equal(parseBoolean(true), true)
    assert.equal(parseBoolean(false), false)
    assert.equal(parseBoolean(undefined, false), false)
    assert.equal(parseBoolean('', true), true)
    assert.equal(parseBoolean('weird', true), true)
    assert.equal(parseBoolean('weird', false), false)
})

// ---------- decodePercentEncodedString ----------
test('decodePercentEncodedString: 正常 / 异常 / 空', () => {
    assert.equal(decodePercentEncodedString(''), 'Unknown')
    assert.equal(decodePercentEncodedString(null), 'Unknown')
    assert.equal(decodePercentEncodedString('-XL0012-abc'), '-XL0012-abc')
    assert.equal(decodePercentEncodedString('A%2DB'), 'A-B')
    // %ZZ 不是合法 hex，原样保留
    assert.equal(decodePercentEncodedString('A%ZZB'), 'A%ZZB')
})

// ---------- decodeClient ----------
test('decodeClient: 只解码可打印 ASCII', () => {
    assert.equal(decodeClient('A%2DB'), 'A-B')        // - 可打印
    assert.equal(decodeClient('A%01B'), 'A%01B')      // SOH 不可打印
    assert.equal(decodeClient('A%7EB'), 'A~B')        // ~ 可打印
    assert.equal(decodeClient(null), '')
})

// ---------- countOnes ----------
test('countOnes: 数 bitfield 的 1 个数（per-nibble popcount）', () => {
    assert.equal(countOnes(''), 0)
    assert.equal(countOnes(null), 0)
    assert.equal(countOnes('0'), 0)
    assert.equal(countOnes('f'), 4)
    assert.equal(countOnes('ff'), 8)
    assert.equal(countOnes('ffff'), 16)
    assert.equal(countOnes('FFFF'), 16)
    assert.equal(countOnes('80'), 1)
    assert.equal(countOnes('0a'), 2)
    // 巨长 hex（旧版 BigInt 在某些场景下会出问题）
    const longHex = 'ff'.repeat(1000)
    assert.equal(countOnes(longHex), 8000)
})

// ---------- hasUnknownKeyword / keywordMatches ----------
test('hasUnknownKeyword: 大小写不敏感识别 Unknown', () => {
    assert.equal(hasUnknownKeyword(['XL', 'Unknown']), true)
    assert.equal(hasUnknownKeyword(['XL', 'unknown']), true)
    assert.equal(hasUnknownKeyword(['XL']), false)
})

test('keywordMatches: 子串匹配，但忽略 Unknown 关键字', () => {
    assert.equal(keywordMatches(['XL', 'SD'], '-XL0012-abc'), true)
    assert.equal(keywordMatches(['XL', 'SD'], '-UT3550-abc'), false)
    // 'Unknown' 永远不通过字符串匹配命中，得通过 hasUnknownKeyword + client==='unknown' 那条路径
    assert.equal(keywordMatches(['Unknown'], 'Unknown anything'), false)
    assert.equal(keywordMatches([], 'whatever'), false)
})

// ---------- peerStateKey ----------
test('peerStateKey: gid + peerId + ip 拼成的稳定 key', () => {
    const k1 = peerStateKey({ peerId: 'abc', ip: '1.2.3.4' }, 'gid1')
    const k2 = peerStateKey({ peerId: 'abc', ip: '1.2.3.4' }, 'gid1')
    const k3 = peerStateKey({ peerId: 'abc', ip: '1.2.3.5' }, 'gid1')
    const k4 = peerStateKey({ peerId: 'abc', ip: '1.2.3.4' }, 'gid2')
    assert.equal(k1, k2)
    assert.notEqual(k1, k3)
    assert.notEqual(k1, k4)
    // 空字段也得有 key
    assert.ok(peerStateKey({}, 'gid'))
})

// ---------- parseConfigLine ----------
test('parseConfigLine: 注释/空行返回 null，含等号则切分', () => {
    assert.equal(parseConfigLine(''), null)
    assert.equal(parseConfigLine('  '), null)
    assert.equal(parseConfigLine('# comment'), null)
    assert.equal(parseConfigLine('no-equal'), null)
    assert.deepEqual(parseConfigLine('rpc-secret=abc'), { key: 'rpc-secret', value: 'abc' })
    assert.deepEqual(parseConfigLine('  key = value with spaces  '), { key: 'key', value: 'value with spaces' })
    // 等号在值里要保留
    assert.deepEqual(parseConfigLine('ab-rpc-key=base64==contents'), { key: 'ab-rpc-key', value: 'base64==contents' })
})

// ---------- isLocalHttpsRpcUrl ----------
test('isLocalHttpsRpcUrl: 识别本地 https 的几种写法', () => {
    assert.equal(isLocalHttpsRpcUrl('https://127.0.0.1:6800/jsonrpc'), true)
    assert.equal(isLocalHttpsRpcUrl('https://127.5.5.5:6800/jsonrpc'), true)
    assert.equal(isLocalHttpsRpcUrl('https://localhost/jsonrpc'), true)
    assert.equal(isLocalHttpsRpcUrl('https://[::1]/jsonrpc'), true)
    assert.equal(isLocalHttpsRpcUrl('http://127.0.0.1:6800/jsonrpc'), false)
    assert.equal(isLocalHttpsRpcUrl('https://example.com/jsonrpc'), false)
    assert.throws(() => isLocalHttpsRpcUrl('not a url'))
})

test('isLocalHttpsRpcUrl: 防止 127.x 子域绕过（B3 安全回归）', () => {
    // 旧版用 host.startsWith('127.')，攻击者控制的 DNS 可让
    // https://127.0.0.1.evil.com/jsonrpc 被当成本地 → TLS 校验默认关闭。
    assert.equal(isLocalHttpsRpcUrl('https://127.0.0.1.evil.com/jsonrpc'), false,
        '127.0.0.1.evil.com 必须不被识别为本地')
    assert.equal(isLocalHttpsRpcUrl('https://127.0.0.1.attacker.test/'), false,
        '在合法 IPv4 后追加任意子域也不能算本地')
    // localhost 子域也不算
    assert.equal(isLocalHttpsRpcUrl('https://localhost.evil.com/jsonrpc'), false)
    // 但 127.x.y.z 整段都是合法 IPv4 → 应识别为本地
    assert.equal(isLocalHttpsRpcUrl('https://127.0.0.1/jsonrpc'), true)
    assert.equal(isLocalHttpsRpcUrl('https://127.255.255.255/jsonrpc'), true)
    // 类 IPv4 但非法的字符串：URL 解析层会拒绝（hostname 含 IPv4-shaped 前缀但带字母）
    // 这种情况由 new URL() 自身抛错，不会走到 startsWith 分支 —— 即便有 startsWith 也没机会触发
    assert.throws(() => isLocalHttpsRpcUrl('https://127a.0.0.1/jsonrpc'),
        /rpc url 格式不正确/, '类 IPv4 非法形态由 URL 解析直接拦下')
})

// ---------- hasIpset ----------
test('hasIpset: 精确匹配 create 行', () => {
    const out = [
        'create bt_blacklist hash:ip family inet timeout 86400',
        'add bt_blacklist 1.2.3.4 timeout 100',
        'create bt_blacklist6 hash:ip family inet6 timeout 86400'
    ].join('\n')
    assert.equal(hasIpset(out, 'bt_blacklist'), true)
    assert.equal(hasIpset(out, 'bt_blacklist6'), true)
    assert.equal(hasIpset(out, 'bt_blacklist_no'), false)
    // 不会被 add 行误命中
    assert.equal(hasIpset('add bt_blacklist 1.2.3.4', 'bt_blacklist'), false)
    assert.equal(hasIpset('', 'x'), false)
})

// ---------- sanitizeError ----------
test('sanitizeError: 不暴露请求体（防 secret 泄漏）', () => {
    // 模拟 axios 风格的 error，包含 config.data 含 token:secret
    const axiosLikeError = {
        message: 'Request failed',
        code: 'ECONNREFUSED',
        address: '127.0.0.1',
        port: 6800,
        config: { data: JSON.stringify({ params: ['token:SECRET_TOKEN'] }) }
    }
    const out = sanitizeError(axiosLikeError)
    assert.ok(typeof out === 'string')
    assert.ok(!out.includes('SECRET_TOKEN'), `不应含 secret，实际：${out}`)
    assert.ok(out.includes('127.0.0.1'))

    assert.equal(sanitizeError(null), 'unknown error')
    assert.equal(sanitizeError('plain string'), 'plain string')
    assert.equal(sanitizeError({ code: 'ETIMEDOUT' }), 'RPC 请求超时')
    assert.ok(sanitizeError({ response: { status: 401, statusText: 'Unauthorized' } }).includes('401'))
})

// ---------- maskSecret ----------
test('maskSecret: 只露首尾字符', () => {
    assert.equal(maskSecret(''), '')
    assert.equal(maskSecret('a'), 'a')
    assert.equal(maskSecret('ab'), 'ab')
    assert.equal(maskSecret('yourtoken'), 'y*******n')
    assert.equal(maskSecret('1234567890abcdef'), '1**************f')
})

// ---------- 状态管理 ----------
test('blockedIps: 记忆 / 过期 / 清理', () => {
    config.timeout = 1 // 1 秒
    rememberBlocked('1.1.1.1')
    assert.equal(isBlocked('1.1.1.1'), true)
    // 强制让其过期
    blockedIps.set('1.1.1.1', Date.now() - 1)
    assert.equal(isBlocked('1.1.1.1'), false, '过期后应自动从 Map 中移除')
    assert.equal(blockedIps.has('1.1.1.1'), false)

    // cleanupBlockedIps 批量清理
    blockedIps.set('a', Date.now() - 1)
    blockedIps.set('b', Date.now() + 60_000)
    cleanupBlockedIps()
    assert.equal(blockedIps.has('a'), false)
    assert.equal(blockedIps.has('b'), true)
})

test('peerState: 获取 / 累积 / 清理', () => {
    const s1 = getPeerState('k1')
    s1.uploaded += 100
    s1.wait += 1

    const s2 = getPeerState('k1')
    assert.equal(s2.uploaded, 100, '同一个 key 应拿到同一对象')
    assert.equal(s2.wait, 1)

    getPeerState('k2')
    getPeerState('k3')
    assert.equal(peerState.size, 3)

    cleanupPeerState(new Set(['k1']))
    assert.equal(peerState.has('k1'), true)
    assert.equal(peerState.has('k2'), false)
    assert.equal(peerState.has('k3'), false)
})

// ---------- syncBlockedIpsFromIpset ----------
test('syncBlockedIpsFromIpset: 从 ipset save 同步已封 IP', () => {
    const save = [
        'create bt_blacklist hash:ip family inet timeout 86400',
        'add bt_blacklist 1.2.3.4 timeout 1000',
        'add bt_blacklist 5.6.7.8 timeout 2000',
        'create bt_blacklist6 hash:ip family inet6 timeout 86400',
        'add bt_blacklist6 ::1 timeout 500',
        'add other_set 9.9.9.9 timeout 100',          // 其他 set 应忽略
        'add bt_blacklist notanip timeout 100',       // 非法 IP 应忽略
        'add bt_blacklist 8.8.8.8'                    // 没 timeout 字段，用 config.timeout
    ].join('\n')
    const n = syncBlockedIpsFromIpset(save)
    assert.equal(n, 4)
    assert.equal(isBlocked('1.2.3.4'), true)
    assert.equal(isBlocked('5.6.7.8'), true)
    assert.equal(isBlocked('::1'), true)
    assert.equal(isBlocked('9.9.9.9'), false)
    assert.equal(isBlocked('notanip'), false)
    assert.equal(isBlocked('8.8.8.8'), true)
})
