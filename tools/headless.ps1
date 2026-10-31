# 无头 Chrome 驱动器：起一个带远程调试的 Chrome，跑冒烟测试/截图，再收拾干净。
#
# 用法（在项目根目录）：
#   .\tools\headless.ps1 -User <账号> -Password '你的密码'              # 跑冒烟测试
#   .\tools\headless.ps1 -User <账号> -Password '你的密码' -Screenshot  # 重新生成 preview.png
#   .\tools\headless.ps1 -User ... -Password ... -Keep                     # 跑完不关浏览器，方便手工看
#
# 说明：Chrome 正式版（137+，这里的 156）已经禁止命令行 --load-extension，
# 所以 tools/smoke.mjs 会自己把 content.js 注入页面执行——测的是脚本本身，
# 不是"打包成扩展"这一层（那一层由 chrome://extensions 手工加载验证）。

param(
  [Parameter(Mandatory = $true)][string]$User,
  [Parameter(Mandatory = $true)][string]$Password,
  [switch]$Screenshot,
  [switch]$Keep,
  [int]$Port = 9333
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$profile = Join-Path $env:TEMP ("upc-headless-" + [guid]::NewGuid().ToString('N').Substring(0, 8))

$chromeCandidates = @(
  "$env:ProgramFiles\Google\Chrome\Application\chrome.exe",
  "${env:ProgramFiles(x86)}\Google\Chrome\Application\chrome.exe",
  "$env:LOCALAPPDATA\Google\Chrome\Application\chrome.exe",
  "$env:ProgramFiles\Microsoft\Edge\Application\msedge.exe"
)
$chrome = $chromeCandidates | Where-Object { Test-Path $_ } | Select-Object -First 1
if (-not $chrome) { throw '没找到 Chrome / Edge，请先安装 Chrome。' }

Write-Host "Chrome: $chrome"
Write-Host "Profile: $profile"

# 端口被上一轮残留的无头 Chrome 占着时，新起的那个绑不上端口，smoke.mjs 会连到**旧浏览器**，
# 于是测的是上一次注入的 content.js——看着全过，其实测了旧版本（2026-10-31 就这么被骗过一次）。
# 所以先把端口让出来；让不出来就直接失败，绝不静默复用。
$stale = Get-CimInstance Win32_Process -Filter "Name='chrome.exe' OR Name='msedge.exe'" -ErrorAction SilentlyContinue |
  Where-Object { $_.CommandLine -match "--remote-debugging-port=$Port\b" }
if ($stale) {
  foreach ($p in $stale) {
    Write-Host "清理占用端口 $Port 的残留浏览器：PID $($p.ProcessId)"
    Stop-Process -Id $p.ProcessId -Force -ErrorAction SilentlyContinue
  }
  Start-Sleep -Milliseconds 800
}

$proc = Start-Process -FilePath $chrome -PassThru -ArgumentList @(
  '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
  "--user-data-dir=$profile", "--remote-debugging-port=$Port",
  'https://in.upcshare.cn/'
)

$code = 1   # 先置失败：中途 throw 时不能把硬失败报成退出码 0

try {
  $ready = $false
  for ($i = 0; $i -lt 40; $i++) {
    Start-Sleep -Milliseconds 250
    try {
      $list = Invoke-WebRequest -Uri "http://127.0.0.1:$Port/json/list" -UseBasicParsing -TimeoutSec 2
      if ($list.StatusCode -eq 200) { $ready = $true; break }
    } catch { }
  }
  if (-not $ready) { throw "Chrome 没有在 127.0.0.1:$Port 上就绪" }

  $env:CDP_PORT = "$Port"
  $env:UPC_USER = $User
  $env:UPC_PASSWORD = $Password

  if ($Screenshot) {
    node (Join-Path $root 'tools\screenshot.mjs')
  } else {
    node (Join-Path $root 'tools\smoke.mjs')
  }
  $code = $LASTEXITCODE
} finally {
  if (-not $Keep) {
    # 只收拾我们自己在临时 profile 上开的那个实例（含它的子进程）。
    # 之前按"同一个 exe + 启动时间"过滤，会顺手杀掉用户在这期间自己打开的 Chrome 窗口。
    $targets = @($proc.Id)
    for ($i = 0; $i -lt 6; $i++) {
      $kids = Get-CimInstance Win32_Process -Filter "Name='chrome.exe'" -ErrorAction SilentlyContinue |
        Where-Object { $_.CommandLine -like "*$profile*" -or ($targets -contains $_.ParentProcessId) }
      if (-not $kids) { break }
      $new = @($kids | ForEach-Object { $_.ProcessId }) | Where-Object { $targets -notcontains $_ }
      if (-not $new.Length) { break }
      $targets += $new
    }
    $targets | ForEach-Object { Stop-Process -Id $_ -Force -ErrorAction SilentlyContinue }
    if (-not $proc.HasExited) { try { $proc | Stop-Process -Force -ErrorAction Stop } catch {} }
    Remove-Item $profile -Recurse -Force -ErrorAction SilentlyContinue
  } else {
    Write-Host "浏览器仍在运行（profile: $profile）"
  }
}

exit $code
