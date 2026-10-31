/* 生成一张面板截图（无头 Chrome + CDP），用于给使用者看效果。
 * 只用假的 File 对象（defineProperty 造 webkitRelativePath），不会真的上传。
 */
import { writeFileSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const PORT = process.env.CDP_PORT || '9333'
const OUT = process.env.OUT || fileURLToPath(new URL('../preview.png', import.meta.url))
const USER = process.env.UPC_USER
const PASSWORD = process.env.UPC_PASSWORD

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()
const page = list.find((t) => t.type === 'page' && String(t.url).includes('upcshare.cn'))
if (!page) throw new Error('页面没开')

const ws = new WebSocket(page.webSocketDebuggerUrl)
let seq = 0
const pending = new Map()
ws.onmessage = (event) => {
  const msg = JSON.parse(event.data)
  if (msg.id && pending.has(msg.id)) {
    const { resolve, reject } = pending.get(msg.id)
    pending.delete(msg.id)
    msg.error ? reject(new Error(JSON.stringify(msg.error))) : resolve(msg.result)
  }
}
await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject })
const send = (method, params = {}) => new Promise((resolve, reject) => {
  const id = ++seq
  pending.set(id, { resolve, reject })
  ws.send(JSON.stringify({ id, method, params }))
})
const evaluate = async (expression) => {
  const result = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, userGesture: true })
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text)
  return result.result.value
}

await send('Runtime.enable')
await send('Page.enable')
await send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false })

// 先登录再刷新：这样站点导航栏也会渲染成"已登录"，截图更真实
if (USER && PASSWORD) {
  await evaluate(`(async () => {
    await fetch('/api/auth/login', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: ${JSON.stringify(USER)}, password: ${JSON.stringify(PASSWORD)} })
    })
    return true
  })()`)
}

// 刷新成干净页面，避免上一轮注入残留的日志/进度条
await send('Page.reload', { ignoreCache: true })
await sleep(3000)

const source = readFileSync(new URL('../content.js', import.meta.url), 'utf8')
const manifest = JSON.parse(readFileSync(new URL('../manifest.json', import.meta.url), 'utf8'))
// 页面上若已有面板（残留浏览器 / 已装扩展），content.js 的去重守卫会让注入变成空操作，
// 截出来的就是旧版本。先重新加载一遍再注入，并记下截的是哪一版。
if (await evaluate(`!!document.getElementById('upcshare-batch-host')`)) {
  await send('Page.navigate', { url: 'https://in.upcshare.cn/' })
  await sleep(3000)
}
await evaluate(source)
console.log('    截图用的是工作副本 content.js（v' + manifest.version + '）')

await evaluate(`(() => {
  const nav = [...document.querySelectorAll('a.nav-link')].find((a) => a.textContent.trim() === '上传资料')
  if (!nav) throw new Error('导航栏里没有「上传资料」入口')
  nav.click()
  return true
})()`)
await sleep(500)

// 造一个像真实课程文件夹的结构；只用于展示，不会上传
await evaluate(`(() => {
  const sr = document.getElementById('upcshare-batch-host').shadowRoot
  const input = sr.querySelector('#upc-picker')
  const dt = new DataTransfer()
  const rows = [
    ['高等数学2-2/期末试卷/2024-2025 期末真题.pdf', '2024-2025 期末真题.pdf', 2_411_000],
    ['高等数学2-2/期末试卷/2023-2024 期末真题.pdf', '2023-2024 期末真题.pdf', 1_982_000],
    ['高等数学2-2/课件/第1章 极限.pptx', '第1章 极限.pptx', 8_340_000],
    ['高等数学2-2/课件/第2章 导数.pptx', '第2章 导数.pptx', 7_120_000],
    ['高等数学2-2/实验报告/实验一 单摆.pdf', '实验一 单摆.pdf', 940_000],
    ['高等数学2-2/实验报告/实验二 杨氏模量.pdf', '实验二 杨氏模量.pdf', 1_120_000]
  ]
  for (const [rel, name, size] of rows) {
    const f = new File(['x'], name, { type: 'application/octet-stream' })
    Object.defineProperty(f, 'webkitRelativePath', { value: rel })
    Object.defineProperty(f, 'size', { value: size })
    dt.items.add(f)
  }
  input.files = dt.files
  input.dispatchEvent(new Event('change', { bubbles: true }))
  return true
})()`)

// 合并空状态后，导入前会先弹一次确认；截图要的是确认之后的工作台样子
await sleep(600)
await evaluate(`(() => {
  const sr = document.getElementById('upcshare-batch-host').shadowRoot
  const btn = sr.querySelector('[data-act="confirmImport"]')
  if (btn) btn.click()
  return true
})()`)

await sleep(6000)
const shot = await send('Page.captureScreenshot', { format: 'png' })
writeFileSync(OUT, Buffer.from(shot.data, 'base64'))
console.log('written → ' + OUT)
ws.close()
