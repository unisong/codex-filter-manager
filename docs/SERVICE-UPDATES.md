# 服务关闭与版本更新

## 页面操作

- 右上角的电源按钮关闭本工具的服务；先展示影响范围，确认后执行。取消不改变任何设置。
- 「设置与诊断」第一张卡片显示当前版本。「检查更新」仅请求本项目 GitHub Release，不调用模型、上传配置或自动安装。
- 有新版时，「可选更新」列出最近 30 个 Release 中比当前版本新的正式版本，可展开版本说明。选择后再次确认安装；失败原因保留在页面中。
- 下载和安装过程中禁用重复提交与页面关闭服务操作。页面关闭成功后停止状态轮询，显示已关闭提示。

## CC Switch 独立服务

关闭接口为 `POST /__codex_filter__/api/service/stop`。它与 `Stop.bat` 共用服务的关闭流程：先恢复本工具接管的 Codex 地址，再取消检测、停止配置同步、等待现有连接结束，最多等待约 10 秒后关闭剩余连接。配置恢复失败时保留服务并返回错误，不把 Codex 留在失效端口。

它只管理本工具的进程，不关闭 CC Switch、Codex 或其他 Node 进程。停止不会清除历史过滤设置、检测证据或模型锁定。下次可继续通过 `Start.bat` 或桌面快捷方式打开。

Windows 发布包支持原目录更新：

1. 从 `unisong/codex-filter-manager` 的正式 Release 下载对应 Windows ZIP 和 `SHA256SUMS.txt`。
2. 核对发布包大小及 SHA-256，在独立暂存目录检查解压路径、必要文件和版本号。校验失败不停止服务。
3. 隐藏的 PowerShell 辅助进程与启动器互斥，停止旧服务，将待替换文件备份到运行目录的 `updates/<任务ID>/backup/`。
4. 替换程序文件，使用原端口、配置、数据库、上游和运行数据目录参数启动新版。`.runtime/`、`.tools/` 不属于更新覆盖范围。
5. 新版启动失败时尝试停止失败的实例、恢复文件并重启旧版。若配置恢复或旧版重启也失败，页面或运行目录中的 `update-result.json` 会说明需要人工处理；此时检查任务目录中的 `service-error.log`。

这不是断电下的事务式安装。安装期间应保持电脑运行，勿手动移动安装目录。遇到断电或进程被强行结束，可以使用备份恢复程序文件，然后运行 `Start.bat`；保留原运行数据目录。历史备份不会自动删除，确认新版正常后再清理对应更新任务目录。

源码检出中可以检查更新，但安装按钮不可用，避免覆盖未提交代码。正在被完整 Magpie 插件使用的安装目录也不允许原地覆盖。

## Magpie 完整工作台

`POST /api/service/stop` 停止检测排期、取消取样并关闭本地工作台 HTTP 监听。工作台属于 Magpie 宿主，不能通过退出整个进程来关闭它，否则会连带中断其他插件和模型请求。因此 Magpie 网关、历史过滤钩子及已发布的暂停规则保留。

关闭后从 Magpie 的工作台入口再次打开，或重新加载插件；仅运行 `Open.bat` 需要工作台已经启动。定期检测已明确停止，不会在重新打开后自动恢复，需在目标卡片点击恢复。

Magpie 的更新按钮负责下载、校验并解压完整新版，页面显示新版的 `magpie-workbench` 目录。请在 Magpie 中把本地插件切换到该目录，再重新加载插件；避免同时加载两份完整工作台。该步骤由 Magpie 管理，当前不尝试篡改宿主配置或自动重启宿主。

检测设置与记录位于原来的 Magpie 工作台数据目录，供应商规则仍由 Magpie 管理。不要复制旧的 `workbench.middleware.js` 到新版：它含有运行时生成的内容，新工作台会按已有状态生成自己的钩子。

社区纯过滤插件由 Magpie 社区市场维护，不包含本页功能。

## 模块与验证

| 模块 | 职责 |
| --- | --- |
| `src/filter.cjs`、`src/guard.cjs` | 独立服务的配置恢复、关闭和取样取消 |
| `src/management.cjs`、`src/proxy.cjs` | 同源且有管理令牌的服务控制与更新 API |
| `src/updater.cjs` | 正式 Release 选择、限定来源下载、校验、状态与辅助进程计划 |
| `scripts/windows/install-update.ps1` | 校验解压、备份替换、启动与失败恢复 |
| `web/assets/service-controls.js`、`workbench-theme.css` | 两套页面共用的关闭、版本选择、更新反馈与样式 |
| `magpie-workbench/server/http.mjs`、`plugin/index.mjs` | Magpie 工作台的会话认证、局部关闭与再次打开 |

Magpie 包中的更新器、辅助脚本和页面控件保持自包含副本，并由 `release:check` 校验一致。新增文件放在现有 `src/`、`scripts/`、`tests/` 和插件对应子目录，根目录入口不变。

离线验证：`npm test`、`node --test magpie-workbench/test/*.test.mjs`、`python tests/update-install-check.py` 和 `python tests/service-controls-check.py`。安装检查只操作临时目录，覆盖成功安装、失败恢复、路径穿越、校验失败及 Magpie 不覆盖现有插件。浏览器检查覆盖两套页面的确认取消、检查状态、版本说明文本安全、窄屏、明暗主题及关闭后的宿主存活。
