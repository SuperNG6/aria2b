'use strict'
/**
 * ipset / iptables 路径单测（IPv4 + IPv6）。
 *
 * 通过替换 runtime.execFile 成 spy 来观察 flushIptablesIpset / blockIp
 * 到底用了哪个二进制、哪个 set 名、是否带 family inet6。
 * 重点是 IPv6 路径 —— cron 集成测试只覆盖了 IPv4。
 */
const test = require('node:test')
const assert = require('node:assert/strict')
const { _internal } = require('../app.js')

const {
    config, blockedIps, runtime,
    flushIptablesIpset, ensureIptablesRule, blockIp,
    isBlocked,
    _reset
} = _internal

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

function spyExecFileWithError(matcher, err) {
    const calls = []
    const original = runtime.execFile
    runtime.execFile = async (file, args) => {
        calls.push({ file, args: [...args] })
        if (matcher(file, args)) throw err
        return { stdout: '', stderr: '' }
    }
    return {
        calls,
        restore() { runtime.execFile = original }
    }
}

test.beforeEach(() => _reset())

// ---------- flushIptablesIpset(4) ----------

test('flushIptablesIpset(4): 使用 iptables + bt_blacklist，不带 family inet6', async (t) => {
    config.timeout = 3600
    const spy = spyExecFile()
    t.after(() => spy.restore())

    await flushIptablesIpset(4)

    // 清旧规则
    assert.deepEqual(spy.calls[0], {
        file: 'iptables',
        args: ['-D', 'INPUT', '-m', 'set', '--match-set', 'bt_blacklist', 'src', '-j', 'DROP']
    })
    assert.deepEqual(spy.calls[1], { file: 'ipset', args: ['destroy', 'bt_blacklist'] })
    // 重建 set —— 必须是 hash:ip + timeout，且 v4 不能含 family inet6
    assert.deepEqual(spy.calls[2], {
        file: 'ipset',
        args: ['create', 'bt_blacklist', 'hash:ip', 'timeout', '3600']
    })
    assert.ok(!spy.calls[2].args.includes('inet6'), 'IPv4 set 不应带 family inet6')
    // 装回 iptables 规则
    assert.deepEqual(spy.calls[3], {
        file: 'iptables',
        args: ['-I', 'INPUT', '-m', 'set', '--match-set', 'bt_blacklist', 'src', '-j', 'DROP']
    })
})

// ---------- flushIptablesIpset(6) ----------

test('flushIptablesIpset(6): 使用 ip6tables + bt_blacklist6 + family inet6', async (t) => {
    config.timeout = 7200
    const spy = spyExecFile()
    t.after(() => spy.restore())

    await flushIptablesIpset(6)

    assert.deepEqual(spy.calls[0], {
        file: 'ip6tables',
        args: ['-D', 'INPUT', '-m', 'set', '--match-set', 'bt_blacklist6', 'src', '-j', 'DROP']
    })
    assert.deepEqual(spy.calls[1], { file: 'ipset', args: ['destroy', 'bt_blacklist6'] })
    // v6 必须带 family inet6，否则 ipset 默认建出来的是 inet（IPv4）set
    assert.deepEqual(spy.calls[2], {
        file: 'ipset',
        args: ['create', 'bt_blacklist6', 'hash:ip', 'timeout', '7200', 'family', 'inet6']
    })
    assert.deepEqual(spy.calls[3], {
        file: 'ip6tables',
        args: ['-I', 'INPUT', '-m', 'set', '--match-set', 'bt_blacklist6', 'src', '-j', 'DROP']
    })
})

test('flushIptablesIpset(6): 首次运行时 -D / destroy 抛错应被吞掉，create / -I 仍执行', async (t) => {
    // 模拟首次启动：旧规则/旧 set 不存在
    const spy = spyExecFileWithError(
        (file, args) => (args[0] === '-D' || args[0] === 'destroy'),
        Object.assign(new Error('not exists'), { code: 1 })
    )
    t.after(() => spy.restore())

    await flushIptablesIpset(6)

    // 关键：create 与 -I 必须仍然被调用（吞错误的目的就是为了首次能成功）
    const createCall = spy.calls.find(c => c.file === 'ipset' && c.args[0] === 'create')
    assert.ok(createCall, 'create 必须执行')
    assert.ok(createCall.args.includes('inet6'))
    const insertCall = spy.calls.find(c => c.file === 'ip6tables' && c.args[0] === '-I')
    assert.ok(insertCall, 'ip6tables -I 必须执行')
})

test('flushIptablesIpset(6): 如果 create 失败应抛出（避免假装初始化成功）', async (t) => {
    const spy = spyExecFileWithError(
        (file, args) => file === 'ipset' && args[0] === 'create',
        Object.assign(new Error('boom'), { code: 1 })
    )
    t.after(() => spy.restore())

    await assert.rejects(() => flushIptablesIpset(6), /boom|unknown/)
})

// ---------- blockIp: IPv6 ----------

test('blockIp(IPv6): ipv6 启用时用 bt_blacklist6', async (t) => {
    config.ipv6 = true
    config.timeout = 600
    const spy = spyExecFile()
    t.after(() => spy.restore())

    await blockIp('2001:db8::1', { origin: 'XL', client: '', version: '' })

    const add = spy.calls.find(c => c.file === 'ipset' && c.args[0] === 'add')
    assert.ok(add, '应调用 ipset add')
    assert.deepEqual(add.args, ['add', '-exist', 'bt_blacklist6', '2001:db8::1', 'timeout', '600'])
    assert.equal(isBlocked('2001:db8::1'), true, 'IPv6 也应进本地缓存')
})

test('blockIp(IPv6): ipv6 禁用时直接跳过，不调 ipset', async (t) => {
    config.ipv6 = false
    const spy = spyExecFile()
    t.after(() => spy.restore())

    await blockIp('2001:db8::2', { origin: 'XL', client: '', version: '' })

    assert.equal(spy.calls.length, 0, 'IPv6 禁用时不应有任何 ipset 调用')
    assert.equal(isBlocked('2001:db8::2'), false, '也不应进本地缓存')
})

test('blockIp(IPv6): ::1 / fe80 等 IPv6 字面量都能识别', async (t) => {
    config.ipv6 = true
    const spy = spyExecFile()
    t.after(() => spy.restore())

    await blockIp('::1', { origin: 'XL' })
    await blockIp('fe80::abcd', { origin: 'XL' })

    const adds = spy.calls.filter(c => c.file === 'ipset' && c.args[0] === 'add')
    assert.equal(adds.length, 2)
    assert.equal(adds[0].args[2], 'bt_blacklist6')
    assert.equal(adds[1].args[2], 'bt_blacklist6')
})

// ---------- blockIp: IPv4 对照 + 无效 IP 防御 ----------

test('blockIp(IPv4): 用 bt_blacklist，与 IPv6 set 分开', async (t) => {
    config.ipv6 = true   // 即便 v6 也启用，IPv4 也不应被塞进 v6 set
    config.timeout = 300
    const spy = spyExecFile()
    t.after(() => spy.restore())

    await blockIp('203.0.113.10', { origin: 'XL' })

    const add = spy.calls.find(c => c.file === 'ipset' && c.args[0] === 'add')
    assert.equal(add.args[2], 'bt_blacklist')
    assert.equal(add.args[3], '203.0.113.10')
    assert.equal(add.args[5], '300')
})

test('blockIp: 无效 IP 字符串直接跳过', async (t) => {
    const spy = spyExecFile()
    t.after(() => spy.restore())

    await blockIp('not-an-ip', { origin: 'XL' })
    await blockIp('', { origin: 'XL' })

    assert.equal(spy.calls.length, 0)
})

// ---------- ensureIptablesRule: 自愈 ----------

test('ensureIptablesRule(4): 规则不存在时补装 iptables -I', async (t) => {
    // -C 失败 → 规则不存在 → 应补 -I
    const calls = []
    const original = runtime.execFile
    runtime.execFile = async (file, args) => {
        calls.push({ file, args: [...args] })
        if (args[0] === '-C') throw Object.assign(new Error('No chain/target/match'), { code: 1 })
        return { stdout: '', stderr: '' }
    }
    t.after(() => { runtime.execFile = original })

    const inserted = await ensureIptablesRule(4)
    assert.equal(inserted, true)

    const check = calls.find(c => c.file === 'iptables' && c.args[0] === '-C')
    assert.ok(check, '必须先用 -C 检查规则是否存在')
    assert.deepEqual(check.args.slice(1),
        ['INPUT', '-m', 'set', '--match-set', 'bt_blacklist', 'src', '-j', 'DROP'])

    const insert = calls.find(c => c.file === 'iptables' && c.args[0] === '-I')
    assert.ok(insert, '规则不存在时必须 -I 补装')
    assert.deepEqual(insert.args.slice(1),
        ['INPUT', '-m', 'set', '--match-set', 'bt_blacklist', 'src', '-j', 'DROP'])
})

test('ensureIptablesRule(4): 规则已存在时只检查、不重复 -I（幂等）', async (t) => {
    const calls = []
    const original = runtime.execFile
    runtime.execFile = async (file, args) => {
        calls.push({ file, args: [...args] })
        // -C 成功 → 规则存在
        return { stdout: '', stderr: '' }
    }
    t.after(() => { runtime.execFile = original })

    const inserted = await ensureIptablesRule(4)
    assert.equal(inserted, false, '规则已存在时返回 false')
    assert.equal(calls.length, 1, '只应调用 -C 一次，不应再 -I')
    assert.equal(calls[0].args[0], '-C')
})

test('ensureIptablesRule(6): 用 ip6tables + bt_blacklist6', async (t) => {
    const calls = []
    const original = runtime.execFile
    runtime.execFile = async (file, args) => {
        calls.push({ file, args: [...args] })
        if (args[0] === '-C') throw Object.assign(new Error('no rule'), { code: 1 })
        return { stdout: '', stderr: '' }
    }
    t.after(() => { runtime.execFile = original })

    await ensureIptablesRule(6)
    assert.ok(calls.every(c => c.file === 'ip6tables'), 'v6 必须用 ip6tables')
    assert.ok(calls.every(c => c.args.includes('bt_blacklist6')), 'v6 必须引用 bt_blacklist6')
})

// ---------- blockIp: ipset add 失败不污染本地缓存 ----------

test('blockIp: ipset add 失败不抛出，不污染本地缓存', async (t) => {
    config.ipv6 = true
    const spy = spyExecFileWithError(
        (file, args) => file === 'ipset' && args[0] === 'add',
        Object.assign(new Error('ipset busy'), { code: 1 })
    )
    t.after(() => spy.restore())

    // 不应抛
    await blockIp('2001:db8::ff', { origin: 'XL' })
    // ipset add 失败了 → 不该认为已封（否则 cron 下一轮命中本地缓存就不会重试）
    assert.equal(blockedIps.has('2001:db8::ff'), false)
})
