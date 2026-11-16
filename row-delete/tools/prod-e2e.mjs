/* upcshare 资料库删除 · 生产环境端到端
 *
 * 用法（在项目根目录，校园网内）：
 *   UPC_USER='大杯烧仙草' UPC_PASSWORD='***' node row-delete/tools/prod-e2e.mjs
 *
 * 做的事：登录 → 传一个 24 字节探针文件并自动审核 → 在资料库搜索到它 →
 * 注入 row-delete/content.js → 真实鼠标点两次删掉 → 确认站点无残留。
 * 探针文件名每轮唯一，清理按前缀扫，跑完不留生产数据。
 */
import { spawn, execFileSync } from 'node:child_process'
import { readFileSync, mkdtempSync, rmSync, existsSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const extDir = resolve(here, '..')
const USER = process.env.UPC_USER
const PASSWORD = process.env.UPC_PASSWORD
if (!USER || !PASSWORD) {
  console.error('缺少 UPC_USER / UPC_PASSWORD 环境变量')
  process.exit(2)
}

const PORT = 9500 + Math.floor(Math.random() * 200)
const SITE = 'https://in.upcshare.cn/'
const PREFIX = '___row_del_probe'
const NAME = `${PREFIX}_${new Date().toTimeString().slice(0, 8).replace(/:/g, '')}___.txt`
const CATEGORY = '__row_delete_probe__'
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

let passed = 0
function check(name, ok, detail) {
  console.log((ok ? '  ok  ' : ' FAIL ') + name + (detail ? '  → ' + detail : ''))
  if (!ok) throw new Error('断言失败：' + name)
  passed++
}

function findChrome() {
  const candidates = [
    process.env.CHROME_PATH,
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    join(process.env.LOCALAPPDATA || '', 'Google\\Chrome\\Application\\chrome.exe')
  ].filter(Boolean)
  for (const p of candidates) if (existsSync(p)) return p
  throw new Error('找不到 Chrome')
}

async function pageTarget() {
  for (let i = 0; i < 60; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${PORT}/json/list`)
      const list = await res.json()
      const page = list.find((t) => t.type === 'page' && String(t.url).includes('upcshare.cn'))
      if (page) return page
    } catch (e) { /* 还没起来 */ }
    await sleep(250)
  }
  throw new Error('等不到 Chrome 的调试端口或站点页面')
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

async function waitFor(client, expression, timeout = 12000) {
  const end = Date.now() + timeout
  while (Date.now() < end) {
    if (await evaluate(client, expression)) return true
    await sleep(200)
  }
  return false
}

async function findProbeRow(client) {
  return evaluate(client, `(() => {
    const trs = [...document.querySelectorAll('.file-table tbody tr')]
    const tr = trs.find((x) => {
      const n = x.querySelector('.file-name-text')
      return n && n.textContent.trim() === ${JSON.stringify(NAME)}
    })
    if (!tr) return null
    const b = tr.querySelector('.upc-row-del-btn')
    if (!b) return null
    const r = b.getBoundingClientRect()
    return { x: r.x + r.width / 2, y: r.y + r.height / 2, text: b.textContent.trim(), h: r.height }
  })()`)
}

async function api(client, path, options = {}) {
  return evaluate(client, `(async () => {
    const res = await fetch(${JSON.stringify(path)}, ${JSON.stringify(options)})
    return { status: res.status, body: await res.json().catch(() => null) }
  })()`)
}

async function main() {
  const source = readFileSync(join(extDir, 'content.js'), 'utf8')
  const manifest = JSON.parse(readFileSync(join(extDir, 'manifest.json'), 'utf8'))
  const sha = createHash('sha256').update(source).digest('hex').slice(0, 12)
  console.log(`测的是 row-delete v${manifest.version} / ${Buffer.byteLength(source)} 字节 / sha ${sha}`)

  const profile = mkdtempSync(join(tmpdir(), 'upc-row-del-prod-'))
  const chrome = spawn(findChrome(), [
    '--headless=new',
    '--disable-gpu',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-sync',
    `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${profile}`,
    '--window-size=1280,900',
    SITE
  ], { stdio: ['ignore', 'ignore', 'pipe'] })
  let chromeErr = ''
  chrome.stderr.on('data', (d) => { chromeErr += d.toString() })

  let client = null
  let probeId = ''
  try {
    client = connect((await pageTarget()).webSocketDebuggerUrl)
    await client.ready
    await client.send('Runtime.enable')
    await client.send('Page.enable')
    client.ws.addEventListener('message', (event) => {
      const msg = JSON.parse(event.data)
      if (msg.method === 'Runtime.exceptionThrown') {
        console.log('    [page exception]', JSON.stringify(msg.params.exceptionDetails).slice(0, 300))
      }
    })
    await client.send('Emulation.setDeviceMetricsOverride', {
      width: 1280, height: 900, deviceScaleFactor: 1, mobile: false
    })
    // 启动参数里的 URL 可能在连上调试端口时还没提交，先显式导航并等文档就绪，
    // 否则相对路径 fetch 会解析失败（location 还是 about:blank）。
    await client.send('Page.navigate', { url: SITE })
    const ready = await waitFor(client, `location.href.startsWith('https://in.upcshare.cn') && document.readyState === 'complete'`, 20000)
    check('站点页面已就绪', ready, await evaluate(client, `location.href + ' / ' + document.title`))

    console.log('1) 登录')
    const login = await api(client, '/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: USER, password: PASSWORD })
    })
    check('登录成功', login.status === 200 && login.body && login.body.ok === true, JSON.stringify(login.body))

    console.log('2) 传一个探针文件并自动审核')
    const upload = await evaluate(client, `(async () => {
      const fd = new FormData()
      fd.append('file', new File([new Uint8Array(24)], ${JSON.stringify(NAME)}, { type: 'text/plain' }))
      fd.append('description', '')
      fd.append('category', ${JSON.stringify(CATEGORY)})
      fd.append('sub_category', '')
      const res = await fetch('/api/upload', { method: 'POST', body: fd })
      return { status: res.status, body: await res.json().catch(() => null) }
    })()`)
    check('上传成功', upload.status === 200 && upload.body && upload.body.id, JSON.stringify(upload.body))
    probeId = upload.body.id
    const approve = await api(client, '/api/admin/approve/' + encodeURIComponent(probeId), { method: 'POST' })
    check('自动审核通过', approve.status === 200, JSON.stringify(approve.body))

    console.log('3) 到资料库搜索出探针，注入 row-delete')
    await client.send('Page.navigate', { url: SITE })
    await waitFor(client, `!!document.querySelector('.subject-search input')`, 15000)
    await evaluate(client, `(() => {
      const input = document.querySelector('.subject-search input')
      input.value = ${JSON.stringify(NAME)}
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })()`)
    const rowFound = await waitFor(client, `(async () => {
      const trs = [...document.querySelectorAll('.file-table tbody tr')]
      return trs.some((x) => {
        const n = x.querySelector('.file-name-text')
        return n && n.textContent.trim() === ${JSON.stringify(NAME)}
      })
    })()`, 15000)
    check('搜索结果里能看到探针', rowFound)

    await evaluate(client, source)
    const injected = await waitFor(client, `(() => {
      const trs = [...document.querySelectorAll('.file-table tbody tr')]
      const tr = trs.find((x) => {
        const n = x.querySelector('.file-name-text')
        return n && n.textContent.trim() === ${JSON.stringify(NAME)}
      })
      return !!(tr && tr.querySelector('.upc-row-del-btn'))
    })()`, 8000)
    check('管理员身份下，探针行出现了删除按钮', injected)

    const btn = await findProbeRow(client)
    check('按钮是 28px 的次级盒子', btn && Math.round(btn.h) === 28, JSON.stringify(btn))
    check('初始文案是「删除」', btn && btn.text === '删除', JSON.stringify(btn))

    console.log('4) 真实鼠标点两次删除')
    await client.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: btn.x, y: btn.y, button: 'left', clickCount: 1 })
    await client.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: btn.x, y: btn.y, button: 'left', clickCount: 1 })
    await sleep(150)
    const armed = await evaluate(client, `(() => {
      const trs = [...document.querySelectorAll('.file-table tbody tr')]
      const tr = trs.find((x) => {
        const n = x.querySelector('.file-name-text')
        return n && n.textContent.trim() === ${JSON.stringify(NAME)}
      })
      const b = tr && tr.querySelector('.upc-row-del-btn')
      return b ? b.textContent.trim() : 'gone'
    })()`)
    check('第一次点只进入待确认', armed === '确认删除', armed)

    const btn2 = await findProbeRow(client)
    await client.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: btn2.x, y: btn2.y, button: 'left', clickCount: 1 })
    await client.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: btn2.x, y: btn2.y, button: 'left', clickCount: 1 })
    const hidden = await waitFor(client, `(() => {
      const trs = [...document.querySelectorAll('.file-table tbody tr')]
      const tr = trs.find((x) => {
        const n = x.querySelector('.file-name-text')
        return n && n.textContent.trim() === ${JSON.stringify(NAME)}
      })
      return !tr || tr.classList.contains('upc-row-del-gone')
    })()`, 8000)
    check('第二次点后这一行收起', hidden)

    console.log('5) 站点侧确认无残留')
    let left = 1
    for (let i = 0; i < 20; i++) {
      const res = await api(client, '/api/files?q=' + encodeURIComponent(PREFIX) + '&size=100&page=1')
      left = res.body && res.body.items ? res.body.items.length : left
      if (left === 0) break
      await sleep(500)
    }
    check('按前缀查不到探针文件', left === 0, '剩余 ' + left + ' 条')
    const pending = await api(client, '/api/admin/files?status=pending&size=200&page=1')
    const pendingLeft = ((pending.body && pending.body.items) || []).filter((x) => x && String(x.original_name || '').startsWith(PREFIX)).length
    check('待审核里也没有探针', pendingLeft === 0, '剩余 ' + pendingLeft + ' 条')

    console.log(`\n${passed} 项全过`)
  } finally {
    // 红线：无论测试怎么挂，都不能把探针留在生产站
    if (client && probeId) {
      try {
        const res = await api(client, '/api/admin/files/' + encodeURIComponent(probeId), { method: 'DELETE' })
        console.log('清理探针：HTTP ' + res.status)
      } catch (e) { console.error('清理探针失败：' + e.message) }
    }
    if (client) { try { client.ws.close() } catch (e) { /* ignore */ } }
    try { execFileSync('taskkill', ['/PID', String(chrome.pid), '/T', '/F'], { stdio: 'ignore' }) } catch (e) { /* 已退出 */ }
    try {
      execFileSync('powershell', ['-NoProfile', '-Command',
        `Get-CimInstance Win32_Process -Filter "Name='chrome.exe'" | Where-Object { $_.CommandLine -and $_.CommandLine.Contains('${profile}') } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }`
      ], { stdio: 'ignore' })
    } catch (e) { /* ignore */ }
    try { rmSync(profile, { recursive: true, force: true }) } catch (e) { /* Windows 偶发占用 */ }
    if (chromeErr && !passed) console.error('Chrome stderr（节选）:\n' + chromeErr.slice(-2000))
  }
}

main().then(() => process.exit(0)).catch((err) => {
  console.error('\n' + err.message)
  process.exit(1)
})
