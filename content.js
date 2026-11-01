/* upcshare 批量投递助手 — 内容脚本
 *
 * 这个脚本只注入到 in.upcshare.cn / upcshare.cn 的页面里，和站点同源运行：
 *   - 直接复用浏览器里已有的登录 Cookie，不读取、不保存账号密码；
 *   - 上传走站点自己的 /api/upload，和网页上传完全一样的接口；
 *   - 所有数据都留在你本机：不写 localStorage、不写 Cookie、不发往任何第三方，
 *     刷新页面就清空（浏览器也不允许脚本保留你选过的文件句柄）。
 *
 * 结构：纯函数（可单测）→ 网络层 → 状态 → UI。
 */
(function () {
  'use strict'

  // 和 FileController.ALLOWED 保持一致
  var ALLOWED_EXT = ['.pdf', '.doc', '.docx', '.zip', '.rar', '.7z', '.tar', '.gz',
    '.ppt', '.pptx', '.xls', '.xlsx', '.txt', '.md', '.csv']
  var MAX_BYTES = 200 * 1024 * 1024           // 产品要求 200MB（站点实际允许 1GB）
  var DIR_DEFAULT = '新子目录'                 // 「新建子目录」没改名之前的占位名（会编号）
  // Nginx 上传区限速 6r/m、burst 3、并发 2；留一点余量，别去撞 429。
  var PACE = { burst: 3, intervalMs: 10500 }

  // 「不知道怎么整理？」里那份可复制的规范。单独抽出来是为了让 selftest 能把它
  // 和上面的白名单、大小上限绑在一起核对——改了规则忘了改说明，测试就会红。
  var ORGANIZE_PROMPT_LINES = [
    '请把待上传的课程资料整理成下面的结构，再交给 upcshare 的「从文件夹导入」。',
    '',
    '一、目录结构（必须）',
    '',
    '  <学科分类>/<子目录>/<文件>',
    '',
    '例：',
    '  高等数学2-2/期末试卷/2024-2025 期末真题.pdf',
    '  高等数学2-2/课件/第 1 章 极限.pptx',
    '  大学物理/实验报告/实验一 单摆.pdf',
    '',
    '二、整理规则',
    '',
    '1. 第一层目录名 = 学科分类。尽量与站内已有的学科分类同名（可在下拉里先查一下）。',
    '2. 第二层目录名 = 子目录。同一学科分类下含义相同的目录请用同一个名字：「期末试卷」和「期末试卷2」会被建成两个目录。',
    '3. 目录最多两级。更深的层级（学科/章/节）会被合并成一个目录名「章/节」。',
    '4. 文件直接放在学科分类下是允许的，会归入该学科分类的「根目录」。',
    '5. 单个文件不超过 200MB。',
    '6. 只接受这些格式：pdf、doc、docx、ppt、pptx、xls、xlsx、txt、md、csv、zip、rar、7z、tar、gz。视频、图片、可执行文件请提前剔除。',
    '7. 文件名不要包含 < > : " | ? * 以及 ".."，也不要以空格或点结尾。',
    '8. 文件名和文件内容里不要出现姓名、学号、手机号、班级等个人信息；含这类信息的文档请先删除或打码。',
    '',
    '三、上传时会发生什么（不需要你处理，但要知道）',
    '',
    '- 与站内已有记录同名且同大小的文件默认跳过，不会重复上传。',
    '- 同名但大小不同的文件只做标记，不会自动跳过——可能是新版本，也可能传错了，需要你确认。',
    '- 新上传的文件默认进入待审核，不会直接出现在前台列表。',
    '- 上传按站点限速排队，100 个文件大约需要 17 分钟，中途不要刷新页面。',
    '',
    '四、建议的操作顺序',
    '',
    '1. 先在硬盘上把一个学科分类的资料按上面的结构整理好。',
    '2. 点「从文件夹导入」，看清确认框里的文件数、子目录数和目标学科分类，再确认导入。',
    '3. 勾上「只试运行」跑一遍，在日志里核对每个文件将落到的学科分类 / 子目录。',
    '4. 取消勾选，正式上传。传完可以去站点后台的「待审核」复查。'
  ]
  var ORGANIZE_PROMPT = ORGANIZE_PROMPT_LINES.join('\n')

  /* ============================ 纯函数 ============================ */

  function extOf(name) {
    var s = String(name || '')
    var i = s.lastIndexOf('.')
    return i >= 0 ? s.slice(i).toLowerCase() : ''
  }

  function isAllowedName(name) {
    return ALLOWED_EXT.indexOf(extOf(name)) >= 0
  }

  // 服务端会拒掉含 <>:"|?* 和控制字符、或带 .. 的文件名
  function hasBadName(name) {
    var s = String(name || '')
    if (!s) return true
    if (s.indexOf('..') >= 0) return true
    return /[<>:"|?*\x00-\x1f]/.test(s)
  }

  function formatSize(bytes) {
    var n = Number(bytes) || 0
    var units = ['B', 'KB', 'MB', 'GB', 'TB']
    var i = 0
    while (n >= 1024 && i < units.length - 1) { n /= 1024; i++ }
    return (i === 0 ? n.toFixed(0) : n.toFixed(1)) + ' ' + units[i]
  }

  // 匹配学科名时忽略空格、标点、全半角差异
  function normalizeText(value) {
    return String(value || '')
      .toLowerCase()
      .replace(/[\s\u3000\u00b7\u30fb._\-—–()（）\[\]【】《》<>"'`、,，.。:：;；/\\+]/g, '')
  }

  function matchScore(a, b) {
    var x = normalizeText(a)
    var y = normalizeText(b)
    if (!x || !y) return 0
    if (x === y) return 100
    if (y.indexOf(x) >= 0 || x.indexOf(y) >= 0) {
      var shortLen = Math.min(x.length, y.length)
      var longLen = Math.max(x.length, y.length)
      return 60 + (shortLen / longLen) * 30
    }
    var p = 0
    while (p < x.length && p < y.length && x[p] === y[p]) p++
    if (p >= 2) return 30 + (p / Math.max(x.length, y.length)) * 30
    return 0
  }

  function bestCategory(name, categories) {
    var best = null
    var bestScore = 0
    var list = categories || []
    for (var i = 0; i < list.length; i++) {
      var s = matchScore(name, list[i])
      if (s > bestScore) { bestScore = s; best = list[i] }
    }
    return bestScore >= 60 ? { name: best, score: Math.round(bestScore) } : null
  }

  /**
   * 下拉候选的模糊排序：完全匹配 > 前缀 > 包含 > 字符子序列。
   * 中文用户常打简称（“高数”），所以子序列必须有兜底。
   */
  function fuzzyScore(raw, query) {
    var q = normalizeText(query)
    var v = normalizeText(raw)
    if (!q) return 0
    if (!v) return 0
    if (v === q) return 100
    if (v.indexOf(q) === 0) return 88 + 10 * (q.length / v.length)
    if (v.indexOf(q) > 0) return 72 + 8 * (q.length / v.length)
    var i = 0
    for (var j = 0; j < v.length && i < q.length; j++) {
      if (v[j] === q[i]) i++
    }
    return i === q.length ? 40 + 18 * (q.length / v.length) : 0
  }

  function fuzzyFilter(list, query, limit) {
    var max = Number(limit) > 0 ? Number(limit) : 8
    var seen = {}
    var out = []
    var src = list || []
    for (var i = 0; i < src.length; i++) {
      var value = String(src[i] == null ? '' : src[i])
      var key = normalizeText(value)
      if (!key || seen[key]) continue
      seen[key] = true
      out.push({ value: value, score: fuzzyScore(value, query), idx: i })
    }
    if (normalizeText(query)) {
      out = out.filter(function (item) { return item.score > 0 })
      out.sort(function (a, b) {
        return b.score - a.score || a.idx - b.idx
      })
    }
    return out.slice(0, max).map(function (item) { return item.value })
  }

  /** 子目录候选：本学科已有子目录优先，再接全局子目录列表。 */
  // 子目录候选：只用这门课在站内真实用过的子目录 + 本次已经建出来的子目录。
  // 不掺全站子目录名 —— 别的课的「课设参考」对当前学科分类没有意义，用户反馈过下拉被污染。
  function dirOptions(subsOfCourse, courseDirs) {
    var out = []
    var seen = {}
    function add(value) {
      var name = String(value == null ? '' : value).trim()
      var key = normalizeText(name)
      if (!key || seen[key]) return
      seen[key] = true
      out.push(name)
    }
    ;(subsOfCourse || []).forEach(add)
    ;(courseDirs || []).forEach(function (dir) { add(dir && dir.name) })
    return out
  }

  // 站内文件列表 → 这门课真实用过的子目录（同名合并、按出现次数从多到少）。
  // 根目录文件（sub_category 为空）也算一个子目录，否则"文件直接挂在学科分类下"的课看起来就是空的。
  function dirsFromItems(items) {
    var map = {}
    var order = []
    ;(items || []).forEach(function (item) {
      if (!item) return
      var name = String(item.sub_category || '').trim()
      var key = normalizeText(name) || ' '
      if (!map[key]) { map[key] = { name: name, count: 0 }; order.push(key) }
      map[key].count++
    })
    order.sort(function (a, b) { return map[b].count - map[a].count })
    return order.map(function (k) { return map[k] })
  }

  // 站内文件 + 本地待传文件 → 子目录行的可删除性判断（见 dirDeletable）
  function dirHasUploaded(dir) {
    return !!(dir && (dir.fromSite || (dir.files || []).some(function (f) {
      return f.status === 'done' || f.status === 'running'
    })))
  }

  /**
   * 把 webkitRelativePath 折算成站点使用的 学科 / 子目录。
   *
   * 站点把文件放在 resources/<学科>/<子目录>/<文件名>，所以子目录就是文件的所在文件夹。
   * 用户选中的根文件夹可能是「高等数学2-2」本身，也可能是「我的课程资料」这种总目录，
   * 所以先拿根目录去和站内已有学科比对：
   *   命中 → 根目录就是学科；
   *   没命中且只有两层 → 第一层当学科；
   *   没命中且更深 → 认为第一层是总目录，第二层才是学科。
   */
  function splitRelativePath(relPath, categories) {
    var parts = String(relPath || '').split('/').filter(Boolean)
    if (parts.length === 0) return { category: '', subCategory: '', source: 'empty' }
    var dirs = parts.slice(0, -1)
    if (dirs.length === 0) return { category: '', subCategory: '', source: 'flat' }

    if (dirs.length === 1) {
      var only = bestCategory(dirs[0], categories)
      return only
        ? { category: only.name, subCategory: '', source: 'matched' }
        : { category: dirs[0], subCategory: '', source: 'new' }
    }

    var rootHit = bestCategory(dirs[0], categories)
    if (rootHit) {
      return { category: rootHit.name, subCategory: dirs.slice(1).join('/'), source: 'matched' }
    }
    var secondHit = bestCategory(dirs[1], categories)
    if (secondHit) {
      return { category: secondHit.name, subCategory: dirs.slice(2).join('/'), source: 'matched' }
    }
    // 根目录是“总目录/我的课程资料”这类容器时，第二层才是学科分类；
    // 否则把根目录当学科分类，避免站内没有的学科分类名（如“工业现场总线技术”）
    // 在三级以上被误判成“附件/子目录”。
    if (isContainerName(dirs[0]) && dirs.length >= 2) {
      return { category: dirs[1], subCategory: dirs.slice(2).join('/'), source: 'new' }
    }
    return { category: dirs[0], subCategory: dirs.slice(1).join('/'), source: 'new' }
  }

  function isContainerName(name) {
    var key = normalizeText(name)
    return key === normalizeText('我的课程资料') ||
      key === normalizeText('我的资料') ||
      key === normalizeText('课程资料') ||
      key === normalizeText('课程文件') ||
      key === normalizeText('资料') ||
      key === normalizeText('总目录') ||
      key === 'files' || key === 'downloads' || key === 'desktop' ||
      key === normalizeText('下载') || key === normalizeText('桌面')
  }

  function safeSegment(value) {
    var s = String(value || '').trim()
    if (!s) return ''
    if (s.indexOf('..') >= 0) return ''
    if (/[<>:"|?*\x00-\x1f]/.test(s)) return ''
    return s
  }

  // 查重必须带"学科分类/子目录"范围：站点把文件落在 resources/<学科>/<子目录>/<文件名>，
  // 不同学科分类里的「第一章.pdf」是两个不同的文件，不该被判成已存在而默认跳过。
  function scopeKey(category, subCategory) {
    return normalizeText(category) + '/' + normalizeText(subCategory)
  }

  function dedupeKey(name, size, scope) {
    return (scope ? scope + '@' : '') + normalizeText(name) + '|' + String(Number(size) || 0)
  }

  function nameKey(name, scope) {
    return (scope ? scope + '@' : '') + normalizeText(name)
  }

  function classify(entry, index, scope) {
    if (!isAllowedName(entry.name)) return 'unsupported'
    if (hasBadName(entry.name)) return 'badname'
    if (Number(entry.size) > MAX_BYTES) return 'toolarge'
    if (!index) return 'ready'
    if (index.byKey[dedupeKey(entry.name, entry.size, scope)]) return 'dup'
    if (index.byName[nameKey(entry.name, scope)]) return 'dupname'
    return 'ready'
  }

  function buildGroups(entries, categories) {
    var map = {}
    var order = []
    for (var i = 0; i < entries.length; i++) {
      var entry = entries[i]
      var hit = splitRelativePath(entry.relPath, categories)
      var key = hit.category + '\u0000' + hit.subCategory
      if (!map[key]) {
        map[key] = {
          category: hit.category,
          subCategory: hit.subCategory,
          source: hit.source,
          files: []
        }
        order.push(key)
      }
      map[key].files.push(entry)
    }
    return order.map(function (k) { return map[k] })
  }

  /** 学科分类下的子目录：同名（归一化后）合并，否则新建。 */
  function upsertDir(course, dirName, entries) {
    var name = String(dirName == null ? '' : dirName).trim()
    var key = normalizeText(name)
    for (var i = 0; i < course.dirs.length; i++) {
      if (normalizeText(course.dirs[i].name) === key) {
        course.dirs[i].files = course.dirs[i].files.concat(entries || [])
        return course.dirs[i]
      }
    }
    var dir = { name: name, files: (entries || []).slice() }
    course.dirs.push(dir)
    return dir
  }

  // 「新建子目录」连点两次，过去会得到两个一模一样的「新子目录」：左栏两行、
  // 右栏标题都分不出谁是谁，用户只能靠猜。默认名按当前已有名字往后编号
  // （新子目录 2、新子目录 3…）；用户自己改过的名字不参与、也不会被覆盖。
  function defaultDirName(existing) {
    var list = existing || []
    var taken = {}
    for (var i = 0; i < list.length; i++) taken[normalizeText(list[i])] = true
    var name = DIR_DEFAULT
    for (var n = 2; taken[normalizeText(name)]; n++) name = DIR_DEFAULT + ' ' + n
    return name
  }

  /* 拖进来的文件夹树 → 一个 File 数组，每个 File 的 webkitRelativePath 与
   * 「从文件夹导入」（input[webkitdirectory]）给出来的形状完全一致：
   * 第一层就是被拖进来的那个文件夹名，所以后面 splitRelativePath 的折算结果也一致。
   * nodes: [{ name, isDirectory, children? , file? }]（由 entryToNode 在同步阶段抓好后异步展开） */
  function flattenDropTree(nodes) {
    var out = []
    function walk(list, prefix) {
      for (var i = 0; i < (list || []).length; i++) {
        var n = list[i]
        if (!n) continue
        var path = prefix ? prefix + '/' + n.name : n.name
        if (n.isDirectory) walk(n.children, path)
        else if (n.file) {
          try {
            Object.defineProperty(n.file, 'webkitRelativePath', { value: path, configurable: true })
          } catch (e) { /* 极少数宿主不让改，退化成只有文件名 */ }
          out.push(n.file)
        }
      }
    }
    walk(nodes, '')
    return out
  }

  /* 结果导出：把队列摊成一张 CSV（Excel 直接双击能开，所以带 UTF-8 BOM、用 CRLF 换行）。
   * 传一半断掉时，人工拿这张表对一遍比看屏幕快得多。 */
  function csvCell(value) {
    var s = (value === null || value === undefined) ? '' : String(value)
    return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s
  }

  function exportCsv(rows) {
    var lines = ['relPath,category,sub_category,status,id,error']
    for (var i = 0; i < (rows || []).length; i++) {
      var r = rows[i] || {}
      lines.push([r.relPath, r.category, r.subCategory, r.status, r.id, r.error]
        .map(csvCell).join(','))
    }
    return '\ufeff' + lines.join('\r\n') + '\r\n'
  }

  /* 每个学科分类都固定有一行「根目录」（文件直接挂在分类下，sub_category 传空串）。
   * 站内还没有根文件时也要给这一行，否则用户想把文件直接放分类下就没有落点；
   * 它不参与上传目标收集（空目录本来就传不出东西），也不给删除。 */
  function ensureRootDir(course) {
    if (!course || !course.name) return course
    var dirs = course.dirs || (course.dirs = [])
    var root = null
    for (var i = 0; i < dirs.length; i++) if (!String(dirs[i].name || '').trim()) root = dirs[i]
    if (root) { root.isRoot = true; return course }
    dirs.unshift({ name: '', files: [], fromSite: false, isRoot: true })
    return course
  }

  function targetFrom(course, dir, entry) {
    return {
      group: { category: course.name, subCategory: dir.name, course: course, dir: dir },
      entry: entry
    }
  }

  function collectDirTargets(course, dir, skipDup) {
    var targets = []
    ;((dir && dir.files) || []).forEach(function (entry) {
      if (entry.status === 'ready' || entry.status === 'failed') {
        targets.push(targetFrom(course, dir, entry))
      } else if (!skipDup && (entry.status === 'dup' || entry.status === 'dupname')) {
        targets.push(targetFrom(course, dir, entry))
      }
    })
    return targets
  }

  function collectCourseTargets(course, skipDup) {
    var targets = []
    ;((course && course.dirs) || []).forEach(function (dir) {
      targets = targets.concat(collectDirTargets(course, dir, skipDup))
    })
    return targets
  }

  /* ============================ 网络层 ============================ */

  function httpError(status, data, fallback) {
    var message = fallback || ('HTTP ' + status)
    if (data && (data.msg || data.message || data.detail)) {
      message = data.detail || data.msg || data.message
    }
    var err = new Error(String(message))
    err.status = status
    return err
  }

  function parseJson(text) {
    try { return JSON.parse(text) } catch (e) { return null }
  }

  function apiJson(path, options) {
    var opts = options || {}
    return fetch(path, {
      method: opts.method || 'GET',
      credentials: 'same-origin',
      headers: opts.body ? { 'Content-Type': 'application/json' } : undefined,
      body: opts.body ? JSON.stringify(opts.body) : undefined
    }).then(function (res) {
      return res.text().then(function (text) {
        var data = parseJson(text)
        if (!res.ok) throw httpError(res.status, data)
        return data
      })
    })
  }

  // 站内已有资料索引：已通过的 + 待审核的（管理员才读得到后者）
  function loadSiteIndex() {
    var byKey = {}
    var byName = {}
    var subsByCategory = {}
    var stats = { approved: 0, pending: 0, pages: 0 }

    function collect(items) {
      for (var i = 0; i < (items || []).length; i++) {
        var item = items[i]
        var name = String(item.original_name || '')
        var size = Number(item.file_size_raw != null ? item.file_size_raw : item.file_size) || 0
        var scope = scopeKey(item.category, item.sub_category)
        byKey[dedupeKey(name, size, scope)] = true
        byName[nameKey(name, scope)] = true
        // 顺手记下“学科 → 子目录”的真实组合，给下拉做候选
        var cat = String(item.category || '').trim()
        var sub = String(item.sub_category || '').trim()
        if (cat && sub) {
          var key = normalizeText(cat)
          var list = subsByCategory[key] || (subsByCategory[key] = [])
          if (list.indexOf(sub) < 0) list.push(sub)
        }
      }
    }

    function walk(pathFor, maxPages) {
      var page = 1
      function next() {
        return apiJson(pathFor(page)).then(function (data) {
          if (!data || !data.items) return null
          collect(data.items)
          stats.pages++
          var isLast = page >= (data.pages || 0) || page >= maxPages
          page++
          return isLast ? null : next()
        })
      }
      return next()
    }

    return walk(function (p) { return '/api/files?size=100&page=' + p }, 40)
      .then(function () {
        stats.approved = Object.keys(byKey).length
        return apiJson('/api/admin/files?status=pending&size=200&page=1').then(function (data) {
          if (data && data.items) {
            collect(data.items)
            stats.pending = data.items.length
            if ((data.pages || 0) > 1) {
              return walk(function (p) { return '/api/admin/files?status=pending&size=200&page=' + p }, 10)
            }
          }
          return null
        }).catch(function (err) {
          // 普通成员没有 admin 权限是常态，静默；其余错误要说，否则待审核文件会被重复上传
          if (err && (err.status === 401 || err.status === 403)) return null
          logLine('待审核列表没读到：' + err.message + '（查重可能漏掉未审核的文件）', 'err')
          return null
        })
      })
      .then(function () {
        return { byKey: byKey, byName: byName, subsByCategory: subsByCategory, stats: stats }
      })
  }

  /**
   * 某一门学科分类在站内真实用过的子目录。
   * 站点没有「按学科分类取子目录」的接口（/api/subcategories 忽略 category 参数，实测过），
   * 只能按 category 过滤文件再自己聚合；这样也顺带拿到每个子目录的文件数。
   */
  function loadCourseDirs(category) {
    var items = []
    var page = 1
    var q = encodeURIComponent(category)
    function next() {
      return apiJson('/api/files?category=' + q + '&size=100&page=' + page).then(function (data) {
        if (!data || !data.items) return null
        items = items.concat(data.items)
        page++
        return (page > (data.pages || 1) || page > 40) ? null : next()
      })
    }
    return next().then(function () { return dirsFromItems(items) })
  }

  // 「已有资源」：当前学科分类 + 当前子目录下的站内文件（已通过 + 待审核）
  function loadSiteFiles(category, subCategory) {
    // 空串是有效的筛选值：站内根目录文件的 sub_category 就是 ""，实测能筛出 455 条
    var base = '/api/files?category=' + encodeURIComponent(category) +
      '&sub_category=' + encodeURIComponent(subCategory || '') + '&size=100&page='
    var items = []
    var page = 1
    function next() {
      return apiJson(base + page).then(function (data) {
        if (!data || !data.items) return null
        items = items.concat(data.items)
        page++
        return (page > (data.pages || 1) || page > 20) ? null : next()
      })
    }
    var pending = apiJson('/api/admin/files?status=pending&size=200&page=1')
      .then(function (data) {
        // 待审核那份是**全站**范围的，不筛就等于把别人目录的文件搬进当前子目录的「已有资源」里——
        // 管理员一伸手删掉的是别的学科分类的文件。实测踩过：材料力学的待审核文件出现在测试分类的列表里。
        var cat = normalizeText(category)
        var sub = normalizeText(subCategory)
        return ((data && data.items) || []).filter(function (item) {
          return item && normalizeText(item.category) === cat &&
            normalizeText(item.sub_category) === sub
        })
      })
      // 只有"没权限"可以静默（普通成员本来就没有这块）；5xx / 断网必须说出来，
      // 否则用户看到的是"站内一个文件都没有"，接着就会重复上传
      .catch(function (err) {
        if (err && (err.status === 401 || err.status === 403)) return []
        logLine('待审核列表没取到：' + err.message, 'err')
        return []
      })
    return Promise.all([next().then(function () { return items }), pending]).then(function (res) {
      var seen = {}
      var out = []
      res[0].concat(res[1]).forEach(function (item) {
        if (!item || seen[item.id]) return
        seen[item.id] = true
        out.push(item)
      })
      return out
    })
  }

  function deleteSiteFile(id) {
    return apiJson('/api/admin/files/' + encodeURIComponent(id), { method: 'DELETE' })
  }

  /**
   * 上传单个文件。用 XHR 而不是 fetch：fetch 拿不到上传进度。
   * 浏览器会自动带上 multipart 边界，所以不要手动设置 Content-Type。
   */
  function uploadFile(entry, category, subCategory, onProgress, signal) {
    return new Promise(function (resolve, reject) {
      var xhr = new XMLHttpRequest()
      var aborted = false

      function abort() {
        aborted = true
        try { xhr.abort() } catch (e) { /* ignore */ }
      }
      if (signal) {
        if (signal.aborted) { abort(); return }
        signal.addEventListener('abort', abort, { once: true })
      }

      xhr.open('POST', '/api/upload', true)
      xhr.responseType = 'text'
      xhr.upload.onprogress = function (event) {
        if (event.lengthComputable && onProgress) onProgress(event.loaded, event.total)
      }
      xhr.onload = function () {
        var data = parseJson(xhr.responseText)
        if (xhr.status >= 200 && xhr.status < 300 && data && data.id) {
          resolve(data)
        } else {
          reject(httpError(xhr.status, data, '上传失败（HTTP ' + xhr.status + '）'))
        }
      }
      xhr.onerror = function () { reject(httpError(0, null, '网络中断，上传没有完成')) }
      xhr.onabort = function () {
        var err = new Error('已停止')
        err.aborted = aborted
        reject(err)
      }

      var form = new FormData()
      form.append('file', entry.file, entry.name)
      form.append('description', '')
      form.append('category', category)
      form.append('sub_category', subCategory)
      xhr.send(form)
    })
  }

  function approveFile(id) {
    return apiJson('/api/admin/approve/' + encodeURIComponent(id), { method: 'POST' })
  }

  /* ============================ 限速器 ============================ */

  // 令牌桶：先给 burst 个令牌，之后每 intervalMs 补一个
  function Pacer(burst, intervalMs) {
    this.capacity = burst
    this.intervalMs = intervalMs
    this.tokens = burst
    this.last = Date.now()
  }
  Pacer.prototype.take = function () {
    var now = Date.now()
    var gained = Math.floor((now - this.last) / this.intervalMs)
    if (gained > 0) {
      this.tokens = Math.min(this.capacity, this.tokens + gained)
      this.last += gained * this.intervalMs
    }
    var self = this
    if (this.tokens > 0) {
      this.tokens--
      return Promise.resolve(0)
    }
    var wait = this.intervalMs - ((Date.now() - this.last) % this.intervalMs)
    return new Promise(function (resolve) {
      setTimeout(function () {
        self.tokens = 0
        self.last = Date.now()
        resolve(wait)
      }, wait)
    })
  }

  /* ============================ 状态 ============================ */

  var state = {
    me: null,
    categories: [],
    subcategories: [],
    subsByCategory: {},
    index: null,
    indexLoading: false,
    indexPromise: null,
    fullscreen: false,
    courseFocusName: '',
    dirsCache: {},
    showSite: false,
    siteFiles: { key: '', items: null, loading: false, error: '' },
    pendingDelete: null,
    course: { name: '', dirs: [] },
    activeDir: null,
    running: false,
    cancelled: false,
    controller: null,
    logLines: [],
    logPinned: false,
    progress: { doneBytes: 0, totalBytes: 0, doneFiles: 0, totalFiles: 0, current: '' }
  }

  /* ============================ UI ============================ */

  var WHALE_PATH = 'M23.748 4.651c-.254-.124-.364.113-.512.233-.051.04-.094.09-.137.137-.372.397-.806.657-1.373.626-.829-.046-1.537.214-2.163.848-.133-.782-.575-1.248-1.247-1.548-.352-.155-.708-.311-.955-.65-.172-.24-.219-.509-.305-.774-.055-.16-.11-.323-.293-.35-.2-.031-.278.136-.356.276-.313.572-.434 1.202-.422 1.84.027 1.436.633 2.58 1.838 3.393.137.094.172.187.129.323-.082.28-.18.553-.266.833-.055.179-.137.218-.328.14a5.5 5.5 0 0 1-1.737-1.179c-.857-.828-1.631-1.743-2.597-2.46a12 12 0 0 0-.689-.47c-.985-.957.13-1.743.387-1.836.27-.098.094-.433-.778-.428-.872.003-1.67.295-2.687.685a3 3 0 0 1-.465.136 9.6 9.6 0 0 0-2.883-.101c-1.885.21-3.39 1.1-4.497 2.622C.082 8.776-.231 10.854.152 13.02c.403 2.284 1.568 4.175 3.36 5.653 1.857 1.533 3.997 2.284 6.438 2.14 1.482-.085 3.132-.284 4.994-1.86.47.234.962.328 1.78.398.629.058 1.235-.031 1.705-.129.735-.155.684-.836.418-.961-2.155-1.004-1.682-.595-2.112-.926 1.095-1.295 2.768-3.598 3.284-6.733.05-.346.115-.834.108-1.114-.004-.171.035-.238.23-.257a4.2 4.2 0 0 0 1.545-.475c1.397-.763 1.96-2.016 2.093-3.517.02-.23-.004-.467-.247-.588M11.58 18.168c-2.088-1.642-3.101-2.183-3.52-2.16-.39.024-.32.472-.234.763.09.288.207.487.371.74.114.167.192.416-.113.603-.673.416-1.842-.14-1.897-.168-1.361-.801-2.5-1.86-3.301-3.306-.775-1.393-1.225-2.888-1.299-4.482-.02-.385.094-.522.477-.592a4.7 4.7 0 0 1 1.53-.038c2.131.311 3.946 1.264 5.467 2.774.868.86 1.525 1.887 2.202 2.89.72 1.066 1.494 2.082 2.48 2.915.348.291.626.513.892.677-.802.09-2.14.109-3.055-.615zm1.001-6.44a.306.306 0 0 1 .415-.287.3.3 0 0 1 .113.074.3.3 0 0 1 .086.214c0 .17-.136.307-.308.307a.303.303 0 0 1-.306-.307m3.11 1.596c-.2.081-.4.151-.591.16a1.25 1.25 0 0 1-.798-.254c-.274-.23-.47-.358-.551-.758a1.7 1.7 0 0 1 .015-.588c.07-.327-.007-.537-.238-.727-.188-.156-.426-.199-.689-.199a.6.6 0 0 1-.254-.078.253.253 0 0 1-.114-.358 1 1 0 0 1 .192-.21c.356-.202.767-.136 1.146.016.352.144.618.408 1.001.782.392.451.462.576.685.915.176.264.336.536.446.848.066.194-.02.353-.25.45'

  var STYLE = [
    ':host{all:initial}',
    '[hidden]{display:none !important}',
    '.upc-overlay{position:fixed;inset:0;z-index:2147483001;background:rgba(15,23,42,.42);',
    '  display:flex;align-items:center;justify-content:center;padding:24px}',
    '.upc-overlay.upc-full{padding:22px 24px 24px;align-items:flex-start;background:var(--page-bg,#f5f5f7);overflow:auto}',
    '.upc-overlay.upc-full.upc-dark{background:var(--page-bg,#12151c)}',
    // 全屏模式不做成"浮在页面上的对话框"：外框拆掉，内容按站点自己的节奏铺成一块块卡片
    '.upc-panel.upc-full{width:100%;max-width:1120px;margin:0 auto;min-height:100%;height:auto;max-height:none;',
    '  overflow:visible;background:transparent;border:none;border-radius:0;box-shadow:none;gap:14px}',
    '.upc-full .upc-head{padding:0 2px;border-bottom:none;background:transparent}',
    '.upc-full .upc-title{font-size:20px;font-weight:600;letter-spacing:-.01em}',
    '.upc-full .upc-brand{width:24px;height:24px}',
    '.upc-full .upc-coursewrap,.upc-full .upc-rail,.upc-full .upc-work,.upc-full .upc-run,',
    '.upc-full .upc-foot{background:var(--bg);border:1px solid var(--line);border-radius:12px;',
    '  box-shadow:0 1px 3px rgba(0,0,0,.04)}',
    '.upc-full .upc-coursebar{border-bottom:none;padding:13px 16px}',
    '.upc-full .upc-hint{padding:0 16px 12px}',
    // 中间那一行吃掉剩余高度：内容少时不留空白，内容多时卡片内部自己滚
    '.upc-full .upc-main{gap:14px;flex:1;min-height:320px;overflow:visible}',
    '.upc-full .upc-rail{width:230px;border-right:none;background:var(--bg);min-height:0}',
    '.upc-full .upc-dirs{max-height:none;flex:1}',
    '.upc-full .upc-work{min-height:0}',
    '.upc-full .upc-run{padding:12px 14px;margin:0}',
    '.upc-full .upc-foot{border-top:none;padding:12px 16px}',
    '.upc-panel{width:min(920px,100%);max-height:88vh;display:flex;flex-direction:column;',
    '  background:var(--bg);color:var(--fg);border-radius:14px;overflow:hidden;',
    '  box-shadow:0 24px 64px rgba(2,8,23,.42);border:1px solid var(--line);',
    '  font:13px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif}',
    '.upc-panel.dark{--bg:#1d222c;--fg:#edf0f7;--muted:#b0b8c8;--line:rgba(255,255,255,.09);--soft:#161a23;--accent:#68adff;--accent-soft:rgba(104,173,255,.13);--accent-hover:#8cc1ff;--danger:#ff6961;--danger-soft:rgba(255,105,97,.14)}',
    '.upc-panel{--bg:#fff;--fg:#1d1d1f;--muted:#6e6e73;--line:rgba(0,0,0,.06);--soft:#f5f5f7;--accent:#0071e3;--accent-soft:rgba(0,113,227,.08);--accent-hover:#0077ed;--danger:#ff3b30;--danger-soft:rgba(255,59,48,.1)}',
    // 站点在 :root / [data-theme=dark] 上定义了同一套 token；Shadow DOM 继承不到，
    // 所以启动时读一次计算值覆盖下面这些默认值（applySiteTokens）
    '.upc-btn:focus-visible,.upc-clear:focus-visible,.upc-toggle:focus-visible,.upc-dir:focus-visible,' +
    '.upc-dir-btn:focus-visible,.upc-dir-del:focus-visible,.upc-chip:focus-visible,.upc-rm:focus-visible{' +
    '  outline:none;box-shadow:0 0 0 3px var(--accent-soft);border-radius:6px}',
    '.upc-course:focus,.upc-dir-title:focus{box-shadow:0 0 0 3px var(--accent-soft)}',
    '.upc-head{display:flex;align-items:center;gap:10px;padding:14px 18px;border-bottom:1px solid var(--line)}',
    '.upc-brand{width:22px;height:22px;fill:var(--accent);flex:none}',
    '.upc-title{font-weight:700;font-size:15px;display:flex;align-items:center;gap:7px}',
    '.upc-title span{font-weight:500;color:var(--muted);font-size:inherit}',
    '.upc-grow{flex:1}',
    '.upc-coursebar{display:flex;align-items:center;gap:9px;padding:11px 18px;border-bottom:1px solid var(--line)}',
    // 不再放「学科分类」这个文字标签：输入框的 placeholder 已经说明它是干什么的，
    // 无障碍名字改挂在输入的 aria-label 上（见下面的 markup）。
    '.upc-coursebox{position:relative;display:inline-flex;flex:none}',
    '.upc-course{width:260px;border:1px solid var(--line);background:var(--soft);color:var(--fg);',
    '  border-radius:8px;padding:5px 32px 5px 9px;font:inherit;font-weight:600;font-size:15px}',
    // 选错学科分类时的一键清除：贴在输入框右端，只有选了学科分类才出现
    '.upc-clear{position:absolute;right:2px;top:50%;transform:translateY(-50%);border:none;',
    '  background:transparent;color:var(--danger);font-size:15px;line-height:1;padding:0;cursor:pointer;',
    '  width:28px;height:28px;display:inline-flex;align-items:center;justify-content:center;',
    '  opacity:.75;border-radius:8px}',
    '.upc-clear:hover{opacity:1;background:var(--danger-soft)}',
    '.upc-course:focus{outline:none;border-color:var(--accent)}',
    '.upc-summary{margin-left:auto;color:var(--muted);font-size:12px}',
    '.upc-main{display:flex;min-height:360px;overflow:hidden}',
    '.upc-rail{width:216px;flex:none;border-right:1px solid var(--line);background:var(--soft);display:flex;flex-direction:column}',
    '',
    '.upc-rail-head{display:flex;align-items:baseline;gap:8px;padding:14px 14px 8px}',
    '.upc-rail-head b{font-size:15px;font-weight:600}',
    '.upc-rail-head span{color:var(--muted);font-size:12px}',
    '.upc-dirs{padding:0 8px 10px;overflow:auto;flex:1;min-height:0}',
    '.upc-dir{display:flex;align-items:center;gap:8px;padding:9px 10px;border-radius:8px;cursor:pointer}',
    '.upc-dir:hover{background:var(--soft)}',
    '.upc-dir.on{background:var(--accent-soft);color:var(--accent);font-weight:600}',
    '.upc-dot{width:6px;height:6px;border-radius:50%;background:var(--muted);opacity:.5;flex:none}',
    '.upc-dir.on .upc-dot{background:var(--accent)}',
    '.upc-dir-name{flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
    '.upc-dir-cnt{color:var(--muted);font-size:12px;font-weight:400}',
    '.upc-dir.on .upc-dir-cnt{color:var(--accent)}',
    '.upc-dir-act{display:flex;align-items:center;gap:2px;flex:none}',
    // 行内动作（目录行的「上传（N）」和 ⋯）：不套盒子，只统一成 13px + accent 文字
    '.upc-dir-btn{border:none;background:transparent;color:var(--muted);cursor:pointer;font:inherit;',
    '  font-size:13px;padding:3px 7px;border-radius:6px;line-height:1.4}',
    '.upc-dir-btn:hover:not([disabled]){background:var(--bg);color:var(--accent)}',
    '.upc-dir-btn.up{color:var(--accent);font-weight:600}',
    // 删除按钮：浅红底 + 红色垃圾桶；第一次点击加深并摇一下，第二次才真删
    '.upc-dir-del{border:none;border-radius:6px;background:var(--danger-soft);color:var(--danger);',
    '  width:30px;height:30px;display:inline-flex;align-items:center;justify-content:center;cursor:pointer;flex:none}',
    '.upc-dir-del:hover{background:var(--danger);color:var(--bg)}',
    '.upc-dir-del[disabled]{background:transparent;color:var(--muted);opacity:.4;cursor:not-allowed}',
    '.upc-dir-del[disabled]:hover{background:transparent;color:var(--muted)}',
    '.upc-dir-del.armed{background:var(--danger);color:var(--bg);animation:upc-shake .32s ease}',
    '@keyframes upc-shake{0%,100%{transform:translateX(0)}20%{transform:translateX(-3px)}40%{transform:translateX(3px)}60%{transform:translateX(-2px)}80%{transform:translateX(2px)}}',
    '.upc-dir-btn[disabled]{opacity:.45;cursor:not-allowed}',
    '.upc-toggle{border:1px solid var(--line);background:var(--soft);color:var(--muted);font:inherit;',
    '  font-size:13px;font-weight:500;border-radius:8px;padding:6px 11px;cursor:pointer;flex:none}',
    '.upc-toggle.on{border-color:var(--accent);color:var(--accent);background:var(--accent-soft)}',
    '.upc-site{margin:0 18px 12px;border:1px solid var(--line);border-radius:10px;overflow:hidden;',
    '  flex:none;max-height:32vh;overflow-y:auto}',
    '.upc-site-head{display:flex;align-items:center;gap:8px;padding:8px 10px;background:var(--soft);',
    '  color:var(--muted);font-size:12px}',
    '.upc-site-row{display:flex;align-items:center;gap:10px;padding:8px 10px;border-top:1px solid var(--line);font-size:13px}',
    '.upc-site-name{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
    '.upc-site-meta{color:var(--muted);font-size:12px;flex:none}',
    '.upc-site-empty{padding:10px;color:var(--muted);font-size:12px;border-top:1px solid var(--line)}',
    '.upc-add-dir{margin:4px 8px 12px;padding:6px 10px;border:1px dashed var(--line);border-radius:8px;',
    '  color:var(--accent);font:inherit;font-size:13px;font-weight:500;cursor:pointer;background:transparent;text-align:left}',
    '.upc-add-dir:hover{border-color:var(--accent);background:var(--accent-soft)}',
    // 没选学科分类时这颗是禁用的：要去掉 hover 的"可点"暗示，光标也换成 not-allowed
    '.upc-add-dir[disabled]{opacity:.45;cursor:not-allowed}',
    '.upc-add-dir[disabled]:hover{border-color:var(--line);background:transparent}',
    '.upc-work{flex:1;min-width:0;display:flex;flex-direction:column}',
    '.upc-work-empty{display:flex;flex-direction:column;align-items:center;justify-content:center;gap:10px;',
    '  flex:1;color:var(--muted);font-size:13px;padding:40px}',
    '.upc-work-head{display:flex;align-items:flex-start;gap:10px;padding:14px 18px 8px}',
    '.upc-dir-title{width:100%;border:1px solid transparent;background:transparent;color:var(--fg);',
    '  font:inherit;font-weight:600;font-size:15px;padding:5px 8px;border-radius:8px;',
    // 高度写死成次级档的 34px：只给内边距会因 line-height 差出 3px，和右边的「已有资源」按钮对不齐
    '  box-sizing:border-box;height:34px}',
    '.upc-dir-title:hover{border-color:var(--line)}',
    '.upc-dir-title:focus{outline:none;border-color:var(--accent);background:var(--soft)}',
    '.upc-dir-meta{color:var(--muted);font-size:12px;padding:0 8px}',
    '.upc-rename-tip{display:none;color:var(--muted);font-size:12px;line-height:1.5;padding:0 8px}',
    '.upc-work.rename .upc-rename-tip{display:block}',
    '.upc-work.locked .upc-dir-title{cursor:default;border-color:transparent;background:transparent}',
    '.upc-work.locked .upc-dir-title:hover{border-color:transparent}',
    '.upc-work.rename .upc-dir-title{border-color:var(--accent);background:var(--soft)}',
    '.upc-work-actions{margin-left:auto;display:flex;gap:6px;flex:none}',
    // 面板里的"盒子"只有两档（容器另算：卡片/日志框用 10px 圆角，状态标签用 999px）：
    // 次级 = 基类 .upc-btn / .upc-toggle / 上传设置（13px · 500 · 6px 内边距 · 8px 圆角 · 约 30px 高）
    // 主操作 = .upc-btn.primary 与课程栏那三个（14px · 600 · 8px 圆角 · 35px 高）
    '.upc-btn{display:inline-flex;align-items:center;gap:6px;border:1px solid var(--line);background:var(--soft);',
    '  color:var(--fg);border-radius:8px;padding:6px 11px;font:inherit;font-size:13px;font-weight:500;cursor:pointer}',
    '.upc-btn:hover{border-color:var(--accent)}',
    '.upc-btn.primary{background:var(--accent);border-color:var(--accent);color:#fff;font-size:15px;font-weight:600;padding:5px 13px}',
    '.upc-btn[disabled]{opacity:.5;cursor:not-allowed}',
    '.upc-btn.small{padding:5px 10px}',
    // 学科分类栏里的三个东西（标签 / 输入框 / 导入按钮）同一档字号、同高：
    // 输入框是 14px + 6px 内边距 + 1px 边框，按钮照抄这个算式才不会一高一低
    '.upc-coursebar .upc-btn{font-size:15px;font-weight:600;padding:5px 13px}',
    '.upc-btn.danger{color:var(--danger)}',
    '.upc-drop{margin:4px 18px 10px;padding:12px;border:1px dashed var(--line);border-radius:8px;',
    '  background:var(--soft);color:var(--muted);font-size:13px;text-align:center;cursor:pointer}',
    '',
    '.upc-drop.on{border-color:var(--accent);background:var(--accent-soft);color:var(--accent)}',
    '.upc-drop b{color:var(--accent);font-weight:600}',
    '.upc-files{padding:0 18px 12px;overflow:auto;flex:1;min-height:80px}',
    '.upc-file{display:flex;align-items:center;gap:10px;padding:9px 2px;border-bottom:1px solid var(--line)}',
    '.upc-file:last-child{border-bottom:none}',
    '.upc-ext{width:34px;height:34px;border-radius:8px;background:var(--soft);color:var(--muted);',
    '  display:flex;align-items:center;justify-content:center;font-size:12px;font-weight:600;flex:none}',
    '.upc-ext.pdf{background:var(--danger-soft);color:var(--danger)}',
    '.upc-ext.docx{background:var(--accent-soft);color:var(--accent)}',
    '.upc-ext.ppt{background:#fdf3e0;color:#a86a00}',
    '.upc-fname{flex:1;min-width:0}',
    '.upc-fname b{display:block;font-weight:500;font-size:13px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
    '.upc-fname span{color:var(--muted);font-size:12px}',
    '.upc-chip{display:inline-block;padding:2px 8px;border:none;border-radius:999px;font:inherit;font-size:12px;white-space:nowrap;cursor:default}',
    '.upc-chip.ready{background:var(--soft);color:var(--muted)}',
    '.upc-chip.ok{background:rgba(34,160,90,.14);color:#1f8a4d}',
    '.upc-chip.warn{background:rgba(230,150,20,.16);color:#a86a00}',
    '.upc-chip.err{background:var(--danger-soft);color:var(--danger)}',
    '.upc-chip.retry{cursor:pointer}',
    '.upc-rm{border:none;background:transparent;color:var(--muted);opacity:.6;cursor:pointer;font-size:15px;padding:6px 8px;border-radius:8px}',
    '.upc-rm:hover{color:var(--danger);opacity:1}',
    '.upc-run{padding:0 18px 10px}',
    '.upc-progress{display:flex;flex-direction:column;gap:5px;margin-bottom:6px}',
    '.upc-pbar{height:8px;background:var(--soft);border-radius:999px;overflow:hidden}',
    '.upc-pbar i{display:block;height:100%;width:0;background:var(--accent);transition:width .2s}',
    '.upc-pmeta{display:flex;justify-content:space-between;color:var(--muted);font-size:12px}',
    '.upc-log{background:var(--soft);border:1px solid var(--line);border-radius:10px;padding:8px 10px;',
    '  max-height:110px;overflow:auto;font:12px/1.55 ui-monospace,Consolas,monospace;white-space:pre-wrap}',
    '.upc-log .e{color:var(--danger)}',
    '.upc-log .s{color:#1f8a4d}',
    '.upc-foot{display:flex;align-items:center;gap:10px;padding:12px 18px;border-top:1px solid var(--line);position:relative}',
    '.upc-queue{color:var(--muted);font-size:12px}',
    '.upc-queue b{color:var(--fg);font-weight:600}',
    '.upc-settings-btn{border:1px solid var(--line);background:var(--soft);color:var(--muted);font:inherit;font-size:13px;cursor:pointer;padding:6px 11px;border-radius:8px;font-weight:500}',
    '.upc-settings-btn:hover{border-color:var(--accent);color:var(--accent)}',
    '.upc-settings{position:absolute;right:16px;bottom:52px;z-index:2147483003;min-width:220px;',
    '  background:var(--bg);border:1px solid var(--line);border-radius:10px;padding:10px 12px;',
    '  box-shadow:0 12px 30px rgba(2,8,23,.22);display:flex;flex-direction:column;gap:8px;font-size:13px}',
    '.upc-settings label{display:flex;align-items:center;gap:7px;cursor:pointer}',
    '.upc-hint{padding:0 18px 9px;color:#b45309;font-size:12px;line-height:1.5}',
    '.upc-panel.dark .upc-hint{color:#e5a93d}',
    '.upc-req{color:var(--muted);font-size:12px;margin:2px 18px 10px;line-height:1.5}',
    '.upc-guide{text-align:center}',
    '.upc-guide h3{margin:0 0 4px;font-size:15px;font-weight:600;color:var(--fg)}',
    '.upc-guide p{margin:0 0 10px;color:var(--muted);font-size:13px;line-height:1.7}',
    '.upc-guide .upc-req{margin:12px 0 0}',
    '.upc-steps{display:flex;gap:0;justify-content:center;color:var(--muted);font-size:12px;margin-bottom:12px}',
    '.upc-step{padding:0 18px;position:relative}',
    '.upc-step+.upc-step::before{content:"→";position:absolute;left:-6px;color:var(--muted);opacity:.6}',
    '.upc-step b{display:inline-flex;width:18px;height:18px;border-radius:50%;background:var(--soft);',
    '  color:var(--accent);align-items:center;justify-content:center;font-size:12px;font-weight:600;margin-right:6px}',
    '.upc-chooser-actions{display:flex;gap:10px;justify-content:flex-end}',
    '.upc-menu{position:fixed;z-index:2147483002;min-width:160px;max-height:200px;overflow:auto;',
    '  background:var(--bg);border:1px solid var(--line);border-radius:9px;padding:4px;',
    '  box-shadow:0 10px 28px rgba(2,8,23,.18)}',
    '.upc-menu[hidden]{display:none !important}',
    '.upc-menu-item{padding:7px 9px;border-radius:6px;cursor:pointer;font-size:13px;',
    '  white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
    '.upc-menu-item.active,.upc-menu-item:hover{background:var(--soft)}',
    '.upc-menu-new{color:var(--accent);border-top:1px solid var(--line);margin-top:4px;padding-top:8px;border-radius:0 0 6px 6px}',
    '.upc-menu-empty{padding:8px 9px;color:var(--muted);font-size:12px;line-height:1.45;white-space:normal}',
    '.upc-menu-tip{padding:2px 9px 4px;color:var(--muted);font-size:12px}',
    '.upc-chooser{position:fixed;inset:0;z-index:2147483004;background:rgba(15,23,42,.5);',
    '  display:flex;align-items:center;justify-content:center;padding:24px}',
    '.upc-chooser-card{width:min(420px,100%);background:var(--bg);color:var(--fg);border:1px solid var(--line);border-radius:12px;padding:18px 20px;',
    '  box-shadow:0 24px 64px rgba(2,8,23,.4)}',
    '.upc-chooser-card h3{margin:0 0 6px;font-size:15px;font-weight:600}',
    '.upc-chooser-card p{margin:0 0 12px;color:var(--muted);font-size:13px}',
    '.upc-chooser-item{display:flex;align-items:center;gap:8px;width:100%;border:1px solid var(--line);',
    '  background:var(--soft);border-radius:8px;padding:9px 11px;margin-bottom:8px;font:inherit;font-size:13px;cursor:pointer;text-align:left}',
    '.upc-chooser-item:hover{border-color:var(--accent);color:var(--accent)}',
    '.upc-chooser-item b{flex:1;font-weight:600}',
    '.upc-chooser-item span{color:var(--muted);font-size:12px}',
    // 「查看文件夹导入规范」不再占一排里的第三个盒子：
    // 它只是「从文件夹导入」的一个补充说明，所以做成贴在该按钮右上角的「?」徽标，
    // 悬停/键盘聚焦时浮出 tooltip 写明它是什么，点开还是那份可复制的整理规范。
    '.upc-importbox{position:relative;display:inline-flex;flex:none}',
    '.upc-help-btn{position:absolute;top:-8px;right:-8px;width:20px;height:20px;padding:0;',
    '  display:inline-flex;align-items:center;justify-content:center;',
    '  border:1px solid var(--accent);border-radius:50%;background:var(--bg);color:var(--accent);',
    '  font:inherit;font-size:12px;font-weight:600;line-height:1;cursor:pointer}',
    '.upc-help-btn:hover,.upc-help-btn:focus-visible{background:var(--accent);color:var(--bg)}',
    '.upc-help-tip{position:absolute;bottom:calc(100% + 6px);right:-2px;white-space:nowrap;',
    '  background:var(--fg);color:var(--bg);font-size:12px;font-weight:500;padding:5px 9px;',
    '  border-radius:6px;opacity:0;pointer-events:none;transition:opacity .12s ease}',
    '.upc-help-btn:hover + .upc-help-tip,.upc-help-btn:focus-visible + .upc-help-tip{opacity:1}',
    '.upc-help-card{width:min(720px,100%);max-height:86vh;display:flex;flex-direction:column}',
    '.upc-help-sub{margin:0 0 10px;color:var(--muted);font-size:13px;line-height:1.7}',
    '.upc-help-body{flex:1;min-height:0;overflow:auto;margin:0;padding:12px 14px;',
    '  background:var(--soft);border:1px solid var(--line);border-radius:8px;text-align:left;',
    '  font-family:ui-monospace,SFMono-Regular,Consolas,"Liberation Mono",monospace;',
    '  font-size:12px;line-height:1.75;color:var(--fg);white-space:pre-wrap;word-break:break-word;tab-size:2}',
    '.upc-help-warn{margin:8px 0 0;color:#b45309;font-size:12px;text-align:left}',
    '.upc-help-actions{display:flex;gap:10px;justify-content:flex-end;margin-top:14px;flex:none}',
    '.upc-help-actions .upc-btn{width:auto;margin-top:0}',
    // 站点在 768px 处有整套移动布局；这里至少保证窄窗口不横向溢出
    '@media (max-width:900px){.upc-full .upc-main{flex-direction:column}}',
    '@media (max-width:900px){.upc-full .upc-rail{width:auto}}',
    '@media (max-width:900px){.upc-full .upc-dirs{display:flex;flex-wrap:wrap;gap:6px;max-height:none}}',
    '@media (max-width:900px){.upc-full .upc-dir{width:calc(50% - 3px)}}',
    '@media (max-width:900px){.upc-full .upc-add-dir{width:100%}}',
    '@media (max-width:640px){.upc-full .upc-coursebar{flex-wrap:wrap}}',
    '@media (max-width:640px){.upc-full .upc-summary{width:100%;margin-left:0}}',
    '@media (max-width:640px){.upc-full .upc-dir{width:100%}}'
  ].join('\n')

  function esc(value) {
    return String(value == null ? '' : value)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
  }

  function createHost() {
    var host = document.createElement('div')
    host.id = 'upcshare-batch-host'
    host.style.cssText = 'all:initial;position:fixed;inset:0;pointer-events:none;z-index:2147483000'
    document.documentElement.appendChild(host)
    var shadow = host.attachShadow({ mode: 'open' })
    var style = document.createElement('style')
    style.textContent = STYLE
    shadow.appendChild(style)
    return shadow
  }

  function buildPanel(shadow) {

    var overlay = document.createElement('div')
    overlay.className = 'upc-overlay'
    overlay.style.pointerEvents = 'auto'
    overlay.hidden = true
    overlay.innerHTML = [
      '<div class="upc-panel" role="dialog" aria-label="upcshare 批量投递">',
      '  <div class="upc-head">',
      '    <div class="upc-title"><svg class="upc-brand" viewBox="0 0 24 24" aria-hidden="true"><path d="' + WHALE_PATH + '"></path></svg>批量投递<span>upcshare</span></div>',
      '    <div class="upc-grow"></div>',
      '  </div>',
      '  <div class="upc-coursewrap">',
      '    <div class="upc-coursebar">',
      '      <span class="upc-coursebox">',
      '        <input class="upc-course" data-el="courseName" placeholder="选择已有学科分类，或输入新建名称" aria-label="学科分类" autocomplete="off" role="combobox" aria-expanded="false" aria-autocomplete="list" aria-controls="upc-menu">',
      '        <button class="upc-clear" data-el="courseClear" data-act="clearCourse" type="button" hidden title="清除学科分类选择" aria-label="清除学科分类选择">×</button>',
      '      </span>',
      '      <span class="upc-importbox">',
      '        <button class="upc-btn small" data-act="pickFolder" type="button">从文件夹导入</button>',
      '        <button class="upc-help-btn" data-act="openHelp" type="button" aria-label="查看文件夹导入规范" title="查看文件夹导入规范">?</button>',
      '        <span class="upc-help-tip" role="tooltip">查看文件夹导入规范</span>',
      '      </span>',
      '      <span class="upc-summary" data-el="summary"></span>',
      '    </div>',
      '    <div class="upc-hint" data-el="courseHint" hidden></div>',
      '  </div>',
      '  <div class="upc-main">',
      '    <aside class="upc-rail">',
      '      <div class="upc-rail-head"><b>子目录</b><span data-el="railCount"></span></div>',
      '      <div class="upc-dirs" data-el="railDirs"></div>',
      '      <button class="upc-add-dir" data-act="addDir" type="button">＋ 新建子目录</button>',
      '    </aside>',
      '    <section class="upc-work" data-el="work">',
      '      <div class="upc-work-empty" data-el="workEmpty">',
      '        <div class="upc-guide">',
      '          <div class="upc-steps">',
      '            <span class="upc-step"><b>1</b>选择学科分类</span>',
      '            <span class="upc-step"><b>2</b>添加子目录</span>',
      '            <span class="upc-step"><b>3</b>上传文件</span>',
      '          </div>',
      '          <h3>还没有子目录</h3>',
      '          <p>先在上方选择或输入学科分类，再新建子目录，然后把文件拖进来；<br>也可以直接「从文件夹导入」，按文件夹层级自动生成学科分类与子目录。</p>',
      '          <button class="upc-btn small" data-act="addDir" type="button">＋ 新建子目录</button>',
      '          <div class="upc-req">支持 PDF、Word、PPT、Excel、ZIP、RAR 等格式，单文件最大 200MB，上传后等待审核。</div>',
      '        </div>',
      '      </div>',
      '      <div class="upc-work-body" data-el="workBody" hidden>',
      '        <div class="upc-work-head" data-el="workHead">',
      '          <div class="upc-grow">',
      '            <input class="upc-dir-title" data-el="dirTitle" placeholder="子目录名称（可选，留空 = 直接挂在学科分类下）" autocomplete="off">',
      '            <div class="upc-dir-meta" data-el="dirMeta"></div>',
      '            <div class="upc-rename-tip" data-el="renameTip"></div>',
      '          </div>',
      '          <div class="upc-work-actions">',
      '            <button class="upc-toggle" data-el="siteToggle" data-act="toggleSite" type="button" hidden>已有资源</button>',
      '          </div>',
      '        </div>',
      '        <div class="upc-drop" data-el="drop">将文件拖放到此处，或 <b>点击选择</b></div>',
      '        <div class="upc-req">支持 PDF、Word、PPT、Excel、ZIP、RAR 等格式，单文件最大 200MB，上传后等待审核。</div>',
      '        <div class="upc-site" data-el="site" hidden>',
      '          <div class="upc-site-head"><span data-el="siteHead"></span></div>',
      '          <div data-el="siteList"></div>',
      '        </div>',
      '        <div class="upc-files" data-el="files"></div>',
      '      </div>',
      '    </section>',
      '  </div>',
      '  <div class="upc-run" data-el="run" hidden>',
      '    <div class="upc-progress" data-el="progress" hidden>',
      '      <div class="upc-pbar"><i data-el="pbarFill"></i></div>',
      '      <div class="upc-pmeta"><span data-el="pText"></span><span data-el="pCount"></span></div>',
      '    </div>',
      '    <div class="upc-log" data-el="log" role="log" aria-live="polite" hidden></div>',
      '  </div>',
      '  <div class="upc-foot">',
      '    <span class="upc-queue" data-el="queueText"></span>',
      '    <div class="upc-grow"></div>',
      '    <button class="upc-settings-btn" data-act="settings" type="button">上传设置</button>',
      '    <button class="upc-settings-btn" data-act="exportCsv" type="button" disabled title="把这一批文件的落点与结果导成 CSV，传断了好核对">导出投递结果（CSV）</button>',
      '    <button class="upc-btn" data-act="stop" type="button" hidden>停止</button>',
      '    <button class="upc-btn primary" data-act="start" type="button" disabled>全部上传</button>',
      '  </div>',
      '  <div class="upc-settings" data-el="settings" hidden>',
      '    <label><input type="checkbox" data-el="skipDup" checked> 跳过站内已存在的文件</label>',
      '    <label data-el="approveWrap"><input type="checkbox" data-el="autoApprove"> 投递后自动通过审核（管理员）</label>',
      '    <label><input type="checkbox" data-el="dryRun"> 只试运行，不真正上传</label>',
      '    <button class="upc-btn small" data-act="index" type="button">刷新站内索引</button>',
      '  </div>',
      '  <input id="upc-picker" type="file" webkitdirectory multiple hidden>',
      '  <div class="upc-menu" id="upc-menu" data-el="menu" role="listbox" hidden></div>',
      '  <div class="upc-chooser" data-el="folderConfirm" hidden>',
      '    <div class="upc-chooser-card">',
      '      <h3>确认导入</h3>',
      '      <p data-el="folderConfirmText"></p>',
      '      <div class="upc-chooser-actions">',
      '        <button class="upc-btn" data-act="cancelImport" type="button">取消</button>',
      '        <button class="upc-btn primary" data-act="confirmImport" type="button">继续导入</button>',
      '      </div>',
      '    </div>',
      '  </div>',
      '  <div class="upc-chooser" data-el="chooser" hidden>',
      '    <div class="upc-chooser-card">',
      '      <h3>检测到多个学科分类</h3>',
      '      <p>一次导入一门，其余可以再选一次文件夹。<br>请确认文件夹已完成分类整理。</p>',
      '      <div data-el="chooserList"></div>',
      '      <button class="upc-btn small" data-el="chooserCancel" type="button">取消</button>',
      '    </div>',
      '  </div>',
      '  <div class="upc-chooser" data-el="helpMask" hidden>',
      '    <div class="upc-chooser-card upc-help-card" role="dialog" aria-modal="true" aria-labelledby="upc-help-title">',
      '      <h3 id="upc-help-title">怎么整理文件夹</h3>',
      '      <p class="upc-help-sub">按下面的结构摆文件，导入时就能自动对上学科分类和子目录。这段文字可以整段复制走，发给同学或存进备忘录。</p>',
      '      <pre class="upc-help-body" data-el="helpBody" tabindex="0"></pre>',
      '      <p class="upc-help-warn" data-el="helpWarn" hidden>这个浏览器环境不允许脚本写剪贴板。点进上面那块文字，全选后手动复制即可。</p>',
      '      <div class="upc-help-actions">',
      '        <button class="upc-btn" data-act="closeHelp" type="button">我知道了</button>',
      '        <button class="upc-btn primary" data-act="copyPrompt" data-el="helpCopy" type="button">复制 prompt</button>',
      '      </div>',
      '    </div>',
      '  </div>',
      '</div>'
    ].join('\n')
    shadow.appendChild(overlay)

    var els = {
      overlay: overlay,
      panel: overlay.querySelector('.upc-panel'),
      courseName: overlay.querySelector('[data-el="courseName"]'),
      courseClear: overlay.querySelector('[data-el="courseClear"]'),
      summary: overlay.querySelector('[data-el="summary"]'),
      railCount: overlay.querySelector('[data-el="railCount"]'),
      railDirs: overlay.querySelector('[data-el="railDirs"]'),
      workEmpty: overlay.querySelector('[data-el="workEmpty"]'),
      workBody: overlay.querySelector('[data-el="workBody"]'),
      dirTitle: overlay.querySelector('[data-el="dirTitle"]'),
      renameTip: overlay.querySelector('[data-el="renameTip"]'),
      workHead: overlay.querySelector('[data-el="workHead"]'),
      work: overlay.querySelector('[data-el="work"]'),
      dirMeta: overlay.querySelector('[data-el="dirMeta"]'),
      siteToggle: overlay.querySelector('[data-el="siteToggle"]'),      site: overlay.querySelector('[data-el="site"]'),
      siteHead: overlay.querySelector('[data-el="siteHead"]'),
      siteList: overlay.querySelector('[data-el="siteList"]'),
      drop: overlay.querySelector('[data-el="drop"]'),
      files: overlay.querySelector('[data-el="files"]'),
      filePicker: null,
      folderPicker: overlay.querySelector('#upc-picker'),
      importBtn: overlay.querySelector('[data-act="pickFolder"]'),
      courseHint: overlay.querySelector('[data-el="courseHint"]'),
      folderConfirm: overlay.querySelector('[data-el="folderConfirm"]'),
      folderConfirmText: overlay.querySelector('[data-el="folderConfirmText"]'),
      helpMask: overlay.querySelector('[data-el="helpMask"]'),
      helpBody: overlay.querySelector('[data-el="helpBody"]'),
      helpWarn: overlay.querySelector('[data-el="helpWarn"]'),
      helpCopy: overlay.querySelector('[data-el="helpCopy"]'),
      queueText: overlay.querySelector('[data-el="queueText"]'),
      start: overlay.querySelector('[data-act="start"]'),
      stop: overlay.querySelector('[data-act="stop"]'),
      settingsBtn: overlay.querySelector('[data-act="settings"]'),
      exportBtn: overlay.querySelector('[data-act="exportCsv"]'),
      settings: overlay.querySelector('[data-el="settings"]'),
      skipDup: overlay.querySelector('[data-el="skipDup"]'),
      autoApprove: overlay.querySelector('[data-el="autoApprove"]'),
      approveWrap: overlay.querySelector('[data-el="approveWrap"]'),
      dryRun: overlay.querySelector('[data-el="dryRun"]'),
      refresh: overlay.querySelector('[data-act="index"]'),
      run: overlay.querySelector('[data-el="run"]'),
      progress: overlay.querySelector('[data-el="progress"]'),
      pbarFill: overlay.querySelector('[data-el="pbarFill"]'),
      pText: overlay.querySelector('[data-el="pText"]'),
      pCount: overlay.querySelector('[data-el="pCount"]'),
      log: overlay.querySelector('[data-el="log"]'),
      menu: overlay.querySelector('[data-el="menu"]'),
      chooser: overlay.querySelector('[data-el="chooser"]'),
      chooserList: overlay.querySelector('[data-el="chooserList"]'),
      chooserCancel: overlay.querySelector('[data-el="chooserCancel"]')
    }

    // 子目录文件选择器（点 drop 区时触发）
    var picker = document.createElement('input')
    picker.type = 'file'
    picker.id = 'upc-file-picker'
    picker.multiple = true
    picker.hidden = true
    overlay.querySelector('.upc-panel').appendChild(picker)
    els.filePicker = picker

    return els
  }

  function logLine(text, kind) {
    var line = '[' + new Date().toTimeString().slice(0, 8) + '] ' + text
    state.logLines.push({ text: line, kind: kind || '' })
    if (state.logLines.length > 400) state.logLines.shift()
    renderLog()
  }

  function renderLog() {
    if (!els || !els.log) return
    var hasErr = state.logLines.some(function (l) { return l.kind === 'err' })
    var show = state.running || state.logPinned || hasErr
    els.run.hidden = !show && els.progress.hidden
    els.log.hidden = !show || !state.logLines.length
    els.log.innerHTML = state.logLines.slice(-200).map(function (l) {
      return '<span class="' + (l.kind === 'err' ? 'e' : l.kind === 'ok' ? 's' : '') + '">' +
        esc(l.text) + '</span>'
    }).join('\n')
    els.log.scrollTop = els.log.scrollHeight
  }

  /* ---------------- 组合框 ---------------- */

  var combo = { input: null, field: '', group: null, entries: [], active: -1, composing: false, onChange: null, gen: 0 }

  function closeMenu() {
    if (combo.input) combo.input.setAttribute('aria-expanded', 'false')
    if (els && els.menu) {
      els.menu.hidden = true
      els.menu.innerHTML = ''
    }
    combo.input = null
    combo.field = ''
    combo.group = null
    combo.entries = []
    combo.active = -1
    combo.onChange = null
  }

  function comboPool(field) {
    if (field === 'category') return state.categories
    return dirOptions(state.subsByCategory[normalizeText(state.course.name)], state.course.dirs)
  }

  function positionMenu() {
    if (!combo.input || !els.menu) return
    var r = combo.input.getBoundingClientRect()
    // 子目录名的下拉要躲开输入框下面那行改名说明：贴着整条 head 的下沿展开
    if (combo.field === 'subCategory' && els.workHead) {
      var head = els.workHead.getBoundingClientRect()
      r = { left: r.left, width: r.width, bottom: head.bottom }
    }
    var width = Math.min(320, Math.max(r.width, 170))
    var left = Math.max(8, Math.min(r.left, window.innerWidth - width - 8))
    var top = r.bottom + 4
    // 始终在输入框下方；空间不够时压缩高度，不往上翻
    var space = window.innerHeight - top - 12
    els.menu.style.maxHeight = Math.max(96, Math.min(200, space)) + 'px'
    els.menu.style.left = left + 'px'
    els.menu.style.top = top + 'px'
    els.menu.style.width = width + 'px'
  }

  function openMenu(input, field, group, onChange) {
    if (!els || !els.menu) return
    // 只读的输入框（站内已有的子目录名）不该有任何下拉可开：focus、click、方向键都走这里
    if (input.readOnly) return
    combo.gen++
    combo.input = input
    combo.field = field
    combo.group = group
    combo.onChange = onChange || null
    combo.active = -1
    renderMenu()
  }

  function renderMenu() {
    if (!combo.input || !els.menu) return
    var field = combo.field
    var query = String(combo.input.value || '').trim()
    var limit = field === 'category' ? 9999 : 8
    var list = fuzzyFilter(comboPool(field), query, limit)
    var exact = false
    for (var i = 0; i < list.length; i++) {
      if (normalizeText(list[i]) === normalizeText(query)) { exact = true; break }
    }
    var entries = list.map(function (value) { return { value: value, isNew: false } })
    if (query && !exact) entries.push({ value: query, isNew: true })
    combo.entries = entries

    var label = field === 'category' ? '学科分类' : '子目录'
    var html = ''
    if (!entries.length) {
      html += '<div class="upc-menu-empty">没有候选，直接输入即可新建' + label + '</div>'
    } else {
      entries.forEach(function (entry, idx) {
        html += '<div class="upc-menu-item' + (entry.isNew ? ' upc-menu-new' : '') +
          (idx === combo.active ? ' active' : '') + '" data-idx="' + idx + '" role="option"' +
          (idx === combo.active ? ' aria-selected="true"' : ' aria-selected="false"') + '>' +
          (entry.isNew
            ? '使用「<b>' + esc(entry.value) + '</b>」（新建' + label + '）'
            : esc(entry.value)) +
          '</div>'
      })
    }
    if (!query) html += '<div class="upc-menu-tip">输入可模糊搜索；找不到就直接输入新建</div>'
    els.menu.innerHTML = html
    els.menu.hidden = false
    if (combo.input) combo.input.setAttribute('aria-expanded', 'true')
    positionMenu()
  }

  function chooseEntry(entry) {
    if (!entry || !combo.input) return
    var input = combo.input
    var field = combo.field
    var group = combo.group
    var onChange = combo.onChange
    input.value = entry.value
    group[field] = entry.value
    if (onChange) onChange(entry.value, 'pick')
    closeMenu()
    input.focus()
  }

  function onComboKey(event) {
    var input = event.currentTarget
    if (combo.input && combo.input !== input) return
    if (!els.menu || els.menu.hidden) {
      if ((event.key !== 'ArrowDown' && event.key !== 'ArrowUp') || !input._comboField) return
      openMenu(input, input._comboField, input._comboGroup, input._comboChange)
    }
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      var total = combo.entries.length
      if (event.key === 'ArrowDown') combo.active = total ? (combo.active + 1) % total : -1
      else combo.active = total ? (combo.active - 1 + total) % total : -1
      renderMenu()
      event.preventDefault()
    } else if (event.key === 'Enter') {
      if (combo.active >= 0) {
        chooseEntry(combo.entries[combo.active])
        event.preventDefault()
      } else {
        // 没有高亮项时按回车：打的是站内已有的学科分类就当作选中它（带出子目录与根目录），
        // 是新名字就保持"打字即新建"，什么都不做。
        if (input._commitTyped) input._commitTyped()
        closeMenu()
      }
    } else if (event.key === 'Escape') {
      closeMenu()
      event.preventDefault()
    } else if (event.key === 'Tab') {
      closeMenu()
    }
  }

  function bindCombo(input, field, group, onChange) {
    input._comboField = field
    input._comboGroup = group
    input._comboChange = onChange || null
    input.addEventListener('focus', function () { openMenu(input, field, group, onChange) })
    input.addEventListener('click', function () {
      if (!els.menu || els.menu.hidden || combo.input !== input) openMenu(input, field, group, onChange)
    })
    input.addEventListener('input', function () {
      group[field] = input.value
      if (onChange) onChange(input.value, 'input')
      if (combo.composing) return
      if (combo.input !== input) openMenu(input, field, group, onChange)
      else renderMenu()
    })
    input.addEventListener('compositionstart', function () { combo.composing = true })
    input.addEventListener('compositionend', function () {
      combo.composing = false
      if (combo.input === input) renderMenu()
    })
    input.addEventListener('keydown', onComboKey)
    input.addEventListener('blur', function () {
      var gen = combo.gen
      setTimeout(function () {
        // 120ms 内如果重新打开过菜单（比如又点回了这个输入框），这个延迟就作废，
        // 否则会把刚打开的下拉关掉——测试里换课时就是这么偶发地踩到的。
        if (combo.input === input && combo.gen === gen) closeMenu()
      }, 120)
    })
  }

  /* ---------------- 数据与渲染 ---------------- */

  function courseFiles() {
    var out = []
    state.course.dirs.forEach(function (dir) { out = out.concat(dir.files) })
    return out
  }

  function isAdmin() {
    return !!(state.me && state.me.is_admin)
  }

  function dirPending(dir) {
    if (!dir) return 0
    return collectDirTargets(state.course, dir, els.skipDup.checked).length
  }

  function activeDirPending() {
    return dirPending(state.activeDir)
  }

  // 站点没有"子目录"这个实体：有文件才有子目录。所以这里只有"把本次新建、还没传过的
  // 一行从列表里去掉"这一种操作；站内已有的子目录不给删除入口——删不掉任何东西，
  // 真要清掉它就去「已有资源」把里面的文件删完，子目录会自己消失。
  function canRemoveDir(dir) {
    // 根目录是学科分类本身；站内已有的子目录没有「目录」这个实体，删不掉
    return !!dir && !dir.isRoot && !dirHasUploaded(dir)
  }

  // 站内已有的子目录不给改名：站点没有"改子目录名"的接口，改了也只影响本次上传落到哪，
  // 反而会让站内的子目录越改越乱。只有本次新建的子目录可以改名。
  function canRenameDir(dir) {
    // 根目录 = 学科分类本身：改了名，文件会落到一个真叫「根目录」的子目录里
    return !!dir && !dir.isRoot && !dirHasUploaded(dir)
  }

  function coursePending() {
    return collectCourseTargets(state.course, els.skipDup.checked).length
  }

  function dirSize(dir) {
    return dir.files.reduce(function (sum, f) { return sum + (Number(f.size) || 0) }, 0)
  }

  function statusInfo(entry) {
    var s = entry.status || 'ready'
    if (s === 'done') return { cls: 'ok', text: '已完成' }
    if (s === 'running') return { cls: 'warn', text: '上传中' }
    if (s === 'dup') return { cls: 'warn', text: '已存在' }
    if (s === 'dupname') return { cls: 'warn', text: '同名' }
    if (s === 'unsupported') return { cls: 'err', text: '类型不支持' }
    if (s === 'toolarge') return { cls: 'err', text: '超过 200MB' }
    if (s === 'badname') return { cls: 'err', text: '文件名非法' }
    if (s === 'failed') return { cls: 'err', text: '失败 · 重试' }
    return { cls: 'ready', text: '待上传' }
  }

  function renderCourseBar() {
    els.courseName.value = state.course.name || ''
    els.courseClear.hidden = !state.course.name || state.running
    var files = courseFiles()
    var bytes = files.reduce(function (sum, f) { return sum + (Number(f.size) || 0) }, 0)
    if (!files.length) {
      els.summary.textContent = state.course.name ? '暂无文件' : ''
    } else {
      els.summary.textContent = state.course.dirs.length + ' 个子目录 · ' + files.length +
        ' 个文件 · ' + formatSize(bytes)
    }
  }

  // 选错学科分类：连这门课的子目录一起去掉，避免留下一个"没有学科分类却挂着一堆子目录"的怪状态。
  // 已经拖了文件就先确认，空的时候不打扰。
  function clearCourse() {
    if (state.running || !state.course.name) return
    var files = courseFiles()
    if (files.length && !window.confirm('清除学科分类「' + state.course.name + '」会把它下面的 ' +
      state.course.dirs.length + ' 个子目录和 ' + files.length + ' 个待传文件一起去掉。是否继续？')) return
    var name = state.course.name
    state.course = { name: '', dirs: [] }
    state.activeDir = null
    state.courseFocusName = ''
    state.showSite = false
    state.siteFiles = { key: '', items: null, loading: false, error: '' }
    courseProxy.category = ''
    logLine('已清除学科分类「' + name + '」的选择，可以重新选了。')
    renderAll()
    els.courseName.focus()
  }

  function renderRail() {
    els.railCount.textContent = state.course.dirs.length ? state.course.dirs.length + ' 个' : '空'
    els.railDirs.innerHTML = ''
    state.course.dirs.forEach(function (dir) {
      var row = document.createElement('div')
      row.className = 'upc-dir' + (dir === state.activeDir ? ' on' : '')
      row.tabIndex = 0
      row.setAttribute('role', 'button')
      row.setAttribute('aria-pressed', dir === state.activeDir ? 'true' : 'false')
      var dot = document.createElement('i')
      dot.className = 'upc-dot'
      var name = document.createElement('span')
      name.className = 'upc-dir-name'
      name.textContent = dir.name || '根目录'
      var cnt = document.createElement('span')
      cnt.className = 'upc-dir-cnt'
      cnt.textContent = String(dir.files.length)
      dir._railName = name
      dir._railCnt = cnt

      var act = document.createElement('div')
      act.className = 'upc-dir-act'
      var up = document.createElement('button')
      up.type = 'button'
      up.className = 'upc-dir-btn up'
      up.textContent = '上传'
      up.title = '只上传这个子目录'
      up.setAttribute('data-act', 'uploadDir')
      up.hidden = dir !== state.activeDir
      up.addEventListener('click', function (event) {
        event.stopPropagation()
        runDir(dir)
      })
      var del = document.createElement('button')
      del.type = 'button'
      del.className = 'upc-dir-del'
      del.innerHTML = '<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true" focusable="false"><path fill="currentColor" d="M9 3h6l1 2h4v2H4V5h4l1-2Zm-3 6h12l-1 11a2 2 0 0 1-2 2H9a2 2 0 0 1-2-2L6 9Zm4 2v9h2v-9h-2Zm4 0v9h2v-9h-2Z"/></svg>'
      del.setAttribute('data-act', 'dirDel')
      del.setAttribute('aria-label', '删除这个子目录')
      var removable = canRemoveDir(dir)
      del.disabled = !removable || state.running
      // 说明里提到的「已有资源」是管理员才有的入口，非管理员只说结论、不指路
      del.title = removable ? '删除子目录（要点两次确认）'
        : (dir.isRoot ? (isAdmin() ? '根目录就是学科分类本身，删不掉；要清文件去「已有资源」' : '根目录就是学科分类本身，删不掉')
          : (isAdmin() ? '站内已有的子目录删不掉：站点没有「目录」这个实体，去「已有资源」把里面的文件删完它就消失了'
            : '站内已有的子目录删不掉'))
      del.addEventListener('click', function (event) {
        event.stopPropagation()
        armOrDeleteDir(dir, del)
      })
      dir._upBtn = up
      dir._delBtn = del
      act.appendChild(up)
      act.appendChild(del)
      row.appendChild(dot)
      row.appendChild(name)
      row.appendChild(cnt)
      row.appendChild(act)
      function pickDir() {
        if (state.running) return
        state.activeDir = dir
        renderRail()
        renderWork()
        updateQueue()
      }
      row.addEventListener('click', pickDir)
      // 子目录行是可聚焦的 div：补上键盘等价物，光有 tabindex 进不去等于没做
      row.addEventListener('keydown', function (event) {
        if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); pickDir() }
      })
      els.railDirs.appendChild(row)
    })
  }

  /* 删除要点两次：第一次把方块摇一下并加深颜色（"我按下了，但还没删"），
     4 秒内再点一次才真删；超时自动退回。和「已有资源」里删文件的口径一致。 */
  function armOrDeleteDir(dir, btn) {
    if (state.running || !canRemoveDir(dir)) return
    if (dir._armed) {
      clearTimeout(dir._armedTimer)
      dir._armed = false
      removeDir(dir)
      return
    }
    dir._armed = true
    btn.classList.add('armed')
    btn.title = dir.files.length ? '再点一次确认删除（会丢掉这 ' + dir.files.length + ' 个待传文件）' : '再点一次确认删除这个空子目录'
    dir._armedTimer = setTimeout(function () {
      dir._armed = false
      if (btn === dir._delBtn) { btn.classList.remove('armed'); btn.title = '删除子目录（要点两次确认）' }
    }, 4000)
  }

  // 只是把这一行从本次列表里去掉（站内已有的子目录走不到这里：canRemoveDir 已经拦了）
  function removeDir(dir) {
    if (state.running || !dir || !canRemoveDir(dir)) return
    if (dir.files.length && !window.confirm('移除「' + (dir.name || '未命名子目录') +
      '」会把它的 ' + dir.files.length + ' 个文件一起从本次列表去掉。是否继续？')) return
    var at = state.course.dirs.indexOf(dir)
    if (at >= 0) state.course.dirs.splice(at, 1)
    if (state.activeDir === dir) state.activeDir = state.course.dirs[at] || state.course.dirs[at - 1] || null
    renderAll()
  }

  function renderFiles() {
    var dir = state.activeDir
    els.files.innerHTML = ''
    if (!dir) return
    dir.files.forEach(function (entry, idx) {
      var row = document.createElement('div')
      row.className = 'upc-file'

      var ext = document.createElement('div')
      var e = extOf(entry.name).slice(1).toUpperCase()
      ext.className = 'upc-ext ' + (e === 'PDF' ? 'pdf' : (e === 'DOCX' || e === 'DOC' ? 'docx' : (e === 'PPT' || e === 'PPTX' ? 'ppt' : '')))
      ext.textContent = e || 'FILE'

      var info = document.createElement('div')
      info.className = 'upc-fname'
      var nm = document.createElement('b')
      nm.textContent = entry.name
      var meta = document.createElement('span')
      meta.textContent = formatSize(entry.size)
      info.appendChild(nm)
      info.appendChild(meta)

      var info2 = statusInfo(entry)
      var chip = document.createElement('button')
      chip.type = 'button'
      chip.className = 'upc-chip ' + info2.cls + (entry.status === 'failed' ? ' retry' : '')
      chip.textContent = info2.text
      if (entry.status === 'failed') {
        chip.addEventListener('click', function () { retryEntry(entry) })
      }

      var rm = document.createElement('button')
      rm.type = 'button'
      rm.className = 'upc-rm'
      rm.textContent = '×'
      rm.title = '移除'
      rm.addEventListener('click', function () {
        if (state.running) return
        var at = dir.files.indexOf(entry)
        if (at >= 0) dir.files.splice(at, 1)
        renderFiles()
        renderCourseBar()
        renderRail()
        syncDirLock()
        updateQueue()
      })

      row.appendChild(ext)
      row.appendChild(info)
      row.appendChild(chip)
      row.appendChild(rm)
      els.files.appendChild(row)
    })
  }

  // 子目录名能不能改，取决于它是不是"站内已有"；传完文件就变成站内有了，所以状态变化时要同步
  function syncDirLock() {
    var dir = state.activeDir
    if (!dir) return
    var renameable = canRenameDir(dir)
    els.dirTitle.readOnly = !renameable
    els.dirTitle.placeholder = '子目录名称（可选，留空 = 直接挂在学科分类下）'
    els.work.classList.toggle('locked', !renameable)
    if (!renameable) els.work.classList.remove('rename')
    els.renameTip.textContent = '改这里即时生效，不需要保存：它只决定本次上传落到哪个子目录，站内已有的文件不会被移动。'
    // 不能改名时把原因写在常驻的元信息行里，而不是等用户点了才弹一行提示
    els.dirMeta.textContent = dir.files.length + ' 个文件 · ' + formatSize(dirSize(dir))
  }

  function renderWork() {
    var dir = state.activeDir
    els.workBody.hidden = !dir
    els.workEmpty.hidden = !!dir
    renderSite()
    if (!dir) return
    els.dirTitle.value = dir.name || ''
    syncDirLock()          // 顺带把「N 个文件 · 大小 ·（不可改名时）站内已有，不可改名」写进 meta 行
    renderFiles()
    // 切子目录时「已有资源」要跟着换，否则显示的是上一个子目录的文件
    if (state.showSite && siteKey() !== state.siteFiles.key) loadSite()
  }

  /* ---------------- 已有资源（管理员专属） ---------------- */

  function siteKey() {
    return normalizeText(state.course.name) + '\u0000' +
      normalizeText(state.activeDir ? state.activeDir.name : '')
  }

  function toggleSiteFiles() {
    if (!isAdmin()) return
    state.showSite = !state.showSite
    els.siteToggle.classList.toggle('on', state.showSite)
    if (!state.showSite) {
      state.siteFiles = { key: '', items: null, loading: false, error: '' }
      els.site.hidden = true
      els.siteList.innerHTML = ''
      return
    }
    loadSite()
  }

  function loadSite() {
    if (!state.showSite) return
    var sf = state.siteFiles
    if (!safeSegment(state.course.name)) {
      sf.items = null
      sf.error = '请先选择学科分类。'
      renderSite()
      return
    }
    var key = siteKey()
    if (sf.key === key && (sf.items || sf.loading)) { renderSite(); return }
    sf.key = key
    sf.items = null
    sf.error = ''
    sf.loading = true
    state.pendingDelete = null
    renderSite()
    loadSiteFiles(state.course.name, state.activeDir ? state.activeDir.name : '')
      .then(function (items) {
        sf.loading = false
        if (siteKey() !== key) return
        sf.items = items
        renderSite()
      })
      .catch(function (err) {
        sf.loading = false
        if (siteKey() !== key) return
        sf.error = err.message
        renderSite()
      })
  }

  function renderSite() {
    if (!els || !els.site) return
    var sf = state.siteFiles
    var show = !!(state.showSite && state.activeDir)
    els.site.hidden = !show
    if (!show) { els.siteList.innerHTML = ''; return }
    els.siteHead.textContent = sf.loading ? '正在读取…'
      : (sf.items ? '当前子目录「' + (state.activeDir.name || '根目录') + '」站内已有 ' + sf.items.length + ' 个文件' : '')
    els.siteList.innerHTML = ''
    if (sf.error) {
      var err = document.createElement('div')
      err.className = 'upc-site-empty'
      err.textContent = '读取失败：' + sf.error
      els.siteList.appendChild(err)
      return
    }
    if (sf.loading || !sf.items) return
    if (!sf.items.length) {
      var none = document.createElement('div')
      none.className = 'upc-site-empty'
      none.textContent = '这个子目录里站内还没有文件。'
      els.siteList.appendChild(none)
      return
    }
    sf.items.forEach(function (item) {
      var row = document.createElement('div')
      row.className = 'upc-site-row'
      var name = document.createElement('div')
      name.className = 'upc-site-name'
      name.textContent = item.original_name || item.file_path || ''
      name.title = name.textContent
      var meta = document.createElement('div')
      meta.className = 'upc-site-meta'
      meta.textContent = [
        item.file_size || formatSize(Number(item.file_size_raw) || 0),
        item.status === 'pending' ? '待审核' : '已通过',
        String(item.created_at || '').slice(0, 10),
        '下载 ' + (item.download_count || 0)
      ].join(' · ')
      var del = document.createElement('button')
      del.type = 'button'
      del.className = 'upc-dir-btn'
      var armed = state.pendingDelete === item.id
      del.textContent = armed ? '确认删除？' : '删除'
      if (armed) del.style.color = 'var(--danger)'
      del.addEventListener('click', function () { armDeleteSiteFile(item.id, del) })
      row.appendChild(name)
      row.appendChild(meta)
      row.appendChild(del)
      els.siteList.appendChild(row)
    })
  }

  // 删除站内文件是不可逆的，必须点两次；4 秒内没点第二下就取消
  function armDeleteSiteFile(id, button) {
    if (!isAdmin()) return
    if (state.pendingDelete !== id) {
      state.pendingDelete = id
      renderSite()
      setTimeout(function () {
        if (state.pendingDelete === id) { state.pendingDelete = null; renderSite() }
      }, 4000)
      return
    }
    state.pendingDelete = null
    button.disabled = true
    deleteSiteFile(id).then(function (data) {
      if (!data || data.ok === false) throw new Error((data && data.msg) || '删除失败')
      var items = state.siteFiles.items || []
      state.siteFiles.items = items.filter(function (i) { return i.id !== id })
      logLine('已删除站内文件，剩余 ' + state.siteFiles.items.length + ' 个。', 'ok')
      renderSite()
      dropEmptiedSiteDir()
    }).catch(function (err) {
      button.disabled = false
      logLine('删除失败：' + err.message, 'err')
    })
  }

  // 站点的"子目录"是有文件才存在的东西：最后一个文件被删掉，服务器那边子目录就没了。
  // 左栏跟着收掉，别留一个点进去永远空着的子目录。
  function dropEmptiedSiteDir() {
    var dir = state.activeDir
    if (!dir || !dir.fromSite || dir.files.length) return
    if (state.siteFiles.items && state.siteFiles.items.length) return
    var at = state.course.dirs.indexOf(dir)
    if (at >= 0) state.course.dirs.splice(at, 1)
    state.activeDir = state.course.dirs[at] || state.course.dirs[at - 1] || null
    state.siteFiles = { key: '', items: null, loading: false, error: '' }
    renderAll()
    logLine('「' + (dir.name || '根目录') + '」已经没有文件，子目录一并去掉了。', 'ok')
  }

  function renderAll() {
    renderCourseBar()
    renderRail()
    renderWork()
    updateQueue()
  }

  function updateQueue() {
    var pending = coursePending()
    var done = 0
    courseFiles().forEach(function (f) { if (f.status === 'done') done++ })
    var total = courseFiles().length
    els.queueText.innerHTML = total
      ? '<b>' + pending + '</b> 个待上传 · ' + done + ' 个已完成'
      : '暂无文件'
    var invalid = !safeSegment(state.course.name)
    var notLoggedIn = !!(state.me && state.me.logged_in === false)
    els.start.disabled = state.running || state.indexLoading || notLoggedIn || pending === 0 || invalid
    els.start.textContent = state.running ? '投递中…' : '全部上传（' + pending + '）'

    var dirPending = activeDirPending()
    // 「上传」只在当前子目录那一行常驻，所以只看当前子目录的待传数
    state.course.dirs.forEach(function (dir) {
      if (!dir._upBtn) return
      dir._upBtn.disabled = state.running || state.indexLoading || notLoggedIn || invalid || dirPending === 0
      dir._upBtn.textContent = '上传' + (dirPending ? '（' + dirPending + '）' : '')
    })
    els.siteToggle.disabled = state.running || !isAdmin()
    els.filePicker.disabled = state.running || !state.activeDir
    els.folderPicker.disabled = state.running
    els.courseName.disabled = state.running
    els.dirTitle.disabled = state.running
    els.importBtn.disabled = state.running
    els.skipDup.disabled = state.running
    els.autoApprove.disabled = state.running || !(state.me && state.me.is_admin)
    els.dryRun.disabled = state.running
    els.refresh.disabled = state.running
    // 子目录必须挂在某个学科分类下：没选分类就不给建（v0.3.22 起，之前允许先建后选）
    els.panel.querySelectorAll('[data-act="addDir"]').forEach(function (b) {
      b.disabled = state.running || invalid
      b.title = invalid ? '先选择或输入一个学科分类，再建子目录' : ''
    })
    // 「导出结果」：有文件才给导，跑动中导出来的是中间态，也先按住
    if (els.exportBtn) els.exportBtn.disabled = state.running || total === 0

    // 合并空状态后，"还差什么"只靠这一行提示说清楚。
    // 但它只在"真的有文件等着传"时才出现：刚点完「新建子目录」，一个文件都还没有，
    // 上传本来就没得可传，这时冒出一行黄字只会读成"新建被拒了、请先选课程"。
    var hint = ''
    if (notLoggedIn) hint = '请先在页面上登录，登录后重新进入「上传资料」。'
    else if (invalid && total > 0) {
      hint = '文件先收下了，但「上传」还点不了：先在上方选择或输入一个学科分类。'
    }
    els.courseHint.textContent = hint
    els.courseHint.hidden = !hint
  }

  function setProgress(patch) {
    state.progress = Object.assign(state.progress, patch)
    var p = state.progress
    var pct = p.totalBytes > 0 ? Math.min(100, (p.doneBytes / p.totalBytes) * 100) : 0
    els.progress.hidden = false
    els.run.hidden = false
    els.pbarFill.style.width = pct.toFixed(1) + '%'
    els.pText.textContent = p.current ? (p.current + ' · ' + pct.toFixed(1) + '%') : '准备中…'
    els.pCount.textContent = p.doneFiles + '/' + p.totalFiles
  }

  function refreshStatus() {
    renderCourseBar()
    renderRail()
    renderFiles()
    syncDirLock()
    if (state.activeDir) syncDirLock()
    updateQueue()
  }

  function fillExistingDirs(list) {
    var seen = {}
    var dirs = []
    ;(list || []).forEach(function (item) {
      // 传进来可以是子目录名字符串，也可以是 dirsFromItems 产出的 { name, count }
      var raw = item && typeof item === 'object'
        ? String(item.name == null ? '' : item.name)
        : String(item == null ? '' : item)
      raw = raw.trim()
      var key = normalizeText(raw)
      if (raw && !key) return                       // 只有含全角空格之类的"伪名字"才丢
      if (seen[key || ' ']) return
      seen[key || ' '] = true
      // fromSite：这个子目录在站内真实存在，普通成员不能删；空名字 = 学科分类根目录
      dirs.push({ name: raw, files: [], fromSite: true })
    })
    ensureRootDir({ name: state.course.name, dirs: dirs })
    state.course.dirs = dirs
    state.activeDir = dirs[0]
    renderAll()
    logLine('已载入 ' + dirs.length + ' 个已有子目录（只显示子目录，不显示已有文件）', 'ok')
    return true
  }

  function startCourse(name) {
    var value = String(name == null ? '' : name).trim()
    if (!value) return
    var key = normalizeText(value)
    state.course = { name: value, dirs: [] }
    state.activeDir = null
    state.courseFocusName = value
    state.showSite = false
    state.siteFiles = { key: '', items: null, loading: false, error: '' }
    renderAll()

    var cached = state.dirsCache[key]
    if (cached) {
      state.subsByCategory[key] = cached.map(function (d) { return d.name })
      if (!fillExistingDirs(cached)) addDir()
      return
    }
    if (!state.categories.some(function (c) { return normalizeText(c) === key })) { addDir(); return }

    els.summary.textContent = '正在读取已有子目录…'
    loadCourseDirs(value).then(function (list) {
      if (normalizeText(state.course.name) !== key) return
      state.dirsCache[key] = list
      state.subsByCategory[key] = list.map(function (d) { return d.name })
      if (!fillExistingDirs(list)) addDir()
    }).catch(function (err) {
      if (normalizeText(state.course.name) !== key) return
      logLine('读取该学科分类的已有子目录失败：' + err.message + '（不影响上传）', 'err')
      addDir()
    })
  }

  function addDir(name) {
    if (state.running) return
    ensureRootDir(state.course)
    // 按钮已经禁用了，这里是给其它调用路径（拖文件、键盘）兜底：
    // 子目录是"学科分类下面的目录"，没有学科分类就没有落点。
    if (!safeSegment(state.course.name)) {
      els.courseName.focus()
      logLine('先选择或输入一个学科分类，再建子目录。', 'err')
      return
    }
    var names = state.course.dirs.map(function (d) { return d.name })
    var dir = { name: name || defaultDirName(names), files: [] }
    state.course.dirs.push(dir)
    state.activeDir = dir
    renderAll()
    els.dirTitle.focus()
    els.dirTitle.select()
  }

  function addFilesToActive(entries) {
    if (state.running || !entries.length) return
    if (!state.activeDir) addDir()
    // addDir 可能因为"还没选学科分类"拒绝建目录（它会自己给日志和焦点），这时别往下走
    if (!state.activeDir) return
    state.activeDir.files = state.activeDir.files.concat(entries)
    refreshStatus()
    logLine('已添加 ' + entries.length + ' 个文件到「' + (state.activeDir.name || '未命名子目录') + '」')
    ensureIndex()
  }

  /* 队列 → CSV 行：落点、状态、站内 id、失败原因一次给全，传断了自己核对。 */
  function csvRows() {
    var rows = []
    if (!state.course) return rows
    var dirs = state.course.dirs || []
    for (var i = 0; i < dirs.length; i++) {
      var dir = dirs[i]
      var files = dir.files || []
      for (var j = 0; j < files.length; j++) {
        var e = files[j]
        rows.push({
          relPath: e.relPath,
          category: state.course.name,
          subCategory: dir.name,
          status: e.status,
          id: e.id || '',
          error: e.error || ''
        })
      }
    }
    return rows
  }

  function downloadCsv() {
    var rows = csvRows()
    if (!rows.length) { logLine('还没有文件可以导出：先添加或上传一些文件。', 'err'); return }
    var blob = new Blob([exportCsv(rows)], { type: 'text/csv;charset=utf-8' })
    var url = URL.createObjectURL(blob)
    var a = document.createElement('a')
    var stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')
    a.href = url
    a.download = 'upcshare-投递结果-' + safeSegment(state.course.name) + '-' + stamp + '.csv'
    document.body.appendChild(a)
    a.click()
    a.remove()
    setTimeout(function () { URL.revokeObjectURL(url) }, 4000)
    logLine('已导出 ' + rows.length + ' 行 CSV（落点 / 状态 / 站内 id / 失败原因）。')
  }

  function retryEntry(entry) {
    if (state.running || !state.activeDir) return
    var targets = [targetFrom(state.course, state.activeDir, entry)]
    runTargets(targets).catch(handleRunError)
  }

  function handleRunError(err) {
    state.running = false
    els.stop.hidden = true
    state.controller = null
    // 兜底：异常路径上没走到状态回填的文件，一律落回 failed，别留在 running
    var stuck = 0
    courseFiles().forEach(function (f) {
      if (f.status === 'running') { f.status = 'failed'; f.error = '已中断'; stuck++ }
    })
    if (stuck) logLine(stuck + ' 个未完成的任务已标为失败，可以重试。', 'err')
    if (state.fullscreen) logLine('投递中断：' + err.message, 'err')
    refreshStatus()
  }

  /* ---------------- 导入与索引 ---------------- */

  function entriesFromFiles(fileList) {
    var entries = []
    for (var i = 0; i < fileList.length; i++) {
      var f = fileList[i]
      if (!f || typeof f.size !== 'number') continue
      entries.push({
        file: f,
        name: f.name,
        size: f.size,
        relPath: f.webkitRelativePath || f.name,
        status: 'ready'
      })
    }
    return entries
  }

  function ensureIndex() {
    if (state.index) {
      applyIndex(state.index)
      return Promise.resolve(state.index)
    }
    if (state.indexPromise) return state.indexPromise
    state.indexLoading = true
    updateQueue()
    state.indexPromise = loadSiteIndex().then(function (index) {
      state.index = index
      state.indexLoading = false
      applyIndex(index)
      var dup = 0
      courseFiles().forEach(function (f) { if (f.status === 'dup' || f.status === 'dupname') dup++ })
      logLine('站内索引读取完成：' + (index.stats.approved || 0) + ' 条记录' +
        (dup ? '，其中 ' + dup + ' 个文件疑似已存在' : ''), dup ? 'err' : 'ok')
      if (dup) logLine('已存在的文件默认会被跳过；需要覆盖时在「上传设置」里取消勾选。')
      return index
    }).catch(function (err) {
      logLine('读取站内索引失败：' + err.message + '（不影响上传，只是无法自动查重）', 'err')
      state.index = { byKey: {}, byName: {}, stats: {}, subsByCategory: {} }
      state.indexLoading = false
      state.indexPromise = null     // 失败的那份 promise 不能留着，否则以后永远拿到这个空索引
      applyIndex(state.index)
      return state.index
    })
    return state.indexPromise
  }

  function applyIndex(index) {
    state.subsByCategory = (index && index.subsByCategory) || {}
    state.course.dirs.forEach(function (dir) {
      dir.files.forEach(function (entry) {
        // done / running 是本轮的事实；failed 是用户看得见的结论，重新分类不能把它抹掉
        if (entry.status === 'done' || entry.status === 'running' || entry.status === 'failed') return
        entry.status = classify(entry, index, scopeKey(state.course.name, dir.name))
      })
    })
    refreshStatus()
  }

  function courseHasFiles() {
    return state.course.dirs.some(function (d) { return d.files.length > 0 })
  }

  function applyImport(groups, courseName) {
    if (!groups.length) return
    courseName = courseName == null ? groups[0].category : courseName
    if (courseHasFiles() && normalizeText(state.course.name) !== normalizeText(courseName)) {
      if (!window.confirm('当前学科分类已有文件。导入「' + (courseName || '未指定学科分类') + '」会替换当前学科分类，继续？')) return
    }
    if (!state.course.name || normalizeText(state.course.name) !== normalizeText(courseName)) {
      state.course = { name: courseName || '', dirs: [] }
      state.activeDir = null
      state.courseFocusName = courseName || ''
    }
    groups.forEach(function (g) {
      if (normalizeText(g.category) !== normalizeText(courseName)) return
      upsertDir(state.course, g.subCategory, g.files)
    })
    ensureRootDir(state.course)
    if (!state.activeDir) state.activeDir = state.course.dirs[0] || null
    renderAll()
    logLine('已导入 ' + groups.reduce(function (n, g) { return n + g.files.length }, 0) +
      ' 个文件，' + state.course.dirs.length + ' 个子目录。')
    ensureIndex()
  }

  function showChooser(groups) {
    var cats = []
    groups.forEach(function (g) {
      var key = normalizeText(g.category)
      if (!cats.some(function (c) { return normalizeText(c) === key })) cats.push(g.category)
    })
    els.chooserList.innerHTML = ''
    cats.forEach(function (cat) {
      var count = 0
      groups.forEach(function (g) { if (normalizeText(g.category) === normalizeText(cat)) count += g.files.length })
      var b = document.createElement('button')
      b.type = 'button'
      b.className = 'upc-chooser-item'
      var name = document.createElement('b')
      name.textContent = cat || '未指定学科分类'
      var meta = document.createElement('span')
      meta.textContent = count + ' 个文件'
      b.appendChild(name)
      b.appendChild(meta)
      b.addEventListener('click', function () {
        els.chooser.hidden = true
        applyImport(groups, cat)
      })
      els.chooserList.appendChild(b)
    })
    els.chooser.hidden = false
  }

  // 选完文件夹先给一次"看得见规模"的确认，确认后才落到工作台
  var pendingImport = null

  /* FileSystemEntry → 普通节点树。readEntries 一次最多给 100 条，必须循环读到空为止，
   * 否则超过 100 个文件的文件夹会被悄悄截断。 */
  function entryToNode(entry) {
    if (!entry) return Promise.resolve(null)
    if (entry.isFile) {
      return new Promise(function (res) {
        entry.file(function (f) { res({ name: entry.name, isDirectory: false, file: f }) },
          function () { res(null) })
      })
    }
    if (!entry.isDirectory) return Promise.resolve(null)
    var reader = entry.createReader()
    var collected = []
    function readBatch() {
      return new Promise(function (res) {
        reader.readEntries(function (list) {
          if (!list || !list.length) { res(collected); return }
          collected = collected.concat(list)
          res(readBatch())
        }, function () { res(collected) })
      })
    }
    return readBatch().then(function (kids) {
      return Promise.all(kids.map(entryToNode)).then(function (nodes) {
        var keep = nodes.filter(function (n) { return !!n })
        return { name: entry.name, isDirectory: true, children: keep }
      })
    })
  }

  /* 拖进来的是文件还是文件夹：
   * 只有文件 → 照旧塞进当前子目录；含文件夹 → 走「从文件夹导入」那条识别链路，
   * 因为用户拖文件夹的意图就是"按这个结构分好类"，不是"把它们塞进当前这个子目录"。
   * webkitGetAsEntry() 必须在 drop 事件的同步阶段调用，回到异步再取全是 null。 */
  function receiveDrop(dataTransfer) {
    if (!dataTransfer) return
    var entries = []
    var items = dataTransfer.items ? Array.prototype.slice.call(dataTransfer.items) : []
    for (var i = 0; i < items.length; i++) {
      if (items[i].kind !== 'file' || !items[i].webkitGetAsEntry) continue
      var e = items[i].webkitGetAsEntry()
      if (e) entries.push(e)
    }
    var hasDir = entries.some(function (e) { return e.isDirectory })
    if (!hasDir) {
      var plain = entriesFromFiles(dataTransfer.files)
      if (plain.length) addFilesToActive(plain)
      else logLine('没收到文件；要传文件夹请整个拖进虚线框。', 'err')
      return
    }
    logLine('正在展开拖进来的文件夹…')
    Promise.all(entries.map(entryToNode)).then(function (nodes) {
      var files = flattenDropTree(nodes.filter(function (n) { return !!n }))
      if (!files.length) { logLine('拖进来的文件夹里没有文件。', 'err'); return }
      importFiles(files)
    }).catch(function (err) {
      logLine('展开文件夹失败：' + (err && err.message ? err.message : err), 'err')
    })
  }

  function importFiles(fileList) {
    var entries = entriesFromFiles(fileList)
    if (!entries.length) return
    var groups = buildGroups(entries, state.categories)
    var cats = []
    groups.forEach(function (g) {
      var key = normalizeText(g.category)
      if (!cats.some(function (c) { return normalizeText(c) === key })) cats.push(g.category)
    })
    // 多门学科分类直接进学科分类选择弹层，那里已经带了分类整理的提醒
    if (cats.length > 1) {
      showChooser(groups)
      return
    }
    var dirs = {}
    groups.forEach(function (g) { dirs[normalizeText(g.subCategory)] = true })
    pendingImport = { groups: groups }
    els.folderConfirmText.innerHTML = '检测到 <b>' + entries.length + '</b> 个文件、<b>' +
      Object.keys(dirs).length + '</b> 个子目录，将生成学科分类「<b>' + esc(groups[0].category || '未指定') +
      '</b>」。<br>请确认文件夹已完成分类整理。'
    els.folderConfirm.hidden = false
  }

  function closeImportConfirm() {
    pendingImport = null
    if (els && els.folderConfirm) els.folderConfirm.hidden = true
  }

  /* ---------- 整理规范弹层 ---------- */

  function openHelp() {
    els.helpBody.textContent = ORGANIZE_PROMPT
    els.helpWarn.hidden = true
    els.helpCopy.textContent = '复制 prompt'
    els.helpMask.hidden = false
    els.helpCopy.focus()
  }

  function closeHelp() {
    if (els && els.helpMask) els.helpMask.hidden = true
  }

  function copyPrompt() {
    els.helpWarn.hidden = true
    writeClipboard(ORGANIZE_PROMPT).then(function (ok) {
      if (ok) {
        els.helpCopy.textContent = '已复制到剪贴板'
        setTimeout(function () { els.helpCopy.textContent = '复制 prompt' }, 2500)
        return
      }
      // 复制不出去时至少把正文选中，用户按 Ctrl+C 就行
      els.helpWarn.hidden = false
      selectText(els.helpBody)
    })
  }

  /** 优先剪贴板 API；非安全上下文或被拒时退回临时 textarea + execCommand */
  function writeClipboard(text) {
    if (navigator.clipboard && window.isSecureContext) {
      return navigator.clipboard.writeText(text).then(
        function () { return true },
        function () { return legacyCopy(text) }
      )
    }
    return Promise.resolve(legacyCopy(text))
  }

  function legacyCopy(text) {
    try {
      var ta = document.createElement('textarea')
      ta.value = text
      ta.setAttribute('readonly', '')
      ta.style.cssText = 'position:fixed;top:0;left:0;opacity:0'
      document.body.appendChild(ta)
      ta.select()
      var ok = document.execCommand('copy')
      document.body.removeChild(ta)
      return ok
    } catch (e) {
      return false
    }
  }

  function selectText(node) {
    if (!node || !window.getSelection) return
    var range = document.createRange()
    range.selectNodeContents(node)
    var sel = window.getSelection()
    sel.removeAllRanges()
    sel.addRange(range)
  }

  /* ---------------- 上传 ---------------- */

  function sleep(ms) {
    return new Promise(function (resolve) { setTimeout(resolve, ms) })
  }

  function runBatch() {
    if (state.running) return
    var targets = collectCourseTargets(state.course, els.skipDup.checked)
    if (!targets.length) return
    runTargets(targets).catch(handleRunError)
  }

  function runDir(dir) {
    dir = dir || state.activeDir
    if (state.running || !dir) return
    if (!safeSegment(state.course.name)) {
      logLine('请先填写或选择学科分类名称，才能上传。', 'err')
      els.courseName.focus()
      return
    }
    var targets = collectDirTargets(state.course, dir, els.skipDup.checked)
    if (!targets.length) return
    runTargets(targets).catch(handleRunError)
  }

  async function runTargets(targets) {
    if (!targets.length) return
    var autoApprove = els.autoApprove.checked && state.me && state.me.is_admin
    var dryRun = els.dryRun.checked

    state.running = true
    state.cancelled = false
    state.logPinned = true
    state.controller = new AbortController()
    els.stop.hidden = false
    renderLog()
    updateQueue()

    var totalBytes = targets.reduce(function (sum, t) { return sum + (Number(t.entry.size) || 0) }, 0)
    setProgress({ doneBytes: 0, totalBytes: totalBytes, doneFiles: 0, totalFiles: targets.length, current: '' })

    var pacer = new Pacer(PACE.burst, PACE.intervalMs)
    var processed = 0
    if (dryRun) logLine('试运行：只检查，不会真正上传任何文件。')

    for (var i = 0; i < targets.length; i++) {
      processed++
      if (state.cancelled) break
      var group = targets[i].group
      var entry = targets[i].entry
      var category = safeSegment(group.category)
      var subCategory = safeSegment(group.subCategory)
      if (!category) { entry.status = 'badname'; refreshStatus(); continue }

      if (dryRun) {
        entry.status = 'ready'
        logLine('将上传：' + entry.relPath + ' → ' + category + '/' + subCategory)
        setProgress({ doneFiles: i + 1, doneBytes: state.progress.doneBytes + (Number(entry.size) || 0), current: entry.name })
        continue
      }

      entry.status = 'running'
      refreshStatus()
      logLine('上传中：' + entry.relPath + ' → ' + category + '/' + (subCategory || '(无子目录)'))

      var attempt = 0
      var ok = false
      while (!ok && attempt < 4 && !state.cancelled) {
        attempt++
        try {
          await pacer.take()
          if (state.cancelled) break
          setProgress({ current: entry.name })
          var result = await uploadFile(entry, category, subCategory, function (loaded) {
            setProgress({ current: entry.name + '（' + formatSize(loaded) + '/' + formatSize(entry.size) + '）' })
          }, state.controller.signal)

          entry.id = result.id
          entry.status = 'done'
          if (autoApprove) {
            try {
              await approveFile(result.id)
              logLine('✓ 已上传并审核通过：' + entry.name, 'ok')
            } catch (approveError) {
              logLine('✓ 已上传，但自动审核失败：' + entry.name + '（' + approveError.message + '）', 'err')
            }
          } else {
            logLine('✓ 已上传（待审核）：' + entry.name, 'ok')
          }
          if (state.index) {
            var upScope = scopeKey(group.category, group.subCategory)
            state.index.byKey[dedupeKey(entry.name, entry.size, upScope)] = true
            state.index.byName[nameKey(entry.name, upScope)] = true
          }
          ok = true
        } catch (err) {
          if (err.aborted || state.cancelled) {
            // 中断也要把状态落回 failed：留在 running 会让这个文件再也进不了待传队列，
            // 还会让所在子目录被 dirHasUploaded() 判成"站内已有"而锁死改名/移除
            entry.status = 'failed'
            entry.error = '已停止'
            throw err
          }
          var status = err.status || 0
          var retryable = status === 0 || status === 429 || status === 502 || status === 503 || status === 504 || status >= 500
          logLine('✗ ' + entry.name + ' 失败：' + err.message + (retryable ? '（' + attempt + '/4，重试中）' : ''), 'err')
          if (!retryable) { entry.status = 'failed'; entry.error = err.message; break }
          if (attempt >= 4) { entry.status = 'failed'; entry.error = err.message; break }
          await sleep(status === 429 ? 15000 * attempt : 4000 * attempt)
        }
      }
      if (!ok && entry.status !== 'failed') {
        entry.status = 'failed'
        entry.error = state.cancelled ? '已停止' : '多次重试仍失败'
      }

      setProgress({ doneFiles: i + 1, doneBytes: state.progress.doneBytes + (Number(entry.size) || 0), current: entry.name })
      refreshStatus()
      await sleep(250)
    }

    state.running = false
    els.stop.hidden = true
    state.controller = null
    updateQueue()

    var done = 0
    targets.forEach(function (t) { if (t.entry.status === 'done') done++ })
    if (state.cancelled) {
      logLine('已停止。本轮处理 ' + processed + '/' + targets.length + '，可随时再传。', 'err')
    } else if (dryRun) {
      logLine('试运行结束：检查了 ' + processed + ' 个文件，没有上传。', 'ok')
    } else {
      logLine('本轮结束：完成 ' + done + '/' + targets.length + '，可以在站点「待审核」里复查。', 'ok')
    }
  }

  /* ============================ 事件绑定 ============================ */

  var els = null
  // 组合框要的"当前学科"代理；clearCourse 也要通过它把下拉的内部状态清掉
  var courseProxy = { category: '' }

  async function openPanel() {
    if (state.fullscreen && els && !els.overlay.hidden) return
    closeMenu()
    state.fullscreen = true
    var nav = document.querySelector('.navbar')
    var navH = nav ? Math.round(nav.getBoundingClientRect().height) : 52
    els.overlay.style.top = navH + 'px'
    els.overlay.style.setProperty('--upc-nav', navH + 'px')
    els.overlay.classList.add('upc-full')
    els.panel.classList.add('upc-full')
    els.overlay.hidden = false
    state.courseFocusName = state.course.name
    closeImportConfirm()
    try { state.me = await apiJson('/api/auth/me') } catch (e) { state.me = { logged_in: false } }
    if (!state.me || !state.me.logged_in) { renderAll(); return }
    var admin = !!(state.me && state.me.is_admin)
    els.approveWrap.hidden = !admin
    els.autoApprove.disabled = !admin
    if (!admin) els.autoApprove.checked = false
    // 「已有资源」是管理员专属：能看到站内文件列表，也能删
    els.siteToggle.hidden = !admin
    if (!admin) state.showSite = false
    if (!state.categories.length) {
      try { state.categories = await apiJson('/api/categories') } catch (e) { state.categories = [] }
      state.categories.sort(function (a, b) { return String(a).localeCompare(String(b), 'zh') })
    }
    if (!state.subcategories.length) {
      try { state.subcategories = await apiJson('/api/subcategories') } catch (e) { state.subcategories = [] }
    }
    renderAll()
  }

  function resetUploader() {
    if (state.running && state.controller) {
      state.cancelled = true
      try { state.controller.abort() } catch (e) {}
    }
    state.running = false
    state.cancelled = false
    state.controller = null
    state.course = { name: '', dirs: [] }
    state.activeDir = null
    state.courseFocusName = ''
    state.logLines = []
    state.logPinned = false
    state.progress = { doneBytes: 0, totalBytes: 0, doneFiles: 0, totalFiles: 0, current: '' }
    els.stop.hidden = true
    els.progress.hidden = true
    els.log.hidden = true
    els.run.hidden = true
    els.pbarFill.style.width = '0%'
    els.pText.textContent = ''
    els.pCount.textContent = ''
    els.settings.hidden = true
    els.chooser.hidden = true
    closeImportConfirm()
    state.showSite = false
    state.siteFiles = { key: '', items: null, loading: false, error: '' }
    state.pendingDelete = null
    els.siteToggle.classList.remove('on')
    renderAll()
  }

  function closePanel(reset) {
    closeMenu()
    state.fullscreen = false
    els.overlay.classList.remove('upc-full')
    els.panel.classList.remove('upc-full')
    els.overlay.hidden = true
    els.overlay.style.top = ''
    if (reset) resetUploader()
  }

  // 站点是 SPA，内容脚本拿不到 Vue Router，也 hook 不到主世界的 pushState。
  // 所以只读地址栏来同步：进 /admin 打开面板，离开就关闭并清空，
  // 下次再点「上传资料」回到初始状态。
  function isUploadRoute() { return /^\/admin\/?$/.test(location.pathname) }

  function syncWithRoute() {
    if (isUploadRoute()) { if (!state.fullscreen) openPanel() }
    else if (state.fullscreen) closePanel(true)
  }

  function bind(shadow) {
    els = buildPanel(shadow)

    // courseProxy 声明在模块作用域：clearCourse 也要用它把组合框的内部状态清掉

    // 「换一门课」和「给当前课改名」是两件事：换课要清空子目录并按站内实际情况重建，
    // 改名只动字符串。判断基准是「进输入框时的学科分类名」，不是实时值 ——
    // 因为点下拉之前一定先打字改过 state.course.name，拿实时值比会永远判定成"没换课"。
    function switchCourse(value) {
      var base = state.courseFocusName
      var prev = state.course.name
      if (normalizeText(value) === normalizeText(base)) {
        // 绕回原来那门课：只是改名，子目录还是它的，不用重建
        state.course.name = value
        courseProxy.category = value
        renderAll()
        return
      }
      if (state.course.dirs.length || courseFiles().length) {
        if (!window.confirm('切换到「' + (value || '未命名') + '」会清空当前 ' + state.course.dirs.length +
          ' 个子目录、' + courseFiles().length + ' 个文件。是否继续？')) {
          els.courseName.value = prev
          courseProxy.category = prev
          renderAll()
          return
        }
      }
      startCourse(value)
    }

    /* 手打全名也要带出站内已有的子目录（含"文件直接挂在学科分类下"的根目录）。
     * 之前只有从下拉里点一项才走 startCourse，打字回车 / 失焦只算改名——
     * 于是站内明明有若干子目录，左栏却只剩一个空的「新子目录」，看起来就像"根目录没显示"。
     * 判定用 courseFocusName（进输入框时记的名字），和"换课 vs 改名"那条规则同一把尺子。 */
    function commitTypedCourse() {
      var value = String(els.courseName.value || '').trim()
      var key = normalizeText(value)
      if (!key || key === normalizeText(state.courseFocusName)) return
      var hit = ''
      for (var i = 0; i < state.categories.length; i++) {
        if (normalizeText(state.categories[i]) === key) { hit = state.categories[i]; break }
      }
      if (!hit) return                       // 站没这个名字 → 仍是"新建"，别拦用户
      els.courseName.value = hit
      switchCourse(hit)
    }
    els.courseName._commitTyped = commitTypedCourse
    // 200ms：给"点了下拉某一项"留出先跑 chooseEntry 的时间，那条路会把 courseFocusName 更新掉，这里就自动跳过
    els.courseName.addEventListener('blur', function () { setTimeout(commitTypedCourse, 200) })

    bindCombo(els.courseName, 'category', courseProxy, function (value, how) {
      if (how === 'pick') { switchCourse(value); return }
      state.course.name = value
      courseProxy.category = value
      renderCourseBar()
      updateQueue()
      if (how === 'pick') { renderRail(); renderWork() }
    })

    var dirProxy = { category: '', subCategory: '' }
    // 改名提示要在组合框打开「之前」就出现，否则下拉会按"没有这一行"的高度定位，把说明挡住
    var renameFrom = ''
    els.dirTitle.addEventListener('focus', function (event) {
      renameFrom = state.activeDir ? state.activeDir.name : ''
      dirProxy.category = state.course.name
      if (state.activeDir) dirProxy.subCategory = state.activeDir.name
      // 不能改名的子目录：不亮提示、不展开下拉，点了就当没看见
      if (els.dirTitle.readOnly) {
        els.work.classList.remove('rename')
        event.stopImmediatePropagation()
        return
      }
      els.work.classList.add('rename')
    })
    els.dirTitle.addEventListener('blur', function () {
      els.work.classList.remove('rename')
      var to = state.activeDir ? state.activeDir.name : ''
      if (normalizeText(to) === normalizeText(renameFrom)) return
      logLine(to ? '子目录名已改成「' + to + '」，本次上传会落到这个子目录。'
                 : '子目录名已清空，本次上传会直接挂在学科分类下。', 'ok')
    })
    // 回车 = 收工：让输入框失焦，触发上面的确认并留下一行记录
    els.dirTitle.addEventListener('keydown', function (event) {
      if (event.key === 'Enter') { event.preventDefault(); els.dirTitle.blur() }
    })
    bindCombo(els.dirTitle, 'subCategory', dirProxy, function (value, how) {
      if (!state.activeDir) return
      state.activeDir.name = value
      if (state.activeDir._railName) state.activeDir._railName.textContent = value || '根目录'
      if (how === 'pick') renderRail()
      // 「已有资源」是按子目录查的，改名后必须重查，否则标题写着新名字、列的是旧子目录的文件
      if (state.showSite) loadSite()
      updateQueue()
    })


    // 「上传资料」本来就跳 /admin：把跳转交给站点自己（手感、地址、路由完全一致），
    // 这里只在点击瞬间先把面板盖上去，避免站点原版上传表单一闪而过。
    document.addEventListener('click', function (event) {
      if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return
      var link = event.target && event.target.closest ? event.target.closest('a.nav-link') : null
      if (!link || (link.textContent || '').trim() !== '上传资料') return
      openPanel()
    }, true)

    window.addEventListener('popstate', syncWithRoute)
    var lastPath = location.pathname
    setInterval(function () {
      if (location.pathname === lastPath) return
      lastPath = location.pathname
      syncWithRoute()
    }, 300)
    syncWithRoute()

    // 整理规范弹层：点遮罩或按 Esc 都能关，和站点其它对话框的习惯一致
    els.helpMask.addEventListener('click', function (event) {
      if (event.target === els.helpMask) closeHelp()
    })
    document.addEventListener('keydown', function (event) {
      if (event.key === 'Escape' && els.helpMask && !els.helpMask.hidden) closeHelp()
    })

    els.menu.addEventListener('mousedown', function (event) { event.preventDefault() })
    // 点面板任何地方（⋯ 菜单内部除外）都先收掉子目录菜单
    els.menu.addEventListener('click', function (event) {
      var item = event.target.closest('[data-idx]')
      if (!item) return
      chooseEntry(combo.entries[Number(item.getAttribute('data-idx'))])
    })
    els.settings.addEventListener('click', function (event) { event.stopPropagation() })
    els.settingsBtn.addEventListener('click', function (event) {
      event.stopPropagation()
      els.settings.hidden = !els.settings.hidden
    })
    els.overlay.addEventListener('click', function () { els.settings.hidden = true })

    els.panel.addEventListener('click', function (event) {
      var act = event.target.closest('[data-act]')
      if (!act) return
      var name = act.getAttribute('data-act')
      // 子目录行上的「上传 / 删除」用各自的监听器处理（要带上是哪一行），这里只认面板级动作
      if (name === 'addDir') addDir()
      else if (name === 'clearCourse') clearCourse()
      else if (name === 'openHelp') openHelp()
      else if (name === 'closeHelp') closeHelp()
      else if (name === 'copyPrompt') copyPrompt()
      else if (name === 'uploadDir') { /* 由子目录行自己的监听器处理 */ }
      else if (name === 'toggleSite') toggleSiteFiles()
      else if (name === 'exportCsv') downloadCsv()
      else if (name === 'pickFolder') {
        // 直接开系统选择器；确认放在选完之后（看得见文件数和学科分类数）
        els.folderPicker.click()
      } else if (name === 'confirmImport') {
        var pending = pendingImport
        closeImportConfirm()
        if (pending && pending.groups.length) applyImport(pending.groups, pending.groups[0].category)
      } else if (name === 'cancelImport') {
        closeImportConfirm()
        logLine('已取消导入。')
      } else if (name === 'start') {
        runBatch()
      } else if (name === 'stop') {
        state.cancelled = true
        if (state.controller) state.controller.abort()
        logLine('正在停止…', 'err')
      }
    })

    els.courseName.addEventListener('focus', function () {
      courseProxy.category = state.course.name
      state.courseFocusName = state.course.name
    })

    els.folderPicker.addEventListener('change', function (event) {
      var files = event.target.files
      if (files && files.length) importFiles(files)
      event.target.value = ''
    })
    // 手打换课：失焦时名字和刚进输入框时不一样，就要说清楚"这些子目录会跟过去"。
    // 命中站内学科分类 → 按换课处理（确认 + 重建）；没命中 → 只是改名，但改了名也要确认一次，
    // 否则拼错一个字符就把 A 课的文件当成 B 课传上去了。
    els.courseName.addEventListener('blur', function () {
      if (state.running) return
      var value = String(els.courseName.value || '').trim()
      var before = String(state.courseFocusName || '').trim()
      if (!value || normalizeText(value) === normalizeText(before)) return
      if (state.categories.some(function (c) { return normalizeText(c) === normalizeText(value) })) {
        switchCourse(value)
        return
      }
      if ((state.course.dirs.length || courseFiles().length) &&
        !window.confirm('这些子目录和文件会跟着改挂到「' + value + '」下，共 ' +
          state.course.dirs.length + ' 个子目录、' + courseFiles().length + ' 个文件。确认这个学科分类名没写错？')) {
        els.courseName.value = before
        courseProxy.category = before
        state.course.name = before
        renderAll()
      }
    })

    els.filePicker.addEventListener('change', function (event) {
      var entries = entriesFromFiles(event.target.files)
      event.target.value = ''
      if (entries.length) addFilesToActive(entries)
    })
    els.drop.addEventListener('click', function () { els.filePicker.click() })

    ;['dragenter', 'dragover'].forEach(function (name) {
      els.drop.addEventListener(name, function (event) {
        event.preventDefault()
        els.drop.classList.add('on')
      })
    })
    els.drop.addEventListener('dragleave', function () { els.drop.classList.remove('on') })
    els.drop.addEventListener('drop', function (event) {
      event.preventDefault()
      els.drop.classList.remove('on')
      receiveDrop(event.dataTransfer)
    })

    // 拖偏了别把整页导航掉：面板范围内一律阻止默认，只在虚线框里收文件
    els.overlay.addEventListener('dragover', function (event) { event.preventDefault() })
    els.overlay.addEventListener('drop', function (event) {
      event.preventDefault()
      if (event.target.closest && event.target.closest('[data-el="drop"]')) return
      if (event.dataTransfer && event.dataTransfer.files.length) {
        logLine('要拖到虚线框「将文件拖放到此处」里才会收进来。', 'err')
      }
    })

    els.refresh.addEventListener('click', function () {
      if (state.running) return
      state.index = null
      // 必须连 indexPromise 一起清掉：否则 ensureIndex() 会一直命中那个已 resolve 的旧 promise，
      // 刷新等于没刷，新加的文件永远走不到查重
      state.indexPromise = null
      state.indexLoading = true
      updateQueue()
      loadSiteIndex().then(function (index) {
        state.index = index
        state.indexLoading = false
        applyIndex(index)
        logLine('站内索引已刷新。', 'ok')
      }).catch(function (err) {
        state.indexLoading = false
        state.index = null
        updateQueue()
        logLine('刷新失败：' + err.message + '（这轮无法自动查重）', 'err')
      })
    })

    els.skipDup.addEventListener('change', updateQueue)
    els.settings.addEventListener('change', updateQueue)
    els.chooserCancel.addEventListener('click', function () { els.chooser.hidden = true })
    window.addEventListener('resize', closeMenu)

    // Shadow DOM 里的元素拿不到页面 :root 上的自定义属性，所以把站点的 token
    // 读出来一次性写进面板自己那套变量上——换主题时再读一遍，保证颜色永远同源。
    var TOKEN_MAP = {
      '--bg': '--surface', '--fg': '--text-primary', '--muted': '--text-secondary',
      '--line': '--border', '--accent': '--accent', '--accent-hover': '--accent-hover',
      '--accent-soft': '--accent-light', '--danger': '--danger'
    }

    function applySiteTokens() {
      var cs = getComputedStyle(document.documentElement)
      var filled = 0
      Object.keys(TOKEN_MAP).forEach(function (mine) {
        var value = String(cs.getPropertyValue(TOKEN_MAP[mine]) || '').trim()
        if (!value) return
        els.panel.style.setProperty(mine, value)
        filled++
      })
      // 软底色取"比 surface 更暗/更亮一档"的页面底色；拿不到就保留 CSS 里的默认值
      if (!filled) return
      var soft = String(cs.getPropertyValue('--bg') || '').trim()
      if (soft) {
        els.panel.style.setProperty('--soft', soft)
        els.overlay.style.setProperty('--page-bg', soft)
      }
    }

    function syncTheme() {
      var dark = document.documentElement.dataset.theme === 'dark'
      els.panel.classList.toggle('dark', dark)
      els.overlay.classList.toggle('upc-dark', dark)
      applySiteTokens()
    }
    syncTheme()
    new MutationObserver(syncTheme).observe(document.documentElement, {
      attributes: true, attributeFilter: ['data-theme']
    })
  }


  /* ============================ 入口 ============================ */

  if (typeof globalThis !== 'undefined') {
    globalThis.__UPC_BATCH__ = {
      extOf: extOf,
      isAllowedName: isAllowedName,
      hasBadName: hasBadName,
      formatSize: formatSize,
      normalizeText: normalizeText,
      matchScore: matchScore,
      bestCategory: bestCategory,
      fuzzyFilter: fuzzyFilter,
      dirOptions: dirOptions,
      dirsFromItems: dirsFromItems,
      dirHasUploaded: dirHasUploaded,
      canRenameDir: canRenameDir,
      splitRelativePath: splitRelativePath,
      safeSegment: safeSegment,
      dedupeKey: dedupeKey,
      nameKey: nameKey,
      scopeKey: scopeKey,
      classify: classify,
      buildGroups: buildGroups,
      upsertDir: upsertDir,
      defaultDirName: defaultDirName,
      ensureRootDir: ensureRootDir,
      flattenDropTree: flattenDropTree,
      csvCell: csvCell,
      exportCsv: exportCsv,
      ALLOWED_EXT: ALLOWED_EXT,
      ORGANIZE_PROMPT: ORGANIZE_PROMPT,
      ORGANIZE_PROMPT_LINES: ORGANIZE_PROMPT_LINES,
      collectDirTargets: collectDirTargets,
      collectCourseTargets: collectCourseTargets,
      Pacer: Pacer
    }
  }

  if (typeof document === 'undefined') return  // Node 里跑单测时到此为止

  function boot() {
    if (document.getElementById('upcshare-batch-host')) return
    var shadow = createHost()
    bind(shadow)
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot, { once: true })
  } else {
    boot()
  }
})()
