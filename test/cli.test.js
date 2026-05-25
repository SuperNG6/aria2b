'use strict'
/**
 * 子进程 smoke test：保证 `node app.js -h` / `-v` 真的能跑起来。
 * 这能挡住 require/语法/启动早期类的回归（比如 v1.10.1 那个 ASI bug）。
 */
const test = require('node:test')
const assert = require('node:assert/strict')
const path = require('node:path')
const { spawnSync } = require('node:child_process')

const APP = path.resolve(__dirname, '..', 'app.js')

function run(args) {
    return spawnSync(process.execPath, [APP, ...args], { encoding: 'utf8', timeout: 10_000 })
}

test('app.js -h: 退出码 0 且输出 usage', () => {
    const r = run(['-h'])
    assert.equal(r.status, 0, `stderr: ${r.stderr}`)
    assert.match(r.stdout, /aria2b v/)
    assert.match(r.stdout, /--scan-interval/)
    assert.match(r.stdout, /--rpc-no-verify/)
})

test('app.js -v: 退出码 0 且输出版本号', () => {
    const r = run(['-v'])
    assert.equal(r.status, 0, `stderr: ${r.stderr}`)
    assert.match(r.stdout, /aria2b v/)
})

test('app.js --help / --version 别名同样可用', () => {
    assert.equal(run(['--help']).status, 0)
    assert.equal(run(['--version']).status, 0)
})

test('app.js --flush -c 指向不存在文件: 退出码非 0 且不继续默认启动', () => {
    const missing = path.join(__dirname, '__definitely_missing_aria2.conf')
    const r = run(['--flush', '-c', missing])
    assert.equal(r.status, 1, `stdout: ${r.stdout}\nstderr: ${r.stderr}`)
    assert.match(r.stderr, /显式指定的配置文件不可用/)
    assert.match(r.stderr, /--flush 失败/)
    assert.doesNotMatch(r.stderr, /ipset 不可用/,
        '显式配置文件读取失败应在触碰 ipset 前停止，避免容器里误操作或误导用户')
})
