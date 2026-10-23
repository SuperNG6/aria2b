'use strict'
/**
 * 配置加载相关测试：CLI 解析、aria2.conf 寄生、TLS 默认行为
 */
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { _internal } = require('../app.js')

const {
    config, parseArgv, applyCliConfig, applyNoVerify, loadConfigFromAria2File,
    _reset, _setArgv
} = _internal

test.beforeEach(() => _reset())

// ---------- CLI 解析基础 ----------

test('parseArgv: alias 与基础选项', () => {
    const v = parseArgv(['-u', 'http://x/jsonrpc', '-s', 'tok', '-b', 'AA,BB'])
    assert.equal(v.url, 'http://x/jsonrpc')
    assert.equal(v.secret, 'tok')
    assert.equal(v['block-keywords'], 'AA,BB')

    assert.equal(parseArgv(['--help']).help, true)
    assert.equal(parseArgv(['--version']).version, true)
    assert.equal(parseArgv(['--rpc-no-verify', 'false'])['rpc-no-verify'], 'false')
    // parseArgv 不再做数字强转：value 始终是 string（避免 --secret 001234
    // 在解析阶段丢失前导 0）。数字字段由 applyPositiveIntegerConfig 转。
    assert.equal(parseArgv(['--scan-interval', '2000'])['scan-interval'], '2000')
})

// ---------- applyNoVerify ----------

test('applyNoVerify: --rpc-no-verify 各种取值正确映射到 rejectUnauthorized', () => {
    _reset(); applyNoVerify('true');   assert.equal(config.rpc_options.rejectUnauthorized, false)
    _reset(); applyNoVerify('false');  assert.equal(config.rpc_options.rejectUnauthorized, true)
    _reset(); applyNoVerify('1');      assert.equal(config.rpc_options.rejectUnauthorized, false)
    _reset(); applyNoVerify('0');      assert.equal(config.rpc_options.rejectUnauthorized, true)
    _reset(); applyNoVerify(true);     assert.equal(config.rpc_options.rejectUnauthorized, false)
    _reset(); applyNoVerify(false);    assert.equal(config.rpc_options.rejectUnauthorized, true)
    // 空值按 fallback=true 处理（即 noVerify=true，rejectUnauthorized=false）
    _reset(); applyNoVerify('');       assert.equal(config.rpc_options.rejectUnauthorized, false)
    _reset(); applyNoVerify(undefined); assert.equal(config.rpc_options.rejectUnauthorized, false)
})

// ---------- applyCliConfig 综合 ----------

test('applyCliConfig: 各 CLI 项正确写入 config', () => {
    _setArgv(parseArgv([
        '-u', 'http://example/jsonrpc',
        '-s', 'mysecret',
        '-b', 'XL,SD',
        '--noprogress-keywords', 'XL,Unknown',
        '--noprogress-piece', '7',
        '--noprogress-wait',  '15',
        '--timeout', '3600',
        '--scan-interval', '2000'
    ]))
    applyCliConfig()
    assert.equal(config.rpc_url, 'http://example/jsonrpc')
    assert.equal(config.secret, 'mysecret')
    assert.deepEqual(config.block_keywords, ['XL', 'SD'])
    assert.deepEqual(config.noprogress_keywords, ['XL', 'Unknown'])
    assert.equal(config.noprogress_piece, 7)
    assert.equal(config.noprogress_wait, 15)
    assert.equal(config.timeout, 3600)
    assert.equal(config.scan_interval, 2000)
})

test('applyCliConfig: --rpc-no-verify 不再因 ASI bug 而崩溃（核心回归）', () => {
    // 这是 v1.10.1 中 app.js:393 的关键回归点：
    //   if (argv['rpc-no-verify'] !== undefined) applyNoVerify(...)['ca','cert','key'].forEach(...)
    // 旧版给 --rpc-no-verify 时会抛 TypeError；不给时整段 TLS forEach 被吞。
    // 新版必须既不崩，也始终能处理 TLS 物料。

    _reset()
    _setArgv(parseArgv(['--rpc-no-verify', 'true']))
    assert.doesNotThrow(() => applyCliConfig())
    assert.equal(config.rpc_options.rejectUnauthorized, false)

    _reset()
    _setArgv(parseArgv(['--rpc-no-verify', 'false', '-u', 'http://x/jsonrpc']))
    assert.doesNotThrow(() => applyCliConfig())
    assert.equal(config.rpc_options.rejectUnauthorized, true)
})

test('applyCliConfig: 本地 https 默认关验证，但显式 --rpc-no-verify=false 时尊重用户', () => {
    _reset()
    _setArgv(parseArgv(['-u', 'https://127.0.0.1:6800/jsonrpc']))
    applyCliConfig()
    assert.equal(config.rpc_options.rejectUnauthorized, false, '本地 https 默认应关验证')

    _reset()
    _setArgv(parseArgv(['-u', 'https://127.0.0.1:6800/jsonrpc', '--rpc-no-verify', 'false']))
    applyCliConfig()
    assert.equal(config.rpc_options.rejectUnauthorized, true, '用户显式 no-verify=false 时应保留验证')

    _reset()
    _setArgv(parseArgv(['-u', 'https://example.com/jsonrpc']))
    applyCliConfig()
    assert.equal(config.rpc_options.rejectUnauthorized, true, '远端 https 应保留验证')
})

test('applyCliConfig: TLS 物料 forEach 必然执行（不再被 ASI 吞掉）', () => {
    // 通过给一个不存在的 ca 路径，确认 forEach 真的跑到了 readTlsMaterial
    _reset()
    _setArgv(parseArgv(['--rpc-ca', '/definitely/not/a/path/and/not/base64']))
    assert.throws(
        () => applyCliConfig(),
        /rpc-ca 指向的文件不存在/,
        'forEach 必然执行：非法 ca 应抛错'
    )
})

test('applyCliConfig: timeout 超过 ipset 上限 2147483 时夹到上限（CLI 与配置文件）', () => {
    const originalWarn = console.warn
    console.warn = () => {}
    try {
        _reset()
        _setArgv(parseArgv(['--timeout', '2592000']))
        applyCliConfig()
        assert.equal(config.timeout, 2147483)

        _reset()
        _setArgv(parseArgv(['--timeout', '2147483']))
        applyCliConfig()
        assert.equal(config.timeout, 2147483, '恰好等于上限时不改')

        const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aria2b-test-'))
        try {
            const cfgPath = path.join(tmpDir, 'aria2.conf')
            fs.writeFileSync(cfgPath, 'ab-bt-ban-timeout=99999999\n')
            _reset()
            _setArgv(parseArgv([]))
            loadConfigFromAria2File(cfgPath)
            applyCliConfig()
            assert.equal(config.timeout, 2147483)
        } finally {
            fs.rmSync(tmpDir, { recursive: true, force: true })
        }
    } finally {
        console.warn = originalWarn
    }
})

test('applyCliConfig: 字符串参数缺值时忽略并警告，不写入 "true"', () => {
    const warnings = []
    const originalWarn = console.warn
    console.warn = (...a) => warnings.push(a.join(' '))
    try {
        _reset()
        config.secret = 'from-conf'
        _setArgv(parseArgv(['--secret', '-b', '--noprogress-keywords', '-u', '--rpc-ca']))
        applyCliConfig()
    } finally {
        console.warn = originalWarn
    }
    assert.equal(config.secret, 'from-conf')
    assert.deepEqual(config.block_keywords, ['XL', 'SD', 'XF', 'QD', 'BN'])
    assert.deepEqual(config.noprogress_keywords, ['XL', 'SD', 'XF', 'QD', 'BN', 'Unknown'])
    assert.equal(config.rpc_url, 'http://127.0.0.1:6800/jsonrpc')
    assert.equal(config.rpc_options.ca, undefined)
    for (const name of ['secret', 'block-keywords', 'noprogress-keywords', 'url', 'rpc-ca']) {
        assert.ok(warnings.some(w => w.includes(`--${name} 缺少参数值`)), `应警告 --${name}`)
    }
})

test('applyCliConfig: --secret= 显式空值仍然生效', () => {
    _reset()
    config.secret = 'from-conf'
    _setArgv(parseArgv(['--secret=']))
    applyCliConfig()
    assert.equal(config.secret, '')
})

test('applyCliConfig: scan-interval 限幅 [1000, 60000]', () => {
    _reset()
    _setArgv(parseArgv(['--scan-interval', '100']))
    applyCliConfig()
    assert.equal(config.scan_interval, 1000)

    _reset()
    _setArgv(parseArgv(['--scan-interval', '999999']))
    applyCliConfig()
    assert.equal(config.scan_interval, 60000)
})

// ---------- loadConfigFromAria2File ----------

test('loadConfigFromAria2File: 寄生读取 aria2 conf', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aria2b-test-'))
    const cfgPath = path.join(tmpDir, 'aria2.conf')
    fs.writeFileSync(cfgPath, [
        '# 这是注释',
        'rpc-secret=hello-secret',
        'rpc-listen-port=16800',
        'rpc-secure=true',
        'ab-bt-ban-client-keywords=XL,SD,XF',
        'ab-bt-noprogress-keywords=XL,Unknown',
        'ab-bt-noprogress-piece=8',
        'ab-bt-noprogress-wait=12',
        'ab-bt-ban-timeout=7200',
        'ab-bt-scan-interval=3000',
        'ab-rpc-no-verify=true',
        '',
        '# 含等号的 base64 值不能被 split 截断',
        'ab-rpc-key=base64==value=='
    ].join('\n'))

    try {
        const ok = loadConfigFromAria2File(cfgPath)
        assert.equal(ok, true)
        assert.equal(config.secret, 'hello-secret')
        assert.equal(config.rpc_url, 'https://127.0.0.1:16800/jsonrpc')
        assert.deepEqual(config.block_keywords, ['XL', 'SD', 'XF'])
        assert.deepEqual(config.noprogress_keywords, ['XL', 'Unknown'])
        assert.equal(config.noprogress_piece, 8)
        assert.equal(config.noprogress_wait, 12)
        assert.equal(config.timeout, 7200)
        assert.equal(config.scan_interval, 3000)
        assert.equal(config.rpc_options.rejectUnauthorized, false)
        assert.equal(config.rpc_options.key, 'base64==value==')
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true })
    }
})

test('loadConfigFromAria2File: disable-ipv6 只能关闭 IPv6，不能覆盖系统探测结果强制开启', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aria2b-test-'))
    const cfgPath = path.join(tmpDir, 'aria2.conf')
    const load = (ipv6Detected, line) => {
        _reset()
        config.ipv6 = ipv6Detected   // initial() 先 detectIpv6Enabled() 再读配置
        fs.writeFileSync(cfgPath, line)
        loadConfigFromAria2File(cfgPath)
        return config.ipv6
    }
    try {
        // aria2 默认就是 disable-ipv6=false；主机没有 IPv6 时不能因此去跑 ip6tables
        assert.equal(load(false, 'disable-ipv6=false'), false)
        assert.equal(load(true, 'disable-ipv6=false'), true)
        assert.equal(load(true, 'disable-ipv6=true'), false)
        assert.equal(load(false, 'disable-ipv6=true'), false)
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true })
    }
})

test('loadConfigFromAria2File: 文件不存在 → 返回 false 不抛', () => {
    assert.equal(loadConfigFromAria2File('/no/such/path/aria2.conf'), false)
})

test('loadConfigFromAria2File: 非法值被忽略并保留默认', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aria2b-test-'))
    const cfgPath = path.join(tmpDir, 'aria2.conf')
    fs.writeFileSync(cfgPath, [
        'ab-bt-noprogress-piece=abc',
        'ab-bt-ban-timeout=-5',
        'ab-bt-scan-interval=0'
    ].join('\n'))
    try {
        loadConfigFromAria2File(cfgPath)
        assert.equal(config.noprogress_piece, 5)
        assert.equal(config.timeout, 86400)
        assert.equal(config.scan_interval, 5000)
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true })
    }
})
