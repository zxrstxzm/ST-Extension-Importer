# ST Extension Importer

用于在 TauriTavern 中迁移 SillyTavern 的第三方扩展。

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
