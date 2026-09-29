# ST Extension Importer

用于在 TauriTavern 中迁移 SillyTavern / GitHub 第三方扩展，并在导入前进行 TT 兼容化处理。

## v0.8.7

本版本重点修复 Android/Tauri 导入流程、性能和界面问题。

- 使用 TauriTavern 自己的 `safeInvoke` 调用归档上传/导入命令，避免直接调用 Tauri command 时出现 `invalid args filePath`。
- 多个扩展尽量合并为一次原生归档导入，避免逐个上传/导入导致 Android 上长时间无响应。
- ZIP 扫描与文件读取增加并发限制，并显示扫描、打包、上传、验证阶段的进度。
- 扩大导入按钮实际点击区域并优化 Android 触摸响应。
- 导入错误提示改为短时提示，详细结果仍保留在面板中，避免持续弹窗遮挡面板。
- 统一扩展版本显示为 `0.8.7`。
- 保留逐个扩展的安装结果验证：真正能加载 manifest 及声明资源才显示“已安装”，失败的新目录会清理并显示“未安装”。

## v0.8.6

本版本增加 ZIP 内部文件/目录路径冲突检查，避免归档解包时出现 `File exists (os error 17)`。

- 检查文件路径与目录路径的祖先/后代冲突。
- 对会影响 manifest 声明资源的冲突不强行导入。
- 将可安全处理的冲突在归档生成阶段清理，减少 TT 后端解包失败。

## v0.8.5

修正原生归档上传完成流程的参数传递，并继续使用 TT 后端负责写入真实 data root。

## v0.8.4

本版本彻底绕开 Android WebView 对 `/storage` 的直接文件写入。

- 不再使用 `plugin:fs` 直接写 TT 的扩展目录，因此不会再出现 `forbidden path: /storage`。
- 每个扩展单独生成 `extensions/third-party/<插件名>/...` 原生数据归档，由 TauriTavern 后端归档引擎写入真实 data root。
- 安装结果逐个等待 TT 归档任务完成，再通过 `/scripts/extensions/third-party/...` 实际资源加载验证。
- TT 发现列表中的残缺旧目录如果 manifest / JS / CSS 无法实际加载，会通过 TT 自己的扩展删除 API 自动清理，不再误显示“已安装”。
- ZIP 与已选择的 third-party 文件夹都走同一套原生归档安装路径。

## v0.8.3

本版本增加 **TT 兼容化预处理**：

- 导入前读取 manifest.json，自动检查 `js` / `css` / `i18n` 实际文件。
- 如果扩展把资源放在 `src/`、`public/` 等目录，而 manifest 仍引用旧路径，会在导入 ZIP 时自动把 manifest 路径改到唯一匹配的真实文件。
- 支持大小写路径差异和唯一 basename/suffix 匹配，避免导入后出现 `stylesheet load failed`。
- 导入任务即使整体返回失败，也会逐个检查每个扩展的实际目录和 manifest 资源；成功的单独显示“已安装”，失败的新目录自动删除。
- 对声明需要高于 TT 当前 SillyTavern 1.18.0 兼容基线的扩展，只提示“不保证兼容”，不会偷偷降低最低版本要求。真正依赖更新 ST API 的扩展仍需要针对代码本身适配。

## v0.8.1

本版本会先在前端把选中的 SillyTavern / GitHub ZIP 规范化为 TauriTavern 原生归档格式，再交给 TT 后端导入。

因此以下 ZIP 都可以直接导入：

```text
插件文件直接在 ZIP 根目录：
manifest.json
index.js
style.css
...

GitHub 仓库 ZIP：
SomeExtension-main/
├── manifest.json
├── index.js
└── ...

传统 ST third-party ZIP：
extensions/
└── third-party/
    └── SomeExtension/
        ├── manifest.json
        └── ...
```

迁移器会统一转换成：

```text
extensions/
└── third-party/
    └── <插件名>/
        └── ...
```

所以不再要求用户手工重新打包 ZIP，也不再因为 ZIP 根目录不是 `extensions/third-party/` 而直接报错。

## v0.8.0

本版本开始使用 TauriTavern 已有的数据归档导入接口，由 TT 后端负责写入数据目录，避免 Android `/storage` 的 `forbidden path`。

### 安装

将本仓库直接安装到 TauriTavern 的第三方扩展目录。

## v0.9.1

增加“插件浏览器数据迁移”功能，用于把旧 SillyTavern WebView 中的浏览器存储带到 TauriTavern。

- 在旧 SillyTavern 环境点击 **导出旧 ST 浏览器数据**，生成独立的数据迁移 ZIP。
- 数据包包含 `localStorage` 和可枚举的 IndexedDB 数据库/对象仓库/记录。
- 在 TauriTavern 点击 **导入插件数据包**，默认采用“只补缺失”策略：已有同名 `localStorage` 不覆盖，已有 IndexedDB 记录尽量保留。
- IndexedDB 的复杂值会进行可逆序列化；大型数据库会按单对象仓库最多 50,000 条记录导出，并在数据包中标记截断状态。
- SQLite 不通过浏览器存储导出；如果 SQLite 已经随 `data/` 搬过去，无需重复迁移。位于其他位置的 SQLite 仍应单独迁移，避免错误覆盖 TT 数据。
- 该数据包不包含密码、Token 等字段的智能过滤；导出前请确认旧 ST 当前 WebView 中的存储内容适合迁移。

## v0.9.0
- 扫描结果按“未安装 / 已安装 / TT 内置 / 其他”分组。
- 每组支持折叠/展开，并显示数量。
- 扫描统计同时显示未安装与已安装数量。
- 保留 v0.8.7 的单次归档导入、TT 资源验证和 Android 导入流程。

### 关于插件数据迁移
插件文件与 `data/` 文件迁移和浏览器存储迁移是两件事。`localStorage`、IndexedDB 属于旧 SillyTavern WebView 的浏览器存储空间，不能从 TauriTavern 端直接读取旧应用的 WebView 存储；SQLite 则需要知道数据库实际路径/归属。后续的数据迁移应采用“旧 ST 导出 → TT 导入”的专用数据包，而不是把所有浏览器存储直接覆盖到 TT。
