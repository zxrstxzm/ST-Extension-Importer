# ST Extension Importer

用于在 TauriTavern 中扫描并导入 SillyTavern 扩展 ZIP。

这是一个独立的 TauriTavern 第三方扩展，不修改 TauriTavern 核心源码。

## 0.4.0：支持多个 ZIP

如果 `third-party` 总大小超过单个 ZIP 的 512 MB 限制，可以拆成多个 ZIP，例如：

```text
ST-ThirdParty-01.zip
ST-ThirdParty-02.zip
ST-ThirdParty-03.zip
```

在面板里点击 **添加 ZIP**，一次选择多个 ZIP。扩展会：

- 逐个扫描 ZIP
- 合并扩展列表
- 自动按扩展目录名去重
- 显示重复数量
- 统一选择和批量导入
- 每个扩展从它所属的 ZIP 读取文件

单个 ZIP 仍有 512 MB 限制；一次选择的 ZIP 总大小上限为 2 GB。

## 推荐打包方式

优先只打包：

```text
public/scripts/extensions/third-party/
```

如果仍然超过 512 MB，就拆成多个 ZIP。ZIP 文件名可以任意。

## 安装

把本仓库作为 TauriTavern 第三方扩展安装：

`https://github.com/YOUR_USERNAME/ST-Extension-Importer`

## 使用

1. 将 SillyTavern 的第三方扩展目录拆分打包成一个或多个 ZIP。
2. 在 TauriTavern 扩展设置中打开 **ST Extension Importer**。
3. 点击 **📦 添加 ZIP**，可以一次选择多个 ZIP。
4. 查看合并后的扫描结果。
5. 勾选需要迁移的扩展。
6. 点击 **开始导入**。
7. 导入完成后重新加载 TT。

## 注意

这个扩展只负责迁移扩展代码文件。聊天、世界书、角色卡等数据不由本扩展迁移。

复制扩展代码并不保证所有 SillyTavern 扩展都能在 TauriTavern 中运行；依赖 SillyTavern 专有 API、Node 服务或其他运行环境的扩展仍可能需要适配。


## v0.4.0

- 优先支持直接选择 SillyTavern 文件夹。
- 自动寻找 `public/scripts/extensions/third-party/`。
- 不再需要把整个第三方扩展目录压成单个 ZIP。
- ZIP 导入继续保留作为备用方案。
