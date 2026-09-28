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
