# ST Extension Importer

用于在 TauriTavern 中迁移 SillyTavern 的第三方扩展。

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
- 已存在的旧安装不会因为本次失败被删除。
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

v0.8.1 在此基础上增加了 ZIP 规范化，因此用户无需手工准备原生归档目录。

### 导入失败清理

导入任务失败后，迁移器会检查本次导入前不存在的扩展目录：如果 TT 原生导入留下了半成品目录，会自动删除，并在面板中显示“未安装”。导入前已经存在的扩展不会因为失败而被删除。

### 安装

将本仓库直接安装到 TauriTavern 的第三方扩展目录。
