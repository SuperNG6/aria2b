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
