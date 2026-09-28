# ST Extension Importer

用于在 TauriTavern 中扫描并导入 SillyTavern `public/scripts/extensions/` 打包出来的 ZIP 扩展。

这是一个**独立的 TauriTavern 第三方扩展**，不修改 TauriTavern 核心源码。

## 功能

- 在 TT 扩展设置中提供完整操作面板
- 选择任意 `.zip` 文件，不要求固定文件名
- 自动识别 `public/scripts/extensions/`、`extensions/` 等常见 ZIP 结构
- 自动识别 `manifest.json`，没有 manifest 的扩展也会尝试识别
- 第三方扩展与 TT 内置扩展分类显示
- TT 内置扩展默认禁用，避免用 ST 版本覆盖 TT 自带版本
- 显示版本、路径、已安装状态
- 全选 / 全不选
- 批量导入
- 已存在扩展提示覆盖
- 导入进度与逐项成功/失败结果
- ZIP 路径安全检查及大小/文件数量限制

## 安装

将本仓库作为 TauriTavern 的第三方扩展安装。

如果 TT 使用 Git URL 安装扩展，填写：

`https://github.com/YOUR_USERNAME/ST-Extension-Importer`

## 使用

1. 在 SillyTavern 中，将 `public/scripts/extensions/` 打包成 ZIP。
2. ZIP 文件名可以任意，例如 `ST-Extensions.zip`、`backup.zip`、`我的插件.zip`。
3. 在 TauriTavern 的扩展设置中打开 **ST Extension Importer**。
4. 点击 **📦 选择 ZIP**。
5. 查看扫描结果并勾选需要迁移的扩展。
6. 点击 **开始导入**。
7. 导入完成后重新加载 TT。

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

这个扩展只负责迁移扩展**代码文件**。SillyTavern 的聊天、世界书、角色卡等数据不由本扩展迁移。

复制扩展代码并不保证所有 SillyTavern 扩展都能在 TauriTavern 中运行；依赖 SillyTavern 专有 API、Node 服务或其他运行环境的扩展仍可能需要适配。

## 版本

当前版本：`0.2.1`
