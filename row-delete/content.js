/* upcshare 资料库删除 · 内容脚本
 *
 * 在资料库列表的每一行「下载」旁边加一个删除按钮。删除走管理后台同一个接口：
 *   DELETE /api/admin/files/{id}
 * 只有管理员（/api/auth/me 的 is_admin）才会看到按钮；删除要点两次。
 * 没有权限、不登录、或页面不是资料库列表时，这个脚本什么都不做。
 */
(function () {
  'use strict'

  // ── 纯函数区（挂到 globalThis，selftest.js 在 Node 里直接测）────────────

  /** 从 /api/download/{id} 里取文件 ID；取不到返回空串。 */
  function fileIdFromHref(href) {
    var m = String(href == null ? '' : href).match(/\/api\/download\/([^/?#]+)/)
    if (!m) return ''
    try { return decodeURIComponent(m[1]) } catch (e) { return m[1] }
  }

  /** 只有站点的管理员能删；登录态明确是 false 时一律不给。 */
  function canDelete(me) {
    return !!(me && me.is_admin && me.logged_in !== false)
  }

  /** 两段式状态机：点同一行才算确认，点别的行只是把待确认对象换过去。 */
  function nextArm(armedId, id) {
    if (armedId && armedId === id) return { next: null, action: 'delete' }
    return { next: id, action: 'arm' }
  }

  /** 列表里没抓到文件名时的兜底。 */
  function fileLabel(name, id) {
    var text = String(name == null ? '' : name).trim()
    return text || ('文件 ' + id)
  }

  function deletedMessage(name) {
    return '已删除：' + name
  }

  /** 失败提示必须带原始状态码，用户截图就能说清问题。 */
  function errorMessage(status) {
    var code = Number(status) || 0
    if (code === 401 || code === 403) {
      return '没有删除权限（HTTP ' + code + '），请确认登录的是管理员账号'
    }
    if (!code) return '删除失败：网络中断，请稍后再试'
    return '删除失败（HTTP ' + code + '），请稍后再试'
  }

  var pure = {
    fileIdFromHref: fileIdFromHref,
    canDelete: canDelete,
    nextArm: nextArm,
    fileLabel: fileLabel,
    deletedMessage: deletedMessage,
    errorMessage: errorMessage
  }
  if (typeof globalThis !== 'undefined') globalThis.__UPC_ROW_DELETE__ = pure

  // Node 里只导出纯函数，不碰 DOM。
  if (typeof document === 'undefined') return

  // ── 页面侧 ─────────────────────────────────────────────────────────────

  var STYLE_ID = 'upcshare-row-delete-style'
  var DELETED_KEY = 'upcshare_row_deleted'
  var CONFIRM_MS = 4000
  var deleted = readDeleted()
  var armed = null // { id, btn, label, timer }
  var toastEl = null
  var toastTimer = null
  var scanTimer = null

  function readDeleted() {
    var out = {}
    try {
      var raw = JSON.parse(sessionStorage.getItem(DELETED_KEY) || '{}')
      if (raw && typeof raw === 'object') out = raw
    } catch (e) { /* 存储不可用就当空 */ }
    return out
  }

  function rememberDeleted(id) {
    deleted[id] = Date.now()
    try { sessionStorage.setItem(DELETED_KEY, JSON.stringify(deleted)) } catch (e) { /* ignore */ }
  }

  function parseJson(text) {
    try { return JSON.parse(text) } catch (e) { return null }
  }

  function injectStyle() {
    if (document.getElementById(STYLE_ID)) return
    var style = document.createElement('style')
    style.id = STYLE_ID
    style.textContent = [
      // 和站点管理后台的 .action-btn.delete 同一套视觉：浅红底、红字、8px 圆角
      '.upc-row-del-btn{box-sizing:border-box;display:inline-flex;align-items:center;justify-content:center;',
      'min-width:64px;height:28px;margin-left:6px;padding:0 10px;border:1px solid rgba(255,59,48,.2);',
      'border-radius:8px;background:rgba(255,59,48,.06);color:var(--danger,#ff3b30);font-family:inherit;',
      'font-size:12px;font-weight:600;line-height:1;white-space:nowrap;cursor:pointer;vertical-align:middle;',
      'transition:background .15s,border-color .15s,color .15s}',
      '.upc-row-del-btn:hover{background:rgba(255,59,48,.12);border-color:rgba(255,59,48,.45)}',
      '.upc-row-del-btn.armed{background:var(--danger,#ff3b30);border-color:var(--danger,#ff3b30);',
      'color:#fff;animation:upc-row-del-shake .32s ease}',
      '.upc-row-del-btn:disabled{opacity:.55;cursor:default}',
      '@keyframes upc-row-del-shake{0%,100%{transform:translateX(0)}25%{transform:translateX(-2px)}75%{transform:translateX(2px)}}',
      '.upc-row-del-gone{display:none!important}',
      '.upc-row-del-empty td{padding:22px;text-align:center;color:var(--text-tertiary,#9ca3af);font-size:13px}',
      '.upc-row-del-toast{position:fixed;right:24px;bottom:24px;z-index:2147483647;max-width:340px;',
      'padding:10px 14px;border-radius:10px;background:rgba(17,24,39,.94);color:#fff;',
      'font:500 13px/1.45 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;',
      'box-shadow:0 10px 30px rgba(0,0,0,.18)}',
      '.upc-row-del-toast.error{background:rgba(180,35,24,.96)}',
      '.upc-row-del-toast[hidden]{display:none!important}'
    ].join('')
    document.head.appendChild(style)
  }

  function ensureToast() {
    if (toastEl) return toastEl
    toastEl = document.createElement('div')
    toastEl.className = 'upc-row-del-toast'
    toastEl.setAttribute('role', 'status')
    toastEl.setAttribute('aria-live', 'polite')
    toastEl.hidden = true
    document.body.appendChild(toastEl)
    return toastEl
  }

  function toast(text, isError) {
    var el = ensureToast()
    el.textContent = text
    el.classList.toggle('error', !!isError)
    el.hidden = false
    clearTimeout(toastTimer)
    toastTimer = setTimeout(function () { el.hidden = true }, 3200)
  }

  function disarm() {
    if (!armed) return
    clearTimeout(armed.timer)
    var btn = armed.btn
    btn.classList.remove('armed')
    btn.textContent = '删除'
    btn.setAttribute('aria-label', '删除 ' + armed.label)
    btn.title = '删除（点两次确认）'
    armed = null
  }

  function arm(id, btn, label) {
    disarm()
    btn.classList.add('armed')
    btn.textContent = '确认删除'
    btn.setAttribute('aria-label', '再点一次确认删除 ' + label)
    btn.title = '再点一次确认删除（4 秒后取消）'
    armed = {
      id: id,
      btn: btn,
      label: label,
      timer: setTimeout(function () { if (armed && armed.id === id) disarm() }, CONFIRM_MS)
    }
  }

  function removeRow(tr, id, label) {
    rememberDeleted(id)
    var btn = tr.querySelector('.upc-row-del-btn')
    if (btn) btn.remove()
    tr.classList.add('upc-row-del-gone')
    toast(deletedMessage(label))
    updateEmpty()
  }

  function onDeleteClick(id, btn, tr, label, event) {
    if (event) { event.preventDefault(); event.stopPropagation() }
    if (btn.disabled) return

    var step = nextArm(armed && armed.id, id)
    if (step.action === 'arm') {
      arm(id, btn, label)
      return
    }

    disarm()
    btn.disabled = true
    btn.textContent = '删除中…'

    fetch('/api/admin/files/' + encodeURIComponent(id), {
      method: 'DELETE',
      credentials: 'same-origin'
    }).then(function (res) {
      return res.text().then(function (text) {
        var data = parseJson(text)
        if (!res.ok) {
          var err = new Error('HTTP ' + res.status)
          err.status = res.status
          throw err
        }
        if (!data || data.ok === false) {
          var bad = new Error('站点没有返回 ok')
          bad.status = res.status
          throw bad
        }
        return data
      })
    }).then(function () {
      removeRow(tr, id, label)
    }).catch(function (err) {
      btn.disabled = false
      btn.textContent = '删除'
      btn.setAttribute('aria-label', '删除 ' + label)
      btn.title = '删除（点两次确认）'
      toast(errorMessage(err && err.status), true)
    })
  }

  function makeButton(id, tr) {
    var nameEl = tr.querySelector('.file-name-text')
    var label = fileLabel(nameEl && nameEl.textContent, id)
    var btn = document.createElement('button')
    btn.type = 'button'
    btn.className = 'upc-row-del-btn'
    btn.textContent = '删除'
    btn.title = '删除（点两次确认）'
    btn.setAttribute('aria-label', '删除 ' + label)
    btn.addEventListener('click', function (event) { onDeleteClick(id, btn, tr, label, event) })
    return btn
  }

  function updateEmpty() {
    var tbody = document.querySelector('.file-table tbody')
    if (!tbody) return
    var rows = tbody.querySelectorAll('tr')
    var visible = 0
    var gone = 0
    for (var i = 0; i < rows.length; i++) {
      var tr = rows[i]
      if (tr.classList.contains('upc-row-del-empty')) continue
      if (tr.classList.contains('upc-row-del-gone')) { gone++; continue }
      if (tr.querySelector('a.dl-btn-sm[href*="/api/download/"]')) visible++
    }
    var placeholder = tbody.querySelector('.upc-row-del-empty')
    if (visible === 0 && gone > 0) {
      if (placeholder) return
      var row = document.createElement('tr')
      row.className = 'upc-row-del-empty'
      var td = document.createElement('td')
      td.colSpan = 6
      td.textContent = '本页文件已删除'
      row.appendChild(td)
      tbody.appendChild(row)
    } else if (placeholder && visible > 0) {
      placeholder.remove()
    }
  }

  function scan() {
    var anchors = document.querySelectorAll('a.dl-btn-sm[href*="/api/download/"]')
    for (var i = 0; i < anchors.length; i++) {
      var a = anchors[i]
      var td = a.closest('td')
      var tr = a.closest('tr')
      if (!td || !tr) continue
      var id = fileIdFromHref(a.getAttribute('href'))
      if (!id) continue
      if (deleted[id]) {
        tr.classList.add('upc-row-del-gone')
        continue
      }
      if (td.querySelector('.upc-row-del-btn')) continue
      td.appendChild(makeButton(id, tr))
    }
    updateEmpty()
  }

  function scheduleScan() {
    if (scanTimer) return
    scanTimer = setTimeout(function () {
      scanTimer = null
      scan()
    }, 50)
  }

  function boot() {
    if (window.__UPC_ROW_DELETE_BOOTED__) return
    window.__UPC_ROW_DELETE_BOOTED__ = true

    fetch('/api/auth/me', { credentials: 'same-origin' })
      .then(function (res) {
        return res.text().then(function (text) {
          return res.ok ? parseJson(text) : null
        })
      })
      .then(function (me) {
        if (!canDelete(me)) return
        injectStyle()
        scan()
        var observer = new MutationObserver(scheduleScan)
        observer.observe(document.documentElement, { childList: true, subtree: true })
      })
      .catch(function () { /* 未登录 / 网络问题：什么都不做 */ })
  }

  boot()
})()
