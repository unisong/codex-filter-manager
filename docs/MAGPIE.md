# Magpie 适配说明

本文说明 **Codex Filter Manager 独立服务附带的 Magpie 历史过滤钩子**，不是 [Magpie Codex 合并工作台插件](https://github.com/unisong/magpie-codex-history-filter)。两种安装方式不要重复启用。合并插件的原生设置页、定期检测与异常暂停以其 README 为准。

本模式使用原生请求中间件：`Codex → Magpie :3425 → 历史过滤插件 → 供应商`。管理页在 `http://127.0.0.1:18181/__codex_filter__/ui`，负责规则设置和手动指纹检测；附带钩子本身没有原生设置页。它不改写 Codex 的 `base_url`，也不修改 Magpie 供应商、密钥或模型选择。已在 Magpie 0.1.1265 验证原生钩子；其他版本需核对接口兼容性。

## 启动与日常使用

1. 先启动 Magpie，使用普通 API 供应商将 Codex 接入网关。Codex 配置应使用 `[model_providers.magpie]` 等 provider 表的 `base_url`，模型形如 `demo/gpt-6-astra`。
2. 双击过滤工具的 `Start.bat` 或桌面「Codex 过滤管理」。工具根据当前 Codex 配置识别网关，在 Magpie 的 `plugins.json` 注册本地插件；页面显示 **Magpie 原生插件**。
3. 在页面为需要处理的供应商打开历史过滤。全新安装默认全部关闭；从旧版本升级时仅迁移已明确保存的 Magpie 历史过滤规则，不继承 CC Switch 的规则。
4. 原生插件覆盖直接请求 Magpie 的旧会话，无需借助旧会话重新读取 Codex 配置。请求统计和插件调用信息以 Magpie 插件页面为准。
5. 新增供应商仍在 Magpie 中完成，点击管理页「刷新列表」后即可配置。关闭浏览器或停止管理服务不卸载插件；Magpie 保持运行且插件启用时，过滤继续执行。电脑重启后，启动 Magpie 即可加载已安装的插件；双击桌面快捷方式可启动管理页。

启动、定时同步和停止均不写入 Magpie 的 Codex `config.toml`。若配置仍指向 `18181`，请核对是否遗留其他代理接入；本工具不会擅自改回地址。

页面的「配置默认供应商」来自 Codex 配置文件。原生过滤按每个 HTTP 请求携带的模型前缀决定：两个会话分别调用 `demo/gpt-6-astra` 和 `backup/gpt-6-astra` 时，各自使用对应供应商的规则。供应商曾改名时，启动或保存规则会同步 Magpie 保存的 `was` 旧前缀。

本服务的手动检测针对当前配置的供应商。监测页面优先显示该供应商最近实际请求的模型，其次采用其检测记录；均无记录时，在当前页展开手动选择并用配置值预填。实际探针带供应商前缀，例如 `demo/gpt-6-astra`，本机按 `gpt-6-astra` 评分。若要手测另一个供应商，先在 Magpie 更改 Codex 的配置默认模型，再刷新此页。最近请求可能来自其他会话，管理页无法识别当前前台会话。

## 清理原理与规则管理

- 原生插件与独立代理共用同一份清理算法。开启后移除旧 reasoning、明确标记的密文内容，以及可携带完整内容的消息和工具条目中的服务器 ID；补充处理 `tool_search_call`、`tool_search_output` 和 `additional_tools` 的可选 ID。
- 旧 `web_search_call` 转为带标记的普通助手文字，保留已记录的查询、动作、状态和来源，避免因缺少旧推理或沿用原资源 ID 导致错误；后续结论与引用保留，不重新搜索。
- 保留正文、工具名称、参数、结果、`call_id`、工具定义与业务对象中的普通 ID，防止破坏工具配对。请求模型和供应商前缀保持不变。
- `previous_response_id`、`conversation`、`item_reference`、加密压缩等无法安全跨资源迁移的上下文会被明确拒绝，提示用文字摘要新建会话，不会静默丢弃。
- 规则保存在 Magpie `plugins.json` 中本插件条目的 `options.providers`，管理页直接读写这份配置。其他插件、全局配置与供应商凭据保持原状；修改前保留上一份插件配置备份。旧的 `.runtime/provider-rules.json` 保留供回退使用。
- 可在 Magpie 插件页面停用或卸载本插件。规则开关不会重新启用已在 Magpie 中停用的插件。插件通过本地路径加载，移动或删除安装目录前应先卸载插件，再从新目录重新安装。
- 默认模式自动识别；便携 Magpie 或自定义地址可显式指定：

```powershell
node .\filter.cjs start --backend magpie --magpie-dir "D:\MagpieData" --upstream http://127.0.0.1:3425
```

如配置使用复杂 TOML、profile、启动参数覆盖或其他数据目录，需核对实际请求是否经过对应 Magpie 实例。切换 CC Switch / Magpie 前先停止管理服务，再切换网关并重新启动。

## 手动检测与自动保护的区别

原生插件模式保留手动 ModelTrace 检测和历史记录，**不提供自动检测或切断保护**。管理页相应开关禁用，并明确显示手动模式；旧版保存的保护设置和锁定记录不会拦截直连 Magpie 的请求。Lite 标头兼容也不可用，因为此请求钩子不能改写 HTTP 标头。

Magpie 的中间件在网关内的 JavaScript 引擎运行，请求钩子限时 250 毫秒，没有 Node.js、网络取样或异步等待能力，无法在其中执行需要数分钟的 ModelTrace 取样和完整响应校验。不能把手动检测的结论当作自动保护已经生效。

手动检测仍验证 Magpie 路由响应头和响应模型；密钥、供应商或插件配置变化会使旧检测上下文失效。这些校验只约束检测本身，不代表每个项目请求都会接受检测。

## 兼容边界

原生历史过滤支持明确的 `供应商/模型` 前缀及 Responses HTTP/SSE。它只处理 agent 请求，Magpie 自身的标题、分类器等内部请求不经过该钩子。下列情况暂不提供固定路由的手动检测验证：

- 裸模型名、自动路由组、`codex-auto-review` 等由网关另行推断的替代模型。
- 已配置供应商 `fallback`、除本工具外的其他自定义插件、无法从普通 endpoint 识别的订阅登录或插件供应商。
- WebSocket、Responses 加密压缩，以及参考库未收录的模型。

无法确定模型前缀时不套用某个供应商的历史规则。多个中间件的顺序会影响结果：若其他插件在本插件之后更改模型路由，应由使用者核对顺序和对应规则。

Magpie 对插件加载失败、未捕获异常或超时采用 **fail open**：继续转发原请求。插件对已知不可迁移上下文会显式拒绝，但无法覆盖网关自身的超时或加载失败策略。请在 Magpie 插件页核对加载错误和调用统计；不能承诺所有请求均已被清理。

**已知显示限制：** 管理页的「已启用」只检查插件配置，尚不读取 Magpie 运行时的加载健康；供应商存在 fallback 或其他自定义插件时，管理页可能因无法固定验证路由而显示未过滤，但原生钩子仍按已保存的供应商前缀规则处理。需要完全停用时，请在 Magpie 插件页关闭本插件。该限制不表示其他供应商或会话不能同时使用。

同一供应商的多 Key 调度仍由 Magpie 管理，检测结论只适用于供应商与模型，不保证探针和项目请求使用同一 Key。即使路由头一致，供应商内部仍可能更换模型或伪装模型名；ModelTrace 是统计指纹检查，不是身份认证或代码质量证明。也不会撤销 Codex 已执行的文件修改。

插件接口依据 [Magpie gateway-middleware 文档](https://github.com/yetone/magpie/blob/main/docs/subsystems/gateway-middleware.md) 与 [官方插件文档](https://usemagpie.ai/docs/plugins#middleware)。供应商配置依据 [provider.go](https://github.com/yetone/magpie/blob/main/internal/provider/provider.go)。适配不保证所有未来版本，升级 Magpie 后应复核插件加载状态。
