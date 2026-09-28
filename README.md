# ST Extension Importer

用于 TauriTavern 的 SillyTavern 第三方扩展迁移工具。

## v0.7.2

- Android 主流程仍使用“选择 third-party 中任意文件”作为锚点，不依赖 Folder Picker。
- 修正本地扩展导入时的相对路径计算：直接依据文件的真实源路径计算，不再把扩展目录名当成文件路径。
- 修正 TT 安装目录定位：从迁移器自身的 `third-party` 安装路径确定目标目录，不再把迁移器目录本身当成目标根目录。
- 已安装检测改为依据 TT `get_extensions` 返回的实际扩展信息判断，并兼容不同返回字段。
- 未安装扩展默认勾选；已安装扩展默认不勾选。
- 面板支持点击标题折叠/展开。
- ZIP 多选和 ZIP 备用导入继续保留。

## Android 使用

1. 打开 `SillyTavern/public/scripts/extensions/third-party/`。
2. 点击本扩展的“选择 ST 扩展文件（自动扫描）”。
3. 在任意一个第三方插件里选择一个文件，推荐 `manifest.json` 或 `index.js`。
4. 工具会根据所选文件路径自动定位 `third-party`，扫描其下所有一级插件目录。
5. 未安装的插件默认勾选；已安装的默认不勾选。
6. 选择需要迁移的插件后点击“一键导入”。

ZIP 仍可作为备用方案；可以一次选择多个 ZIP。
