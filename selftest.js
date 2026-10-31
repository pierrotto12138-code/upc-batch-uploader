/* 纯逻辑自测：node selftest.js
 * content.js 在 Node 里不会启动 UI，只把纯函数挂到 globalThis.__UPC_BATCH__。
 */
const assert = require('assert')
require('./content.js')
const B = globalThis.__UPC_BATCH__

let passed = 0
function test(name, fn) {
  fn()
  passed++
  console.log('  ok  ' + name)
}

console.log('upcshare 批量投递 · 逻辑自测')

test('扩展名识别（大小写不敏感）', () => {
  assert.strictEqual(B.extOf('A.PDF'), '.pdf')
  assert.strictEqual(B.extOf('noext'), '')
  assert.strictEqual(B.isAllowedName('课件.pptx'), true)
  assert.strictEqual(B.isAllowedName('视频.mp4'), false)
})

test('非法文件名拦截', () => {
  assert.strictEqual(B.hasBadName('a<b.pdf'), true)
  assert.strictEqual(B.hasBadName('..\\evil.pdf'), true)
  assert.strictEqual(B.hasBadName(''), true)
  assert.strictEqual(B.hasBadName('正常 文件.pdf'), false)
})

test('体积格式化', () => {
  assert.strictEqual(B.formatSize(0), '0 B')
  assert.strictEqual(B.formatSize(1024), '1.0 KB')
  assert.strictEqual(B.formatSize(1024 * 1024 * 3.5), '3.5 MB')
})

test('学科名归一化匹配', () => {
  assert.ok(B.matchScore('高等数学 2-2', '高等数学2-2') >= 60)
  assert.ok(B.matchScore('高数', '高等数学2-2') < 60, '短名字不该硬匹配')
  const hit = B.bestCategory('高等数学2-2', ['高等数学2-2', '线性代数'])
  assert.strictEqual(hit.name, '高等数学2-2')
  assert.strictEqual(B.bestCategory('完全没听过的课', ['高等数学2-2']), null)
})

const CATS = ['高等数学2-2', '大学物理', '数据结构']

test('路径折算：根目录就是课程', () => {
  const r = B.splitRelativePath('高等数学2-2/期末试卷/2024期末.pdf', CATS)
  assert.deepStrictEqual(r, { category: '高等数学2-2', subCategory: '期末试卷', source: 'matched' })
})

test('路径折算：根目录是总目录，第二层才是课程', () => {
  const r = B.splitRelativePath('我的课程资料/大学物理/实验报告/实验一.pdf', CATS)
  assert.deepStrictEqual(r, { category: '大学物理', subCategory: '实验报告', source: 'matched' })
})

test('路径折算：没有命中已有学科时按层数猜', () => {
  assert.strictEqual(
    B.splitRelativePath('某新课/课件/a.pdf', CATS).category, '某新课')
  const deep = B.splitRelativePath('总目录/某新课/课件/第一章/a.pdf', CATS)
  assert.strictEqual(deep.category, '某新课')
  assert.strictEqual(deep.subCategory, '课件/第一章')
})

test('路径折算：站内没有的课程名也能把根目录当课程', () => {
  const r = B.splitRelativePath('工业现场总线技术/附件/实验视频/a.mp4', CATS)
  assert.strictEqual(r.category, '工业现场总线技术')
  assert.strictEqual(r.subCategory, '附件/实验视频')
  const r2 = B.splitRelativePath('精密机械设计基础/附件/汇报/a.mp4', CATS)
  assert.strictEqual(r2.category, '精密机械设计基础')
  assert.strictEqual(r2.subCategory, '附件/汇报')
})

test('路径折算：单层与扁平', () => {
  assert.strictEqual(B.splitRelativePath('线性代数/笔记.pdf', CATS).category, '线性代数')
  assert.deepStrictEqual(
    B.splitRelativePath('裸文件.pdf', CATS), { category: '', subCategory: '', source: 'flat' })
})

test('分组：同一学科+目录合并成一行', () => {
  const groups = B.buildGroups([
    { relPath: '高数/期末试卷/a.pdf', name: 'a.pdf', size: 1 },
    { relPath: '高数/期末试卷/b.pdf', name: 'b.pdf', size: 2 },
    { relPath: '高数/课件/c.pdf', name: 'c.pdf', size: 3 }
  ], ['高数'])
  assert.strictEqual(groups.length, 2)
  assert.strictEqual(groups[0].files.length, 2)
})

test('查重：同名同大小算重复，同名不同大小算可疑', () => {
  const index = { byKey: { [B.dedupeKey('a.pdf', 100, '高数/期末')]: true }, byName: {} }
  assert.strictEqual(B.classify({ name: 'a.pdf', size: 100 }, index, '高数/期末'), 'dup')
  assert.strictEqual(B.classify({ name: 'a.pdf', size: 100 }, index, '大物/课件'), 'ready')
  assert.strictEqual(B.classify({ name: 'a.pdf', size: 200 }, index, '高数/期末'), 'ready')
  const byName = { byKey: {}, byName: { [B.nameKey('b.pdf', '高数/课件')]: true } }
  assert.strictEqual(B.classify({ name: 'b.pdf', size: 5 }, byName, '高数/课件'), 'dupname')
  assert.strictEqual(B.classify({ name: 'b.pdf', size: 9 }, byName, '高数/课件'), 'dupname')
  assert.strictEqual(B.classify({ name: 'b.pdf', size: 9 }, byName, '大物/课件'), 'ready')
  assert.strictEqual(B.scopeKey(' 高等数学2-2 ', undefined), B.scopeKey('高等数学2-2', ''))
})

test('查重：不支持的类型 / 超大文件 / 非法名优先拦住', () => {
  const empty = { byKey: {}, byName: {} }
  assert.strictEqual(B.classify({ name: 'x.mp4', size: 1 }, empty), 'unsupported')
  assert.strictEqual(B.classify({ name: 'x.pdf', size: 2 * 1024 * 1024 * 1024 }, empty), 'toolarge')
  assert.strictEqual(B.classify({ name: 'x<.pdf', size: 1 }, empty), 'badname')
})

test('目录名安全校验', () => {
  assert.strictEqual(B.safeSegment('期末试卷'), '期末试卷')
  assert.strictEqual(B.safeSegment('../etc'), '')
  assert.strictEqual(B.safeSegment('a/b'), 'a/b')
})

test('下拉候选：空查询按原顺序并受上限约束', () => {
  const list = ['课件', '试卷', '实验', '作业']
  assert.deepStrictEqual(B.fuzzyFilter(list, '', 3), ['课件', '试卷', '实验'])
  assert.deepStrictEqual(B.fuzzyFilter(list, ''), list)
})

test('下拉候选：完全匹配 > 前缀 > 包含', () => {
  const list = ['大学物理实验', '物理', '物理化学', '数学物理方法']
  assert.deepStrictEqual(B.fuzzyFilter(list, '物理').slice(0, 3), ['物理', '物理化学', '大学物理实验'])
  assert.strictEqual(B.fuzzyFilter(list, '大学物理实验')[0], '大学物理实验')
})

test('下拉候选：按字符子序列兜底（高数 → 高等数学2-2）', () => {
  assert.deepStrictEqual(B.fuzzyFilter(['高等数学2-2', '线性代数'], '高数'), ['高等数学2-2'])
})

test('下拉候选：无命中返回空，重复项只留一个', () => {
  assert.deepStrictEqual(B.fuzzyFilter(['课件', '试卷'], 'zzz'), [])
  assert.deepStrictEqual(B.fuzzyFilter(['课件', '课件 ', '实验'], '课'), ['课件'])
})

test('目录候选：只用本课站内目录 + 本次已建目录，不掺全站', () => {
  const course = { dirs: [{ name: '课件' }, { name: '实验报告' }, { name: '' }] }
  assert.deepStrictEqual(
    B.dirOptions(['期末试卷', '课件'], course.dirs), ['期末试卷', '课件', '实验报告'])
  assert.deepStrictEqual(B.dirOptions(undefined, course.dirs), ['课件', '实验报告'])
  assert.deepStrictEqual(B.dirOptions([], []), [])
  assert.deepStrictEqual(B.dirOptions(null, null), [])
})

test('按课程聚合目录：同名合并、按文件数排序、根目录也算一个目录', () => {
  const items = [
    { sub_category: '课件' }, { sub_category: '课件' }, { sub_category: '期末试卷' },
    { sub_category: ' 课件 ' }, { sub_category: '' }, { sub_category: null }, {}
  ]
  const dirs = B.dirsFromItems(items)
  assert.deepStrictEqual(dirs.map((d) => d.name), ['课件', '', '期末试卷'])
  assert.deepStrictEqual(dirs.map((d) => d.count), [3, 3, 1])
  assert.deepStrictEqual(B.dirsFromItems([]), [])
  assert.deepStrictEqual(B.dirsFromItems(null), [])
})

test('目录可删除性：站内已有或传过文件的，普通成员不能去掉', () => {
  assert.strictEqual(B.dirHasUploaded({ name: '课件', files: [] }), false)
  assert.strictEqual(B.dirHasUploaded({ name: '课件', files: [{ status: 'ready' }] }), false)
  assert.strictEqual(B.dirHasUploaded({ name: '课件', files: [{ status: 'done' }] }), true)
  assert.strictEqual(B.dirHasUploaded({ name: '课件', files: [{ status: 'running' }] }), true)
  assert.strictEqual(B.dirHasUploaded({ name: '课件', files: [], fromSite: true }), true)
})

test('工作台：同课程+目录自动合并，空目录单独成行', () => {
  const course = { name: '高等数学2-2', dirs: [] }
  const a = B.upsertDir(course, '期末试卷', [{ name: 'a.pdf', status: 'ready' }])
  const b = B.upsertDir(course, '期末 试卷', [{ name: 'b.pdf', status: 'ready' }])
  assert.strictEqual(course.dirs.length, 1)
  assert.strictEqual(a, b)
  assert.strictEqual(a.files.length, 2)

  B.upsertDir(course, '', [{ name: 'c.pdf', status: 'ready' }])
  assert.strictEqual(course.dirs.length, 2)
})

test('新建子目录的默认名不重复：按已有名字往后编号', () => {
  assert.strictEqual(B.defaultDirName([]), '新子目录')
  assert.strictEqual(B.defaultDirName(['新子目录']), '新子目录 2')
  assert.strictEqual(B.defaultDirName(['新子目录', '新子目录 2']), '新子目录 3')
  // 用户改过名、或站内已有的目录名都不影响编号起点
  assert.strictEqual(B.defaultDirName(['课件', '期末 试卷']), '新子目录')
  // 归一化后同名（大小写/空格差异）也算被占用
  assert.strictEqual(B.defaultDirName(['新子目录 ']), '新子目录 2')
})

test('工作台：按目录收集待传文件，尊重状态和跳过已存在', () => {
  const dir = {
    name: '期末试卷',
    files: [
      { name: 'a', status: 'ready' },
      { name: 'b', status: 'done' },
      { name: 'd', status: 'dup' }
    ]
  }
  const course = { name: '高等数学2-2', dirs: [dir] }
  assert.strictEqual(B.collectDirTargets(course, dir, true).length, 1)
  assert.strictEqual(B.collectDirTargets(course, dir, true)[0].entry.name, 'a')
  assert.strictEqual(B.collectDirTargets(course, dir, false).length, 2)
  assert.strictEqual(B.collectDirTargets(course, dir, true)[0].group.category, '高等数学2-2')
  assert.strictEqual(B.collectDirTargets(course, dir, true)[0].group.subCategory, '期末试卷')
})

test('工作台：全部上传合并所有目录', () => {
  const course = {
    name: '高等数学2-2',
    dirs: [
      { name: '期末试卷', files: [{ name: 'a', status: 'ready' }] },
      { name: '课件', files: [{ name: 'b', status: 'failed' }, { name: 'c', status: 'done' }] }
    ]
  }
  assert.strictEqual(B.collectCourseTargets(course, true).length, 2)
  assert.deepStrictEqual(
    B.collectCourseTargets(course, true).map((t) => t.group.subCategory),
    ['期末试卷', '课件'])
})

test('空子目录不产出任何上传目标：建一堆空目录也传不出东西', () => {
  // 站点没有"目录"这个实体，只有 /api/upload 带文件时才会落出目录；
  // 所以只要 target 全部来自 dir.files，空目录就不可能刷站内记录（防恶心人）
  const course = {
    name: '高等数学2-2',
    dirs: [
      { name: '空1', files: [] },
      { name: '空2', files: [] },
      { name: '空3', files: [{ name: 'x', status: 'done' }] },       // 已传完 → 不再产 target
      { name: '空4', files: [{ name: 'y', status: 'dup' }] },        // 已存在 → 跳过时不产 target
      { name: '有货', files: [{ name: 'z', status: 'ready' }] }
    ]
  }
  assert.deepStrictEqual(B.collectCourseTargets(course, true).map((t) => t.group.subCategory), ['有货'])
  assert.strictEqual(B.collectDirTargets(course, course.dirs[0], false).length, 0)
  // 一个文件都没有时，整门课也凑不出任何 target
  const allEmpty = { name: 'X', dirs: [{ name: 'a', files: [] }, { name: 'b', files: [] }] }
  assert.strictEqual(B.collectCourseTargets(allEmpty, false).length, 0)
})

test('拖进来的文件夹树摊平后，与「从文件夹导入」给出同一种 relPath', () => {  const mk = (name) => ({ name, size: 10 })
  const tree = [{
    name: '高等数学2-2', isDirectory: true, children: [
      { name: '期末试卷', isDirectory: true, children: [{ name: 'a.pdf', file: mk('a.pdf') }] },
      { name: '课件', isDirectory: true, children: [
        { name: '第一章', isDirectory: true, children: [{ name: 'b.pptx', file: mk('b.pptx') }] }] },
      { name: '根上的.pdf', file: mk('根上的.pdf') }
    ]
  }]
  const files = B.flattenDropTree(tree)
  // 三层也要能翻出来；根目录名保留成第一段，和 webkitdirectory 的口径一致
  assert.deepStrictEqual(files.map((f) => f.webkitRelativePath), [
    '高等数学2-2/期末试卷/a.pdf',
    '高等数学2-2/课件/第一章/b.pptx',
    '高等数学2-2/根上的.pdf'
  ])
  // 摊平的结果直接喂给导入那条路：折算出来的学科分类 / 子目录必须对得上
  // （第三层会被拼成「课件/第一章」，与站点的两级落盘规则一致，见 design.md）
  const entries = files.map((f) => ({ file: f, name: f.name, size: f.size, relPath: f.webkitRelativePath, status: 'ready' }))
  const groups = B.buildGroups(entries, ['高等数学2-2'])
  assert.ok(groups.every((g) => g.category === '高等数学2-2'), '三段路径的第一段就是学科分类')
  assert.deepStrictEqual(
    groups.map((g) => g.subCategory).sort(),
    ['', '期末试卷', '课件/第一章'].sort()
  )
})

test('结果导出 CSV：带 BOM、CRLF、表头齐全，逗号引号换行都能转义', () => {
  const csv = B.exportCsv([{
    relPath: '高数/期末,"真题".pdf', category: '高数', subCategory: '期末',
    status: 'failed', id: 42, error: '429 太多请求\n再来一次'
  }])
  assert.strictEqual(csv.charCodeAt(0), 0xFEFF, '开头必须有 UTF-8 BOM，否则 Excel 打开中文乱码')
  assert.ok(csv.includes('\r\n'), '必须用 CRLF 换行')
  const lines = csv.slice(1).trim().split('\r\n')
  assert.strictEqual(lines[0], 'relPath,category,sub_category,status,id,error')
  // 含逗号/引号的字段整体加引号，内部引号翻倍；含换行的字段允许跨行
  assert.strictEqual(lines[1], '"高数/期末,""真题"".pdf",高数,期末,failed,42,"429 太多请求\n再来一次"')
  assert.strictEqual(B.exportCsv([]).trim().split('\r\n').length, 1, '空队列也要只有一行表头')
  assert.strictEqual(B.csvCell(null), '', 'null / undefined 落成空串而不是 "null"')
})

test('每个学科分类都固定有一行「根目录」', () => {
  // 站内带子目录、也带挂在分类根下的文件：不重复造，只补标记
  const withRoot = B.ensureRootDir({ name: '大学物理', dirs: [{ name: '', files: [] }, { name: '实验报告', files: [] }] })
  assert.strictEqual(withRoot.dirs.length, 2, '已有根目录时不该再多出一行')
  assert.strictEqual(withRoot.dirs[0].isRoot, true)
  // 站内只有具名子目录：仍然给一行根目录，否则"文件直接挂在分类下"没有落点
  const noRoot = B.ensureRootDir({ name: '信号与系统', dirs: [{ name: '期末试卷', files: [] }] })
  assert.strictEqual(noRoot.dirs.length, 2)
  assert.strictEqual(noRoot.dirs[0].name, '', '根目录固定排在最前')
  assert.strictEqual(noRoot.dirs[0].isRoot, true)
  // 空课程（新建分类）也要有
  const fresh = B.ensureRootDir({ name: '新课', dirs: [] })
  assert.strictEqual(fresh.dirs.length, 1)
  // 没选学科分类时不凭空造行
  assert.deepStrictEqual(B.ensureRootDir({ name: '', dirs: [] }).dirs, [])
  // 根目录不参与上传目标：空根目录不该产出任何目标
  assert.strictEqual(B.collectCourseTargets(fresh, false).length, 0)
})

test('整理规范文案与代码规则一致（界面上说的 = 代码做的）', () => {
  const text = B.ORGANIZE_PROMPT
  assert.ok(Array.isArray(B.ORGANIZE_PROMPT_LINES), '文案按行存放，方便逐条核对')
  assert.ok(text.includes('<学科分类>/<子目录>/<文件>'), '要给出目录结构模板')
  assert.ok(text.includes('200MB'), '要写明单文件上限')
  assert.ok(text.includes('两级'), '要说明目录层级上限')
  assert.ok(text.includes('待审核'), '要说明上传后不是直接可见')
  assert.ok(/姓名|学号/.test(text), '要提醒去掉个人信息')
  // 白名单逐个比对：ALLOWED_EXT 里每个扩展名都得在文案里出现
  B.ALLOWED_EXT.forEach((ext) => {
    assert.ok(text.includes(ext.replace('.', '')), '文案缺少格式 ' + ext)
  })
  assert.ok(!text.includes('mp4'), '不该把不支持的格式写进文案')
})

test('限速器：burst 内立即放行，之后按间隔排队', async () => {
  const pacer = new B.Pacer(2, 60)
  const t0 = Date.now()
  await pacer.take()
  await pacer.take()
  const burstMs = Date.now() - t0
  assert.ok(burstMs < 40, 'burst 内应当几乎不等待，实际 ' + burstMs + 'ms')
  const t1 = Date.now()
  await pacer.take()
  const waitMs = Date.now() - t1
  assert.ok(waitMs >= 40, '第三个请求应当等待，实际 ' + waitMs + 'ms')
})

// 异步用例单独收尾
Promise.resolve()
  .then(async () => {
    const pacer = new B.Pacer(1, 60)
    await pacer.take()
    const t0 = Date.now()
    await pacer.take()
    assert.ok(Date.now() - t0 >= 40)
    console.log('  ok  限速器（异步）')
    console.log('\n全部通过：' + (passed + 1) + ' 项')
  })
  .catch((err) => {
    console.error('\n失败：', err && err.message)
    process.exit(1)
  })
