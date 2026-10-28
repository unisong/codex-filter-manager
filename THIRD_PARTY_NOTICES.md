# 第三方来源与许可

Codex Filter Manager 自有代码采用 [MIT License](LICENSE)。这不改变随附第三方文件的署名与许可要求。

## ModelTrace：已集成

- 项目：<https://github.com/xqy2006/ModelTrace>
- 固定提交：[`6cd4a8ff0f3f4e49d6d6969dd2fbadfa1569fde2`](https://github.com/xqy2006/ModelTrace/tree/6cd4a8ff0f3f4e49d6d6969dd2fbadfa1569fde2)
- 版权：Copyright (c) 2026 xqy2006
- 许可证：[MIT，完整原文](vendor/modeltrace/LICENSE)

| 本仓库文件 | 上游文件 |
| --- | --- |
| `vendor/modeltrace/fingerprint-core.mjs` | `static/fingerprint-core.js` |
| `vendor/modeltrace/challenge-browser.mjs` | `static/challenge-browser.js` |
| `vendor/modeltrace/unified_bank.json` | `data/unified_bank.json` |

评分核心、网页出题器和参考库按原内容随附；扩展名调整用于 Node.js ES Module 加载。下载来源、固定提交与 SHA-256 记录在 [`vendor/modeltrace/provenance.json`](vendor/modeltrace/provenance.json)，运行时会验证这三个文件的校验值。本项目围绕评分器实现本机代理、供应商设置、探针调度、响应拦截与界面，没有将 ModelTrace 相对权重包装成真实身份概率。

这是**本地代码与数据集成**，不是调用 ModelTrace 提供的托管 API。探针通过用户自己的 CC Switch 或 Magpie 网关访问其供应商。

## Responses 历史回放补丁：兼容场景与回归测试参考

- 项目：<https://github.com/yunhanhai/agentrouter-responses-shim-sentry-fix>
- 审阅提交：[`cf33739`](https://github.com/yunhanhai/agentrouter-responses-shim-sentry-fix/tree/cf33739)
- 版权：Copyright (c) 2026 stevenarai
- 许可证：[MIT，完整原文](vendor/responses-shim-sentry-fix/LICENSE)

该上游补丁针对池化上游资源在旧历史中携带资源绑定 `encrypted_content`、又因嵌套删除未重新序列化而继续报错的问题。本项目采用其兼容场景、copy-on-write 思路和回归测试；没有随附或加载上游 shim、npm 补丁或代理进程。下载来源、提交和集成范围记录在 [`vendor/responses-shim-sentry-fix/provenance.json`](vendor/responses-shim-sentry-fix/provenance.json)。上游仓库地址只作为来源与许可署名保留。

## meow-llm-detector：仅调研，未集成

- 项目：<https://github.com/chen-006/meow-llm-detector>
- 评估时提交：[`dc608d5c097abf96575d5b34f49952ddbd27c281`](https://github.com/chen-006/meow-llm-detector/tree/dc608d5c097abf96575d5b34f49952ddbd27c281)
- 项目许可：PolyForm Noncommercial

仅对其方法、样本规模及适用场景作比较。本项目不包含该项目代码、训练/参考数据或远程接口，因此不将其作为 MIT 组件重新发行。链接和方法介绍不意味着原作者认可本项目。

## Node.js：首次启动按需下载

- 项目：<https://nodejs.org/> · <https://github.com/nodejs/node>
- Node.js 主许可证：MIT；二进制发行包含另外的第三方许可证与版权声明。

Windows 启动器按需从 Node.js 官方发行源下载便携运行时到 `.tools/` 并验证固定 SHA-256。本项目源码与应用 ZIP 不嵌入 Node.js 二进制；下载后提取 `node.exe` 与随附的完整 `LICENSE`，不安装 npm。使用或再分发该运行时时，应同时遵守其完整许可证。

## 外部配套与品牌

[CC Switch](https://github.com/farion1231/cc-switch) 由用户另外安装，不随本项目打包；CC Switch 数据库只读。Codex、OpenAI、GitHub 等名称和图标用于识别兼容对象或链接目标，不表示合作、赞助或官方背书。
