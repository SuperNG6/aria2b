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
    iptablesBinaries,
    classifyFirewallError, describeBackendFailure, describeSetupFailure,
    reportBackendSwitch, reportIpv6Unavailable,
    pickIptablesBackendForVersion, sanitizeError,
    flushIptablesIpset, ensureIptablesRule, blockIp,
    runIdleMode, readIpsetSave,
    isBlocked,
    _reset, _getIdleHeartbeat
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

test('readIpsetSave: 给 ipset save 配置足够大的 maxBuffer（长期运行黑名单较大）', async (t) => {
    const original = runtime.execFile
    let captured = null
    runtime.execFile = async (file, args, opts) => {
        captured = { file, args: [...args], opts }
        return { stdout: 'create bt_blacklist hash:ip timeout 86400\n', stderr: '' }
    }
    t.after(() => { runtime.execFile = original })

    const out = await readIpsetSave()
    assert.equal(out, 'create bt_blacklist hash:ip timeout 86400\n')
    assert.equal(captured.file, 'ipset')
    assert.deepEqual(captured.args, ['save'])
    assert.ok(captured.opts.maxBuffer >= 16 * 1024 * 1024,
        `ipset save maxBuffer 应明显大于 Node 默认 1MB，实际 ${captured.opts.maxBuffer}`)
})

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
    // 重建 set —— 必须是 hash:ip + timeout，maxelem 与本地缓存上限一致（ipset 默认 65536），
    // 且 v4 不能含 family inet6
    assert.deepEqual(spy.calls[2], {
        file: 'ipset',
        args: ['create', 'bt_blacklist', 'hash:ip', 'timeout', '3600', 'maxelem', '200000']
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
        args: ['create', 'bt_blacklist6', 'hash:ip', 'timeout', '7200', 'maxelem', '200000', 'family', 'inet6']
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

// ---------- 子进程错误摘要 / 归类：日志一行说清，提示对症 ----------
// 以下 stderr 均为真实输出（群晖 DSM / Alpine 3.23 容器缺 NET_ADMIN）。
const NFT_SYNOLOGY = 'Warning: Extension set revision 0 not supported, missing kernel module?\n' +
    'iptables v1.8.11 (nf_tables): Could not fetch rule set generation id: Invalid argument\n'
const NFT_NO_NET_ADMIN = 'iptables v1.8.11 (nf_tables): Could not fetch rule set generation id: Permission denied (you must be root)\n'
const LEGACY_NO_NET_ADMIN = "iptables v1.8.11 (legacy): can't initialize iptables table `filter': Permission denied (you must be root)\n" +
    'Perhaps iptables or your kernel needs to be upgraded.\n'
const IP6_NO_SET_MATCH = "ip6tables v1.8.11 (legacy): Couldn't load match `set':No such file or directory\n\n" +
    "Try `ip6tables -h' or 'ip6tables --help' for more information.\n"

function execError(cmd, stderr) {
    return Object.assign(new Error(`Command failed: ${cmd}\n${stderr}`), { cmd, stderr, code: 2 })
}

function enoent(bin) {
    return Object.assign(new Error(`spawn ${bin} ENOENT`), { code: 'ENOENT', path: bin, cmd: `${bin} -L INPUT -n`, stderr: '' })
}

test('sanitizeError: 子进程错误压成一行，跳过 Warning / Perhaps / Try 附加行', () => {
    assert.equal(sanitizeError(execError('iptables -L INPUT -n', NFT_SYNOLOGY)),
        'iptables v1.8.11 (nf_tables): Could not fetch rule set generation id: Invalid argument')
    assert.equal(sanitizeError(execError('iptables-legacy -L INPUT -n', LEGACY_NO_NET_ADMIN)),
        "iptables v1.8.11 (legacy): can't initialize iptables table `filter': Permission denied (you must be root)")
    assert.equal(sanitizeError(execError('ip6tables-legacy -I INPUT', IP6_NO_SET_MATCH)),
        "ip6tables v1.8.11 (legacy): Couldn't load match `set':No such file or directory")
    assert.equal(sanitizeError(enoent('iptables-legacy')), '找不到命令 iptables-legacy')
    // 没有 stderr 时退回 message 第一行
    assert.equal(sanitizeError(Object.assign(new Error('Command failed: ipset save\n'), { cmd: 'ipset save', stderr: '' })),
        'Command failed: ipset save')
})

test('classifyFirewallError: 先判断权限，再区分 nft / xt_set / 缺命令', () => {
    assert.equal(classifyFirewallError(execError('iptables', NFT_SYNOLOGY)), 'nft')
    // 缺 NET_ADMIN 时 nft 后端同样报 generation id，必须归为权限问题，不能提示去装 iptables-legacy
    assert.equal(classifyFirewallError(execError('iptables', NFT_NO_NET_ADMIN)), 'permission')
    assert.equal(classifyFirewallError(execError('iptables-legacy', LEGACY_NO_NET_ADMIN)), 'permission')
    assert.equal(classifyFirewallError(execError('ipset save', 'ipset v7.24: Kernel error received: Operation not permitted\n')), 'permission')
    assert.equal(classifyFirewallError(execError('ip6tables-legacy', IP6_NO_SET_MATCH)), 'set-match')
    assert.equal(classifyFirewallError(enoent('iptables-legacy')), 'missing')
    assert.equal(classifyFirewallError(execError('ipset create', "ipset v7.24: Syntax error: '9' is out of range\n")), 'other')
    assert.equal(classifyFirewallError(null), 'other')
})

test('describeBackendFailure: 只在确实缺包时建议安装 iptables-legacy', () => {
    const noLegacy = describeBackendFailure('iptables', 'iptables-legacy',
        execError('iptables', NFT_SYNOLOGY), enoent('iptables-legacy'))
    assert.equal(noLegacy.installable, true)
    assert.match(noLegacy.reason, /不支持默认 iptables 使用的 nft 后端，镜像里也没有 iptables-legacy/)
    assert.match(noLegacy.fix, /apk add --no-cache iptables iptables-legacy ipset nodejs/)

    const noNetAdmin = describeBackendFailure('iptables', 'iptables-legacy',
        execError('iptables', NFT_NO_NET_ADMIN), execError('iptables-legacy', LEGACY_NO_NET_ADMIN))
    assert.equal(noNetAdmin.installable, false)
    assert.match(noNetAdmin.reason, /没有操作防火墙的权限/)
    assert.match(noNetAdmin.fix, /NET_ADMIN/)
    assert.doesNotMatch(noNetAdmin.fix, /iptables-legacy/)

    const unknown = describeBackendFailure('ip6tables', 'ip6tables-legacy',
        execError('ip6tables', 'boom\n'), execError('ip6tables-legacy', 'bang\n'))
    assert.equal(unknown.installable, false)
    assert.match(unknown.reason, /ip6tables：boom；ip6tables-legacy：bang/)
})

test('describeSetupFailure: 内核缺 xt_set 时说明容器内无法修复，不建议安装软件包', () => {
    iptablesBinaries.v6 = 'ip6tables-legacy'
    const r = describeSetupFailure(6, execError('ip6tables-legacy -I INPUT', IP6_NO_SET_MATCH))
    assert.match(r.reason, /当前内核不支持 ip6tables-legacy 的 ipset 匹配/)
    assert.doesNotMatch(r.fix, /apk add/)
    assert.match(describeSetupFailure(4, execError('ipset create', 'ipset v7.24: Syntax error\n')).reason, /^ipset v7.24: Syntax error$/)
})

// ---------- pickIptablesBackendForVersion: 探测 + 自动切换 legacy ----------

test('pickIptablesBackendForVersion(4): 默认 iptables 探测通过 → 不切换', async (t) => {
    const calls = []
    const original = runtime.execFile
    runtime.execFile = async (file, args) => {
        calls.push({ file, args: [...args] })
        return { stdout: '', stderr: '' }
    }
    t.after(() => { runtime.execFile = original })

    const { ok } = await pickIptablesBackendForVersion(4)
    assert.equal(ok, true)
    assert.equal(iptablesBinaries.v4, 'iptables', '默认能用就不切换')
    // 探测命令必须是 -L INPUT -n（不依赖 ipset / 额外模块的最小探针，且 -n 防 DNS 阻塞）
    assert.deepEqual(calls[0], { file: 'iptables', args: ['-L', 'INPUT', '-n'] })
    assert.equal(calls.length, 1, '默认通过就不该再探 legacy')
})

test('pickIptablesBackendForVersion(4): 默认 iptables 报 nft 错误 → 自动切到 iptables-legacy', async (t) => {
    const calls = []
    const original = runtime.execFile
    runtime.execFile = async (file, args) => {
        calls.push({ file, args: [...args] })
        if (file === 'iptables') {
            // 模拟群晖 DSM 4.x 上 nft 后端报错
            throw Object.assign(new Error('Could not fetch rule set generation id: Invalid argument'), {
                stderr: 'iptables v1.8.11 (nf_tables): Could not fetch rule set generation id'
            })
        }
        // iptables-legacy 探测通过
        return { stdout: '', stderr: '' }
    }
    t.after(() => { runtime.execFile = original })

    const r = await pickIptablesBackendForVersion(4)
    assert.equal(r.ok, true)
    assert.equal(r.switched, true)
    assert.equal(r.nftUnsupported, true)
    assert.equal(r.bin, 'iptables-legacy')
    assert.equal(iptablesBinaries.v4, 'iptables-legacy', '默认坏 + legacy 好 → 切到 legacy')
    // 两次探测：默认 → legacy
    assert.equal(calls[0].file, 'iptables')
    assert.equal(calls[1].file, 'iptables-legacy')
})

test('pickIptablesBackendForVersion(6): 默认坏 → 切到 ip6tables-legacy', async (t) => {
    const calls = []
    const original = runtime.execFile
    runtime.execFile = async (file, args) => {
        calls.push({ file, args: [...args] })
        if (file === 'ip6tables') {
            throw Object.assign(new Error('Could not fetch rule set generation id'), {
                stderr: 'nf_tables: generation id error'
            })
        }
        return { stdout: '', stderr: '' }
    }
    t.after(() => { runtime.execFile = original })

    const { ok } = await pickIptablesBackendForVersion(6)
    assert.equal(ok, true)
    assert.equal(iptablesBinaries.v6, 'ip6tables-legacy')
    // 关键：v6 探测不能误污染 v4（两个版本独立选）
    assert.equal(iptablesBinaries.v4, 'iptables')
})

test('pickIptablesBackendForVersion(4): 默认与 legacy 都报错 → 返回 false（IPv4 致命，上层退出）', async (t) => {
    const original = runtime.execFile
    runtime.execFile = async (_file, _args) => {
        throw Object.assign(new Error('boom'), { code: 'ENOENT' })
    }
    t.after(() => { runtime.execFile = original })

    const { ok } = await pickIptablesBackendForVersion(4)
    assert.equal(ok, false, '都不可用必须返回 ok=false 让上层进暂停状态')
    // 不应抛错（这是与"返回 false"的语义边界 —— 让 initial() 决定致命/降级）
})

test('pickIptablesBackendForVersion(6): 都不可用返回 false（IPv6 软降级路径）', async (t) => {
    const original = runtime.execFile
    runtime.execFile = async (_file, _args) => {
        throw new Error('ENOENT')
    }
    t.after(() => { runtime.execFile = original })

    const { ok } = await pickIptablesBackendForVersion(6)
    assert.equal(ok, false, '上层会据此 config.ipv6=false 软降级')
})

// ---------- 后端切换 / IPv6 未启用：能正常运行的情况只打普通提示 ----------

function captureConsole(fn) {
    const out = { log: [], warn: [], error: [] }
    const original = { log: console.log, warn: console.warn, error: console.error }
    for (const k of Object.keys(out)) console[k] = (...a) => out[k].push(a.join(' '))
    try { fn() } finally { Object.assign(console, original) }
    return out
}

test('reportBackendSwitch: 内核不支持 nft → 一行普通提示列出切换到的后端，不打警告', () => {
    const v4 = { ok: true, switched: true, nftUnsupported: true, bin: 'iptables-legacy' }
    const v6 = { ok: true, switched: true, nftUnsupported: true, bin: 'ip6tables-legacy' }
    const out = captureConsole(() => reportBackendSwitch([v4, v6]))
    assert.deepEqual(out.log, ['[aria2b] 检测到当前内核不支持 nft 防火墙后端，已切换到 iptables-legacy / ip6tables-legacy'])
    assert.deepEqual(out.warn, [])
    assert.deepEqual(out.error, [])

    // 没有切换（默认后端可用）或 IPv6 未探测时不打任何日志
    const quiet = captureConsole(() => reportBackendSwitch([{ ok: true, switched: false, bin: 'iptables' }, null]))
    assert.deepEqual(quiet.log, [])

    // 非 nft 原因的切换：说明默认后端的报错
    const other = captureConsole(() => reportBackendSwitch([{ ok: true, switched: true, nftUnsupported: false,
        bin: 'iptables-legacy', defaultBin: 'iptables', defaultError: '找不到命令 iptables' }]))
    assert.deepEqual(other.log, ['[aria2b] 默认的 iptables 无法使用（找不到命令 iptables），已切换到 iptables-legacy'])
})

test('reportIpv6Unavailable: 内核不支持只打普通提示；确实缺包才警告并给修复方法', () => {
    const kernel = captureConsole(() => reportIpv6Unavailable({
        reason: '当前内核不支持 ip6tables-legacy 的 ipset 匹配（xt_set）', fix: '容器内无法修复', installable: false }))
    assert.deepEqual(kernel.log, ['[aria2b] IPv6 封禁未启用：当前内核不支持 ip6tables-legacy 的 ipset 匹配（xt_set），仅启用 IPv4 封禁'])
    assert.deepEqual(kernel.warn, [])

    const missing = captureConsole(() => reportIpv6Unavailable({
        reason: '镜像里没有 ip6tables-legacy', fix: '在 Dockerfile 增加 apk add 后重启容器', installable: true }))
    assert.deepEqual(missing.log, [])
    assert.equal(missing.warn.length, 1)
    assert.match(missing.warn[0], /IPv6 封禁未启用（IPv4 不受影响）：镜像里没有 ip6tables-legacy。如需 IPv6 封禁，在 Dockerfile 增加 apk add 后重启容器。/)
})

// ---------- flushIptablesIpset 使用 iptablesBinaries 切换后的 binary ----------

test('flushIptablesIpset(4): 切换到 iptables-legacy 后调用的是 iptables-legacy 而非 iptables', async (t) => {
    iptablesBinaries.v4 = 'iptables-legacy'
    const spy = spyExecFile()
    t.after(() => spy.restore())

    await flushIptablesIpset(4)

    // 所有 iptables 子进程调用必须用 iptables-legacy
    const iptCalls = spy.calls.filter(c => c.file === 'iptables' || c.file === 'iptables-legacy')
    assert.ok(iptCalls.length > 0)
    assert.ok(iptCalls.every(c => c.file === 'iptables-legacy'),
        `切换后所有 iptables 调用都应走 legacy；实际：${JSON.stringify(iptCalls.map(c => c.file))}`)
})

test('ensureIptablesRule(6): 切换到 ip6tables-legacy 后 -C / -I 都走 legacy', async (t) => {
    iptablesBinaries.v6 = 'ip6tables-legacy'
    const calls = []
    const original = runtime.execFile
    runtime.execFile = async (file, args) => {
        calls.push({ file, args: [...args] })
        if (args[0] === '-C') throw Object.assign(new Error('no rule'), { code: 1 })
        return { stdout: '', stderr: '' }
    }
    t.after(() => { runtime.execFile = original })

    await ensureIptablesRule(6)

    assert.ok(calls.every(c => c.file === 'ip6tables-legacy'),
        '切换后 -C 和 -I 必须都走 ip6tables-legacy')
})

// ---------- runIdleMode: 启动阶段环境失败时进程保持存活，不退出 ----------
// 不变量 #15：aria2b 在 docker-aria2 镜像里是 s6-overlay v2 service，
// 退出会被 s6 反复重启 → crash-loop 拖垮容器。任何启动阶段不可恢复的环境问题
// （IPv4 后端不可用、ipset 缺失、未捕获异常等）都要走 idle mode，让进程静默存活，
// 同容器里 aria2c / AriaNg 继续工作。

test('runIdleMode: 装一个 refed setInterval 让进程不退出（防 s6 crash-loop）', (t) => {
    _reset()
    runIdleMode('test reason')
    const heartbeat = _getIdleHeartbeat()
    assert.ok(heartbeat, 'idle mode 必须装心跳 setInterval')
    // 这个 timer 必须是 refed（CLAUDE.md 第 1 条不变量同样适用 idle mode）：
    // setInterval 默认是 refed 的，hasRef() 应该返回 true。否则 keep-alive 池超时后
    // 事件循环会因无 refed handle 而退出，回到 crash-loop。
    assert.equal(typeof heartbeat.hasRef === 'function' ? heartbeat.hasRef() : true, true,
        'idle 心跳必须 refed，不能让进程静默退出')
    t.after(() => _reset())
})

test('runIdleMode: 幂等 —— 重复调用不会装多个心跳定时器（防泄漏）', (t) => {
    _reset()
    runIdleMode('first')
    const first = _getIdleHeartbeat()
    runIdleMode('second')
    const second = _getIdleHeartbeat()
    assert.strictEqual(first, second, '重复进入 idle mode 必须复用同一个心跳，避免泄漏')
    t.after(() => _reset())
})

test('runIdleMode: _reset 必须能清理 idle heartbeat，否则 node --test 无法退出', (t) => {
    _reset()
    runIdleMode('cleanup test')
    assert.ok(_getIdleHeartbeat())
    _reset()
    assert.equal(_getIdleHeartbeat(), null, '_reset 必须 clearInterval(idleHeartbeat) 否则测试进程挂死')
    t.after(() => _reset())
})

test('scheduleNext: idle mode 启用后不再调度 cron（防 cron 空跑拖资源）', (t) => {
    _reset()
    const { scheduleNext, _getScanTimer, _clearScanTimer } = _internal
    // 先确保正常状态下 scheduleNext 会装 timer
    scheduleNext()
    assert.ok(_getScanTimer(), '正常状态下 scheduleNext 应装 scanTimer')
    _clearScanTimer()

    runIdleMode('block cron')
    scheduleNext()
    assert.equal(_getScanTimer(), null, 'idle mode 一旦启用，scheduleNext 必须直接返回不再装 scanTimer')
    t.after(() => _reset())
})

test('runIdleMode: --flush 一次性 CLI 模式下 idle 触发应 exit(1) 而非保活（避免命令静默挂死）', (t) => {
    _reset()
    const { _setArgv } = _internal
    _setArgv({ flush: true })
    // monkey-patch process.exit 避免真的退出 + 验证调用
    const origExit = process.exit
    let exitCode = null
    process.exit = (code) => { exitCode = code }
    t.after(() => { process.exit = origExit; _setArgv({}); _reset() })

    runIdleMode('test reason')
    assert.equal(exitCode, 1, '--flush 模式失败必须 exit 1，不进 idle')
    assert.equal(_getIdleHeartbeat(), null, '--flush 模式下不能装 idle 心跳')
})
