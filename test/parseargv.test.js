'use strict'
/**
 * parseArgv 的边界与回归用例。
 *
 * 重点覆盖：
 * - B4 回归：纯数字字面量不应在解析阶段静默改值（前导 0 / 负号 / 小数）
 * - --key=value / --key value / --key（无值）/ short alias 四种形态
 * - 不应误把 `-` / `--` 当作 flag
 * - 后续 token 是 `-` 开头时不消费
 */
const test = require('node:test')
const assert = require('node:assert/strict')
const { _internal } = require('../app.js')

const { parseArgv, applyCliConfig, config, _reset, _setArgv } = _internal

test.beforeEach(() => _reset())

// ---------- B4 回归：纯数字字面量 ----------

test('parseArgv: 纯数字 secret 不应被转 Number 丢前导 0（B4 回归）', () => {
    const v = parseArgv(['-s', '001234'])
    assert.equal(v.secret, '001234', '纯数字字符串必须原样保留')
    assert.equal(typeof v.secret, 'string')
})

test('parseArgv: 单字符数字 secret 也不被转 Number', () => {
    assert.equal(parseArgv(['--secret', '0']).secret, '0')
    assert.equal(parseArgv(['--secret=0']).secret, '0')
})

test('parseArgv: 小数字符串原样保留', () => {
    assert.equal(parseArgv(['--scan-interval', '5.5'])['scan-interval'], '5.5')
})

test('parseArgv: 负数 token 因以 - 开头会被当作 flag（已知行为，记录）', () => {
    // `--timeout -1` 这种写法在 aria2b 不支持：-1 被当作 short flag。
    // 我们的数字配置都是正数，所以这是可接受的限制；写明在这避免误回归。
    const v = parseArgv(['--timeout', '-1'])
    assert.equal(v.timeout, true)
    assert.equal(v['1'], true)
})

test('applyCliConfig: --secret 001234 端到端不丢前导 0（B4 端到端）', () => {
    _setArgv(parseArgv(['--secret', '001234']))
    applyCliConfig()
    assert.equal(config.secret, '001234')
})

test('applyCliConfig: 非法数字字段（abc / 0）被忽略并保留默认', () => {
    _setArgv(parseArgv(['--timeout', 'abc', '--noprogress-piece', '0']))
    applyCliConfig()
    assert.equal(config.timeout, 86400)
    assert.equal(config.noprogress_piece, 5)
})

test('applyCliConfig: --key 不带值时 value=true 不应静默写入数字字段（B5 回归）', () => {
    // 旧版 parsePositiveInteger(true) → Number(true)=1 → isInteger → 写入 1
    _setArgv(parseArgv(['--noprogress-wait', '--noprogress-piece', '--timeout', '--scan-interval']))
    applyCliConfig()
    assert.equal(config.noprogress_wait, 10, '保留默认而不是变成 1')
    assert.equal(config.noprogress_piece, 5)
    assert.equal(config.timeout, 86400)
    assert.equal(config.scan_interval, 5000)
})

// ---------- 形态覆盖 ----------

test('parseArgv: --key=value 与 --key value 等价', () => {
    assert.deepEqual(parseArgv(['--url=http://x', '--secret=ab']), { _: [], url: 'http://x', secret: 'ab' })
    assert.deepEqual(parseArgv(['--url', 'http://x', '--secret', 'ab']), { _: [], url: 'http://x', secret: 'ab' })
})

test('parseArgv: --key 无值 / 末尾无值 → true', () => {
    assert.equal(parseArgv(['--flush']).flush, true)
    assert.equal(parseArgv(['--help']).help, true)
})

test('parseArgv: --key 后接 -开头 token 不被消费为 value', () => {
    const v = parseArgv(['--secret', '-s', 'real-secret'])
    // --secret 后跟 -s，不应吞 -s 当作 value；secret = true（无值）
    assert.equal(v.secret, 'real-secret', '后面的 -s 被解析为别名 secret，覆盖前一个')
    // 注意：这里 secret 被后一个 -s 覆盖。这是已知行为：后写的覆盖。
})

test('parseArgv: short alias 映射', () => {
    const v = parseArgv(['-c', '/etc/aria2.conf', '-u', 'http://x', '-s', 'tok', '-b', 'XL,SD', '-h', '-v'])
    assert.equal(v.config, '/etc/aria2.conf')
    assert.equal(v.url, 'http://x')
    assert.equal(v.secret, 'tok')
    assert.equal(v['block-keywords'], 'XL,SD')
    assert.equal(v.help, true)
    assert.equal(v.version, true)
})

test('parseArgv: -, --, 与非 flag token 进 _', () => {
    const v = parseArgv(['-', '--', 'plain-arg'])
    assert.deepEqual(v._, ['-', '--', 'plain-arg'])
})

test('parseArgv: 未知 short flag 当作 long key 处理（不抛）', () => {
    const v = parseArgv(['-Z', 'whatever'])
    assert.equal(v.Z, 'whatever')
})

test('parseArgv: --key= 空值', () => {
    const v = parseArgv(['--url='])
    assert.equal(v.url, '')
})

test('parseArgv: 重复 flag 后值覆盖前值', () => {
    const v = parseArgv(['--timeout', '100', '--timeout', '200'])
    assert.equal(v.timeout, '200')
})

test('parseArgv: 完全为空', () => {
    assert.deepEqual(parseArgv([]), { _: [] })
})

test('parseArgv: 非字符串元素被跳过', () => {
    // 防御性：node 通常不会把非字符串传进 process.argv，
    // 但 _setArgv 在测试里可能拿到任意输入
    const v = parseArgv(['--url', 'http://x', null, undefined, 42])
    assert.equal(v.url, 'http://x')
})
