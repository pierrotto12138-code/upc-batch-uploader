# 交接文档 · 2026-10-31 · v0.3.32

> 配合 [AGENTS.md](AGENTS.md)（怎么开工）、[docs/design.md](docs/design.md)（为什么这样设计）、
> [docs/history.md](docs/history.md)（每个版本改了什么）一起看。
> 这一份只回答一个问题：**现在做到哪了，什么验过，什么没做。**
> 感谢 [upc-share](https://github.com/foggy-33/upc-share) 的作者为学校资源共享做出的伟大贡献；
> 感谢 DeepSeek V4.1 Flash 与 Qwen 3.8 Flash 的优渥能力。

| 项 | 状态 |
|---|---|
| 版本 | v0.3.32（`dist/` 已重建：文件夹 + zip + crx） |
| 单测 | 31 项全绿（`node selftest.js`） |
| 端到端 | 生产站 62 项断言全过、站点无残留（2026-10-31） |
| Vue 镜像 | 31 条 `node --test` / 29 项无头断言 / `vite build` 均通过 |
| 未验证 | 真人鼠标手感、几百 MB 大文件的进度表现 |
| 提 PR | **已创建 [#1](https://github.com/foggy-33/upc-share/pull/1)**（2026-10-31，OPEN / MERGEABLE），等上游作者 review——见 [docs/pr-readiness.md](docs/pr-readiness.md) 与 §4 |

## 目录

- [0. 一句话状态](#0-一句话状态)
- [1. 怎么确认当前代码是好的](#1-怎么确认当前代码是好的)
- [2. 入口与交互的实现要点](#2-入口与交互的实现要点改代码前必读)
- [3. 隐私与数据红线](#3-隐私与数据红线这一条最重要)
- [4. 还没做的](#4-还没做的按价值排序)
- [5. 分发包](#5-分发包)

> 版本历史（v0.3.6 → v0.3.32 每轮改了什么）搬到了 [docs/history.md](docs/history.md)。

---

## 0. 一句话状态

插件 v0.3.32 端到端可用：**31 项单测全绿、62 项生产端到端断言全过、站点无残留**（2026-10-31 实测）；
同一份逻辑已移植进上游 Vue 版并提交 PR [#1](https://github.com/foggy-33/upc-share/pull/1)（见 §4 第 6 条）。
`files/` 里 410 个课件已全部整理+去隐私+压成合规格式，随时可以上传。
面板现在**看起来就是站点自己的一个页面**（标题 + 几块卡片，没有外层对话框，
颜色/圆角/阴影/字体在运行时取自站点 CSS token，含深色主题），
只有一个视图；目录按课程单独拉取（含"文件直接挂在课程下"的根目录）、换课必清空；
**站内已有的目录既不给改名也不给"删除目录"**（站点没有这两个操作，目录是文件推出来的），
只有「已有资源」里删站内文件这一个真删除入口，且仅管理员可见。
**v0.3.18 是一轮全量审查的结果**：结论、缺陷清单和修复见 `docs/pr-readiness.md`。

---

## 1. 怎么确认当前代码是好的

```powershell
node selftest.js                                        # 全部通过：31 项（零副作用）
.\tools\headless.ps1 -User <账号> -Password '<问用户要>'   # 约 40 秒，会真上传 17 字节探针再删掉
.\tools\headless.ps1 -User ... -Password ... -Screenshot     # 重新生成 preview.png
```

**v0.3.19 → v0.3.22 已经一起补上了生产端到端**（2026-10-30 22:58，41 项断言全过、站点无残留、退出码 0），
`preview.png` 也在 22:59 重新生成过。中间跑出过一次真失败，见 [docs/history.md](docs/history.md) 的 v0.3.22：
「已有资源」把**全站**待审核文件混进当前子目录的列表，管理员伸手删的就是别人学科分类的文件——已修。
（术语与字号那部分当时只在本地 mock 站点 `C:\Temp\upcorg\harness` 逐项验过：
标题「批量投递 / upcshare」同为 20px，学科分类栏标签/输入框/按钮同为 14px，输入框与按钮同为 35px 高。）

2026-10-30 晚些时候实测结果（v0.3.18 审查修复后跑的）：
```
单测   全部通过：27 项
端到端 38 项断言全过 → 全部通过 ✅
        其中新覆盖：真实鼠标点导航「上传资料」→ /admin 打开、
                    overlay.top=53px 与 navbar 同高、面板宽 1120（.container 同宽）、
                    外层卡片已拆掉（面板背景透明、目录栏带站点样式的卡片边框）、
                    点「资料库」自动关闭（path 回到 /）、
                    课程下拉 94 项 = 站内 94 门、max-height 200px、overflow auto、可滚轮、
                    打开就是单视图工作台（.upc-empty 已不存在）、
                    没填课程名可先建目录+放文件但两个上传按钮都禁用且出现提示行、
                    导入前弹「检测到 1 个文件、1 个目录，将生成课程「__demo_test__」」、
                    目录条 ⋯ 菜单 = 上传本目录 / 重命名 / 从本次列表移除、
                    站内已有目录：名称只读、点了不提示不下拉、菜单里只有上传、
                    「已有资源」列出站内该目录文件 → 删除需点两次确认 → 删除成功、
                    目录改名即时生效并留下一行确认（无保存按钮）、
                    目录下拉只含本课目录且不挡改名说明、
                    换到别的课程后旧课程的目录不再残留（C++ 这类文件直接挂在课程下的课，现在能看见「根目录」）
清理   测试文件由「已有资源」的界面删除掉 / 站点无残留（剩余 0）
```

> smoke 里加了 `window.confirm` 自动接受（`Page.javascriptDialogOpening` → `handleJavaScriptDialog`）：
> 合并视图后确认点变多（换课程、导入覆盖、删目录），不自动接受会把无头测试卡死。

---

## 2. 入口与交互的实现要点（改代码前必读）

```js
// content.js 末尾
isUploadRoute()  // /^\/admin\/?$/
syncWithRoute()  // 进 /admin 且没开 → openPanel()；离开且开着 → closePanel(true)
```

- **地址必须由站点的路由器改。** 早期版本插件自己 `history.pushState` 到 `/admin`，Vue Router 的内部路由没变，
  于是点「资料库」（目标正好是当前路由）被判成重复导航、地址卡在 `/admin`、面板关不掉。
- 内容脚本 hook 不到主世界的 `pushState`，所以用 **300ms 地址轮询** 同步开关；直接刷新 `/admin` 也会自动打开面板。
- 导航点击的捕获监听**不 preventDefault**，只是在路由跳转前一瞬间先把面板盖上去，避免原站上传表单一闪。
- 面板不是遮罩：`position:fixed; top:navH`，`background:#f5f7fb`（暗色 `#0f131b`），圆角卡片 + 阴影，和站点容器宽度一致（1120px）。
- **只有一个视图**：课程栏 → 左目录 → 右文件 → 底部队列。v0.3.9 起没有独立的「选择课程」空状态页，也没有 ×；缺什么靠课程栏下方那一行提示说，退出方式是点导航去别的页面。
- 状态全在内存，没有持久化（见 `docs/design.md` 第 8 条）。

---

## 3. 隐私与数据红线（这一条最重要）

| 目录 | 内容 | 能不能外发 |
|---|---|---|
| `files/` | 已去隐私、已合规的 410 个文件 | ✅ 只传这个 |
| `_整理归档_20261027/未压缩原件` | 449 个 / 1.2GB 不支持格式的原文件 | ⚠️ 本地留存 |
| `_整理归档_20261027/原始文件` | 用户原始下载 | ❌ **绝不可外发/上传** |
| `_整理归档_20261027/整理后_打码前` | 1.9GB，含班级姓学号 | ❌ **绝不可外发/上传** |

其他红线（同 `AGENTS.md` 第 7 条）：不加密码输入框、不把密码/token 写进任何文件或 `localStorage`、
保持同源 `/api/...`（跨源 fetch 会丢 Cookie）、不提高并发或去掉限速、不引入构建工具/npm 依赖。

**这个目录从 2026-10-31 起是一个 git 仓库**，远端是 <https://github.com/pierrotto12138-code/upc-batch-uploader>（公开）；`.gitignore` 排除了 `files/`、`_整理归档_*/`、`dist/`。真实密码不在任何文件里（`grep -i password` 只会命中 `docs/api.md` 的 `"***"` 占位和两个测试脚本从环境变量读密码的那两行），需要时向用户索取。

---

## 4. 还没做的（按价值排序）

1. ~~拖拽文件夹递归~~、~~结果导出 CSV~~ —— **v0.3.28 已做**（纯函数 + 30 条单测 + 生产端到端断言各一条）。
2. **同名目录合并**——导入 + 手工新建会出现两个「课件」各占一行（截图里见过）；改 `upsertDir` + 补单测。
3. **普通成员路径只做过本地验证**——手上没有非管理员账号，`#member` 那套门禁是在本地 mock 站点里验的；服务端 `DELETE /api/admin/files` 本身有鉴权，所以最坏情况是按钮露出来但点了报 403。
4. 更深目录 `courseDepth`、整体 ETA / 暂停继续、`PACE`/`MAX_BYTES` 可配置。
5. **真人手感验证**——无头测试测不了滚轮手感、拖拽手感、大文件进度条，以及"空目录不给删"的手感是否别扭。
6. **PR 已提交：[#1](https://github.com/foggy-33/upc-share/pull/1)**（2026-10-31）——等上游作者 review，三条产品决策交给他定。
   2026-10-31：用户和上游作者打过招呼，Vue 版移植完成，推到 `pierrotto12138-code/upc-share` 的 `feat/batch-upload`
   （本地工作副本 `C:\Users\Pierrot\Documents\upc-share`，十五个 commit，最新 `7d05cee`）；
   17 个文件（15 源码 + 2 张截图）、约 3100 行、零新增依赖，31 条 `node --test` + `vite build` + 29 项无头交互断言全过（2026-10-31 实测，含两档盒子与四档字号、徽标可达性、拖文件夹识别、CSV 导出、根目录常驻与两段式垃圾桶）。
   多一个「不知道怎么整理？」弹层（可复制的整理规范，文案与 `logic.js` 的规则由同一条测试绑定）。
   PR 正文在 `docs/upstream-pr-body.md`（客观描述式），含三个待确认项（限速放客户端 / 替换 `/admin` / 自动通过审核要不要留）。
   术语那个待拍板项已在 v0.3.19 定了（跟站点走：学科分类 / 子目录）。
   要在本地跑上游那套验证，得先 `cd vue && npm install --no-save --package-lock=false`（仓库里的 `node_modules/`
   是被 `.gitignore` 的 `dist/` 挖空过的，装完才能 build；esbuild 还要补 `node node_modules/esbuild/install.js`），
   然后**别用 `git checkout -- vue/node_modules` 收尾**——会把树搞成"包在、dist 没了"，只能删了重装；
   node_modules 让它在本地脏着，提交只 `git add` 自己那 17 个文件。细节在 `AGENTS.md` §10。

对齐情况：读过原仓库的 `vue/src/views/Upload.vue`（文案原句）、`main.js`（`/admin` 路由）、
`NavBar.vue`（`a.nav-link` 文案）、`style.css`（navbar 52px、container 1120px）。
**原仓库 `foggy-33/upc-share` 一行没动、一个 issue/PR 都没发过**；改动全在自己的 fork 分支 `feat/batch-upload` 上（作者已授权提 PR，但 PR 未创建）。

---

## 5. 分发包

两套包，**代码完全相同**（`content.js` 逐字节一致，sha256 相同），只是清单与说明里的浏览器名不同：

| 包 | 给谁 | 说明 |
|---|---|---|
| `dist/upcshare-batch-uploader/` + `upcshare-batch-uploader-0.3.32.zip` | Chrome | 2026-10-31 20:05 重建 |
| `dist/upcshare-batch-uploader-edge/` + `upcshare-batch-uploader-edge-0.3.32.zip` | Edge | 2026-11-01 收到，清单多一个 `browser_specific_settings.edge`；Edge 156 实测 `--load-extension` 能加载并打开面板 |
| `upcshare-batch-uploader.crx` | 备份 | 带 `.key.pem` 签名，仅作备份——Chrome 个人版会拒绝手动拖入的 CRX，报 `CRX_REQUIRED_PROOF_MISSING` |

两个文件夹都含 manifest + content.js + icons + README + LICENSE + `preview.png`。
两个 zip 都作为资产挂在 [Release v0.3.32](https://github.com/pierrotto12138-code/upc-batch-uploader/releases/tag/v0.3.32) 上。

安装：Chrome 用 `chrome://extensions`、Edge 用 `edge://extensions` → 开发者模式 → 加载已解压 → 选对应文件夹 → 刷新 upcshare 页面。
**不要把项目根目录当扩展加载**（里面有 1.5GB 的 `files/` 和归档）。
