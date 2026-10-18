# Codex 过滤管理

为 **Codex + CC Switch / Magpie** 提供按供应商控制的历史兼容过滤，缓解切换中转站后旧会话出现的加密内容验证失败、跨 Azure 资源 ID、`web_search_call` 缺少 reasoning 等问题；可选模型监测会在项目响应进入会话前检查指纹是否明显偏离。

**Windows 10 / 11 · 无需管理员权限 · 首次启动自动准备 Node.js · MIT**

当前版本：**v1.0.12 / 服务 v37**。[下载最新版](https://github.com/unisong/codex-filter-manager/releases/latest) · [更新记录](docs/CHANGELOG.md) · [问题反馈](https://github.com/unisong/codex-filter-manager/issues)

## 两种版本

| 版本 | 适用环境 | 包含内容 |
| --- | --- | --- |
| **全功能版**（本仓库） | CC Switch 或 Magpie | 历史过滤、可视化工作台、模型监测、记录与诊断 |
| **社区纯过滤插件** | Magpie 社区插件市场 | 仅历史过滤中间件，无工作台 UI 或模型检测 |

全功能版在两种网关下的接入方式不同：

- **CC Switch**：本仓库的代理服务接管 Codex 路由，界面开关直接对应供应商规则。
- **Magpie**：加载本仓库的 [`magpie-workbench/`](magpie-workbench/README.md) 插件，Codex 继续直连 Magpie，本工具不修改 `base_url`。

只需过滤的 Magpie 用户可以在 **Plugins → Discover → Gateway middleware** 搜索 **Codex History Filter** 安装社区版，或执行：

```sh
magpie plugin add @magpie-community/middleware-codex-history
```

社区版源码位于 [unisong/magpie-codex-history-filter](https://github.com/unisong/magpie-codex-history-filter)。完整工作台与社区纯过滤插件选择一种加载，避免重复处理请求。

## CC Switch 快速开始

先让 Codex 能通过 CC Switch 正常调用模型，并开启其路由接入。旧版界面通常写作 **「本地代理」+「Codex 接管」**，新版界面在 Codex 页选择 **「路由」** 后点击 **「开始路由」**。只停留在路由标签、或只启动代理但没有让 Codex 使用，都不算完成接入。无需开启自动故障转移。

1. 从 [Releases](https://github.com/unisong/codex-filter-manager/releases/latest) 下载 ZIP，完整解压到长期使用的可写目录。
2. 双击 **`Start.bat`**。首次启动会校验并下载官方 Node.js，不需要安装 npm 依赖。
3. 浏览器打开本机管理页，桌面同时创建 **「Codex 过滤管理」** 快捷方式。
4. 完全退出并重新打开 Codex，让客户端重新读取接入地址。
5. 在「历史过滤」页为需要的供应商开启规则。**新安装不预置供应商，过滤与模型保护默认关闭。**

```text
Codex → 本机过滤服务 → CC Switch → 当前供应商
```

日常入口：`Start.bat` 启动并打开页面；`Status.bat` 查看状态；`Diagnose.bat` 导出脱敏诊断。退出时点击页面右上角 **「关闭服务」**，确认后恢复 Codex 配置、取消检测并结束过滤进程；`Stop.bat` 仍可使用。关闭浏览器不会停止后台服务，工具默认不注册开机启动。

供应商数据库短暂忙碌时，服务会异步重试读取规则，最多追加 3 次、等待合计约 1.2 秒。仍无法读取则返回本地 `503 / filter_policy_unavailable`，附请求编号及重试提示，不把未知规则当成关闭过滤。管理页会保留本次运行的异常统计；持续出现时点击「查看诊断」。无需因此新建会话或更改兼容开关。

## Magpie 快速开始

将本仓库解压到固定目录，然后在 Magpie 中加载：

```sh
magpie plugin add /path/to/codex-filter-manager/magpie-workbench
```

只使用历史过滤时，不必打开工作台，直接在 Magpie 侧边栏的 **Codex Workbench · 历史过滤** 原生页面设置；在 Magpie 扩展／插件页面确认插件已启用、无调用错误。需要模型监测时，再运行 `magpie-workbench/Open.bat` 打开本地工作台。

详细安装、升级、数据位置与边界见 [Magpie 使用方式](docs/MAGPIE.md)。

## 关闭与更新

在 **设置与诊断 → 版本更新** 点击「检查更新」，版本按从新到旧排列，选择比当前版本新的正式版本，查看说明后按需更新。下载过程中显示字节进度与百分比。打开页面不会自动检查、下载或安装，也不会调用模型。

| 环境 | 关闭按钮 | 更新方式 |
| --- | --- | --- |
| CC Switch 的 Windows 发布包 | 关闭过滤服务并恢复配置；CC Switch 与 Codex 保持运行 | 「安装并重启」下载并校验发布包，备份程序文件后安装；保留规则、记录与运行时，失败时尝试恢复旧版 |
| Magpie 完整工作台 | 关闭本机工作台及检测；Magpie、历史过滤与已有暂停规则继续有效 | 「下载并准备新版」生成独立插件目录，按页面给出的路径在 Magpie 切换目录并重新加载 |
| Git 源码目录 / 非 Windows | 按对应环境关闭 | 可以检查版本，通过 Git 或发布页更新；源码目录禁止覆盖安装 |

安装更新和关闭服务前，请结束正在进行的 Codex 调用。Magpie 工作台关闭后，从 Magpie 的工作台入口重新打开或重新加载插件；已停止的定期检测需手动恢复。浏览器和 GitHub 的网络错误不会自动关闭正在运行的服务。

目前检查最近 30 个 Release 中带完整 Windows ZIP 和 `SHA256SUMS.txt` 的更新版本，不提供降级或预发布版本。首次获得页面更新功能仍需安装包含本功能的版本；老版本不会自动出现按钮。详细行为、备份和故障恢复见 [服务关闭与更新](docs/SERVICE-UPDATES.md)。

## 界面

界面按 **当前状态 → 主操作 → 配置列表 → 技术说明** 排列。Magpie 工作台每次打开默认进入首栏「历史过滤」，模型监测需主动切换。左上角显示运行状态、版本和项目链接；右上角提供明暗切换、当前页面刷新和关闭入口。

![历史过滤](docs/images/providers.png)

<details>
<summary>查看模型监测、检测记录和供应商设置</summary>

![模型监测](docs/images/protection.png)
![同页调整监测](docs/images/monitor-settings.png)
![检测记录](docs/images/history.png)
![供应商设置](docs/images/provider-settings.png)
![设置与诊断](docs/images/settings.png)
![深色主题](docs/images/protection-dark.png)

</details>

## 历史过滤

过滤按供应商独立保存，历史过滤、Lite 协议兼容和模型保护互不联动。新供应商默认关闭，兼容开关本身不会发起模型请求。

| 选项 | 作用 | 建议 |
| --- | --- | --- |
| 过滤历史加密内容 | 移除旧 reasoning、明确标记的密文和可移植条目中的服务器 ID，保留正文与工具配对 | 切换供应商后旧会话报密文或跨资源 ID 错误时开启 |
| 保留新响应的加密内容请求 | 保留客户端原有的 `reasoning.encrypted_content` 请求，不会恢复已经清理的旧密文 | 开启历史过滤时通常保持开启 |
| Lite 协议兼容 | 移除 Responses/Lite 扩展标头，不改模型与推理强度 | 仅在上游明确提示 Lite 与 `reasoning.context` 冲突时开启 |

推荐从 **前两项开启、第三项关闭** 开始。上游明确拒绝新响应密文请求时，再尝试关闭第二项。三个选项的完整原理、流程与截图见 [兼容规则说明](docs/COMPATIBILITY.md)。

服务 v33 起，历史过滤也会把旧 `web_search_call` 转换为带说明的普通助手文字，保留已记录的查询、动作和来源，避免旧搜索条目必须依赖已经被移除的 reasoning。该转换不会重新搜索，也不会补造结果。

## 模型监测

模型监测使用 [ModelTrace](https://github.com/xqy2006/ModelTrace) 的出题器、评分逻辑和参考库，在本机通过当前供应商取样并评分。检测请求不携带项目对话，也不会改用 ModelTrace 的云端检测接口。

- **手动检测**：点击后才产生 3 个样本；强差异时可能追加复核，最多 6 个。
- **自动保护**（CC Switch）：请求响应完整验证后才交付；结果可按有效期复用，默认 10 分钟。
- **定期观测 / 异常暂停**（Magpie 工作台）：按 5、10、20、30、60 分钟或自定义间隔取样；任务结束时可从顶部一键停止全部轮询。

一轮通常产生 3 次计费请求，网络故障最多额外重试 3 次。匹配分是有限候选模型之间的相对证据，不是身份概率，也不能证明代码质量。网络错误、上游 403 和样本无效不会被标成“确认降智”。详细评分、重试、锁定和费用边界见 [模型保护说明](docs/MODEL-GUARD.md)。

## 数据与边界

- 过滤不解密密文、不改写 Codex 会话文件，只移除可安全丢弃的内部状态；无法安全迁移的服务器引用或加密压缩历史会明确拒绝。
- CC Switch 模式仅支持 Responses HTTP/SSE；自动故障转移、复杂路由组或其他接入方式可能让管理页无法准确识别当前供应商。
- CC Switch 开启模型保护后，响应会等待完整校验后再显示，不能逐字流出，也不能撤回已经执行的工具操作。
- Magpie 插件加载失败、超时或被宿主跳过时，请求可能继续放行；运行状态应以 Magpie 插件页为准。
- 管理端口只监听本机，不上传遥测。不要公开 `.runtime/`、Magpie 配置、API Key、会话文件或未检查的日志。

完整隐私说明见 [SECURITY.md](SECURITY.md)；常见错误与恢复步骤见 [排障文档](docs/TROUBLESHOOTING.md)。

## 诊断

在「设置与诊断」点击检查，可预览并下载只含运行元数据的 JSON；页面打不开时运行 `Diagnose.bat`。报告不包含对话、密钥、供应商地址或个人路径，也不会自动上传。反馈问题时请附上产品版本、服务版本、发生时间和操作步骤。

## 开发

需要 Node.js 24+，核心运行无第三方 npm 依赖：

```powershell
npm test
node magpie-workbench/tools/build-middleware.mjs
node --test magpie-workbench/test/*.test.mjs
powershell -File tests/launcher/launcher-check.ps1
```

目录职责、命令行参数、浏览器测试和提交要求见 [CONTRIBUTING.md](CONTRIBUTING.md)。

```text
AGENTS.md                仓库目录与提交规则（也供 AI 编码助手读取）
filter.cjs               稳定 CLI 入口
src/                     CC Switch 服务、过滤、模型保护与诊断
web/                     CC Switch 管理页面与共享静态资源
magpie-workbench/        完整 Magpie 插件、原生设置页与本机工作台
tests/                   自动测试、浏览器检查和固定测试数据
scripts/                 启动实现、打包、截图与手动检查工具
docs/                    使用、兼容、维护、排障与更新记录
```

## 许可与致谢

本项目采用 [MIT](LICENSE)。感谢 [ModelTrace](https://github.com/xqy2006/ModelTrace) 提供模型行为指纹算法、中文出题器与参考库；固定版本、许可和校验值见 [第三方说明](THIRD_PARTY_NOTICES.md)。感谢 [CC Switch](https://github.com/farion1231/cc-switch) 与 [Magpie](https://github.com/yetone/magpie) 提供本地网关生态。

友情链接：[LINUX DO](https://linux.do/)
