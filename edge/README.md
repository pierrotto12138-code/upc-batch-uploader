# Edge 版

这里是 **Microsoft Edge** 用的加载目录，和根目录的 Chrome 版**是同一份代码**：

- `content.js` 与根目录的 `content.js` 逐字节相同（`cmp` 无差异）；
- 只有 `manifest.json` 多一个 `browser_specific_settings.edge`；
- 图标、`preview.png`、`LICENSE` 都取自根目录。

## 怎么装

1. 地址栏打开 `edge://extensions` → 左下角打开「开发人员模式」。
2. 点「加载解压缩的扩展」→ 选这个 `edge/` 文件夹（里面能看到 `manifest.json`）。
3. 打开 <https://in.upcshare.cn> 登录，点导航栏的「上传资料」。

也可以从 [Releases](https://github.com/pierrotto12138-code/upc-batch-uploader/releases) 直接下
`upcshare-batch-uploader-edge-0.3.32.zip` 解压后加载，内容与本目录相同。

## 改代码时注意

`edge/content.js` 是**副本**，改根目录的 `content.js` 之后要同步过来：

```bash
cp content.js edge/content.js
```

功能、规则、测试、设计取舍都见根目录的 [README.md](../README.md)、[AGENTS.md](../AGENTS.md) 和
[docs/](../docs/)；这一页只解释"为什么有 `edge/` 这个目录"。

---

感谢 [upc-share](https://github.com/foggy-33/upc-share) 的作者为学校资源共享做出的伟大贡献；
感谢 DeepSeek V4.1 Flash 与 Qwen 3.8 Flash 的优渥能力。
