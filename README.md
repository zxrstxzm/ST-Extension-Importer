# ST Extension Importer

SillyTavern 第三方扩展迁移工具，面向 TauriTavern。

## Android 推荐用法

Android 上 TT 当前没有可用的文件夹选择器，因此点击 **「多选插件文件」**：

1. 在每个第三方扩展目录里至少选择一个文件，推荐 `manifest.json` 或 `index.js`。
2. 可以一次选择多个文件。
3. 工具根据所选文件自动向上寻找包含 `manifest.json` 的扩展根目录。
4. 自动读取整个扩展目录。
5. 扫描后勾选需要迁移的扩展，点击 **「一键导入」**。

例如：

```text
SillyTavern/public/scripts/extensions/third-party/
├── cocktail/
│   ├── manifest.json  ← 选这个
│   └── ...
├── tavern-db/
│   ├── manifest.json  ← 再选这个
│   └── ...
```

不需要把整个 575 MB 的 `third-party` 压成一个 ZIP。

ZIP 导入仍然保留作为备用方案。


## Android 自动扫描

移动端不需要 Folder Picker。点击“选择 ST 扩展文件（自动扫描）”，在 `public/scripts/extensions/third-party/` 内任意一个插件中选择任意文件（推荐 `manifest.json`）。扩展会根据所选文件路径自动定位 `third-party` 目录，然后递归扫描其中的全部第三方扩展。


## v0.6.0
- ZIP 单文件上限提高到 1000 MB。
- 移除对不存在的 `get_runtime_paths` 命令的依赖。
- 通过 TauriTavern 公开的 `get_extensions` 定位本扩展自身目录，并以其父目录作为第三方扩展安装目录。
- 移动端继续支持“选择 third-party 中任意文件作为锚点”扫描整个第三方扩展目录。
