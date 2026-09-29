# ST Extension Importer

用于在 TauriTavern 中迁移 SillyTavern 的第三方扩展。

## v0.8.0

本版本不再通过前端 `plugin:fs|write_file` 直接写入 TT 的数据目录。ZIP 导入改为调用 TauriTavern 已有的数据归档导入接口，由 TT 后端负责写入 `data/extensions/third-party/`，避免 Android `/storage` 的 `forbidden path`。

### ZIP 格式

为了让 TT 原生归档系统识别，ZIP 根目录必须是：

```text
extensions/
└── third-party/
    ├── Cocktail/
    ├── 心迹回廊/
    └── 其他插件/
```

也可以外包一层 `data/`：

```text
data/extensions/third-party/...
```

不要把整个 `public/scripts/extensions/` 打进去；迁移器只接受第三方扩展目录，避免覆盖 TT 内置扩展。

### 导入失败清理

导入任务失败后，迁移器会检查本次导入前不存在的扩展目录：如果 TT 原生导入留下了半成品目录，会自动删除，并在面板中显示“未安装”。导入前已经存在的扩展不会因为失败而被删除。

### 安装

将本仓库直接安装到 TauriTavern 的第三方扩展目录。
