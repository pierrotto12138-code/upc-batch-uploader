/* 纯逻辑自测：node row-delete/selftest.js
 * content.js 在 Node 里不启动 UI，只把纯函数挂到 globalThis.__UPC_ROW_DELETE__。
 */
const assert = require('assert')
require('./content.js')
const R = globalThis.__UPC_ROW_DELETE__

let passed = 0
function test(name, fn) {
  fn()
  passed++
  console.log('  ok  ' + name)
}

console.log('upcshare 资料库删除 · 逻辑自测')

test('从下载链接里取文件 ID', () => {
  assert.strictEqual(R.fileIdFromHref('/api/download/abc123'), 'abc123')
  assert.strictEqual(R.fileIdFromHref('https://in.upcshare.cn/api/download/ab%2Fcd'), 'ab/cd')
  assert.strictEqual(R.fileIdFromHref('/api/download/abc123?x=1#y'), 'abc123')
  assert.strictEqual(R.fileIdFromHref('/api/download/'), '')
  assert.strictEqual(R.fileIdFromHref('/api/files/abc'), '')
  assert.strictEqual(R.fileIdFromHref(null), '')
})

test('只有管理员能看到删除入口', () => {
  assert.strictEqual(R.canDelete({ logged_in: true, is_admin: true }), true)
  assert.strictEqual(R.canDelete({ is_admin: true }), true)
  assert.strictEqual(R.canDelete({ logged_in: false, is_admin: true }), false)
  assert.strictEqual(R.canDelete({ logged_in: true, is_admin: false }), false)
  assert.strictEqual(R.canDelete({}), false)
  assert.strictEqual(R.canDelete(null), false)
})

test('两段式状态机：点同一行才删，换行只换待确认对象', () => {
  assert.deepStrictEqual(R.nextArm(null, 'a'), { next: 'a', action: 'arm' })
  assert.deepStrictEqual(R.nextArm('a', 'a'), { next: null, action: 'delete' })
  assert.deepStrictEqual(R.nextArm('a', 'b'), { next: 'b', action: 'arm' })
})

test('文件名兜底与提示文案', () => {
  assert.strictEqual(R.fileLabel('试卷.pdf', 'abc'), '试卷.pdf')
  assert.strictEqual(R.fileLabel('   ', 'abc'), '文件 abc')
  assert.strictEqual(R.fileLabel('', 'abc'), '文件 abc')
  assert.strictEqual(R.deletedMessage('试卷.pdf'), '已删除：试卷.pdf')
})

test('删除失败的提示带上状态码', () => {
  assert.strictEqual(R.errorMessage(403), '没有删除权限（HTTP 403），请确认登录的是管理员账号')
  assert.strictEqual(R.errorMessage(401), '没有删除权限（HTTP 401），请确认登录的是管理员账号')
  assert.strictEqual(R.errorMessage(500), '删除失败（HTTP 500），请稍后再试')
  assert.strictEqual(R.errorMessage(0), '删除失败：网络中断，请稍后再试')
})

console.log(`\n${passed} 项全过`)
