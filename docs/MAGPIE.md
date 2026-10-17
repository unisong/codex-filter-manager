# Magpie 使用方式

Magpie 只提供两种选择：本仓库的完整工作台，或社区市场的纯过滤插件。两者选择一种，不重复启用。早期「独立管理服务＋Magpie 钩子」入口已从主线移除，不再维护。

## 全功能版

加载本仓库的 `magpie-workbench/` 目录，详见 [安装说明](../magpie-workbench/README.md)。

- 只需要历史过滤：在 Magpie 的 **Codex Workbench · 历史过滤** 原生页面按供应商设置，不需要打开工作台。
- 需要模型检测：打开该目录的 `Open.bat`，使用手动检测、定期观测、异常暂停、记录与诊断。
- 定期间隔可选 5、10、20、30、60 分钟，或自定义 1–10080 分钟的整数，默认 30 分钟。定期检测会使用上游额度。
- Codex 保持连接 Magpie 原网关，工作台不改写 `base_url`；不同会话按各自请求的 `供应商/模型` 前缀选取过滤规则。

根目录的 `Start.bat` / `filter.cjs start` 仅启动 CC Switch 服务。识别到 Magpie 配置时会拒绝启动并提示正确入口，不安装旧钩子或改写 Magpie 的 Codex 地址。完整工作台使用自己的本机后台与入口。

检测、暂停、规则保存及诊断的详细边界见 [工作台使用说明](../magpie-workbench/docs/USAGE.md)。

## 社区纯过滤插件

在 Magpie 自带的社区插件市场 **Plugins → Discover → Gateway middleware** 搜索 **Codex History Filter** 安装，或运行：

```sh
magpie plugin add @magpie-community/middleware-codex-history
```

此版本仅提供历史过滤，无额外 UI、工作台、模型检测或保护。在 **Plugins → Installed → 本插件 → Options** 中按供应商设置，默认全部关闭；不需要启动本仓库的服务。

[社区插件源码与配置示例](https://github.com/unisong/magpie-codex-history-filter)

## 共同边界

过滤保留可读正文与工具配对，不解密历史密文。不可安全迁移的服务器引用或加密压缩会明确拒绝。规则按进入请求钩子时的模型前缀选择；其他插件或 fallback 后续改写路由时，不保证对应最终上游。插件加载失败、异常或超时可能被 Magpie 放行，请在其插件页核对运行状态。

完整功能与 UI 在主仓库维护，社区仓库只同步纯过滤代码，详见 [维护与发布关系](MAINTENANCE.md)。
