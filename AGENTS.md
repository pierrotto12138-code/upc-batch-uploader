# AGENTS.md

> 给下一个接手这个项目的 AI agent（或开发者）。
> 读这一份就够开工，不需要重新调研站点。**最后更新：2026-10-31，v0.3.32 生产端到端 62 项断言全过、站点无残留。**
> 代码仓库：<https://github.com/pierrotto12138-code/upc-batch-uploader>（`dist/`、`files/`、归档目录都不进仓库）
>
> **进度对齐看 [HANDOFF.md](HANDOFF.md)：做到哪了、验过什么、什么没做、哪些目录不能外发。**
> 感谢 [upc-share](https://github.com/foggy-33/upc-share) 的作者为学校资源共享做出的伟大贡献；
> 感谢 DeepSeek V4.1 Flash 与 Qwen 3.8 Flash 的优渥能力。

## 目录

- [0. 30 秒上手](#0-30-秒上手)
- [1. 这个项目是什么](#1-这个项目是什么)
- [2. 现状](#2-现状2026-10-31-实测)
- [3. 环境](#3-环境)
- [4. 文件地图](#4-文件地图)
- [5. 架构与数据流](#5-架构与数据流)
- [6. 服务端契约（摘要）](#6-服务端契约摘要)
- [7. 红线（不要做）](#7-红线不要做)
- [8. 已知坑](#8-已知坑都踩过别再踩)
- [9. 测试](#9-测试)
- [10. 待办](#10-待办按价值排序含验收标准)
- [11. 代码风格](#11-代码风格)
- [12. 交接检查清单](#12-交接检查清单)

> 面向使用者的说明在 [README.md](README.md)；设计取舍在 [docs/design.md](docs/design.md)；
> 接口实测在 [docs/api.md](docs/api.md)；能否提 PR 在 [docs/pr-readiness.md](docs/pr-readiness.md)。

---

## 0. 30 秒上手

```powershell
# 1) 纯逻辑单测（不需要登录、不联网、不产生副作用）
node selftest.js

# 2) 端到端冒烟（会真上传一个 17 字节的探针文件到生产站，跑完自己删掉）
.\tools\headless.ps1 -User <账号> -Password '***'
```

两条都过了，说明当前代码是好的。改完任何东西，**两条都要重跑**。

---

## 1. 这个项目是什么

一个 **Chrome MV3 内容脚本**，注入到 `https://in.upcshare.cn`，
围绕「课程 → 目录 → 文件」三栏工作：选文件夹自动拆目录，或手动建课程/目录后拖文件，
按目录或整体调用站点 `/api/upload` 上传，可选自动审核通过。

**它不是什么（很重要）：**

- 不是服务端项目。没有后端、没有数据库、没有构建步骤。
- 不是爬虫。只操作用户自己登录的账号。
- 不修改 upcshare 站点。站点仓库是 [foggy-33/upc-share](https://github.com/foggy-33/upc-share)（Spring Boot 3 + MySQL + Vue 3），**我们没有改动它的权限，也不应该改**。
  顺带一句：这个平台让课程资料第一次有了"学长传下来、学弟找得到"的地方，**作者为学校做的贡献是这整个项目的前提**——
  技术上、文档里、PR 沟通时都要保持这份尊重（README 的[致谢](README.md#致谢)有正式表述）。

## 2. 现状（2026-10-31 实测）

| 项 | 状态 |
|---|---|
| 版本 | v0.3.32 |
| 面板 | 单视图三栏（学科分类 → 子目录 → 文件），融入站点外观并纵向铺满；颜色/圆角/字体运行时取自站点 token（含深色主题） |
| 课程栏 | 输入框 + 「从文件夹导入」+ 右上角「?」徽标（35px / 8px 圆角 / 15px·600）；手打全名回车或失焦也会带出站内子目录 |
| 子目录栏 | 每个学科分类常驻一行「根目录」；行右侧 30px 两段式垃圾桶（点两次才删，站内子目录与根目录禁用并说明原因）；「＋ 新建子目录」在列表下方 |
| 导入 | 「从文件夹导入」与**直接拖文件夹**共用同一条识别链路（按层级折算成学科分类 / 子目录，先弹"看得见规模"的确认，超 100 个文件也不截断） |
| 上传 | 令牌桶限速（burst 3 / 10.5 秒一个）、跳过已存在、只试运行、管理员自动通过审核、导出投递结果 CSV（UTF-8 BOM） |
| 权限 | 「已有资源」（看/删站内文件）仅管理员；站内子目录与根目录不可删（站点没有「目录」实体） |
| 单测 / 端到端 | 31 项 / 生产 62 项断言全过、站点无残留 |
| 打包 | `chrome --pack-extension` 通过，`manifest.json` 合法 |
| 真人鼠标 | 未验证（手感、大文件进度、滚动时的跟随） |
| 使用者 | 站点管理员账号（真实账号不进仓库；跑端到端时向使用者索取）。密码不写进仓库 |

> 每一条是怎么一步步变成这样的、当轮怎么验的，见 [docs/history.md](docs/history.md)。

---

## 3. 环境

| 需要 | 说明 |
|---|---|
| Chrome | 装扩展手工验证用；本机实测 156.0.8078.48 |
| Node ≥ 22 | 只用于跑测试（用了内置 `WebSocket` 和 `fetch`）。运行时零依赖 |
| 网络 | 必须在校园网，`in.upcshare.cn` 可直连（公网入口走 frp，会很慢） |

**没有** package.json、没有 `npm install`、没有 tsconfig。别加。

## 4. 文件地图

```
upc-batch-uploader/
├── manifest.json          # MV3；无 permissions；matches 三个域名
├── content.js             # ★ 全部逻辑与 UI（约 2800 行，IIFE）
│   ├── 纯函数区            # extOf/hasBadName/formatSize/normalizeText/matchScore/
│   │                       # bestCategory/splitRelativePath/safeSegment/dedupeKey/
│   │                       # classify/buildGroups/upsertDir/dirsFromItems/dirHasUploaded/
│   │                       # collectDirTargets/collectCourseTargets/
│   │                       # fuzzyFilter/dirOptions  ← 挂到 globalThis.__UPC_BATCH__
│   ├── 网络层              # apiJson / loadSiteIndex（含学科→目录收集）/ uploadFile(XHR) / approveFile
│   ├── Pacer              # 令牌桶限速器
│   ├── 状态 state          # me/categories/subcategories/index/course{name,dirs}/activeDir/running/progress/fullscreen
│   ├── UI                 # 标题鲸鱼 → 课程头 → 左目录栏 → 右文件区 → 底部队列；bind/组合框/拖拽
│   └── 路由同步            # isUploadRoute()/syncWithRoute()：进 /admin 开、离开就关并清空
├── selftest.js            # node selftest.js（31 项纯函数单测）
├── HANDOFF.md             # ★ 现在做到哪、验过什么、还没做（版本历史在 docs/history.md）
├── tools/
│   ├── headless.ps1       # 起无头 Chrome → 跑 smoke 或 screenshot → 清理
│   ├── smoke.mjs          # CDP 端到端（62 项断言：外观+铺满→「?」弹层→两档盒子/四档字号→门禁→导入→拖文件夹→上传→CSV→两段式删除→垃圾桶→换课清空）
│   └── screenshot.mjs     # 生成 preview.png（假 File，不上传）
├── docs/
│   ├── api.md             # ★ 服务端契约实测记录（字段、状态码、限速）
│   ├── design.md          # ★ 为什么这样设计（改代码前必读，21 条决策）
│   ├── history.md         # ★ 版本历史（v0.3.6 → 当前，每轮为什么改、怎么验）
│   ├── pr-readiness.md    # ★ PR 就绪度与移植记录：结论、缺陷清单、待上游拍板的三件事
│   ├── upstream-issue-draft.md  # 上游沟通草稿（**已当面沟通过，不再发送**，仅留档）
│   └── upstream-pr-body.md        # ★ PR 正文（已创建 [#1](https://github.com/foggy-33/upc-share/pull/1)）
├── icons/                 # 16/48/128
├── preview.png            # README 用的截图
└── README.md              # 面向使用者
```

## 5. 架构与数据流

```
点导航「上传资料」→ 站点自己跳 /admin → 面板覆盖在导航栏下方（300ms 轮询对齐路由）
   ↓
课程栏：下拉选已有课程（自动带出站内已有目录）/ 直接输入新名字建课 / 「从文件夹导入」
   ↓
importFiles(FileList) ── buildGroups() ── splitRelativePath()/bestCategory()
   ↓ 先弹「检测到 N 个文件、M 个目录」确认；多门课程则进课程选择弹层
applyImport(groups, courseName)
   ↓
state.course = { name, dirs: [{ name, files: [] }] }
   ↓
左侧目录 / 右侧文件；拖文件或「选择文件」→ dir.files.push(entries)
   ↓ （首次）ensureIndex() → loadSiteIndex()
/api/files + /api/admin/files?status=pending → classify()
   ↓ 用户确认（上传本目录 / 全部上传）
runTargets(targets) ── Pacer(3, 10500) ── uploadFile(XHR) ── approveFile()
   ↓
entry.status → 文件行状态、目录计数、底部队列同步
```

状态全部在内存（`state`），刷新页面即清空。**没有持久化**——这是刻意的，见 `docs/design.md` 第 8 条。

## 6. 服务端契约（摘要）

详细字段见 **`docs/api.md`**。必须记住的三条硬约束：

1. **上传限速 6 次/分钟、burst 3、并发 2**（Nginx）。`PACE = {burst:3, intervalMs:10500}` 就是按这个算的。
2. **站点单文件 ≤ 1GB**，但插件按产品要求把 `MAX_BYTES` 收紧到 **200MB**；扩展名白名单固定（与 `FileController.ALLOWED` 同步），文件名不能含 `..` 或 `<>:"|?*`。
3. **上传后是 `pending`**，前台看不到；`POST /api/admin/approve/{id}` 才能变 `approved`（该接口**无请求体**）。

## 7. 红线（不要做）

- ❌ 不要加密码输入框、不要把 token/密码写进 `localStorage` 或任何文件。
- ❌ 不要把上传改成跨源 `fetch`（会丢 Cookie）。必须保持同源：路径一律写 `/api/...`。
- ❌ 不要提高并发或去掉限速器。站点会给这个账号 429，甚至影响别人。
- ❌ 不要引入构建工具、框架、npm 依赖。改完直接能被 Chrome 加载是硬指标。
- ❌ 不要在测试里留下生产数据。`smoke.mjs` 必须在第 9 步删除探针文件。
- ❌ 不要把真实密码提交进仓库或写进 AGENTS.md / README。

## 8. 已知坑（都踩过，别再踩）

| 坑 | 现象 | 正确做法 |
|---|---|---|
| Chrome 正式版禁用 `--load-extension` | `--disable-extensions-except is not allowed in Google Chrome` | 测试时不用扩展加载，直接 CDP 注入 `content.js`（`smoke.mjs` 已这么做）；真人验证走 `chrome://extensions` UI |
| Shadow DOM 里 `hidden` 无效 | 面板一打开就全显示、关不掉 | 样式表里必须有 `[hidden]{display:none !important}` |
| 宿主 `pointer-events:none` 被继承 | 按钮看得见但鼠标点不动，`element.click()` 却正常 | 遮罩必须显式 `pointer-events:auto`；smoke 用真实鼠标事件验证 |
| 没有 `webkitRelativePath` | 测试时文件全归到一组 | 用 `Object.defineProperty(file,'webkitRelativePath',{value:'a/b/c.pdf'})` 伪造 |
| 拿不到上传进度 | 进度条不动 | 用 `XMLHttpRequest` 的 `upload.onprogress`，不要 fetch |
| 中文文件名 | 下载/列表里乱码 | 站点自己处理编码；插件只需原样传 `File`，不要转码 |
| `/api/files` 的 size 上限 100 | 传 200 会 400 或截断 | 前台 100、admin 200，分开写 |
| `Map.of` 空值 NPE | 站点偶尔 500（服务端旧代码） | 插件侧对 `data.items` 做空判断 |
| 页面是 SPA | 路由切换后面板还在 | 宿主机挂在 `documentElement` 上，与路由无关；重复注入用 `#upcshare-batch-host` 去重；面板靠 300ms 地址轮询跟随路由开关 |
| 内容脚本自己 `history.pushState` 改地址 | Vue Router 内部路由没变，点「资料库」被判成重复导航，地址卡在 `/admin`、面板关不掉 | **地址交给站点的路由器改**，插件只读 `location.pathname` 同步开关；不要拦下导航点击 |
| 组合框失焦的 120ms 延迟关闭 | 刚重新打开的下拉会被上一次失焦的定时器关掉（换课程时"点了没反应"） | `openMenu` 递增 `combo.gen`，延迟回调只在 `gen` 未变时才 `closeMenu` |
| 只把"点下拉"当成换课 | 手打一个站内已有的学科分类再回车/失焦，只算改名：站内明明有子目录（含挂在分类根下的那批），左栏却只剩一个空「新子目录」，用户读成"根目录不显示"（v0.3.29 修） | `commitTypedCourse()`：回车与失焦都拿 `normalizeText` 去 `state.categories` 里找同名，命中就 `switchCourse`；判定仍用 `courseFocusName`，所以"改名"和"换课"不会互相误伤，站里没有的名字仍是新建 |
| 用「当前 `state.course.name`」判断换课 | 点下拉之前一定先触发过 `input`（改名），实时值已经等于目标课程，于是永远判定成"没换课"，旧课程的目录留在左栏 | 比较基准取**进入输入框时**记的 `state.courseFocusName` |
| `/api/subcategories` 想按课程过滤 | 它**忽略** `category` 参数，返回全站 36 个目录名 | 按课程取目录只能 `GET /api/files?category=X` 自己聚合（`loadCourseDirs`） |
| 站内根目录文件 | `sub_category` 是空串，`?sub_category=` 是**有效筛选**（实测 455 条），不能省略 | 拼 URL 时空串也要带上 |
| 目录下拉掺全站目录名 | 别的课的「课设参考」出现在这门课的下拉里 | `dirOptions()` 只给本课站内目录 + 本次已建目录（v0.3.12 起不再用 `state.subcategories`） |
| 给站内已有目录改名或删除 | 站点没有改名接口，也没有"目录"这个实体（有文件才有目录）——这两个入口点了都改变不了任何事 | **都不给**：`canRenameDir()` / `canRemoveDir()` 都等于"非站内目录"；已有目录名称只读、focus 与 click 都不展开下拉（`openMenu` 里 `if (input.readOnly) return`）、菜单里只有「上传本目录」；原因写在常驻的 meta 行而不是点了才弹的提示 |
| 站内目录里的文件被删空 | 服务器那边目录就没了，左栏还留着一行空目录，看着像 bug | `dropEmptiedSiteDir()`：`已有资源` 删完最后一个文件就把这一行收掉 |
| 端到端里"换课"挑到的目标课恰好就是当前课 | 断言永远失败在"旧子目录没清空"，其实只是把换课当成了改名（v0.3.29 加断言时踩到） | 挑"既不是测试课、也不是当前这门"的分类：`list.find(c => c !== PROBE_CATEGORY && c !== 当前输入框的值)` |
| 合成 `.click()` / 对已聚焦的元素 `.focus()` | 测试里"点了没反应"：不触发 blur/focus 事件，依赖 focus 才打开的下拉根本没开 | 测试里先 `blur()` 再 `focus()`；真实鼠标不受影响 |
| 用「还差什么」那行提示去覆盖"刚建了个空子目录" | 点「新建子目录」明明成功了，却立刻在上方冒出一行黄字"请先填写或选择课程名称"——用户读成"新建被拒了"（v0.3.20 修） | 那行只解释"上传为什么是灰的"，所以触发条件必须收紧到 `invalid && total > 0`（真的有待传文件）；文案也点名「上传」而不是泛泛的"才能开始上传" |
| 只把按钮 `disabled` 就当"禁用了" | `.upc-add-dir` 是自绘的虚线按钮，禁用后照样 hover 变蓝、光标还是手型——用户以为能点，点了没反应（v0.3.22） | 禁用态要一起改样式：`.upc-add-dir[disabled]{opacity:.45;cursor:not-allowed}` + 去掉 hover 高亮，并用 `title` 就地写明为什么 |
| 只在按钮上拦、`addDir()` 内部不拦 | 键盘、`addFilesToActive()` 这些路径照样能进到建目录逻辑；而 `addFilesToActive` 里 `addDir()` 被拒绝后 `state.activeDir` 还是 null，下一行 `.files` 直接 TypeError | 守卫写在动作函数第一行（和按钮同一个条件 `safeSegment(state.course.name)`），调用方补 `if (!state.activeDir) return` |
| 「已有资源」把全站待审核文件当成当前子目录的 | `/api/admin/files?status=pending` 是**全站**范围、不按学科分类筛；管理员在 A 目录的列表里能看到 B 学科分类的文件，两步确认后删掉的就是别人的文件（v0.3.22 修，之前一直没撞上是因为当时站内恰好没有待审核文件） | `loadSiteFiles` 拿到 pending 之后按 `category` + `sub_category`（归一化）自己筛一遍，再和前台列表合并 |
| 端到端用固定的探针文件名 | 站点的文件列表有短时缓存：上一轮删掉的文件，下一轮的索引里可能还留着 → 被判 `dup`，`全部上传（0）`，看起来像产品 bug（2026-10-31 就这么误报过一次） | 文件名带时间戳（`PROBE_NAME`），**清理和"站点无残留"检查按前缀 `PROBE_PREFIX` 扫**，把历史遗留一起删掉 |
| 对 `disabled` 的复选框调 `.click()` | 静默无操作：勾不上也不报错，失败要到下一步断言才暴露，查半天（2026-10-31 的 `自动通过审核` 假失败） | 点完立刻读 `.checked` 作为独立断言，没勾上就再点一次——别让静默失败往下走 |
| 下拉定位时提示行还没显示 | 监听器注册顺序：`bindCombo` 的 focus 先跑，按"没有改名说明"的高度定位，之后说明才出现 → 被挡住 | 把改名提示的 focus 监听注册放在 `bindCombo` **之前**，让下拉贴着整条 head 下沿展开 |
| 借站点的按钮类改样式，只改静止态 | 上游 Vue 版「从文件夹导入」复用了站点 `.btn-upload`（整宽实心蓝提交键），只覆盖了 `background/padding`，**鼠标一碰就命中全局 `.btn-upload:hover{background:var(--accent-hover)}`**，变成蓝底配深色字，看着像坏掉（v0.3.25 修） | 借类改样式要把 `:hover` / `:disabled` / `:focus` 一起接管；改完用无头脚本读 `getComputedStyle` 的静止态和 hover 态两份，别只看一张截图 |
| 点一下行再量它的按钮 | 点行会重画左栏，之前抓到的节点已经脱离文档：`getComputedStyle` 全空、点击也不生效，看起来像"按钮没反应"（v0.3.31 加垃圾桶断言时踩到） | 交互后再重新 `querySelector` 取节点，别拿旧引用 |
| 端到端里挑"当前行"的按钮 | 第一行永远是常驻的「根目录」，`querySelector(".upc-dir-del")` 抓到的可能是它，断言就会拿根目录的提示去比站内子目录的提示（v0.3.31 踩到） | 按语义挑：`.upc-dir.on` / 按名字过滤，或把断言写成"两种说明都算" |
| 为了"好点"把图标字号调大 | 清除用的红 × 从 15px 调到 18px，`smoke`/`ui-check` 那条"字号只有四档"的断言立刻红——它抓到的是我自己在收口后又开出第五种字号（v0.3.30） | 点击区靠 `width/height` 的盒子给，字形留在符号档 15px；断言别关掉，它是最后一道闸 |
| 同一排里混用"实线 / 虚线 / 无边框"三种描边 | 用户读成"四个不同样子的框，很难看"——而且虚线在这个界面里是拖放区（`.upc-drop`）的语言，给按钮用会串味（v0.3.25 统一） | 同一排的可操作盒子只用一套：同底色 + 同 1px 实线 + 同圆角 + 同字号，主次靠字色字重区分，hover 只点亮描边 |
| 用 `Blob.text()` 量 CSV 开头的 BOM | TextDecoder 解码时默认把字节序标记吃掉，明明带 BOM 的文件被量成"没有"，测试假红（v0.3.28 踩过） | 量 BOM 要看 `arrayBuffer()` 的前三个字节（EF BB BF）；要文本就 `new TextDecoder("utf-8",{ignoreBOM:true})` 再自己去掉开头那个字符 |
| 断言里"先点取消、再读弹层可见性" | `folderConfirm.hidden` 是在取消之后才读的，永远 true，看起来像"确认根本没弹"（v0.3.28 踩过） | 状态要紧跟动作读，在任何收尾点击之前存进局部变量 |
| 端到端"页面上已经有面板就跳过注入" | 上一轮超时/中断留下的无头 Chrome 还占着 9333，新一轮的 Chrome 绑不上端口，`smoke.mjs` 连到**旧浏览器**——那里面的面板是上一次注入的 `content.js`，于是改了代码照样 46/46 全过（v0.3.26 才发现） | `headless.ps1` 起 Chrome 前先把占着 `--remote-debugging-port` 的残留浏览器清掉；`smoke.mjs` 第 1 步**无条件**重新加载页面 + 注入工作副本，并把 `v版本号 / 字节数 / sha 前 12 位` 打进日志，让每次运行自带"测的是哪一份"的证据；`screenshot.mjs` 同理（否则 `content.js` 的宿主去重守卫会让注入变成空操作） |

## 9. 测试

```powershell
node selftest.js                                   # 秒级，零副作用
.\tools\headless.ps1 -User <账号> -Password <密码>  # 约 30 秒，会真上传再删除
.\tools\headless.ps1 -User <账号> -Password <密码> -Screenshot   # 重新生成 preview.png
```

`smoke.mjs` 的 50 项断言：注入 → 登录 → 真实鼠标点导航「上传资料」→ 全屏页保留顶部导航 →
**外层卡片已拆掉、内容分块成站点样式** → **纵向铺满（面板高 ≥ 视口高 - 导航栏）** →
管理员能看到审核开关 → 点「资料库」自动关闭 →
打开就是单视图工作台（无独立空状态页，清除用的 × 也藏着）→
未选课程时引导可见、上传与新建子目录都禁用 → 学科分类下拉全量（站内当前数量，会波动）且在输入框下方可滚轮 →
没选学科分类时「新建子目录」禁用、点不出目录（v0.3.22）→ 输入学科分类后解禁、连点两下默认名分得开（新子目录 / 新子目录 2）→ 放文件后提示行不出现 → 导入前弹「几个文件/几个目录」确认 →
确认导入识别课程 → 文件进目录 → 新建目录 → **目录下拉只含本课目录且不挡改名说明** →
**本次新建目录的菜单 = 上传本目录 / 重命名 / 从本次列表移除** → 移除空目录 → 试运行 →
**单目录上传** + 自动审核 → 站内校验 →
**站内已有的目录：名称只读、点了不提示不下拉、菜单里只有上传（改名和删除都给不了）** →
**「已有资源」列出站内文件 → 删除要先点一次确认 → 确认后删除 → 站点无残留** →
**改名即时生效并留下一行确认（没有保存按钮）** → **换到别的课程后旧课程的目录已清空** →
整理规范弹层（内容 / 两颗按钮与焦点 / 复制反馈 / 关闭）→ **课程栏两个盒子 + 主按钮同规格**（35px/8px/14·600）→
**全面板只有两档盒子**（次级 34px/13·500，圆角一律 8px）→ **「?」徽标压在导入按钮右上角**（默认收起 tooltip、有 aria-label、Tab 能走到且聚焦时 tooltip 浮出）。

**面板里的 `window.confirm` 由 smoke 自动接受**（`Page.javascriptDialogOpening` → `handleJavaScriptDialog`），
否则换课程/导入覆盖/删目录那几处确认会把无头测试卡住。

**改 UI 后没跑 smoke 就等于没测。** 单测只覆盖纯函数，`content.js` 里 UI 部分只有 smoke 能覆盖。

## 10. 待办（按价值排序，含验收标准）

### ~~P0 · 拖拽文件夹~~ 已完成（v0.3.28）
- `receiveDrop()` 在 drop 同步阶段取 `webkitGetAsEntry()`，`entryToNode()` 递归展开（`readEntries` 一次最多 100 条，循环读到空），`flattenDropTree()` 把根目录名留成路径第一段 → 与「从文件夹导入」共用同一条 `buildGroups` 链路。
- 做法：监听 `dragover/drop`，用 `DataTransferItem.webkitGetAsEntry()` 递归遍历目录，拼出 `relPath` 后复用 `buildGroups()`。
- 验收：拖入 3 层目录，分组结果与 `input[webkitdirectory]` 完全一致；拖非文件夹时给出提示不乱报错。
- 注意：`webkitGetAsEntry()` 必须在 `drop` 事件同步阶段调用，异步后再调用返回 null。

### ~~P0 · 结果导出~~ 已完成（v0.3.28）
- 纯函数 `exportCsv(rows)`（UTF-8 BOM + CRLF + 逗号/引号/换行转义），底部队列「导出结果」用 `Blob` + `URL.createObjectURL` 下载，列即 `relPath,category,sub_category,status,id,error`。

### P1 · 更深目录
- 现状：`dirs.length > 2` 时把第二段当学科，其余拼成 `a/b` 目录。
- 需求：支持"学科/章/节"这种多级，或让用户在 UI 里指定"第几段是学科"。
- 验收：`splitRelativePath` 新增参数 `courseDepth`，`selftest.js` 补 3 个用例，旧用例不回归。

### P1 · 进度体验
- 显示整体 ETA（剩余字节 / 实测速度）、当前文件速度、暂停/继续。
- 验收：100 个假文件时 ETA 误差 < 20%；暂停后点继续能从下一个文件接着传。

### P2 · 与站点联动
- 上传完成后给出"去后台查看"的链接；或直接调用 `/api/admin/files?status=pending` 显示结果列表。
- 验收：点链接跳到 `/dashboard`（站点后台路由）且不丢登录态。

### P2 · 可配置化
- 把 `PACE`、`MAX_BYTES`、白名单从硬编码改成设置面板（存 `localStorage`）。
- 验收：改完不重启页面生效；默认值仍与站点一致。

### P2 · 同名目录合并（已做一半）
- 导入路径已经合并：`applyImport` 走 `upsertDir`，归一化后同名（`期末 试卷` == `期末试卷`）并到同一行，`selftest.js` 有用例。
- 手工「新建子目录」是**故意**各占一行的（连点两次就是要两个）；v0.3.21 给默认名编号（新子目录 2 / 3…）解决"看不出谁是谁"。
- 还没做的：用户把两个子目录**手动改成同名**时既不合并也不提示——真撞名了会往站内同一个目录传两批文件。

### P2 · 并入站点（提 PR）— 已移植，PR 待发
- **2026-10-31：用户已和上游作者打过招呼，授权提 PR。** 移植已完成并推到 fork：
  `pierrotto12138-code/upc-share` 分支 `feat/batch-upload`（本地工作副本 `C:\Users\Pierrot\Documents\upc-share`）。
  17 个文件（15 个源码 + 2 张验证截图）、约 2900 行：`vue/src/uploader/{logic,api,useUploader,organizePrompt}.js` + `vue/src/components/uploader/*`（6 个组件，含「不知道怎么整理？」的规范弹层）+ 重写 `views/Upload.vue`，
  外加 30 条 `node --test` 用例和 `vue/tools/` 的本地验证脚本；**`package.json` 未改，没引入任何依赖**。
  分支上七个 commit，最新 `626c30d`（课程栏三个盒子统一成同一个盒子同一套字 + 无头检查补齐弹层与对齐断言）。
- 验证（2026-10-31 全新 `npm install` 之后重跑，不是复用上一轮绿灯）：30 条单测全过、`vite build` 通过、
  **29 项无头交互断言全过**（真实鼠标 + 真 Tab 键 + 合成 drop 事件，打的是本地 mock，不碰生产站；
  覆盖两档盒子与四档字号、「?」徽标可达性、拖入三层文件夹走导入识别、导出 CSV 按字节核对 BOM）。
  分支上十五个 commit，最新 `7d05cee`（两档盒子与四档字号、「?」徽标、拖文件夹递归、结果导出 CSV、界面收口、根目录常驻、两段式垃圾桶并加大到 30px）。
- **上游 `node_modules/` 的坑（2026-10-31 踩实）**：它是提交进仓库的，但根 `.gitignore` 的 `dist/` 把
  `node_modules/*/dist/` 一起排除了，所以克隆下来跑不了 `npm run build`，必须 `npm install`；
  本机 npm 的 allow-scripts 会拦 esbuild 的 postinstall，还得补一句 `node node_modules/esbuild/install.js`。
  **装完别指望 `git checkout -- vue/node_modules` 还原**——它只恢复"被跟踪的那些文件"，
  会把 npm 刚换上的新版本和 git 里的旧副本混着摆，实测结果是一串包"目录在、dist 没了"，`vite build` 逐个报
  `ERR_MODULE_NOT_FOUND` / `Failed to resolve entry`，只能整目录删掉重装。
  正确做法只有一个：**node_modules 让它在本地脏着**，提交时只 `git add` 自己那 17 个文件，
  并用 `git diff --cached --name-only | grep -c node_modules` 确认是 `0` 再 commit。
- **PR 已创建**（2026-10-31）：[#1](https://github.com/foggy-33/upc-share/pull/1)，OPEN / MERGEABLE，17 个文件、+3147/−89。正文与三条待确认项记录在 `docs/upstream-pr-body.md`。
  里面列了三个待确认项：限速放客户端还是服务端、`/admin` 是否直接替换、自动通过审核是否保留。

### 想清楚再做
- 支持 `.zip` 自动解包上传？——站点不支持服务端解包，浏览器里解压 1GB 会炸内存。
- 多账号切换？——超出"个人工具"定位。

## 11. 代码风格

- ES5 风格：`var` + `function`，不用箭头函数/class 语法糖（`Pacer` 用原型）。原因：保持能在旧 Chrome 里跑，也避免"要不要加 Babel"的讨论。
- 中文注释，解释"为什么"，不解释"做了什么"。
- 纯函数放文件顶部，UI 相关放后面。新增纯函数要挂到 `globalThis.__UPC_BATCH__` 并补 `selftest.js`。
- 所有用户可见文案用中文；错误信息带上原始 HTTP 状态，方便用户截图反馈。
- **界面名词一律用站点口径：「学科分类」「子目录」**（对齐 `Upload.vue` 的两个字段标签）。
  "课程/目录"只允许出现在代码内部（`state.course`、`addDir`、`dirTitle`）和解释性注释里；
  `isContainerName()` 比对的 `'我的课程资料' / '课程资料' / '课程文件' / '总目录'` 是用户硬盘上真实的文件夹名，**改了会破坏路径折算**。
  文件直接挂在学科分类下（`sub_category` 空串）那一行仍显示「根目录」。取舍见 `docs/design.md` 第 17 条。

## 12. 交接检查清单

- [ ] `node selftest.js` 全绿（31 项）
- [ ] tools/headless.ps1 62 项断言全过，站点无残留（第 9 步会验证）
- [ ] 若改了 UI：重新跑 `-Screenshot`，`preview.png` 有变化
- [ ] 若改了接口假设：同步更新 `docs/api.md`
- [ ] 若改了设计取舍：同步更新 `docs/design.md`
- [ ] 若改了 `content.js` / `manifest.json`：升版本号并重建 `dist/`（文件夹 + zip + crx）
- [ ] 阶段性收尾：更新 `HANDOFF.md` 的「做到哪 / 没做啥 / 复验命令」
- [ ] 没有把密码/token 写进任何文件（`git grep -i password` 自查）
