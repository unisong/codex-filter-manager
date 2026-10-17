# Codex Filter Manager · Codex 过滤管理

为 **Codex + CC Switch / Magpie** 提供按供应商设置的历史兼容过滤，缓解切换中转站后旧会话的密文验证、跨资源历史 ID 等错误；另提供可选的 ModelTrace 模型指纹检测。

**Windows 10 / 11 · 无需管理员权限 · 无需手动安装 Node.js · MIT**

当前版本：**v1.0.7 / 服务 v33**。[下载最新版本](https://github.com/unisong/codex-filter-manager/releases/latest) · [更新说明](docs/RELEASE-v1.0.7.md) · [反馈问题](https://github.com/unisong/codex-filter-manager/issues)

## 选择使用方式

| 使用环境 | 建议入口 | 模型检测与保护 |
| --- | --- | --- |
| CC Switch | 本仓库的一键启动服务 | 手动检测、请求前检测、异常锁定及响应验证 |
| Magpie，希望在其内管理插件 | [Magpie Codex 工作台](https://github.com/unisong/magpie-codex-history-filter) | 合并插件提供可选手动检测、定期观测与异常暂停 |
| Magpie，继续使用本仓库管理页 | 本服务附带的历史过滤钩子 | 手动检测与记录；不支持自动切断或 Lite 标头修改 |

两种 Magpie 安装方式请选择一种，避免同时启用重复过滤。**本仓库的附带钩子与 Magpie 合并插件功能不同**，配置方法见 [Magpie 适配说明](docs/MAGPIE.md)。

## 点击即用

先让 Codex 能通过 CC Switch 或 Magpie 正常调用模型。CC Switch 需开启「本地代理」与「Codex 接管」。

1. 下载 [Release ZIP](https://github.com/unisong/codex-filter-manager/releases/latest)，完整解压到当前用户可写、准备长期使用的目录。
2. 双击 **`Start.bat`**。启动器会查找兼容的 Node.js，必要时从官方源下载便携版并校验；无需 `npm install`。
3. 浏览器自动打开 [本机管理页](http://127.0.0.1:18181/__codex_filter__/ui)，并创建桌面「Codex 过滤管理」快捷方式。
4. CC Switch 首次接入后，完全退出并重新打开 Codex。Magpie 模式保持原网关地址不变。
5. 在「历史过滤」为需要兼容的供应商打开开关。**新安装没有预置供应商规则，过滤和模型保护均默认关闭。**

```text
CC Switch：Codex → 过滤服务 :18181 → CC Switch → 供应商
Magpie：   Codex → Magpie :3425（历史过滤钩子）→ 请求指定的供应商
```

供应商切换仍在原网关操作；Magpie 不同会话按各自的 `供应商/模型` 前缀独立过滤。

| 日常操作 | 入口 |
| --- | --- |
| 启动并打开页面 | `Start.bat` 或桌面快捷方式；电脑重启后也用此入口 |
| 查看状态 / 导出诊断 | `Status.bat` / `Diagnose.bat` |
| 停止服务 | `Stop.bat`；CC Switch 随后重启 Codex；Magpie 钩子需在其插件页单独停用 |
| 更新 | 停止旧服务，备份 `.runtime/`，覆盖公开文件后启动；保留自己的运行数据 |
| 搬迁或卸载 | 先停止；CC Switch 确认地址恢复，Magpie 移除本地插件后再移动或删除目录 |

关闭浏览器不会停止服务。本工具不注册开机自启动。

## 界面预览

截图使用虚构供应商与演示记录。页面右上角单个月亮 / 太阳图标切换明暗主题；四个分区为历史过滤、模型监测、检测记录、设置与诊断。

![历史过滤与供应商设置](docs/images/providers.png)

<details>
<summary>查看模型监测、检测记录与深色主题</summary>

![模型监测](docs/images/protection.png)
![同页调整监测](docs/images/monitor-settings.png)
![检测记录](docs/images/history.png)
![设置与诊断](docs/images/settings.png)
![深色主题](docs/images/protection-dark.png)

</details>

## 如何选择开关

兼容选项按供应商保存，与模型保护独立；三个兼容开关本身不会发起模型检测。

v1.0.7 修复历史 `web_search_call` 缺少关联 `reasoning` 的错误：开启历史过滤后，将旧搜索调用转为文字记录，保留已记录的查询与后续结论，避免重放依赖原资源的搜索条目。适用于普通对话和携带完整明文历史的压缩总结请求。[错误说明](docs/TROUBLESHOOTING.md#web_search_call-缺少-reasoning)

| 兼容开关 | 作用 | 推荐 |
| --- | --- | --- |
| 过滤历史加密内容 | 清理旧 reasoning、明确密文块和可移植历史的服务器 ID，保留正文与工具配对 | 旧会话出现密文或跨资源 ID 错误时开启 |
| 保留新响应的加密内容请求 | 保留客户端原有的 `reasoning.encrypted_content` 请求，不会恢复已清理的旧密文 | 开启历史过滤时通常保持勾选 |
| Lite 协议兼容 | 移除 Responses/Lite 扩展标头，不修改模型或推理强度；仅适用于 CC Switch | 仅遇到对应协议错误时开启 |

### 推荐组合

供应商使用正常时保持默认关闭；处理旧会话兼容问题时，先用 **「前两项勾选、第三项关闭」**。上游明确拒绝新响应的加密内容请求时，再尝试取消第二项。[三个按钮的完整原理、边界与设置截图](docs/COMPATIBILITY.md)

**模型保护建议先手动检测，再按需开启。** 自动保护检查每条实际请求的模型与推理强度；默认通过缓存有效 10 分钟，到期后的下一次请求重新检测，空闲时不主动取样。页面优先显示最近实际请求，其次显示检测记录，无记录时在本页手动选择。

检测采用 [ModelTrace](https://github.com/xqy2006/ModelTrace) 的出题器、评分器和参考库，通过自己的供应商取样，在本机评分。通常一轮 3 个请求，强差异时追加复核，**可能计费并增加等待时间**。保护开启时，未能验证的请求也会被拦截；红色模型差异与黄色网络/样本错误分别显示。[评分、重试、锁定与费用说明](MODEL-GUARD.md)

## 使用边界与隐私

- 过滤不解密密文、不改写会话文件；会丢弃部分内部推理状态。无法恢复的服务器引用、加密压缩历史及过滤中的 `/responses/compact` 会明确拒绝，需整理明文摘要后新开会话。
- 独立代理仅支持 Responses HTTP/SSE，不支持 WebSocket。CC Switch 的复杂配置、自动故障转移或其他接入路径可能影响识别和保护。
- 模型指纹可能误报或漏报，不是身份认证或能力保证。CC Switch 开启保护后先缓存完整响应再交付，失去逐 token 显示；不能撤回工具操作或回滚文件。
- Magpie 钩子加载失败、异常或超时时，宿主可能放行原请求；请在 Magpie 插件页核对运行状态。
- 管理端口仅供本机使用，不要映射到公网。CC Switch 模式接管并恢复 Codex 的目标地址；Magpie 模式不改写该地址。供应商配置只读，无自动遥测上传。
- 不要公开 `.runtime/`、Magpie 配置、Key 或会话文件；只分享检查过的脱敏报告。[安全与数据说明](SECURITY.md)

## 诊断与反馈

在「设置与诊断」检查状态、复现问题后重新检查并导出 JSON；页面打不开时双击 **`Diagnose.bat`**。将检查过的报告、版本、发生时间和操作步骤附到 [Issue](https://github.com/unisong/codex-filter-manager/issues/new?template=bug_report.yml)。诊断不调用模型、不自动上传。

Magpie 请求不经过本管理端口，计数为零不能单独认定过滤失效，应查看 Magpie 插件页。[常见错误与恢复步骤](docs/TROUBLESHOOTING.md)

## 开发与命令行

源码运行需要 Node.js 24+，无需安装运行依赖：

```powershell
node filter.cjs start   # stop / status / diagnose
npm test               # 临时配置与本机模拟上游，不调用真实模型
```

服务代码在 `src/`，页面在 `web/`，测试在 `tests/`，开发工具在 `scripts/`；默认运行数据仍在安装目录的 `.runtime/`。[目录职责、自定义路径与开发验证](CONTRIBUTING.md)

## 许可与致谢

本项目采用 [MIT](LICENSE)。感谢 [ModelTrace](https://github.com/xqy2006/ModelTrace) 提供模型行为指纹算法、中文出题器与参考库，原许可和固定来源见 [第三方说明](THIRD_PARTY_NOTICES.md)。感谢配套项目 [CC Switch](https://github.com/farion1231/cc-switch) 与 [Magpie](https://github.com/yetone/magpie)；本工具为独立社区项目。

友情链接：[LINUX DO](https://linux.do/)
