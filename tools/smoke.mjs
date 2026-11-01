/* upcshare 批量投递 · 端到端冒烟测试（Node 24，CDP 驱动无头 Chrome）
 *
 * 前置：无头 Chrome 已启动并监听 9333（用 tools/headless.ps1 会自动处理）。
 *
 * 用法（在项目根目录）：
 *   .\tools\headless.ps1 -User <账号> -Password '...'
 */
const PORT = process.env.CDP_PORT || '9333'
const USER = process.env.UPC_USER
const PASSWORD = process.env.UPC_PASSWORD
// 探针文件名每轮唯一：站点的文件列表有短时缓存，上一轮刚删掉的文件可能在下一轮的索引里
// 还留着，固定名字会被判成"已存在"，导致「全部上传（0）」这种假失败。
// 清理和"站点无残留"仍然按前缀查——那样连历史遗留一起扫掉，红线才守得住。
const PROBE_PREFIX = '___plugin_probe'
const PROBE_NAME = `${PROBE_PREFIX}_${new Date().toTimeString().slice(0, 8).replace(/:/g, '')}___.txt`
const PROBE_CATEGORY = '__demo_test__'
// 4d 只用来验"没选学科分类就建不出子目录"，不会传上去（第 5 步导入会换掉这门课）
const MANUAL_CATEGORY = '__manual_stage__'

if (!USER || !PASSWORD) {
  console.error('缺少 UPC_USER / UPC_PASSWORD 环境变量')
  process.exit(2)
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function pageTarget() {
  const res = await fetch(`http://127.0.0.1:${PORT}/json/list`)
  const list = await res.json()
  const page = list.find((t) => t.type === 'page' && String(t.url).includes('upcshare.cn'))
  if (!page) throw new Error('找不到 upcshare 页面，Chrome 是否已启动？')
  return page
}

function connect(url) {
  const ws = new WebSocket(url)
  let seq = 0
  const pending = new Map()
  ws.onmessage = (event) => {
    const msg = JSON.parse(event.data)
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id)
      pending.delete(msg.id)
      if (msg.error) reject(new Error(JSON.stringify(msg.error)))
      else resolve(msg.result)
    }
  }
  const ready = new Promise((resolve, reject) => {
    ws.onopen = resolve
    ws.onerror = () => reject(new Error('CDP WebSocket 连接失败'))
  })
  const send = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const id = ++seq
      pending.set(id, { resolve, reject })
      ws.send(JSON.stringify({ id, method, params }))
    })
  return { ws, ready, send }
}

function evaluate(client, expression) {
  return client.send('Runtime.evaluate', {
    expression,
    awaitPromise: true,
    returnByValue: true,
    userGesture: true
  }).then((result) => {
    if (result.exceptionDetails) {
      const d = result.exceptionDetails
      throw new Error('页面执行出错：' + (d.exception ? d.exception.description : d.text))
    }
    return result.result.value
  })
}

const S = 'document.getElementById("upcshare-batch-host").shadowRoot'
const check = (name, ok, detail) => {
  console.log((ok ? '  ok  ' : ' FAIL ') + name + (detail ? '  → ' + detail : ''))
  if (!ok) throw new Error('断言失败：' + name)
}

let mainClient = null
async function main() {
  const client = (mainClient = connect((await pageTarget()).webSocketDebuggerUrl))
  await client.ready
  await client.send('Runtime.enable')
  await client.send('Page.enable')
  // 面板里有几处 window.confirm（换学科分类、导入覆盖、删子目录），无头环境里必须自动接受，否则会卡住
  client.ws.addEventListener('message', (event) => {
    const msg = JSON.parse(event.data)
    if (msg.method === 'Page.javascriptDialogOpening') {
      client.send('Page.handleJavaScriptDialog', { accept: true }).catch(() => {})
    }
  })
  await client.send('Emulation.setDeviceMetricsOverride', {
    width: 1280, height: 900, deviceScaleFactor: 1, mobile: false
  })

  console.log('1) 扩展注入')
  // 页面上可能已经有一个面板（上一轮残留的浏览器、或真人 Chrome 里装着扩展）。
  // 那种情况下"跳过注入"就等于在测别的副本——看着全过，其实测的是旧代码。
  // 所以：先把页面重新加载一遍（顺带把旧实例的定时器一起清掉），再注入仓库里这一份，
  // 并把"注入的是哪一份"写进日志，让每次运行都自带证据。
  const { readFileSync } = await import('node:fs')
  const { createHash } = await import('node:crypto')
  const source = readFileSync(new URL('../content.js', import.meta.url), 'utf8')
  const manifest = JSON.parse(readFileSync(new URL('../manifest.json', import.meta.url), 'utf8'))
  await client.send('Page.navigate', { url: 'https://in.upcshare.cn/' })
  for (let i = 0; i < 40; i++) {
    await sleep(250)
    if (await evaluate(client, `!!document.querySelector('#app')`)) break
  }
  const stale = await evaluate(client, `!!document.getElementById('upcshare-batch-host')`)
  if (stale) {
    await evaluate(client, `(() => { const h = document.getElementById('upcshare-batch-host'); if (h) h.remove(); return true })()`)
    console.log('    页面上已有面板（残留浏览器或已装扩展）→ 已拆掉，改注入工作副本')
  }
  await evaluate(client, source)
  const injected = await evaluate(client, `(() => {
    const h = document.getElementById('upcshare-batch-host')
    return !!h && !!h.shadowRoot.querySelector('.upc-panel')
  })()`)
  console.log('    注入的是工作副本 content.js（v' + manifest.version + '，' + source.length +
    ' 字节，sha ' + createHash('sha256').update(source).digest('hex').slice(0, 12) + '）')
  check('shadow host 已注入页面', injected === true)

  console.log('2) 登录（页面内 fetch，与插件使用同一份 Cookie）')
  const login = await evaluate(client, `(async () => {
    const res = await fetch('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: ${JSON.stringify(USER)}, password: ${JSON.stringify(PASSWORD)} })
    })
    return { status: res.status, body: await res.json() }
  })()`)
  check('登录成功', login.status === 200 && login.body.ok === true, JSON.stringify(login.body))

  console.log('3) 导航「上传资料」打开全屏上传页')
  let navBox = null
  for (let i = 0; i < 15; i++) {
    navBox = await evaluate(client, `(() => {
      const a = [...document.querySelectorAll('a.nav-link')].find((x) => x.textContent.trim() === '上传资料')
      if (!a) return null
      const r = a.getBoundingClientRect()
      return { x: r.left + r.width / 2, y: r.top + r.height / 2, w: r.width, h: r.height, href: a.getAttribute('href') }
    })()`)
    if (navBox && navBox.w > 0 && navBox.h > 0) break
    await sleep(200)
  }
  check('找到导航链接', !!navBox && navBox.href === '/admin', JSON.stringify(navBox))
  await client.send('Input.dispatchMouseEvent', {
    type: 'mousePressed', x: navBox.x, y: navBox.y, button: 'left', clickCount: 1
  })
  await client.send('Input.dispatchMouseEvent', {
    type: 'mouseReleased', x: navBox.x, y: navBox.y, button: 'left', clickCount: 1
  })
  await sleep(1200)
  const layout = await evaluate(client, `(() => {
    const S = ${S}
    const nav = document.querySelector('.navbar')
    const overlay = S.querySelector('.upc-overlay')
    const panel = S.querySelector('.upc-panel')
    return {
      open: !overlay.hidden,
      full: panel.classList.contains('upc-full'),
      path: location.pathname,
      approveVisible: !S.querySelector('[data-el="approveWrap"]').hidden,
      navH: nav ? Math.round(nav.getBoundingClientRect().height) : 0,
      navVisible: !!nav && nav.getBoundingClientRect().height > 0,
      overlayTop: Math.round(parseFloat(getComputedStyle(overlay).top) || 0),
      panelW: Math.round(panel.getBoundingClientRect().width),
      panelH: Math.round(panel.getBoundingClientRect().height),
      viewportH: innerHeight,
      panelBare: getComputedStyle(panel).backgroundColor === 'rgba(0, 0, 0, 0)',
      railCard: getComputedStyle(S.querySelector('.upc-rail')).borderTopWidth !== '0px',
      viewportW: innerWidth
    }
  })()`)
  check('上传页已打开', layout.open && layout.full && layout.path === '/admin', JSON.stringify(layout))
  check('保留顶部导航且内容未拉满',
    layout.navVisible && layout.overlayTop >= layout.navH - 1 && layout.panelW < layout.viewportW,
    JSON.stringify(layout))
  check('管理员可见「自动通过审核」', layout.approveVisible === true)
  check('融入站点：外层卡片拆掉，内容按站点样式分块',
    layout.panelBare === true && layout.railCard === true, JSON.stringify(layout))
  check('纵向铺满：内容少时也不留半屏空白',
    layout.panelH >= layout.viewportH - layout.navH - 60,
    '面板高 ' + layout.panelH + ' / 可用 ' + (layout.viewportH - layout.navH))

  // 切到资料库：上传页应关闭并重置，再点上传资料回到初始页
  const shelfBox = await evaluate(client, `(() => {
    const a = [...document.querySelectorAll('a.nav-link')].find((x) => x.textContent.trim() === '资料库')
    const r = a.getBoundingClientRect()
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 }
  })()`)
  await client.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: shelfBox.x, y: shelfBox.y, button: 'left', clickCount: 1 })
  await client.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: shelfBox.x, y: shelfBox.y, button: 'left', clickCount: 1 })
  await sleep(1000)
  const leftPage = await evaluate(client, `({ open: !${S}.querySelector('.upc-overlay').hidden, path: location.pathname })`)
  check('切换页面自动关闭上传页', !leftPage.open && leftPage.path !== '/admin', JSON.stringify(leftPage))

  const nav2 = await evaluate(client, `(() => {
    const a = [...document.querySelectorAll('a.nav-link')].find((x) => x.textContent.trim() === '上传资料')
    const r = a.getBoundingClientRect()
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 }
  })()`)
  await client.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: nav2.x, y: nav2.y, button: 'left', clickCount: 1 })
  await client.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: nav2.x, y: nav2.y, button: 'left', clickCount: 1 })
  await sleep(1000)

  console.log('4) 打开就是工作台：空状态已并入，引导在工作区里')
  const merged = await evaluate(client, `(() => {
    const S = ${S}
    const panel = S.querySelector('.upc-panel')
    return {
      noEmptyView: !S.querySelector('.upc-empty') && !panel.classList.contains('empty'),
      courseInput: !!S.querySelector('[data-el="courseName"]'),
      importBtn: !!S.querySelector('[data-act="pickFolder"]'),
      guide: !S.querySelector('[data-el="workEmpty"]').hidden,
      guideText: S.querySelector('[data-el="workEmpty"]').textContent,
      course: S.querySelector('[data-el="courseName"]').value,
      dirs: S.querySelectorAll('.upc-dir').length,
      startDisabled: S.querySelector('[data-act="start"]').disabled,
      clearHidden: S.querySelector('[data-el="courseClear"]').hidden,
      addDirDisabled: S.querySelector('[data-act="addDir"]').disabled
    }
  })()`)
  check('空状态已并入工作台',
    merged.noEmptyView && merged.courseInput && merged.importBtn && merged.guide &&
      merged.course === '' && merged.dirs === 0, JSON.stringify(merged))
  check('未选学科分类时引导可见，「上传」和「新建子目录」都禁用',
    /还没有子目录/.test(merged.guideText) && merged.startDisabled &&
      merged.addDirDisabled === true && merged.clearHidden === true, JSON.stringify(merged))

  console.log('4b) 学科分类下拉：全量、在输入框下方、可滚轮浏览')
  const combo = await evaluate(client, `(async () => {
    const S = ${S}
    const pick = S.querySelector('[data-el="courseName"]')
    pick.focus()
    await new Promise((r) => setTimeout(r, 400))
    const menu = S.querySelector('.upc-menu')
    const cs = getComputedStyle(menu)
    const cats = await fetch('/api/categories').then((r) => r.json())
    const out = {
      open: !menu.hidden,
      items: S.querySelectorAll('.upc-menu-item').length,
      cats: Array.isArray(cats) ? cats.length : -1,
      overflow: cs.overflowY,
      maxH: Math.round(parseFloat(cs.maxHeight) || 0),
      scrollable: menu.scrollHeight > menu.clientHeight,
      below: Math.round(menu.getBoundingClientRect().top - pick.getBoundingClientRect().bottom)
    }
    pick.blur()
    return out
  })()`)
  check('学科分类下拉列出全部学科分类', combo.open && combo.cats > 0 && combo.items >= combo.cats,
    '下拉 ' + combo.items + ' 项 / 站内 ' + combo.cats + ' 个学科分类')
  check('下拉出现在输入框下方且可滚轮查看',
    combo.below >= 0 && /auto|scroll/.test(combo.overflow) && combo.maxH <= 260 && combo.scrollable,
    JSON.stringify(combo))

  console.log('4bb) 「不知道怎么整理本地文件夹？」弹层：内容、复制反馈、关闭')
  const help = await evaluate(client, `(async () => {
    const S = ${S}
    S.querySelector('[data-act="openHelp"]').click()
    await new Promise((r) => setTimeout(r, 200))
    const mask = S.querySelector('[data-el="helpMask"]')
    const opened = mask.hidden === false        // 必须在关闭之前记，否则读到的是关上的状态
    const card = mask.querySelector('.upc-chooser-card')
    const body = S.querySelector('[data-el="helpBody"]').textContent
    const copyBtn = mask.querySelector('[data-el="helpCopy"]')
    const buttons = Array.prototype.slice.call(mask.querySelectorAll('.upc-help-actions button'))
      .map((b) => b.textContent.trim())
    const focusOn = copyBtn.textContent.trim()
    // 复制：无头环境里剪贴板可能被拒，两条路（成功 / 手动提示）都算通过
    copyBtn.click()
    await new Promise((r) => setTimeout(r, 400))
    const copied = S.querySelector('[data-el="helpCopy"]').textContent.trim()
    const warn = !S.querySelector('[data-el="helpWarn"]').hidden
    S.querySelector('[data-act="closeHelp"]').click()
    await new Promise((r) => setTimeout(r, 200))
    return {
      open: opened,
      labelled: card.getAttribute('role') === 'dialog' && !!card.getAttribute('aria-labelledby'),
      template: body.indexOf('<学科分类>/<子目录>/<文件>') >= 0,
      rules: body.indexOf('200MB') >= 0 && /姓名|学号/.test(body),
      buttons: buttons.join('|'),
      focusOn: focusOn,
      copyFeedback: /已复制/.test(copied) || warn,
      closed: mask.hidden === true
    }
  })()`)
  check('整理规范弹层能打开，正文含目录模板与关键规则',
    help.open && help.labelled && help.template && help.rules, JSON.stringify(help))
  check('弹层下方是「我知道了」和「复制 prompt」，打开时焦点在复制按钮上',
    help.buttons === '我知道了|复制 prompt' && help.focusOn === '复制 prompt', JSON.stringify(help))
  check('复制有反馈（成功文案或手动复制提示），「我知道了」能关闭',
    help.copyFeedback === true && help.closed === true, JSON.stringify(help))

  console.log('4b2) 课程栏两个盒子（学科分类输入框 / 从文件夹导入）几何与样式一致')
  const boxes = await evaluate(client, `(() => {
    const S = ${S}
    const pick = (sel) => {
      const n = S.querySelector(sel)
      if (!n) return null
      const r = n.getBoundingClientRect(), c = getComputedStyle(n)
      return { h: Math.round(r.height), top: Math.round(r.top), radius: c.borderTopLeftRadius,
        border: c.borderTopWidth + ' ' + c.borderTopStyle + ' ' + c.borderTopColor,
        bg: c.backgroundColor, font: c.fontSize, weight: c.fontWeight, color: c.color }
    }
    return { input: pick('.upc-course'), browse: pick('[data-act="pickFolder"]') }
  })()`)
  const sameBox = (k) => boxes.input && boxes.browse && boxes.input[k] === boxes.browse[k]
  check('课程栏两个盒子同高、同基线、同圆角、同描边、同底色、同字号字重字色',
    sameBox('h') && sameBox('top') && sameBox('radius') && sameBox('border') && sameBox('bg') &&
      sameBox('font') && sameBox('weight') && sameBox('color'),
    JSON.stringify(boxes))

  console.log('4b3) 整个面板的盒子只有两档（主操作 / 次级），圆角一律 8px')
  // 「已有资源」那颗要等有子目录才出现，放到第 10 步再量
  const tiers = await evaluate(client, `(() => {
    const S = ${S}
    const pick = (sel) => {
      const n = S.querySelector(sel)
      if (!n) return null
      const r = n.getBoundingClientRect(), c = getComputedStyle(n)
      return { h: Math.round(r.height), radius: c.borderTopLeftRadius, font: c.fontSize, weight: c.fontWeight }
    }
    return {
      primary: ['.upc-course', '[data-act="pickFolder"]', '.upc-btn.primary'].map(pick),
      secondary: ['.upc-settings-btn', '.upc-add-dir'].map(pick)
    }
  })()`)
  const tierOK = (list, h, font, weight) => list.every((x) => x && x.h === h &&
    x.radius === '8px' && x.font === font && x.weight === weight)
  check('主操作 35px/15px·600、次级 34px/13px·500，圆角全是 8px',
    tierOK(tiers.primary, 35, '15px', '600') && tierOK(tiers.secondary, 34, '13px', '500'),
    JSON.stringify(tiers))

  console.log('4b5) 字号只有四档：20（页面标题）/ 15（区块与主操作）/ 13（正文）/ 12（辅助）')
  const sizes = await evaluate(client, `(() => {
    const S = ${S}
    const found = {}
    S.querySelectorAll('*').forEach(function (n) {
      // <style> 里也有文本节点，但它不渲染，别算进字号
      if (n.tagName === 'STYLE' || n.tagName === 'SCRIPT' || n.tagName === 'TITLE') return
      var own = Array.prototype.some.call(n.childNodes, function (c) {
        return c.nodeType === 3 && c.textContent.trim()
      })
      if (!own) return
      var fs = getComputedStyle(n).fontSize
      found[fs] = (found[fs] || 0) + 1
    })
    return found
  })()`)
  const ALLOWED = ['20px', '15px', '13px', '12px']
  const strays = Object.keys(sizes).filter((k) => ALLOWED.indexOf(k) < 0)
  check('面板里出现的字号全部落在四档内（多出来的字号会被列出来）',
    strays.length === 0 && ALLOWED.every((k) => sizes[k]),
    '实测 ' + JSON.stringify(sizes) + '；越界 ' + JSON.stringify(strays))

  console.log('4b4) 「?」徽标：贴在导入按钮右上角、有 tooltip 文案、键盘可达、点开规范弹层')
  const badge = await evaluate(client, `(() => {
    const S = ${S}
    const b = S.querySelector('.upc-help-btn')
    const importBtn = S.querySelector('[data-act="pickFolder"]')
    const tip = S.querySelector('.upc-help-tip')
    if (!b || !importBtn || !tip) return { missing: true }
    const br = b.getBoundingClientRect(), ir = importBtn.getBoundingClientRect()
    const tc = getComputedStyle(tip)
    return {
      text: b.textContent.trim(),
      label: b.getAttribute('aria-label'),
      // 徽标要压在导入按钮的右上角：上边越过去、水平方向落在按钮范围内
      anchored: br.top < ir.top && br.right > ir.right - 4 && br.left < ir.right,
      size: [Math.round(br.width), Math.round(br.height)],
      round: getComputedStyle(b).borderTopLeftRadius,
      tipText: tip.textContent.trim(),
      tipHiddenByDefault: tc.opacity === '0',
      focusable: b.tabIndex >= 0 && b.tagName === 'BUTTON'
    }
  })()`)
  check('「?」徽标压在导入按钮右上角，默认收起、文案是「查看文件夹导入规范」',
    badge.missing !== true && badge.text === '?' && badge.label === '查看文件夹导入规范' &&
      badge.anchored === true && badge.round === '50%' && badge.tipText === '查看文件夹导入规范' &&
      badge.tipHiddenByDefault === true && badge.focusable === true,
    JSON.stringify(badge))
  // 用真的 Tab 键走焦：programmatic .focus() 不算 :focus-visible（Chrome 只给键盘发起的聚焦加这个伪类），
  // 直接 focus() 再读 tooltip 会假失败。
  await evaluate(client, `(() => { ${S}.querySelector('[data-act="pickFolder"]').focus(); return true })()`)
  for (let i = 0; i < 3; i++) {
    await client.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 })
    await client.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 })
    await sleep(200)
    if (await evaluate(client, `(() => { const S = ${S}
      // 面板在 Shadow DOM 里：document.activeElement 只给到宿主元素，真正的答案在 shadowRoot.activeElement
      return S.activeElement === S.querySelector('.upc-help-btn') })()`)) break
  }
  const tipShown = await evaluate(client, `(() => {
    const S = ${S}
    const tip = S.querySelector('.upc-help-tip')
    return JSON.stringify({
      focused: S.activeElement === S.querySelector('.upc-help-btn'),
      opacity: getComputedStyle(tip).opacity
    })
  })()`)
  const ts = JSON.parse(tipShown)
  check('键盘 Tab 能走到「?」，聚焦时 tooltip 浮出（不只靠鼠标）',
    ts.focused === true && Number(ts.opacity) > 0.9, tipShown)

  console.log('4c) 没选学科分类时不给建子目录（子目录必须挂在某个学科分类下面）')
  const blocked = await evaluate(client, `(() => {
    const S = ${S}
    const add = S.querySelector('[data-act="addDir"]')
    add.click()
    return {
      disabled: add.disabled,
      title: add.title,
      dirs: S.querySelectorAll('.upc-dir').length,
      hintShown: !S.querySelector('[data-el="courseHint"]').hidden
    }
  })()`)
  check('没选学科分类：新建子目录禁用、点不出目录、也不会弹一行像报错的提示',
    blocked.disabled === true && /先选择或输入/.test(blocked.title) &&
      blocked.dirs === 0 && blocked.hintShown === false, JSON.stringify(blocked))

  console.log('4d) 输入一个学科分类之后才解禁；连点两下默认名要分得开')
  await evaluate(client, `(() => {
    const S = ${S}
    const input = S.querySelector('[data-el="courseName"]')
    input.focus()
    input.value = ${JSON.stringify(MANUAL_CATEGORY)}
    input.dispatchEvent(new Event('input', { bubbles: true }))
    return true
  })()`)
  await sleep(300)
  const unlocked = await evaluate(client, `(() => {
    const S = ${S}
    const add = S.querySelector('[data-act="addDir"]')
    add.click()
    add.click()
    return {
      disabled: add.disabled,
      names: Array.prototype.slice.call(S.querySelectorAll('.upc-dir-name')).map((n) => n.textContent)
    }
  })()`)
  check('选了学科分类后新建子目录解禁，且两个空子目录的默认名不同（新子目录 / 新子目录 2）',
    // 第一行固定是「根目录」（v0.3.31 起），比对后面新建的两行
    unlocked.disabled === false && unlocked.names.slice(-2).join('|') === '新子目录|新子目录 2',
    JSON.stringify(unlocked))
  await evaluate(client, `(() => {
    const S = ${S}
    const title = S.querySelector('[data-el="dirTitle"]')
    title.value = '手工子目录'
    title.dispatchEvent(new Event('input', { bubbles: true }))
    title.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    const dt = new DataTransfer()
    dt.items.add(new File(['x'], 'staged.txt', { type: 'text/plain' }))
    const fp = S.querySelector('#upc-file-picker')
    fp.files = dt.files
    fp.dispatchEvent(new Event('change', { bubbles: true }))
    return true
  })()`)
  await sleep(500)
  const staged = await evaluate(client, `(() => {
    const S = ${S}
    return {
      dirs: S.querySelectorAll('.upc-dir').length,
      files: S.querySelectorAll('.upc-file').length,
      names: [...S.querySelectorAll('.upc-dir-name')].map((n) => n.textContent),
      hintShown: !S.querySelector('[data-el="courseHint"]').hidden,
      dirUploadDisabled: S.querySelector('[data-act="uploadDir"]').disabled
    }
  })()`)
  check('有学科分类就能正常整理：两个子目录（外加常驻的「根目录」）、文件进当前目录、提示行不出现',
    staged.dirs === 3 && staged.files === 1 && staged.hintShown === false &&
      staged.dirUploadDisabled === false, JSON.stringify(staged))

  console.log('5) 从文件夹导入 → 看得见规模的确认 → 落到工作台')
  await evaluate(client, `(() => {
    const input = ${S}.querySelector('#upc-picker')
    const dt = new DataTransfer()
    const f = new File(['plugin smoke test'], ${JSON.stringify(PROBE_NAME)}, { type: 'text/plain' })
    Object.defineProperty(f, 'webkitRelativePath', {
      value: ${JSON.stringify(PROBE_CATEGORY + '/' + PROBE_NAME)}
    })
    dt.items.add(f)
    input.files = dt.files
    input.dispatchEvent(new Event('change', { bubbles: true }))
    return input.files.length
  })()`)
  await sleep(500)
  const confirmBox = await evaluate(client, `(() => {
    const S = ${S}
    const box = S.querySelector('[data-el="folderConfirm"]')
    return { shown: !box.hidden, text: S.querySelector('[data-el="folderConfirmText"]').textContent }
  })()`)
  check('导入前出现确认弹层（含文件数与学科分类名）',
    confirmBox.shown && /个文件/.test(confirmBox.text) && confirmBox.text.includes(PROBE_CATEGORY),
    JSON.stringify(confirmBox))
  await evaluate(client, `${S}.querySelector('[data-act="confirmImport"]').click()`)
  await sleep(600)

  let dirCount = 0
  for (let i = 0; i < 30; i++) {
    await sleep(500)
    dirCount = await evaluate(client, `${S}.querySelectorAll('.upc-dir').length`)
    const loading = await evaluate(client, `${S}.querySelector('[data-act="start"]').disabled`)
    if (dirCount > 0 && !loading) break
  }
  const imported = await evaluate(client, `(() => {
    const S = ${S}
    return {
      course: S.querySelector('[data-el="courseName"]').value,
      dirs: S.querySelectorAll('.upc-dir').length,
      files: S.querySelectorAll('.upc-file').length,
      names: [...S.querySelectorAll('.upc-dir-name')].map((n) => n.textContent),
      start: S.querySelector('[data-act="start"]').textContent,
      startDisabled: S.querySelector('[data-act="start"]').disabled,
      clearShown: !S.querySelector('[data-el="courseClear"]').hidden
    }
  })()`)
  check('自动识别出学科分类', imported.course === PROBE_CATEGORY, imported.course)
  check('选了学科分类后输入框右端出现清除用的小红 ×', imported.clearShown === true, JSON.stringify(imported))
  // 探针文件是直接挂在学科分类下的，所以导入后那一行就是常驻的「根目录」
  check('文件进入当前子目录（这一行正是「根目录」）',
    imported.dirs === 1 && imported.files === 1 && imported.names[0] === '根目录', JSON.stringify(imported))
  check('全部上传按钮可用', imported.start.includes('1') && !imported.startDisabled, imported.start)

  console.log('5a) 拖进一个三层文件夹：必须走「从文件夹导入」的识别链路，而不是塞进当前子目录')
  const dropped = await evaluate(client, `(async () => {
    const S = ${S}
    const dir = (name, kids) => ({
      name: name, isDirectory: true, isFile: false,
      createReader: function () {
        var sent = false
        return { readEntries: function (ok) { if (sent) { ok([]); return } sent = true; ok(kids) } }
      }
    })
    const file = (name) => ({ name: name, isDirectory: false, isFile: true, file: function (ok) { ok(new File(['x'], name)) } })
    // 故意做三层：学科分类 / 子目录 / 再一层，验证递归与"第三层折进子目录名"
    const tree = dir('${PROBE_CATEGORY}', [
      dir('拖拽实验', [file('拖进来的 1.pdf'), file('拖进来的 2.pdf')]),
      dir('课件', [dir('第一章', [file('slides.pptx')])])
    ])
    const zone = S.querySelector('[data-el="drop"]')
    const dt = { items: [{ kind: 'file', webkitGetAsEntry: function () { return tree } }], files: [] }
    const ev2 = new Event('drop', { bubbles: true, cancelable: true })
    ev2.dataTransfer = dt
    zone.dispatchEvent(ev2)
    await new Promise((r) => setTimeout(r, 900))
    const box = S.querySelector('[data-el="folderConfirm"]')
    const text = box ? box.textContent : ''
    // 必须在点「取消」之前记下可见性：取消会把这块收起来，之后再读永远是 hidden
    const shown = box ? box.hidden === false : false
    const dirsBefore = S.querySelectorAll('.upc-dir').length
    const filesBefore = S.querySelectorAll('.upc-file').length
    // 看清规模了就取消：这一步不能往生产站留任何东西
    const cancel = S.querySelector('[data-act="cancelImport"]')
    if (cancel) cancel.click()
    await new Promise((r) => setTimeout(r, 300))
    return {
      shown: shown,
      counts: /3/.test(text) && /个文件/.test(text) && /个学科分类|个子目录|学科分类/.test(text),
      unchanged: S.querySelectorAll('.upc-dir').length === dirsBefore &&
        S.querySelectorAll('.upc-file').length === filesBefore
    }
  })()`)
  check('拖入文件夹弹出「看得见规模」的确认（3 个文件）',
    dropped.shown === true && dropped.counts === true, JSON.stringify(dropped))
  check('取消后工作台没被改动（拖拽本身不产生副作用）', dropped.unchanged === true, JSON.stringify(dropped))

  console.log('5b) 新建子目录并重命名')
  await evaluate(client, `${S}.querySelector('[data-act="addDir"]').click()`)
  await evaluate(client, `(() => {
    const S = ${S}
    const title = S.querySelector('[data-el="dirTitle"]')
    title.value = '手工测试子目录'
    title.dispatchEvent(new Event('input', { bubbles: true }))
    title.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
  })()`)
  await sleep(200)
  const added = await evaluate(client, `(() => {
    const S = ${S}
    return {
      dirs: S.querySelectorAll('.upc-dir').length,
      names: [...S.querySelectorAll('.upc-dir-name')].map((n) => n.textContent)
    }
  })()`)
  check('新建子目录出现在左侧', added.dirs === 2 && added.names.includes('手工测试子目录'), added.names.join(' / '))
  // 下拉只能在"本次新建、还没传过"的子目录上打开：根目录与站内已有目录都是只读的（v0.3.33 起根目录也不给改名）。
  // 所以挑最后一行（刚建的「手工测试子目录」）来量下拉内容。
  const dirPool = await evaluate(client, `(async () => {
    const S = ${S}
    const rows = [...S.querySelectorAll('.upc-dir')]
    rows[rows.length - 1].click()
    await new Promise((r) => setTimeout(r, 250))
    const t = S.querySelector('[data-el="dirTitle"]')
    t.blur()                       // 新建子目录时焦点还在这里，先移开才能让 focus 真的触发
    t.focus()
    await new Promise((r) => setTimeout(r, 350))
    const items = Array.prototype.slice.call(S.querySelectorAll('.upc-menu-item')).map((i) => i.textContent.trim())
    const menu = S.querySelector('.upc-menu').getBoundingClientRect()
    const tip = S.querySelector('.upc-rename-tip').getBoundingClientRect()
    t.blur()
    return { items: items, covered: menu.top < tip.bottom && menu.bottom > tip.top }
  })()`)
  check('子目录下拉只给本分类的子目录，不掺全站',
    dirPool.items.join('|') === '手工测试子目录', JSON.stringify(dirPool.items))
  check('子目录下拉不挡改名说明', dirPool.covered === false, JSON.stringify(dirPool))
  await evaluate(client, `(() => {
    const S = ${S}
    var rows = S.querySelectorAll('.upc-dir')
    rows[rows.length - 1].click()
    return true
  })()`)
  await sleep(250)

  // 行右侧不再是「⋯ 更多操作」，而是一颗两段式垃圾桶：
  // 第一次点击只"武装"（摇一下 + 底色加深），第二次才真删
  const trash = await evaluate(client, `(async () => {
    const S = ${S}
    const rows = [...S.querySelectorAll('.upc-dir')]
    rows[rows.length - 1].click()
    await new Promise((r) => setTimeout(r, 250))
    // 点行会重画左栏，旧节点已经脱离文档：必须重新查一遍，否则量到的是个空壳（computed 全空）
    const fresh = [...S.querySelectorAll('.upc-dir')]
    const last = fresh[fresh.length - 1]
    const btn = last.querySelector('.upc-dir-del')
    const before = S.querySelectorAll('.upc-dir').length
    const first = { exists: !!btn, disabled: btn ? btn.disabled : null,
      armed: btn ? btn.classList.contains('armed') : null,
      label: btn ? btn.getAttribute('aria-label') : null,
      icon: btn ? !!btn.querySelector('svg') : null,
      bgIdle: btn ? getComputedStyle(btn).backgroundColor : '' }
    if (btn) btn.click()
    await new Promise((r) => setTimeout(r, 200))
    const armed = { count: S.querySelectorAll('.upc-dir').length,
      cls: btn ? btn.classList.contains('armed') : null,
      title: btn ? btn.title : '',
      bg: btn ? getComputedStyle(btn).backgroundColor : '' }
    if (btn) btn.click()
    await new Promise((r) => setTimeout(r, 400))
    return { first: first, before: before, armed: armed, after: S.querySelectorAll('.upc-dir').length }
  })()`)
  check('子目录行右侧是垃圾桶按钮（SVG 图标 + aria-label，未禁用）',
    trash.first.exists === true && trash.first.disabled === false && trash.first.icon === true &&
      trash.first.label === '删除这个子目录' && trash.first.armed === false,
    JSON.stringify(trash.first))
  check('第一次点击只"武装"：不删行，底色加深并提示再点一次',
    trash.armed.count === trash.before && trash.armed.cls === true && /再点一次/.test(trash.armed.title) &&
      trash.armed.bg !== trash.first.bgIdle, JSON.stringify(trash))
  check('第二次点击才真删除这个子目录', trash.after === trash.before - 1, JSON.stringify(trash))

  // 子目录行上的「上传」每行一个，只有当前子目录那颗可见——测试要点的就是它
  const visibleUpload = `Array.prototype.slice.call(${S}.querySelectorAll('[data-act="uploadDir"]')).filter((b) => !b.hidden)[0]`

  console.log('6) 试运行')
  await evaluate(client, `${S}.querySelector('[data-el="dryRun"]').click()`)
  await evaluate(client, `(${visibleUpload}).click()`)
  await sleep(1500)
  const dryLog = await evaluate(client, `${S}.querySelector('[data-el="log"]').textContent`)
  check('试运行日志出现', dryLog.includes('试运行'), dryLog.split('\n').slice(-2).join(' | '))
  check('试运行列出将上传的文件', dryLog.includes(PROBE_NAME))

  console.log('7) 单子目录上传 + 自动通过审核')
  await evaluate(client, `${S}.querySelector('[data-el="dryRun"]').click()`)
  await evaluate(client, `${S}.querySelector('[data-el="autoApprove"]').click()`)
  await sleep(200)
  // 复选框在 disabled 状态下 .click() 是空操作（上一轮的竞态就是这么静默失败的），
  // 所以先把"勾上了"当成一条独立断言，没勾上就再点一次，别让后面的失败查不到原因。
  let checked = await evaluate(client, `!!${S}.querySelector('[data-el="autoApprove"]').checked`)
  if (!checked) {
    await evaluate(client, `${S}.querySelector('[data-el="autoApprove"]').click()`)
    await sleep(300)
    checked = await evaluate(client, `!!${S}.querySelector('[data-el="autoApprove"]').checked`)
  }
  check('「投递后自动通过审核」已勾选', checked === true, 'checked=' + checked)
  await sleep(200)
  for (let i = 0; i < 20; i++) {
    const ready = await evaluate(client, `!(${visibleUpload}).disabled`)
    if (ready) break
    await sleep(200)
  }
  await evaluate(client, `(${visibleUpload}).click()`)

  let logText = ''
  for (let i = 0; i < 40; i++) {
    await sleep(500)
    logText = await evaluate(client, `${S}.querySelector('[data-el="log"]').textContent`)
    if (logText.includes('审核通过') || logText.includes('失败')) break
  }
  check('上传并自动审核通过', logText.includes('审核通过'), logText.split('\n').slice(-2).join(' | '))

  console.log('8) 校验站内状态')
  const found = await evaluate(client, `(async () => {
    const res = await fetch('/api/files?q=' + encodeURIComponent(${JSON.stringify(PROBE_NAME)}) + '&size=5')
    const data = await res.json()
    return data.items.map((i) => ({ id: i.id, status: i.status, category: i.category, sub: i.sub_category, size: i.file_size }))
  })()`)
  check('前台可见且已通过', found.length === 1 && found[0].status === 'approved', JSON.stringify(found))
  check('学科/子目录按面板填写落库', found[0] && found[0].category === PROBE_CATEGORY, JSON.stringify(found[0]))

  console.log('8a) 导出投递结果（CSV）：拦下 Blob 与 a.click，按字节核对 BOM 与表头')
  const csv = await evaluate(client, `(async () => {
    const S = ${S}
    const btn = S.querySelector('[data-act="exportCsv"]')
    if (!btn) return { missing: true }
    const disabledWhileEmpty = btn.disabled
    let blob = null
    const names = []
    const origUrl = URL.createObjectURL
    const origClick = HTMLAnchorElement.prototype.click
    URL.createObjectURL = function (b) { blob = b; return origUrl.call(URL, b) }
    HTMLAnchorElement.prototype.click = function () { names.push(this.download) }
    btn.click()
    await new Promise((r) => setTimeout(r, 500))
    URL.createObjectURL = origUrl
    HTMLAnchorElement.prototype.click = origClick
    if (!blob) return { missing: false, empty: true, disabledWhileEmpty: disabledWhileEmpty }
    // BOM 必须按字节看：Blob.text() 解码时会把它吃掉，量出来是个假失败
    const bytes = new Uint8Array(await blob.arrayBuffer())
    // ignoreBOM:true 会把 BOM 留在字符串里（我们要按字节验它），比表头前记得先去掉
    const text = new TextDecoder('utf-8', { ignoreBOM: true }).decode(bytes).replace(/^\uFEFF/, '')
    return {
      bom: [bytes[0], bytes[1], bytes[2]].join('-'),
      header: text.split('\\r\\n')[0],
      rows: text.trim().split('\\r\\n').length - 1,
      name: names[0] || '',
      type: blob.type
    }
  })()`)
  check('「导出投递结果（CSV）」给出带 UTF-8 BOM 的 CSV，表头与行数对得上',
    csv.missing !== true && csv.bom === '239-187-191' &&
      csv.header === 'relPath,category,sub_category,status,id,error' &&
      csv.rows >= 1 && /^upcshare-投递结果-.*\.csv$/.test(csv.name) &&
      /text\/csv/.test(csv.type), JSON.stringify(csv))

  console.log('8b) 站内已有的子目录：不给改名也不给"删除子目录"（站点没有这两个操作）')
  const locked = await evaluate(client, `(async () => {
    const S = ${S}
    const t = S.querySelector('[data-el="dirTitle"]')
    t.blur()
    t.focus()
    t.click()
    await new Promise((r) => setTimeout(r, 300))
    const menu = S.querySelector('.upc-menu')
    const state = {
      readOnly: t.readOnly,
      meta: S.querySelector('[data-el="dirMeta"]').textContent,
      tipShown: getComputedStyle(S.querySelector('[data-el="renameTip"]')).display !== 'none',
      dropdownOpened: !menu.hidden,
      locked: S.querySelector('[data-el="work"]').classList.contains('locked')
    }
    t.blur()
    // 要量的是当前这门站内子目录那一行：第一行永远是常驻的「根目录」，它的提示是另一句
    const del = S.querySelector('.upc-dir.on .upc-dir-del') || S.querySelector('.upc-dir-del')
    state.trashDisabled = del ? del.disabled : null
    state.trashTitle = del ? del.title : ''
    return state
  })()`)
  check('站内已有的子目录：名称只读、无提示无下拉（v0.3.30 起 meta 行不再重复写"不可改名"）',
    locked.readOnly === true && locked.locked === true && locked.dropdownOpened === false &&
      locked.tipShown === false && !/不可改名/.test(locked.meta) && /个文件/.test(locked.meta),
    JSON.stringify(locked))
  check('站内已有的子目录：垃圾桶是禁用的，并就地说明为什么删不掉',
    locked.trashDisabled === true && /删不掉/.test(locked.trashTitle),
    JSON.stringify({ d: locked.trashDisabled, t: locked.trashTitle }))

  console.log('9) 「已有资源」：管理员能看到站内文件，并能两步确认删除')
  await evaluate(client, `${S}.querySelector('[data-el="siteToggle"]').click()`)
  let siteRows = []
  for (let i = 0; i < 20; i++) {
    await sleep(400)
    siteRows = await evaluate(client, `Array.prototype.slice.call(${S}.querySelectorAll('.upc-site-row')).map((r) => r.textContent)`)
    if (siteRows.some((t) => t.includes(PROBE_NAME))) break
  }
  check('已有资源列出了站内该子目录的文件',
    siteRows.length === 1 && siteRows[0].includes(PROBE_NAME), JSON.stringify(siteRows))
  const siteBtn = await evaluate(client, `(() => {
    const n = ${S}.querySelector('.upc-toggle')
    const r = n.getBoundingClientRect(), c = getComputedStyle(n)
    return { h: Math.round(r.height), radius: c.borderTopLeftRadius, font: c.fontSize, weight: c.fontWeight }
  })()`)
  check('「已有资源」也是次级档（34px / 8px / 13px·500）',
    siteBtn.h === 34 && siteBtn.radius === '8px' && siteBtn.font === '13px' && siteBtn.weight === '500',
    JSON.stringify(siteBtn))
  await evaluate(client, `(${S}.querySelectorAll('.upc-site-row button')[0]).click()`)
  await sleep(300)
  const armed = await evaluate(client, `${S}.querySelector('.upc-site-row button').textContent`)
  check('删除要先点一次确认', armed.includes('确认'), armed)
  await evaluate(client, `(${S}.querySelector('.upc-site-row button')).click()`)
  let gone = false
  for (let i = 0; i < 20; i++) {
    await sleep(400)
    gone = await evaluate(client, `(${S}.querySelectorAll('.upc-site-row').length) === 0`)
    if (gone) break
  }
  check('确认后站内文件被删除', gone)
  const left = await evaluate(client, `(async () => {
    const res = await fetch('/api/files?q=' + encodeURIComponent(${JSON.stringify(PROBE_PREFIX)}) + '&size=20')
    return (await res.json()).total
  })()`)
  check('站点无残留（按前缀扫，含历史遗留）', left === 0, '剩余 ' + left)

  console.log('9b) 手打全名（不点下拉）也要带出站内已有子目录与「根目录」')
  const typed = await evaluate(client, `(async () => {
    const S = ${S}
    const cats = await (await fetch('/api/categories?size=200')).json()
    const names = (cats.items || cats || []).map((c) => c.name || c)
    let target = ''
    for (const name of names) {
      const d = await (await fetch('/api/files?category=' + encodeURIComponent(name) + '&size=20&page=1')).json()
      const items = (d && d.items) || []
      // 找一门"有文件直接挂在学科分类下"的课：这类课最容易暴露根目录没显示的问题
      if (items.some((i) => !String(i.sub_category || '').trim())) { target = name; break }
    }
    if (!target) return { none: true }
    S.querySelector('[data-act="clearCourse"]').click()
    await new Promise((r) => setTimeout(r, 400))
    const input = S.querySelector('[data-el="courseName"]')
    input.focus()
    input.value = target
    input.dispatchEvent(new Event('input', { bubbles: true }))
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    await new Promise((r) => setTimeout(r, 3500))
    return {
      target: target,
      value: input.value,
      shown: [...S.querySelectorAll('.upc-dir-name')].map((n) => n.textContent)
    }
  })()`)
  check('打字回车选中站内已有的学科分类 → 左栏带出「根目录」',
    !typed.none && Array.isArray(typed.shown) && typed.shown.indexOf('根目录') >= 0, JSON.stringify(typed))

  console.log('9c) 界面收口：工作区标题与「已有资源」同高同顶、左栏标题 15px、「＋ 新建子目录」在列表下方、清除 × 点击区 ≥28px')
  const round = await evaluate(client, `(() => {
    const S = ${S}
    const rect = (sel) => {
      const n = S.querySelector(sel)
      if (!n) return null
      const r = n.getBoundingClientRect()
      return { h: Math.round(r.height), top: Math.round(r.top), font: getComputedStyle(n).fontSize }
    }
    const add = S.querySelector('.upc-add-dir')
    const first = S.querySelector('.upc-dir')
    return {
      title: rect('.upc-dir-title'), siteBtn: rect('.upc-toggle'), railTitle: rect('.upc-rail-head b'),
      clear: (function () { const n = S.querySelector('[data-el="courseClear"]')
        const r = n.getBoundingClientRect(); return { w: Math.round(r.width), h: Math.round(r.height), font: getComputedStyle(n).fontSize } })(),
      addBelowList: !!add && !!first && add.getBoundingClientRect().top > first.getBoundingClientRect().top,
      trash: (function () {
        const n = S.querySelector('.upc-dir-del')
        if (!n) return null
        const r = n.getBoundingClientRect(), svg = n.querySelector('svg')
        const sr = svg ? svg.getBoundingClientRect() : { width: 0, height: 0 }
        return { w: Math.round(r.width), h: Math.round(r.height), icon: Math.round(sr.width) }
      })()
    }
  })()`)
  check('工作区标题框与「已有资源」按钮同高同顶（图一）',
    !!round.title && !!round.siteBtn && round.title.h === round.siteBtn.h && round.title.top === round.siteBtn.top,
    JSON.stringify(round))
  check('左栏「子目录」标题与右侧标题同一档 15px（图六）',
    !!round.railTitle && round.railTitle.font === '15px', JSON.stringify(round.railTitle))
  check('「＋ 新建子目录」在子目录列表下方（v0.3.31 按用户意见放回原处）', round.addBelowList === true, JSON.stringify(round))
  check('清除用的红 × 点击区 ≥28px 见方，字号仍是符号档 15px（图五）',
    round.clear.w >= 28 && round.clear.h >= 28 && round.clear.font === '15px', JSON.stringify(round.clear))
  check('垃圾桶点击区 ≥30px 见方、图标 ≥16px（比上一版更好点）',
    !!round.trash && round.trash.w >= 30 && round.trash.h >= 30 && round.trash.icon >= 16,
    JSON.stringify(round.trash))

  console.log('9d) 根目录常驻：选中任一学科分类，左栏第一行就是「根目录」')
  const rootRow = await evaluate(client, `(async () => {
    const S = ${S}
    const names = [...S.querySelectorAll('.upc-dir-name')].map((n) => n.textContent)
    const rootBtn = S.querySelector('.upc-dir .upc-dir-del')
    // 选中根目录，看右侧名字框是不是只读（根目录 = 学科分类本身，不给改名）
    S.querySelectorAll('.upc-dir')[0].click()
    await new Promise((r) => setTimeout(r, 300))
    const title = S.querySelector('[data-el="dirTitle"]')
    return { names: names, firstIsRoot: names[0] === '根目录',
      rootDisabled: rootBtn ? rootBtn.disabled : null, rootTitle: rootBtn ? rootBtn.title : '',
      titleReadOnly: title ? title.readOnly : null, titleValue: title ? title.value : null }
  })()`)
  check('「根目录」固定排在第一行，且不给删除（它是学科分类本身）',
    rootRow.firstIsRoot === true && rootRow.rootDisabled === true &&
      /根目录就是学科分类本身/.test(rootRow.rootTitle), JSON.stringify(rootRow))
  check('选中「根目录」时名字是只读的（改名会把文件传进「根目录」这个真子目录）',
    rootRow.titleReadOnly === true && rootRow.titleValue === '', JSON.stringify(rootRow))

  console.log('10) 换学科分类必须清空上一门的子目录')
  // 先在当前分类下放一个有名字的子目录，换课后就该消失
  await evaluate(client, `${S}.querySelector('[data-act="addDir"]').click()`)
  await evaluate(client, `(() => {
    const S = ${S}
    const t = S.querySelector('[data-el="dirTitle"]')
    t.value = '换课前的子目录'
    t.dispatchEvent(new Event('input', { bubbles: true }))
    t.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    return true
  })()`)
  await sleep(400)
  const beforeSwitch = await evaluate(client, `(() => {
    const S = ${S}
    return {
      names: [...S.querySelectorAll('.upc-dir-name')].map((n) => n.textContent),
      log: S.querySelector('[data-el="log"]').textContent
    }
  })()`)
  check('改名即时生效并留下一行确认（不需要保存按钮）',
    beforeSwitch.names.includes('换课前的子目录') && /子目录名已改成/.test(beforeSwitch.log),
    JSON.stringify(beforeSwitch))

  const other = await evaluate(client, `(async () => {
    const S = ${S}
    const cats = await fetch('/api/categories').then((r) => r.json())
    const list = Array.isArray(cats) ? cats : (cats.items || []).map((c) => c.name || c)
    const now = S.querySelector('[data-el="courseName"]').value
    // 要挑"既不是本门测试课、也不是当前这门"的：选到当前这门只会算改名，测不出换课
    return list.find((c) => c !== ${JSON.stringify(PROBE_CATEGORY)} && c !== now)
  })()`)
  await evaluate(client, `(async () => {
    const S = ${S}
    const input = S.querySelector('[data-el="courseName"]')
    // 先 blur 再 focus：对"已经聚焦着"的元素调 focus() 不会再触发 focus 事件，
    // 组合框就不会重新渲染下拉，下面找不到那一项就等于没换课（AGENTS 第 8 节的坑）
    input.blur()
    await new Promise((r) => setTimeout(r, 300))
    input.focus()
    input.value = ${JSON.stringify(other)}
    input.dispatchEvent(new Event('input', { bubbles: true }))
    await new Promise((r) => setTimeout(r, 400))
    const hit = Array.prototype.slice.call(S.querySelectorAll('.upc-menu-item'))
      .filter((i) => i.textContent.trim() === ${JSON.stringify(other)})[0]
    if (hit) hit.click()
    return !!hit
  })()`)
  await sleep(1500)
  const switched = await evaluate(client, `(() => {
    const S = ${S}
    return {
      course: S.querySelector('[data-el="courseName"]').value,
      dirs: Array.prototype.slice.call(S.querySelectorAll('.upc-dir-name')).map((n) => n.textContent)
    }
  })()`)
  check('切到别的学科分类后旧学科分类的子目录已清空',
    switched.course === other && !switched.dirs.includes('换课前的子目录'), JSON.stringify(switched))

  console.log('11) 输入框右端的小红 × 一键清除学科分类选择（连子目录一起）')
  const cleared = await evaluate(client, `(async () => {
    const S = ${S}
    S.querySelector('[data-el="courseClear"]').click()
    await new Promise((r) => setTimeout(r, 600))
    return {
      course: S.querySelector('[data-el="courseName"]').value,
      dirs: S.querySelectorAll('.upc-dir').length,
      files: S.querySelectorAll('.upc-file').length,
      clearHidden: S.querySelector('[data-el="courseClear"]').hidden,
      guide: !S.querySelector('[data-el="workEmpty"]').hidden,
      focused: S.querySelector('[data-el="courseName"]') === S.activeElement
    }
  })()`)
  check('点小红 × 后学科分类与子目录都清空、回到引导',
    cleared.course === '' && cleared.dirs === 0 && cleared.files === 0 &&
      cleared.clearHidden === true && cleared.guide === true && cleared.focused === true,
    JSON.stringify(cleared))

  console.log('11b) 清空学科分类后，「新建子目录」重新变回禁用')
  const afterClear = await evaluate(client, `(() => {
    const S = ${S}
    const add = S.querySelector('.upc-rail [data-act="addDir"]')
    add.click()
    add.click()
    return {
      disabled: add.disabled,
      dirs: S.querySelectorAll('.upc-dir').length,
      hintShown: !S.querySelector('[data-el="courseHint"]').hidden
    }
  })()`)
  check('没有学科分类就建不出子目录（点两下也还是 0 个）',
    afterClear.disabled === true && afterClear.dirs === 0 && afterClear.hintShown === false,
    JSON.stringify(afterClear))
  client.ws.close()
}

// 红线：不管断言有没有过，都不能把测试数据留在生产站上。
// 中途 throw 时第 9 步的界面删除不会执行，所以这里再兜一次：
// 按文件名把探针文件（已通过 + 待审核）全部删掉。
async function sweepProbe() {
  const client = connect((await pageTarget()).webSocketDebuggerUrl)
  await client.ready
  await client.send('Runtime.enable')
  const swept = await evaluate(client, `(async () => {
    const q = encodeURIComponent(${JSON.stringify(PROBE_PREFIX)})
    const found = []
    for (const url of ['/api/files?q=' + q + '&size=20',
                       '/api/admin/files?status=pending&q=' + q + '&size=20']) {
      try {
        const d = await (await fetch(url)).json()
        ;(d.items || []).forEach((i) => found.push(i.id))
      } catch (e) { /* 拿不到就算了，下面按 id 删 */ }
    }
    const ids = [...new Set(found)]
    const statuses = []
    for (const id of ids) {
      try { statuses.push((await fetch('/api/admin/files/' + id, { method: 'DELETE' })).status) }
      catch (e) { statuses.push('err') }
    }
    return { ids: ids.length, statuses: statuses }
  })()`)
  if (swept.ids) console.log('兜底清理：删掉 ' + swept.ids + ' 个残留探针文件 ' + JSON.stringify(swept.statuses))
  client.ws.close()
}

main()
  .then(() => console.log('\n全部通过 ✅'))
  .catch((err) => {
    console.error('\n失败：' + err.message)
    process.exitCode = 1
  })
  .finally(() => sweepProbe()
    .catch((err) => console.error('兜底清理也没跑成：' + err.message + '（请手工检查站内 ' + PROBE_NAME + '）'))
    // 断言失败时 main() 提前抛出，主 CDP 的 WebSocket 没人关，事件循环会一直挂着
    // ——headless.ps1 等 node 退出，于是一句 FAIL 变成卡死十分钟（2026-10-31 实测）。
    .then(() => {
      if (mainClient && mainClient.ws.readyState <= 1) mainClient.ws.close()
      setTimeout(() => process.exit(process.exitCode || 0), 120)
    }))

