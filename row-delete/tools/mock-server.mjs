/* 本地 mock：照搬站点资料库列表的表格结构，给 row-delete 做端到端测试。
 * 不联网、不碰生产站。用 node row-delete/tools/e2e.mjs 启动。
 */
import http from 'node:http'

const FILES = [
  {
    id: 'f1',
    original_name: '自动控制原理_课件_第1章.pdf',
    category: '自动控制原理',
    sub_category: '课件',
    file_size: '1.2 MB',
    download_count: 3,
    created_at: '2026-09-01'
  },
  {
    id: 'f2',
    original_name: '自动控制原理_试卷_2022-2023.pdf',
    category: '自动控制原理',
    sub_category: '试卷',
    file_size: '3.5 MB',
    download_count: 12,
    created_at: '2026-09-05'
  },
  {
    id: 'f3',
    original_name: '自动控制原理_实验_实验报告.docx',
    category: '自动控制原理',
    sub_category: '实验',
    file_size: '873.3 KB',
    download_count: 1,
    created_at: '2026-09-06'
  }
]

const page = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8">
<title>upcshare · 资料库（mock）</title>
<script>
  // 用 ?role=member 换身份，content script 随后请求 /api/auth/me 时读这个 cookie
  const role = new URLSearchParams(location.search).get('role')
  if (role) document.cookie = 'role=' + encodeURIComponent(role) + '; path=/'
</script>
<style>
  :root { --danger:#ff3b30; --border:#e5e7eb; --text-primary:#111827; --text-secondary:#6b7280; --text-tertiary:#9ca3af; --accent:#0071e3; --accent-light:#eaf3ff; --bg:#f5f6f8; --surface:#fff; }
  body { margin:0; padding:32px; font:14px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif; color:var(--text-primary); background:var(--bg); }
  .file-table-wrap { background:var(--surface); border:1px solid var(--border); border-radius:12px; overflow:hidden; }
  .file-table { width:100%; border-collapse:collapse; }
  .file-table th { text-align:left; padding:14px 18px; font-size:12px; font-weight:600; color:var(--text-tertiary); border-bottom:1px solid var(--border); }
  .file-table td { padding:14px 18px; border-bottom:1px solid var(--border); }
  .file-table tr:last-child td { border-bottom:none; }
  .file-name-text { font-weight:500; }
  .file-sub-path { display:block; font-size:12px; color:var(--text-tertiary); }
  .dl-btn-sm { display:inline-flex; align-items:center; padding:6px 14px; font-size:12px; font-weight:500; color:var(--accent); border:1px solid var(--accent); border-radius:16px; text-decoration:none; }
  #rerender { margin-top:20px; }
</style></head>
<body>
<main>
  <div class="file-table-wrap">
    <table class="file-table">
      <thead><tr><th class="col-name">文件名</th><th>学科</th><th>大小</th><th>下载量</th><th>日期</th><th></th></tr></thead>
      <tbody id="tbody"></tbody>
    </table>
  </div>
  <button id="rerender">模拟 Vue 重画</button>
</main>
<script>
  const FILES = ${JSON.stringify(FILES)};
  const tbody = document.getElementById('tbody');
  function render() {
    tbody.innerHTML = FILES.map(function (f) {
      return '<tr data-id="' + f.id + '">' +
        '<td><div class="file-name-cell"><div class="file-name-wrap">' +
          '<span class="file-name-text">' + f.original_name + '</span>' +
          (f.sub_category ? '<span class="file-sub-path">' + f.sub_category + '</span>' : '') +
        '</div></div></td>' +
        '<td>' + f.category + '</td><td>' + f.file_size + '</td>' +
        '<td>' + f.download_count + '</td><td>' + f.created_at + '</td>' +
        '<td style="text-align:right"><a class="dl-btn-sm" href="/api/download/' + f.id + '">下载</a></td>' +
      '</tr>'
    }).join('');
  }
  render();
  document.getElementById('rerender').addEventListener('click', render);
</script>
</body></html>`

export function startMock(port) {
  const state = { deletes: [] }
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1')
    if (process.env.MOCK_DEBUG) console.log('[mock]', req.method, url.pathname)

    if (url.pathname === '/api/auth/me') {
      const cookie = String(req.headers.cookie || '')
      const m = cookie.match(/(?:^|;\s*)role=([^;]+)/)
      const role = m ? decodeURIComponent(m[1]) : 'admin'
      res.setHeader('content-type', 'application/json; charset=utf-8')
      res.end(JSON.stringify(role === 'member'
        ? { logged_in: true, is_admin: false, username: 'mock-member' }
        : { logged_in: true, is_admin: true, username: 'mock-admin' }))
      return
    }

    if (url.pathname.startsWith('/api/admin/files/') && req.method === 'DELETE') {
      const id = decodeURIComponent(url.pathname.slice('/api/admin/files/'.length))
      state.deletes.push(id)
      setTimeout(() => {
        res.setHeader('content-type', 'application/json; charset=utf-8')
        res.end(JSON.stringify({ ok: true, msg: 'File deleted' }))
      }, 60)
      return
    }

    if (url.pathname === '/__state') {
      res.setHeader('content-type', 'application/json; charset=utf-8')
      res.end(JSON.stringify(state))
      return
    }

    if (url.pathname === '/__reset') {
      state.deletes.length = 0
      res.end('{}')
      return
    }

    if (url.pathname === '/' || url.pathname === '/index.html') {
      res.setHeader('content-type', 'text/html; charset=utf-8')
      res.end(page)
      return
    }

    res.statusCode = 404
    res.end('not found')
  })

  return new Promise((resolve) => {
    server.listen(port, '127.0.0.1', () => resolve({ server, state }))
  })
}

if (process.argv[1] && process.argv[1].endsWith('mock-server.mjs')) {
  const port = Number(process.env.MOCK_PORT) || 8791
  const { state } = await startMock(port)
  console.log('mock listening on http://127.0.0.1:' + port, 'files:', FILES.map((f) => f.id).join(','))
  process.on('SIGINT', () => { console.log(JSON.stringify(state)); process.exit(0) })
}
