# PR 就绪度与移植记录 · 2026-10-31 · v0.3.32

| 项 | 状态 |
|---|---|
| 是否符合上游设计规范 | 符合（颜色/圆角/字体/术语都跟站点走，见 §2） |
| 是否有设计缺陷 | 审查出的 5 个 Critical 已修；已知限制保留（§3/§4） |
| Vue 移植 | **已完成**，推到 `pierrotto12138-code/upc-share` 的 `feat/batch-upload`（§6） |
| PR | **已创建 [#1](https://github.com/foggy-33/upc-share/pull/1)**（2026-10-31，OPEN / MERGEABLE，17 文件 +3147/−89），等上游作者 review |

> 两个独立审查（设计系统符合度 / 工程质量）+ 我逐条复核后的结论与处置，外加 2026-10-31 的移植记录。
> 结论先行：**功能与形态够格；但不能以浏览器扩展的形式提 PR——PR 的形态是 Vue 视图替换 `/admin`，
> 已经移植完成，剩三件事要上游拍板（§5）。**
> 感谢 [upc-share](https://github.com/foggy-33/upc-share) 的作者为学校资源共享做出的伟大贡献；
> 感谢 DeepSeek V4.1 Flash 与 Qwen 3.8 Flash 的优渥能力。

## 目录

- [1. 结论](#1-结论)
- [2. 设计规范符合度](#2-设计规范符合度)
- [3. 工程审查发现与处置](#3-工程审查发现与处置)
- [4. 验证证据](#4-验证证据本轮全部实跑)
- [5. PR 里仍待上游确认的三件事](#5-pr-里仍待上游确认的三件事)
- [6. 移植记录（已完成）](#6-移植记录已完成2026-10-31)

---

## 1. 结论

| 问题 | 回答 |
|---|---|
| 是否符合原仓库设计规范？ | **符合**（v0.3.18 起颜色/圆角/阴影/字体/焦点都从站点 token 取；v0.3.19 起术语也跟站点走：学科分类 / 子目录） |
| 是否有设计缺陷？ | 有，5 个 Critical 已修（含 v0.3.22 补跑端到端抓到的那个误删风险），若干已知限制保留（见 §4） |
| 是否有资格提交 PR？ | ~~Not ready — needs port~~ **已移植并提交（2026-10-31）**：Vue 版推到 `pierrotto12138-code/upc-share` 的 `feat/batch-upload`，PR [#1](https://github.com/foggy-33/upc-share/pull/1) 已创建，三条产品决策交给上游作者定 |

审查方法：把 `foggy-33/upc-share@main` 的 `style.css`(118KB)、`theme.css`、`theme.js`、`Upload.vue`、`NavBar.vue`、`Courses.vue`、`http.js` 拉到本地逐条对照，另派一个独立 reviewer 通读 `content.js` + 测试。

---

## 2. 设计规范符合度

### 2.1 颜色 token：从"抄一套近似值"改成"运行时读站点的"

审查前我们硬编码了一整套自造色值，其中最刺眼的是主色 `#2f6fed`（站点是 `#0071e3`）——所有按钮、高亮、焦点色都偏色，一眼能看出不是同一个站。

现在 `applySiteTokens()` 在启动和换主题时读 `getComputedStyle(document.documentElement)`，把站点的 `--accent / --surface / --border / --text-* / --danger / --accent-light` 映射进面板自己的变量（Shadow DOM 继承不到页面自定义属性，只能显式搬）。真实站点实测：

```
siteAccent  #0071e3  →  panelAccent  #0071e3
siteSurface #ffffff  →  panelBg      #ffffff
siteBorder  rgba(0,0,0,.06) → panelBorder 同值
主按钮背景  rgb(0, 113, 227)
```
读不到时退回我们自己的默认值（已同步成站点的值），所以独立打开页面也不会花。

### 2.2 其余项

| 项 | 修前 | 现在 |
|---|---|---|
| 暗色模式漏网 | 导入确认卡/多门课选择卡整块硬编码 `#fff`，暗色页上一块刺白 | 改用 `var(--bg)/--fg/--line/--muted`；扩展名徽章、状态 chip 也走变量 |
| 焦点可见性 | 完全没有焦点环（`outline:none` 且无替代） | 按钮/输入框/目录行/菜单项统一 `box-shadow:0 0 0 3px var(--accent-soft)`，与站点 `:focus` 一致 |
| 响应式 | 无 `@media`，窄窗口横向溢出 | 900px 以下目录栏变横排卡片、640px 以下课程栏换行、摘要独占一行 |
| 容器/间距/圆角/字体 | 1120 已对齐；圆角 8/9/10/12/14 混用 | 卡片 12px（站点 `--radius-md`），字体栈交给站点（面板内仍保留近似栈做兜底） |
| 文案 | 格式说明与 `Upload.vue` 逐字一致 ✅ | 不变 |
| **术语** | 站点表单写"学科分类 / 子目录"，我们全程"课程 / 目录" | **v0.3.19 已跟站点走**（代码内部标识符与注释保留"课程/目录"，硬盘文件夹名和「根目录」不动） |

---

## 3. 工程审查发现与处置

### 已修（本轮）

| 级别 | 问题 | 后果 | 处置 |
|---|---|---|---|
| Critical | 点"停止"后文件永远卡在 `running` | 该文件再也进不了待传队列；所在目录被 `dirHasUploaded()` 判成"站内已有"，改名/移除一起锁死，只能刷新页面 | 中断路径落回 `failed`；`handleRunError` 兜底清扫所有 `running` |
| Critical | smoke 中途失败会在**生产站**留下已审核通过的探针文件 | 违反自家红线，且下一轮 `found.length===1` 必然被污染 | 加 `sweepProbe()`：无论成败都按文件名清一遍（已通过 + 待审核） |
| Important | "刷新站内索引"失败后查重**静默永久失效** | `indexPromise` 没清，`ensureIndex()` 永远命中那个已 resolve 的旧 promise；重复文件被无提示再传一遍，服务端还会自动改名成 `名字_1.ext` 制造垃圾 | 刷新和失败分支都清 `indexPromise` |
| Important | 查重不分课程/目录 | 不同课的「第一章.pdf」被判成"已存在"并默认跳过——合法文件被静默排除 | `dedupeKey/nameKey` 加 `学科/子目录` 范围；`classify(entry, index, scope)`；补单测 |
| Important | `applyIndex` 把 `failed` 覆盖回"待上传" | 失败原因丢失、重试 chip 消失 | 终态（done/running/failed）不参与重分类 |
| Important | 手打一个站内不存在的课程名，静默把上一门的目录文件挂过去 | 拼错一个字符 = A 课文件当 B 课上传；其他三条路径都有确认，唯独这条没有 | 失焦时确认"这些目录和文件会跟着改挂到 X 下"，可取消回退 |
| Important | 目录改名后「已有资源」不刷新 | 标题写着新名字、列的是旧目录的文件，管理员两步确认时极易误删 | 改名即重查 |
| Important | admin 接口 401/403 之外的错误也被静默吞掉 | 断网/5xx 时用户看到"站内一个文件都没有"，接着重复上传 | 只对 401/403 静默，其余写日志 |
| Important | 拖文件落在虚线框外会把整页导航掉 | 本次已 staged 的文件全丢（无持久化） | 面板级 `dragover/drop` 一律阻止默认，框外只提示 |
| Important | `headless.ps1` 按"同 exe + 启动时间"杀进程 | 会顺手杀掉用户测试期间自己打开的 Chrome 窗口 | 只杀我们临时 profile 的进程树；退出码先置失败 |
| Important | 目录行是 `div`，键盘到不了 | "移除/删除"等破坏性操作不可键盘触达 | `tabindex=0` + `role=button` + `aria-pressed` + Enter/Space 选中（实测 focus 与 Enter 均生效） |
| Important | ARIA 只声明不实现 | 有 `role="combobox"` 却没有 `aria-expanded/aria-controls`，等于没写 | 补齐 `aria-expanded`、`aria-controls="upc-menu"`、选项 `aria-selected`、日志 `aria-live` |
| Critical | 「已有资源」把**全站**待审核文件并进当前子目录的列表 | 管理员在 A 学科分类的列表里看到 B 的文件，两步确认后删掉的就是别人的文件（v0.3.22 补跑端到端时抓到，之前没暴露纯粹因为当时站内没有待审核文件） | `loadSiteFiles()` 拿到 pending 后按 `category` + `sub_category`（归一化）自己筛一遍再合并 |
| Important | 只给「新建子目录」设了 `disabled`，没改样式也没在动作里拦 | 禁用态看着照样能点（hover 还变蓝），而键盘/拖文件这些路径能绕过按钮直接建出无归属的子目录 | 禁用态补 `opacity/cursor:not-allowed` + `title` 就地说明；`addDir()` 第一行同源守卫，调用方补 `if (!state.activeDir) return` |
| Minor | 文件头注释写"只会写到你自己的 localStorage" | 这是给用户看的隐私声明，而实际零持久化 | 改成准确表述 |
| Minor | `--upc-nav` 设了没用、`/api/subcategories` 拉了不用、`refreshStatus` 重复调 `syncDirLock` | 死代码/浪费请求 | 保留 subcategories（查重兜底仍可能用），其余清理 |

### 保留的已知限制（不是 bug，但你该知道）

1. **`dirsCache` 没有失效策略**：同一会话里你在站内新建了目录，左栏不会自动出现，要切走再切回。
2. **`isUploadRoute()` 只认 `/admin` 和 `/admin/`**：上游若加 `/admin/queue` 这类子路由会被判成"离开"。
3. **非管理员路径只在本地 mock 验过**：手上没有普通账号。服务端 `/api/admin/**` 有鉴权，最坏是按钮露出来点了报 403。
4. **测试跑在生产站**：上传 17 字节探针再删掉。有兜底清理，但"跑测试=写生产库"这件事本身就别指望上游 CI 接受——移植时必须换成 mock 或测试账号 + 测试分类。
5. **CDP 注入跑在主世界**，真实扩展跑在 isolated world：`--load-extension` 那一层和 manifest 的 `matches` 从来没被自动化验证过，只有手工装过。

---

## 4. 验证证据（本轮全部实跑）

```
node selftest.js                    → 全部通过：25 项
tools/headless.ps1（生产站端到端）  → 41 项断言全过 ✅ 站点无残留 退出码 0
运行时 token 实测                   → panelAccent #0071e3 = 站点值；主按钮 rgb(0,113,227)
键盘可达性实测                      → 目录行 tabindex=0 / role=button / Enter 切换生效 / aria-pressed 跟随
dist                                → v0.3.18，content.js 与 README 与源码逐字节一致
```

v0.3.19 → v0.3.22 之后：`node selftest.js` 27 项全绿；术语与字号在本地 mock 站点逐元素实测
（标题 20/20px、栏内三元素 14/14/14px、输入框与按钮同为 35px 高）；`dist/` 已重建为 0.3.19 并逐字节校验一致。
**v0.3.19–v0.3.22 已于 2026-10-30 22:58 补跑生产端到端：41 项断言全过、站点无残留、退出码 0**。

---

## 5. PR 里仍待上游确认的三件事

这三条是产品决策，**交给上游作者定**（服务器在他在管，哪种做法损耗最小由他判断）；PR 正文的「待确认」一节逐条列了默认做法与替代方案：

1. **客户端限速要不要进上游？** 我们把 6 次/分钟、burst 3 做在插件里。如果上游不做，真实用户批量传照样撞 Nginx 429；如果做了，我们的 Pacer 就该删掉。这是产品决策，不是我们能替作者定的。
2. **`/admin` 路由冲突**：站点已有 `Upload.vue` 挂在 `/admin`。PR 的实质是**替换**那个页面（或加 `?mode=batch` 共存），不是新增页面。得先问作者要不要。
3. **自动审核的权限口径**：`POST /api/admin/approve/{id}` 是 admin-only，UI 按 `me.is_admin` 门控（我们已经这么做，可直接搬）。但"上传即自动通过"是否鼓励，是站点的审核策略问题。

术语问题已定：**跟站点走**。v0.3.19 已把所有用户可见文案改成「学科分类 / 子目录」，
边界（代码内部标识符、硬盘文件夹名、「根目录」这一行）写在 `docs/design.md` 第 17 条。

---

## 6. 移植记录（已完成，2026-10-31）

- 丢掉：Shadow DOM 宿主、`host.style`、路由轮询、`isUploadRoute/syncWithRoute`、`openPanel/closePanel/resetUploader`、`buildPanel` 的字符串 HTML、自造 CSS 与 token 同步（改继承站点 `:root`）。
- 保留（几乎可原样搬）：`splitRelativePath / bestCategory / buildGroups / upsertDir / dirsFromItems / dirHasUploaded / dedupeKey / nameKey / scopeKey / classify / collectDirTargets / collectCourseTargets / fuzzyFilter / dirOptions / Pacer` 及它们的单测（移植后随功能增长到 31 条）。
- 实际落地：17 个文件、约 3100 行、零新增依赖；`vue/tools/` 带一个本地接口替身 + 29 项无头断言，`node --test` 31 条。
- PR 创建后的追加（同一分支，PR 自动更新）：上传页按视口铺满（收掉站点落地页 64/80 留白，三栏吃掉剩余高度）+ 未登录时顶部提示「请先登录」。
- 拆组件：`CoursePicker.vue`（组合框）、`DirRail.vue`、`FileDrop.vue`、`QueueBar.vue`、`SiteFilesPanel.vue`。
- 状态：`reactive({ course, activeDir, running, progress })`，仍然不落盘。
- 测试：把 smoke 从 CDP 注入改成 Vitest + 组件测试，生产站那条只留作手工验收。
