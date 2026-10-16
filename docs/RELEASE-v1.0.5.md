# v1.0.5 · Codex 过滤管理（服务 v31）

新增 Magpie 原生历史过滤插件，同时保留 CC Switch 独立代理和原有模型保护功能。管理页面显示 **v31**，下载包与 GitHub Release 使用 **v1.0.5**。

## 主要变化

- 自动识别 CC Switch / Magpie，也可用 `--backend` 显式选择。
- Magpie 模式自动注册本地请求插件，Codex 直接连接 Magpie；启动、停止和定时同步不改写 `config.toml` 中的地址。
- 不同会话按请求中的 `供应商/模型` 前缀分别应用规则，支持同时过滤多个供应商。
- 两种模式共用历史清理算法，补充工具搜索调用、工具搜索结果及附加工具定义条目的可选服务器 ID 清理，保留可读历史及工具配对。
- 管理页区分 Magpie 手动检测模式与 CC Switch 自动保护模式。公开安装包不附带供应商规则，历史过滤及自动保护默认关闭。

## 安装与升级

下载 `codex-filter-manager-v1.0.5-windows.zip`，解压后双击 `Start.bat`。首次需要运行时会下载并校验官方 Node.js，无需手动安装 npm 依赖。

已有用户先运行旧目录的 `Stop.bat`，备份自己的 `.runtime/`，覆盖到同一目录后再启动。CC Switch 用户需重新打开 Codex，让客户端读取接入地址。Magpie 用户应先完成 Codex 接入，使用明确的 `供应商/模型`，再启动本工具并按需开启过滤。

使用过服务 v30 Magpie 独立代理开发版的用户，应先用旧版停止命令恢复原网关地址，再升级。v31 不会擅自恢复或改写 Magpie 地址。Magpie 插件通过安装目录的本地路径加载，移动或删除目录前须在 Magpie 中卸载旧插件。

## 兼容边界

- Magpie 原生模式保留历史过滤、手动 ModelTrace 检测与记录，**不支持自动降智检测或切断、Lite 标头修改**；停止管理服务后插件继续工作，需在 Magpie 中单独停用。
- 已验证 Magpie 0.1.1265。插件加载失败或超时可能放行原请求；管理页「已启用」不是运行健康确认，应在 Magpie 插件页核对。
- fallback / 其他自定义插件场景存在管理页过滤状态显示限制，详见 [Magpie 适配说明](https://github.com/unisong/codex-filter-manager/blob/v1.0.5/docs/MAGPIE.md)。
- 过滤只能缓解部分历史兼容问题，无法解密旧密文、迁移所有服务器资源引用或保证消除全部 Azure 历史错误。
- 模型检测算法与参考库来自 [ModelTrace（MIT）](https://github.com/xqy2006/ModelTrace)，本次未更改评分算法。

## 验证

158 项离线回归测试覆盖共用清理、供应商规则隔离、CC Switch 恢复流程和 Magpie 配置只读；另有管理页浏览器检查、10 项 Windows 启动器检查及公开包检查。测试使用临时配置和模拟上游，原生钩子在本机 Magpie 中通过拒绝请求确认加载，未调用付费模型探针。
