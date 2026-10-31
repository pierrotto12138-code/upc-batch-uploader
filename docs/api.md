# 站点接口契约（实测记录）

> 全部内容来自对 `https://in.upcshare.cn` 的**真实请求**，不是从代码推断的。
> 服务端实现见仓库 [upc-share](https://github.com/foggy-33/upc-share) 的
> `springboot/src/main/java/cn/upcshare/downloadsite/controller/`。
> 站点升级后行为变了，以实测为准更新本文件。
> 感谢 [upc-share](https://github.com/foggy-33/upc-share) 的作者为学校资源共享做出的伟大贡献；
> 感谢 DeepSeek V4.1 Flash 与 Qwen 3.8 Flash 的优渥能力。
>
> **最后实测**：2026-10-31（v0.3.32 复验：`/api/categories` 93 个、全站待审核 0 条、行为与下表一致）

## 端点速查

| 方法 | 路径 | 用途 | 权限 | 必须记住的一点 |
|---|---|---|---|---|
| GET | `/api/ping` | 连通性探测 | 公开 | 返回走的是校园网还是公网入口 |
| POST | `/api/auth/login` | 登录（**只有测试脚本用**） | 公开 | 插件里没有密码输入框，也不该有 |
| GET | `/api/auth/me` | 当前用户 | Cookie | 未登录返回 200 + `{"logged_in":false}`，不报错 |
| GET | `/api/categories` | 全部学科分类 | 公开 | 站内全量（93～95，会波动）；"文件夹名 → 正式名"匹配的唯一依据 |
| GET | `/api/subcategories` | 全部子目录名 | 公开 | ⚠️ **忽略 `category` 参数**，返回的是全站 36 个名字 |
| GET | `/api/files` | 前台列表（只含已通过） | Cookie | `size` 上限 **100**；`sub_category=`（空串）是有效筛选 |
| GET | `/api/admin/files` | 管理端列表（可查待审核） | 管理员 | `size` 上限 **200**；⚠️ **不按学科分类筛**，插件侧自己过滤 |
| POST | `/api/upload` | 上传单个文件 | Cookie | multipart；限速 6 次/分钟、burst 3、并发 2 |
| POST | `/api/admin/approve/{id}` | 审核通过 | 管理员 | **没有请求体**，传了也忽略 |
| DELETE | `/api/admin/files/{id}` | 删除文件 | 管理员 | 同时删磁盘文件和数据库记录；`/api/admin/reject/{id}` 等价 |

## 目录

- [通用约定](#通用约定)
- [GET /api/ping](#get-apiping)
- [POST /api/auth/login](#post-apiauthlogin)
- [GET /api/auth/me](#get-apiauthme)
- [GET /api/categories](#get-apicategories)
- [GET /api/subcategories](#get-apisubcategories)
- [GET /api/files](#get-apifiles前台只返回已通过)
- [GET /api/admin/files](#get-apiadminfiles管理员可按状态查)
- [POST /api/upload](#post-apiuploadmultipartform-data)
- [POST /api/admin/approve/{id}](#post-apiadminapproveid)
- [DELETE /api/admin/files/{id}](#delete-apiadminfilesid)
- [限速（Nginx 层）](#限速nginx-层实测)
- [文档与实现不一致的地方](#已知的文档实现不一致不要在插件里依赖)

## 通用约定

- 认证：Cookie `access_token`（JWT，7 天），`HttpOnly`。请求带上它即可，接口不读 `Authorization` 头。
- 请求体：JSON，`Content-Type: application/json`（上传除外，见下）。
- 错误格式：`{"ok": false, "msg": "...", "detail": "..."}`，HTTP 状态码语义正常。
- 未登录访问受保护接口 → `401 {"ok":false,"msg":"请先登录"}`。
- 非管理员访问 `/api/admin/**` → `403 {"ok":false,"msg":"需要管理员权限"}`。

---

## `GET /api/ping`

连通性探测，前端用它判断能不能走校园网入口。

```json
{"ok": true, "node": "campus", "server_time": "2026-10-26T12:31:50.764228537Z"}
```

---

## `POST /api/auth/login`

```json
{"username": "<账号>", "password": "***"}
```

- `200` `{"username":"<账号>","ok":true}`，同时下发 `Set-Cookie: access_token=...`
- `401` 用户名或密码错误
- `403` 账号被封禁

## `GET /api/auth/me`

```json
{"logged_in": true, "uid": "<uid>", "username": "<账号>",
 "is_admin": true, "user_level": "admin", "avatar_url": ""}
```

未登录返回 `{"logged_in": false}`（200，不报错）。

---

## `GET /api/categories`

```json
["C++", "C语言", "高等数学2-2", "大学物理", "数据结构", "..."]
```

站点有 93～95 个学科分类（2026-10-30 实测 95，10-31 实测 93——**这个数字会随用户上传波动，别在断言里写死**）。**这是"文件夹名 → 正式学科分类名"匹配的唯一依据**。

## `GET /api/subcategories`

```json
["期末试卷", "课件", "实验报告", "往年试题", "课件、试卷", "..."]
```

注意：目录是**自由文本**，不是外键——上传时传什么就存什么，站点会把 `category/sub_category` 直接当磁盘目录名。

**这个接口忽略 `category` 参数**（2026-10-28 实测：带不带都返回全站 36 个目录名）。想要"某门课程用过哪些目录"，只能 `GET /api/files?category=X` 分页拉文件再自己聚合，见 `content.js` 的 `loadCourseDirs()`。站内也没有"空目录"的概念——没有文件的目录在 API 里查不到。

---

## `GET /api/files`（前台，只返回已通过）

| 参数 | 说明 |
|---|---|
| `q` | 模糊匹配 `original_name` / `description` / `category` |
| `category` / `sub_category` / `ext` | 精确筛选，`ext` 可带或不带点。`sub_category=`（空串）是**有效筛选**，命中的是根目录文件（实测 455 条），不要省略 |
| `page` | 从 1 开始 |
| `size` | **上限 100**，默认 20 |

```json
{"total": 519, "page": 1, "size": 100, "pages": 6,
 "items": [{
   "id": "df0cbea56596866f193c9474fd9f0c87",
   "file_path": "__demo_test__/___plugin_probe___.txt",
   "original_name": "___plugin_probe___.txt",
   "extension": ".txt",
   "file_size": "17.0 B",          // 给人看的字符串
   "file_size_raw": 17,            // ★ 字节数，查重必须用这个
   "description": "",
   "category": "__demo_test__",
   "sub_category": "",
   "created_at": "2026-10-26T12:32:24.026334684",
   "download_count": 0,
   "status": "approved",
   "uploader": "<账号>",
   "rewarded_download_count": 0
 }]}
```

## `GET /api/admin/files`（管理员，可按状态查）

参数同上，外加 `status=pending|approved`，`size` **上限 200**。

**这是断点续传的关键**：上次传了一半失败的，在 `status=pending` 里能查到，重跑时会被自动跳过。

⚠️ **但它不按学科分类筛**：`category=` 传了也不生效，返回的是**全站**的待审核清单（实测：测试分类 `__demo_test__` 的「已有资源」里会冒出「材料力学」的待审核文件）。
所以插件在 `loadSiteFiles()` 里拿到 pending 之后必须自己按 `category` + `sub_category`（归一化）筛一遍再合并——
否则管理员在某个子目录的列表里看到别的学科分类的文件，两步确认后删掉的就是别人的文件。

---

## `POST /api/upload`（multipart/form-data）

| 字段 | 必填 | 说明 |
|---|---|---|
| `file` | 是 | 单个文件 |
| `description` | 否 | 默认 `""` |
| `category` | 否 | 缺省 `uncategorized`；**空字符串也会被当成 `uncategorized`** |
| `sub_category` | 否 | 可空，可含 `/` 形成多级目录 |

**站点没有"建目录"这个接口**：目录是 `file` 落盘时按 `category/sub_category` 顺带形成的。
所以**空目录传不上去，也刷不出记录**——想靠建一堆空子目录往站内灌水，在协议层面就不成立。
插件侧同一件事由两处保证：`collectDirTargets` / `collectCourseTargets` 的 target 只来自 `dir.files`
（空目录、只剩已完成/已跳过的目录都凑不出 target），行上的「上传」在 `dirPending === 0` 时直接禁用。
`selftest.js` 有对应用例，2026-10-30 在 mock 站点实测：5 个空子目录 + 1 个文件，点「全部上传」
只发出 1 次 `POST /api/upload`，没有任何其它写请求。

成功：

```json
{"message": "上传成功，等待审核", "id": "e4e592eae0cf643f1e10d41729ebb0e8",
 "filename": "___demo_probe___.txt", "points": 31.1}
```

新上传的文件 `status = 'pending'`，**不会**出现在前台列表里，必须再调 approve。

### 服务端校验（照抄自 `FileController`）

- 扩展名白名单：`.pdf .doc .docx .zip .rar .7z .tar .gz .ppt .pptx .xls .xlsx .txt .md .csv`
- 文件名含 `..`、`<>:"|?*`、控制字符 → `400 Invalid file name`
- 单文件 > 1GB → `413 {"msg":"上传文件过大，单文件最大支持 1GB"}`
- `category` / `sub_category` 会被 `Path.resolve(...).normalize()` 后校验必须落在资源目录内，越界 → `400 Invalid directory`
- 落盘路径：`resources/<category>/<sub_category>/<filename>`；重名自动改成 `名字_1.ext`
- `id = md5(相对路径)`，所以同一个路径永远同一个 id

---

## `POST /api/admin/approve/{id}`

**没有请求体**（别传 JSON，传了也忽略）。

```json
{"ok": true, "msg": "File approved"}
```

## `DELETE /api/admin/files/{id}`

```json
{"ok": true, "msg": "File deleted"}
```

同时删除磁盘文件与数据库记录（`/api/admin/reject/{id}` 等价）。

---

## 限速（Nginx 层，实测）

```nginx
limit_req_zone $binary_remote_addr zone=upload_limit:10m rate=6r/m;   # /api/upload
limit_req_zone $binary_remote_addr zone=api_limit:10m    rate=10r/s;  # 其余
limit_conn conn_limit 2;                                              # /api/upload 并发
```

`/api/upload` 是 **6 次/分钟 + burst 3**：前 3 个请求立即通过，之后约每 10 秒放行一个。
超了返回 `429`（无 JSON 体，是 Nginx 直接返回的 HTML）。

---

## 已知的文档/实现不一致（不要在插件里依赖）

- 上游 README 写的 `POST /api/admin/scan` **并不存在**（代码里没有这个映射）。
- 上游 README 让配 `APP_COOKIE_DOMAIN`，而 compose 只转发 `COOKIE_DOMAIN`——按 README 配会导致跨子域登录态失效。
- `/api/files` 的 `size` 上限是 100，`/api/admin/files` 是 200，别混用。
