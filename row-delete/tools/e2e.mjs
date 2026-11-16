/* upcshare 资料库删除 · 本地端到端（真实扩展加载 + 真实鼠标）
 *
 * 用法：node row-delete/tools/e2e.mjs
 *
 * 用 Edge 无头模式 --load-extension 加载 row-delete/ 这一份扩展（Chrome 正式版禁了
 * --load-extension，Edge 可以），打本地 mock 页面，不碰生产站。
 */
import { spawn, execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync, mkdtempSync, rmSync, existsSync, copyFileSync, cpSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { startMock } from './mock-server.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const extDir = resolve(here, '..')
const PORT = 9400 + Math.floor(Math.random() * 200)
const MOCK_PORT = 8800 + Math.floor(Math.random() * 100)
const MOCK = `http://127.0.0.1:${MOCK_PORT}`
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

let passed = 0
function check(name, ok, detail) {
  console.log((ok ? '  ok  ' : ' FAIL ') + name + (detail ? '  → ' + detail : ''))
  if (!ok) throw new Error('断言失败：' + name)
  passed++
}

function findEdge() {
  const candidates = [
    process.env.EDGE_PATH,
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe'
  ].filter(Boolean)
  for (const p of candidates) if (existsSync(p)) return p
  throw new Error('找不到 Edge 可执行文件；本测试需要 Edge 的 --load-extension 能力')
}

async function pageTarget() {
  for (let i = 0; i < 60; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${PORT}/json/list`)
      const list = await res.json()
      const page = list.find((t) => t.type === 'page')
      if (page) return page
    } catch (e) { /* 浏览器还没起来 */ }
    await sleep(200)
  }
  throw new Error('等不到 Edge 的调试端口')
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

async function waitFor(client, expression, timeout = 6000) {
  const end = Date.now() + timeout
  while (Date.now() < end) {
    if (await evaluate(client, expression)) return true
    await sleep(120)
  }
  return false
}

async function click(client, selector) {
  const box = await evaluate(client, `(() => {
    const el = document.querySelector(${JSON.stringify(selector)})
    if (!el) return null
    const r = el.getBoundingClientRect()
    if (!r.width || !r.height) return null
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 }
  })()`)
  if (!box) throw new Error('点不到元素：' + selector)
  await client.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: box.x, y: box.y })
  await client.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: box.x, y: box.y, button: 'left', clickCount: 1 })
  await client.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: box.x, y: box.y, button: 'left', clickCount: 1 })
}

async function mockState() {
  return fetch(MOCK + '/__state').then((r) => r.json())
}

async function main() {
  const source = readFileSync(join(extDir, 'content.js'), 'utf8')
  const manifest = JSON.parse(readFileSync(join(extDir, 'manifest.json'), 'utf8'))
  const sha = createHash('sha256').update(source).digest('hex').slice(0, 12)
  console.log(`测的是 row-delete v${manifest.version} / ${Buffer.byteLength(source)} 字节 / sha ${sha}`)

  // 生产清单只匹配 upcshare 三个域名；mock 在 127.0.0.1 上，所以加载一份"只多一条本地匹配"的清单副本。
  // content.js 和图标原样复制，并核对 sha，保证测的就是仓库这一份。
  const shippedMatches = manifest.content_scripts[0].matches.slice().sort()
  check('生产清单仍只匹配 upcshare 三个域名', shippedMatches.join(',') ===
    'https://in.upcshare.cn/*,https://upcshare.cn/*,https://www.upcshare.cn/*', shippedMatches.join(','))

  const testExt = mkdtempSync(join(tmpdir(), 'upc-row-del-ext-'))
  copyFileSync(join(extDir, 'content.js'), join(testExt, 'content.js'))
  cpSync(join(extDir, 'icons'), join(testExt, 'icons'), { recursive: true })
  const testManifest = JSON.parse(JSON.stringify(manifest))
  testManifest.content_scripts[0].matches.push('http://127.0.0.1/*')
  writeFileSync(join(testExt, 'manifest.json'), JSON.stringify(testManifest, null, 2))
  check('测试副本的 content.js 与仓库逐字节相同',
    createHash('sha256').update(readFileSync(join(testExt, 'content.js'))).digest('hex').slice(0, 12) === sha)

  const { server } = await startMock(MOCK_PORT)
  const userData = mkdtempSync(join(tmpdir(), 'upc-row-del-'))
  // Edge 的 --load-extension 在无头模式下不生效（和 Chrome 一样）；默认用移出屏幕的窗口。
  const headless = process.env.E2E_HEADFUL !== '1'
  const windowArgs = headless
    ? ['--headless=new', '--disable-gpu']
    : ['--window-position=-32000,-32000', '--window-size=1280,900']
  const edge = spawn(findEdge(), [
    ...windowArgs,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-sync',
    '--no-proxy-server',
    `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${userData}`,
    `--disable-extensions-except=${testExt}`,
    `--load-extension=${testExt}`,
    'about:blank'
  ], { stdio: ['ignore', 'ignore', 'pipe'] })
  let edgeErr = ''
  edge.stderr.on('data', (d) => { edgeErr += d.toString() })

  let client = null
  try {
    const target = await pageTarget()
    client = connect(target.webSocketDebuggerUrl)
    await client.ready
    await client.send('Runtime.enable')
    await client.send('Page.enable')
    await client.send('Emulation.setDeviceMetricsOverride', {
      width: 1280, height: 900, deviceScaleFactor: 1, mobile: false
    })

    console.log('1) 管理员身份：列表行出现删除入口')
    await client.send('Page.navigate', { url: MOCK + '/?role=admin' })
    const injected = await waitFor(client, `document.querySelectorAll('.upc-row-del-btn').length === 3`)
    check('三行都注入了删除按钮', injected, injected ? '' : '扩展没加载或被 CSP 拦了')
    check('后台还没收到任何删除请求', (await mockState()).deletes.length === 0)

    const metrics = await evaluate(client, `(() => {
      const b = document.querySelector('.upc-row-del-btn')
      const s = getComputedStyle(b)
      return {
        tag: b.tagName, text: b.textContent.trim(), type: b.type,
        h: b.getBoundingClientRect().height,
        fs: s.fontSize, fw: s.fontWeight, br: s.borderRadius,
        label: b.getAttribute('aria-label') || ''
      }
    })()`)
    check('是真实 button，初始文案「删除」', metrics.tag === 'BUTTON' && metrics.type === 'button' && metrics.text === '删除', JSON.stringify(metrics))
    check('28px 高、8px 圆角', Math.round(metrics.h) === 28 && metrics.br === '8px', `${metrics.h}px / ${metrics.br}`)
    check('字号 12、字重 600', metrics.fs === '12px' && metrics.fw === '600', `${metrics.fs} / ${metrics.fw}`)
    check('aria-label 带文件名', metrics.label.includes('自动控制原理_课件_第1章.pdf'), metrics.label)

    console.log('2) 第一次点只进入待确认')
    await click(client, 'tr[data-id="f2"] .upc-row-del-btn')
    await sleep(180)
    const armed = await evaluate(client, `(() => {
      const b = document.querySelector('tr[data-id="f2"] .upc-row-del-btn')
      return { text: b.textContent.trim(), armed: b.classList.contains('armed'), label: b.getAttribute('aria-label') || '' }
    })()`)
    check('没有发删除请求', (await mockState()).deletes.length === 0)
    check('按钮变成「确认删除」并进入 armed 态', armed.text === '确认删除' && armed.armed, JSON.stringify(armed))
    check('提示改成再点一次', armed.label.includes('再点一次'), armed.label)

    console.log('3) 4 秒不点第二下就自动取消')
    await sleep(4300)
    const reset = await evaluate(client, `(() => {
      const b = document.querySelector('tr[data-id="f2"] .upc-row-del-btn')
      return { text: b.textContent.trim(), armed: b.classList.contains('armed') }
    })()`)
    check('自动回到「删除」', reset.text === '删除' && !reset.armed, JSON.stringify(reset))
    check('仍然没有发删除请求', (await mockState()).deletes.length === 0)

    console.log('4) 连点两下才真的删')
    await click(client, 'tr[data-id="f2"] .upc-row-del-btn')
    await sleep(120)
    await click(client, 'tr[data-id="f2"] .upc-row-del-btn')
    const gone = await waitFor(client, `(() => {
      const tr = document.querySelector('tr[data-id="f2"]')
      return !tr || getComputedStyle(tr).display === 'none'
    })()`)
    check('删掉的行原地收起', gone)
    const after = await mockState()
    check('后台收到的是这一行的 ID', after.deletes.length === 1 && after.deletes[0] === 'f2', JSON.stringify(after.deletes))
    const toast = await evaluate(client, `(() => {
      const t = document.querySelector('.upc-row-del-toast')
      return t && !t.hidden ? t.textContent : ''
    })()`)
    check('右下角提示带文件名', toast.includes('已删除：自动控制原理_试卷_2022-2023.pdf'), toast)
    check('其余两行还有按钮', await evaluate(client, `document.querySelectorAll('.upc-row-del-btn').length === 2`))

    console.log('5) Vue 重画后删掉的行不会复活')
    await click(client, '#rerender')
    await sleep(500)
    check('重画后 f2 仍然隐藏', await evaluate(client, `getComputedStyle(document.querySelector('tr[data-id="f2"]')).display === 'none'`))
    check('重画后按钮没有重复注入', await evaluate(client, `document.querySelectorAll('.upc-row-del-btn').length === 2`))

    console.log('6) 删空一页：显示占位')
    for (const id of ['f1', 'f3']) {
      await click(client, `tr[data-id="${id}"] .upc-row-del-btn`)
      await sleep(120)
      await click(client, `tr[data-id="${id}"] .upc-row-del-btn`)
      await sleep(300)
    }
    const all = await mockState()
    check('三次删除都走 /api/admin/files/{id}', all.deletes.sort().join(',') === 'f1,f2,f3', JSON.stringify(all.deletes))
    check('整页删空后出现占位', await waitFor(client, `document.body.textContent.includes('本页文件已删除')`), await evaluate(client, `document.querySelector('.upc-row-del-empty') && document.querySelector('.upc-row-del-empty').textContent.trim()`))

    console.log('7) 普通成员：页面上什么都不多')
    await evaluate(client, `sessionStorage.clear()`)
    await client.send('Page.navigate', { url: MOCK + '/?role=member' })
    await waitFor(client, `document.querySelectorAll('.file-table tbody tr[data-id]').length === 3`)
    await sleep(800)
    check('没有删除按钮', await evaluate(client, `document.querySelectorAll('.upc-row-del-btn').length === 0`))
    check('没有注入样式', await evaluate(client, `!document.getElementById('upcshare-row-delete-style')`))
    check('成员页面的行数保持原样', await evaluate(client, `document.querySelectorAll('.file-table tbody tr[data-id]').length === 3`))

    console.log(`\n${passed} 项全过`)
  } finally {
    if (client) { try { client.ws.close() } catch (e) { /* ignore */ } }
    try { execFileSync('taskkill', ['/PID', String(edge.pid), '/T', '/F'], { stdio: 'ignore' }) } catch (e) { /* 已经退了 */ }
    // Edge 会以 "--edge-skip-compat-layer-relaunch" 再拉起一个主进程，原 PID 的 /T 打不到它。
    // 按这次运行独有的 user-data-dir 扫一遍，别把真人开着的 Edge 一起带走。
    try {
      execFileSync('powershell', ['-NoProfile', '-Command',
        `Get-CimInstance Win32_Process -Filter "Name='msedge.exe'" | Where-Object { $_.CommandLine -and $_.CommandLine.Contains('${userData}') } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }`
      ], { stdio: 'ignore' })
    } catch (e) { /* ignore */ }
    try { server.closeAllConnections() } catch (e) { /* Node 18- */ }
    server.close()
    try { rmSync(userData, { recursive: true, force: true }) } catch (e) { /* Windows 偶发占用 */ }
    try { rmSync(testExt, { recursive: true, force: true }) } catch (e) { /* ignore */ }
    if (edgeErr && !passed) console.error('Edge stderr（节选）:\n' + edgeErr.slice(-2000))
  }
}

main().then(() => process.exit(0)).catch((err) => {
  console.error('\n' + err.message)
  process.exit(1)
})
