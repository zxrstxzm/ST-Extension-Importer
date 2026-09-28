# ST Extension Importer

用于在 TauriTavern 中导入 SillyTavern `public/scripts/extensions/` 打包的 ZIP 扩展。

> 这是一个独立的 TauriTavern 第三方扩展，不修改 TauriTavern 核心源码。

## 功能

- 选择任意 `.zip` 文件，不要求固定文件名
- 自动识别 `extensions/`、`public/scripts/extensions/` 等常见目录结构
- 扫描扩展目录并显示扩展列表
- 第三方扩展默认选中
- TauriTavern 已内置的系统扩展默认跳过，避免直接覆盖 TT 自带版本
- 支持批量导入
- 对 ZIP 路径进行安全检查

## 安装

将本仓库作为 TauriTavern 的第三方扩展安装。

如果 TT 使用 Git URL 安装扩展，填写本仓库地址：

`https://github.com/YOUR_USERNAME/ST-Extension-Importer`

## 使用

1. 在 SillyTavern 中，将 `public/scripts/extensions/` 打包成 ZIP。
2. ZIP 文件名可以任意，例如 `ST-Extensions.zip`、`backup.zip`、`我的插件.zip`。
3. 在 TauriTavern 中打开 **ST Extension Importer**。
4. 点击 **选择 ZIP**。
5. 选择需要迁移的扩展。
6. 点击 **导入选中的扩展**。

推荐 ZIP 结构：

```text
extensions/
├── memory/
├── regex/
└── third-party/
    ├── cocktail/
    └── other-extension/
```

也兼容直接从 `public/scripts/extensions/` 打包得到的结构。

## 注意

这个扩展只负责迁移扩展代码文件。SillyTavern 的聊天、世界书、角色卡等数据不由本扩展迁移。

复制扩展代码并不保证所有 SillyTavern 扩展都能在 TauriTavern 中运行；依赖 SillyTavern 专有 API、Node 服务或其他运行环境的扩展仍可能需要适配。

## 版本

当前版本：`0.1.0`
