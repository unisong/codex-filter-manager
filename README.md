# Codex Filter Manager · Codex 过滤管理

一个运行在 **Codex 与 CC Switch 之间的本机代理**，提供可视化的供应商历史兼容设置与可选的模型一致性保护。适合切换供应商后，旧会话出现加密内容无法验证、历史 item ID 不属于当前上游等错误的用户。

**Windows 10 / 11 · 无需管理员权限 · 无需手动安装 Node.js 或 npm 依赖 · MIT**

发布版本：**1.0.0**；页面与状态接口中的过滤服务版本：**v20**。

[GitHub 仓库](https://github.com/unisong/codex-filter-manager) · [下载最新版本](https://github.com/unisong/codex-filter-manager/releases/latest) · [反馈问题](https://github.com/unisong/codex-filter-manager/issues)

> 本项目是独立社区工具，与 OpenAI、CC Switch 或任何供应商没有官方隶属关系。它可以缓解部分历史兼容问题；模型保护提供统计风险检查，不能证明模型能力，也不能保证杜绝“降智”或项目污染。

## 能做什么

| 功能 | 实际行为 |
| --- | --- |
| 历史过滤 | 按供应商清理可移植历史中的 reasoning 密文、部分服务器 item ID，保留普通消息、工具参数、工具结果与 call_id；不修改已有会话文件 |
| 可视化供应商管理 | 从 CC Switch 只读加载供应商；逐个开启或关闭历史过滤、模型保护和兼容选项，无需改脚本 |
| 模型一致性保护 | 在项目请求前发出独立数字样本探针；检测到重复的明显指纹差异或响应模型名不符时锁定，阻止受保护输出交付 |
| 响应检查 | 开启保护后缓存完整 Responses 响应，验证完成事件和模型字段，再交付客户端 |
| 历次检测记录 | 保留最近 100 次检测，每页 10 条，独立页签和列表内滚动；当前锁定独立显示 |
| 兼容性与恢复 | 部分供应商 Responses/Lite 兼容、受限的 429 排队重试，以及停止服务时恢复本工具接管的地址 |

转发路径：

```text
Codex → 本机过滤服务（默认 127.0.0.1:18181）→ CC Switch 本地代理 → 当前供应商
```

**检测算法来源：[xqy2006/ModelTrace](https://github.com/xqy2006/ModelTrace)。** 本项目集成了该项目 MIT 许可的评分核心与参考库，在本机评分；没有连接所谓的 ModelTrace 云端检测接口。探针请求走你自己的 CC Switch 与供应商，可能计费。[检测原理与局限](MODEL-GUARD.md) · [第三方许可](THIRD_PARTY_NOTICES.md)

## 界面预览

以下截图使用虚构的演示供应商与检测数据，不代表任何真实供应商的检测结论。

**供应商管理：顶部快速切换，按供应商保存设置。**

![供应商管理页面](docs/images/providers.png)

<details>
<summary>展开查看模型保护与检测记录</summary>

**模型保护：手动检测、设置缓存间隔、查看当前锁定。**

![模型保护页面](docs/images/protection.png)

**检测记录：独立分页，不挤占供应商操作区域。**

![检测记录页面](docs/images/history.png)

</details>

## 点击即用

### 准备

- Windows 10 / 11，x64 或 ARM64；使用当前用户有写入权限的文件夹。
- 已安装并配置 [CC Switch](https://github.com/farion1231/cc-switch)，其 **本地代理** 与 **Codex 接管** 已开启。
- Codex 原本能够通过 CC Switch 新建会话并调用供应商。本工具不提供模型额度、API Key 或供应商账号。

### 首次启动

1. 从 [最新 Release](https://github.com/unisong/codex-filter-manager/releases/latest) 下载发布 ZIP，解压到准备长期使用的目录。不要在压缩包内直接运行。
2. 双击 **`Start.bat`**。启动器会寻找兼容的 Node.js；需要时从 `nodejs.org` 下载固定版本的便携运行时，校验 SHA-256 后放入项目的 `.tools/`。无需管理员权限，也不需要 `npm install`。
3. 浏览器打开 [管理页面](http://127.0.0.1:18181/__codex_filter__/ui)。启动器同时创建桌面的 **「Codex 过滤管理」** 快捷方式。
4. 确认服务已接入、CC Switch 可连接。**首次接入后完全退出并重新打开 Codex**，让客户端读取新的代理地址。
5. 在页面为需要兼容的供应商开启「历史过滤」；「模型保护」按需单独开启。供应商切换仍在 CC Switch 操作。

首次运行需要联网下载便携运行时；之后可复用本机缓存。模型请求本身仍需要供应商可用。启动脚本的 `ExecutionPolicy Bypass` 只用于这一次进程，不修改系统执行策略。Windows 可能提示未签名下载文件；请先核对下载来源，无需关闭系统安全防护。

### 日常启动、停止与更新

| 操作 | 入口 |
| --- | --- |
| 启动并打开页面 | 桌面「Codex 过滤管理」或 `Start.bat` |
| 查看服务状态 | `Status.bat` |
| 停止并恢复地址 | `Stop.bat`，随后重启 Codex |
| 电脑重启后继续使用 | 再次双击桌面快捷方式；本工具不会注册开机自启动 |
| 更新 | 先运行旧目录的 `Stop.bat`，备份 `.runtime/`，将新版本解压覆盖到同一目录，再运行 `Start.bat`；不要用其他人的运行数据覆盖自己的 `.runtime/` |
| 卸载 | 先运行 `Stop.bat`，确认地址已恢复，再删除项目目录和桌面快捷方式 |

关闭浏览器不会停止后台服务。不要在服务运行时移动目录；需要搬迁时先停止，完整移动后从新目录启动并更新快捷方式。不要同时启动多个副本接管同一个 Codex 配置。

## 如何选择开关

**历史过滤**用于处理切换供应商后的旧会话兼容问题，例如 `encrypted content hydration failed` 或历史资源不属于当前上游。它会丢弃部分历史内部推理状态，可能影响长任务连续性；如果会话只剩无法解密的压缩摘要，过滤不能恢复丢失的信息。

新增供应商通常默认直通；少量内置域名兼容规则会在页面显示。你保存的供应商设置优先于内置规则。「关闭全部兼容」可明确保存直通设置，「恢复默认」撤销自定义。历史过滤与模型保护是两个独立开关。

当前内置历史过滤域名为 `agentrouter.org`、`air-outer.com`、`anyrouter.top`、`apizn.com`、`ark717.com`、`venlacy.com`（含合法子域）；`https://hub.oaifree.com` 使用独立的 Responses/Lite 标头兼容规则。这些规则是历史兼容经验，不代表对供应商的质量评价或持续可用性保证，均可在界面覆盖。

**模型保护**默认关闭。开启前建议先手动检测，确认当前模型在参考库中且供应商接受探针请求。默认通过结果可复用 10 分钟，可改为每次请求或 1–60 分钟：例如 30 分钟到期后，**下一次受保护请求**会先重新检测；空闲时不会每隔 30 分钟自动调用模型。

一次普通检测发出 **3 个独立请求**，每个要求生成 300 个 1–355 的整数；明显不一致时再发 3 个复核。探针不携带项目历史、文件或工具，但会使用当前模型和推理强度，可能消耗较多输出及推理 token。实际 token 与费用取决于供应商与模型，不能仅用“900 个数字”推算。[完整检测说明](MODEL-GUARD.md)

受保护请求遇到超时、参考库未收录、结果模糊等情况也会停止放行，但这些结果属于 **“未能验证”**，不等同于“已确认降智”。清除锁定只是允许重新检测，不会直接判定通过。

## 已知缺陷与边界

- **统计指纹不能证明质量。** 参考库有限，可能误报或漏报；探针和真实项目请求可能被路由到不同模型，响应模型名也可能被伪装。检测通过不是模型身份认证、质量保证或文件回滚机制。
- **开启保护会增加等待时间和调用费用。** 每次检测总时限为 145 秒；项目响应完整缓存后才放行，客户端会失去逐 token 的流式显示。单响应上限 16 MiB，并发缓存总上限 64 MiB，超限会拦截。
- **长会话压缩受限。** 历史过滤或模型保护生效时，不支持 `/responses/compact` 与不可迁移的加密压缩历史；长会话可能需要先生成明文任务摘要，再开新会话。
- **只支持 Responses HTTP/SSE。** 不支持 WebSocket，握手会返回 426；不是通用 Chat Completions 网关，也不是所有 Codex 配置来源的统一入口。
- **依赖 CC Switch 的本地数据库结构和接管配置。** 未来版本变更可能导致识别失败；复杂 TOML、配置 profile、命令行覆盖或其他客户端配置源也可能绕过接入。以页面接入状态和请求计数为准。
- **自动故障转移与验证冲突。** 开启 CC Switch 自动 failover 时，历史兼容处理会停用；存在已开启的模型保护而路由无法固定时，请求会被拒绝。避免在请求进行中切换供应商；本工具不能原子锁定 CC Switch 内部路由。
- **只提供 Windows 启动器与验证流程。** macOS/Linux 尚未提供开箱即用的部署支持；供应商和模型兼容性也需逐个确认。

常见错误、连接恢复和安全停用步骤见 [排障文档](docs/TROUBLESHOOTING.md)。

## 数据与隐私

管理服务只监听本机 `127.0.0.1`，使用本机管理令牌、同源校验与禁止跨域/嵌入策略。不要把管理端口映射到公网或作为共享网关使用。

本工具只读访问 CC Switch 数据库，不写入供应商 Key 或选择；为了接入代理，会修改当前 Codex 配置中的目标 `base_url` 并记录恢复信息。停止时只恢复本工具仍拥有的精确地址。模型保护会在内存中处理项目响应与探针所需认证头，正常日志不记录请求正文或鉴权头。没有项目自带的遥测上传功能。

以下数据留在本机，已由 `.gitignore` 排除，**不要随 Issue、截图或开源源码上传**：

| 位置 | 内容 |
| --- | --- |
| `.runtime/service.json` | 进程信息与本机控制令牌 |
| `.runtime/routes.json` | 接管前地址与恢复信息；恢复前不要删除 |
| `.runtime/provider-rules.json` | 供应商历史兼容规则与 ID |
| `.runtime/model-guard.json` | 模型保护设置、供应商标识、锁定与最近 100 次检测证据 |
| `.runtime/*.previous`、日志与其他备份 | 本机运行备份和诊断信息；可能含供应商名称或本机路径 |
| `.tools/` | 下载的便携 Node.js 运行时 |

详细安全边界与漏洞报告方式见 [SECURITY.md](SECURITY.md)。

## 开发与命令行

源码运行需要 **Node.js 24+**，运行时使用 Node 内置模块，无 npm 包依赖。

```powershell
node .\filter.cjs start
node .\filter.cjs status
node .\filter.cjs stop
```

默认读取 `%USERPROFILE%\.cc-switch\cc-switch.db` 和 `%CODEX_HOME%\config.toml`；未设置 `CODEX_HOME` 时读取 `%USERPROFILE%\.codex\config.toml`。CC Switch 监听端口从其数据库发现。

```powershell
# 仅在确有自定义路径或端口时指定；stop/status 必须使用相同 runtime。
node .\filter.cjs start --port 18181 --upstream http://127.0.0.1:15721 --config "D:\Codex\config.toml" --runtime "D:\FilterData" --cc-db "D:\CCSwitch\cc-switch.db"
```

`state=filtering` 表示配置地址已接入，不代表当前供应商的历史过滤或模型保护均已开启。已运行的客户端可能缓存旧地址；确认接入后重启客户端，并观察新请求是否使计数增长。

```powershell
npm test
```

离线自动测试使用临时配置、模拟 SQLite 数据库和本机 HTTP 服务，不调用真实模型、不改用户的 CC Switch 数据库或 Codex 配置。浏览器检查、源码结构和提交要求见 [CONTRIBUTING.md](CONTRIBUTING.md)。`live-check.cjs` 等真实连通性工具会调用当前供应商并可能计费，未包含在默认测试中。

## 来源与许可

本项目采用 [MIT License](LICENSE)。

- **已集成：[ModelTrace](https://github.com/xqy2006/ModelTrace)**，MIT；评分核心和参考库固定在提交 [`6cd4a8f`](https://github.com/xqy2006/ModelTrace/tree/6cd4a8ff0f3f4e49d6d6969dd2fbadfa1569fde2)，原许可证保留于 [`vendor/modeltrace/LICENSE`](vendor/modeltrace/LICENSE)。
- **仅调研：[meow-llm-detector](https://github.com/chen-006/meow-llm-detector)**，PolyForm Noncommercial；未集成其代码、数据或检测接口。
- **配套工具：[CC Switch](https://github.com/farion1231/cc-switch)**，需用户另外安装。本项目不会将其打包发行。

第三方组件仍遵循各自许可证，详情见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。欢迎提交可复现的兼容性问题；反馈前请按排障文档移除个人信息与密钥。
