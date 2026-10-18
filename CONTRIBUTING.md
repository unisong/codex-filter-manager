# 参与开发

欢迎提交可复现的兼容性问题、文档改进与修复。请先阅读 [README](README.md)、[模型保护边界](docs/MODEL-GUARD.md) 和 [安全说明](SECURITY.md)。

## 环境与启动

开发需要 Node.js 24+，核心运行时没有第三方 npm 依赖。Windows 启动器面向 Windows 10 / 11 的 x64 / ARM64，PowerShell 脚本应兼容系统自带的 Windows PowerShell 5.1。

CC Switch 服务启动会接管当前用户的 Codex 配置；Magpie 使用独立加载的完整工作台插件，不修改 Codex 地址。根目录服务不再支持旧 Magpie 模式。开发与验证应使用独立临时目录、模拟 CC Switch 数据库和 Magpie 配置文件；不要让测试操作正式会话、数据库、供应商余额或真实项目。

## 目录与职责

| 文件 | 用途 |
| --- | --- |
| `filter.cjs` | 兼容现有命令和启动器的轻量入口，调用 `src/filter.cjs` |
| `src/filter.cjs` | 后台生命周期、启动/停止、配置接入 |
| `src/config.cjs` | CC Switch 发现、只读策略、精确地址恢复 |
| `src/policy-read.cjs` | 规则读取错误分类、可取消的短暂重试、失败时明确拒绝，禁止复用其他供应商规则 |
| `src/service-backend.cjs` | 识别 Magpie 配置并提示使用完整工作台，避免误启动独立服务 |
| `src/history-filter.mjs`、`src/portable-web-search.mjs` | CC Switch 代理的历史清理与搜索文字转换 |
| `magpie-workbench/` | 完整 Magpie 本地工作台源码、原生设置页、本机后台和独立离线测试 |
| `src/proxy.cjs` | HTTP/SSE 转发、历史清理、429 重试 |
| `src/management.cjs` | 本机管理 API、规则与页面 |
| `src/updater.cjs`、`scripts/windows/install-update.ps1` | 正式版检查、校验下载、Windows 安装与失败恢复；Magpie 包内保持自包含副本 |
| `web/assets/service-controls.js` | 两套工作台共用的关闭服务与更新交互 |
| `src/diagnostics.cjs` | 字段白名单日志、运行中轮转、脱敏诊断报告 |
| `web/dashboard.html`、`web/assets/` | 不依赖前端构建的可视化页面、共享样式与图标 |
| `src/guard.cjs` | 指纹检查、通过缓存、锁定和检测历史 |
| `src/guard-evidence.cjs` | 逐样本与汇总评分、数字证据结构校验 |
| `src/guard-retry.cjs` | 整次检测共享重试预算与可取消退避 |
| `src/guard-service.cjs` | 路由上下文、请求授权与引擎衔接 |
| `src/guard-transport.cjs` | 探针请求、完整响应验证与缓存预算 |
| `tests/` | Node 自动测试与 Python 离线浏览器检查 |
| `scripts/` | 启动实现、打包、截图与手动连通性检查 |
| `tests/fixtures/` | 测试使用的证据、样例与固定数据 |
| `vendor/modeltrace/` | 固定版本的第三方出题器、评分器、参考库与许可 |
| `Start.bat` 等 | Windows 一键启动、停止和状态入口；实现位于 `scripts/windows/` |

根目录与 `magpie-workbench/` 顶层只允许白名单内的条目，测试文件只能位于 `tests/` 或 `magpie-workbench/test/`，`npm run release:check` 会拒绝其他位置。完整 Magpie 插件需要自包含加载，少量共享文件保留副本并由该检查校验一致；具体清单和规则见 [AGENTS.md](AGENTS.md)。

## 命令行与自定义路径

在项目目录执行，`stop`、`status`、`diagnose` 使用与 `start` 相同的路径参数：

```powershell
node filter.cjs start
node filter.cjs status
node filter.cjs stop
node filter.cjs diagnose
```

默认配置为 `%CODEX_HOME%\config.toml`；未设置 `CODEX_HOME` 时使用 `%USERPROFILE%\.codex\config.toml`。默认运行数据为安装目录的 `.runtime/`。CC Switch 数据库默认在 `%USERPROFILE%\.cc-switch\cc-switch.db`，代理端口从数据库读取。

仅在确有自定义配置、端口或数据目录时覆盖：

```powershell
node filter.cjs start --backend ccswitch --port 18181 --upstream http://127.0.0.1:15721 --config "D:\Codex\config.toml" --runtime "D:\FilterData" --cc-db "D:\CCSwitch\cc-switch.db"
```

Magpie 请按 [完整工作台说明](magpie-workbench/README.md)加载 `magpie-workbench/`，使用该目录的启动和诊断入口；不再使用根目录的 `--backend magpie` 或 `--magpie-dir`。

Windows 启动器对应 `-Backend`（仅 auto / ccswitch）、`-Port`、`-Upstream`、`-Config`、`-Runtime` 和 `-CcDb`，例如：

```powershell
powershell -File .\scripts\windows\start.ps1 -Action Diagnose -Runtime "D:\FilterData" -Config "D:\Codex\config.toml"
```

诊断不会启动服务或改写配置；需要已安装 Node.js 24+ 或启动器缓存的便携运行时。报告写入所选运行目录的 `reports/`。启动器的 `ExecutionPolicy Bypass` 仅作用于当前进程，不修改系统执行策略。

## 本地验证

版本与社区同步规则见 [维护关系](docs/MAINTENANCE.md)。修改完整工作台时还需执行 `node --test magpie-workbench/test/*.test.mjs`；重建公开钩子只在源码目录运行，不能覆盖已安装工作台中的运行中生成文件。

```powershell
npm test
```

默认测试只访问临时配置/数据库和本机 mock HTTP 服务，不请求真实模型。若直接运行 Node 测试，可显式指定工作区之外的临时目录：

```powershell
$env:PI_SCRATCH_DIR = Join-Path $env:TEMP 'codex-filter-tests'
New-Item -ItemType Directory -Force $env:PI_SCRATCH_DIR | Out-Null
node --test tests/*.test.cjs
```

浏览器测试是可选的开发工具，需另行准备 Python 和 Playwright。运行 `python -m playwright install chromium` 安装测试浏览器；也可通过环境变量 `CHROME_PATH` 指向本机 Chrome 可执行文件。测试默认使用 Playwright 管理的 Chromium。

```powershell
python -m pip install playwright
python .\tests\dashboard-check.py
python .\tests\guard-dashboard-check.py
python .\magpie-workbench\test\web-check.py
python .\magpie-workbench\test\filter-ui-check.py
python .\magpie-workbench\test\interval-ui-check.py
python .\magpie-workbench\test\schedule-ui-check.py
python .\tests\service-controls-check.py
python .\tests\update-install-check.py
```

这些脚本使用模拟供应商数据，不应连接正式页面或读取真实凭据。`scripts/live-check.cjs` 与 `scripts/live-guard-check.cjs` 属于**明确手动执行的真实供应商检查**，可能调用模型并计费，不应放入 CI 或默认测试链。

## 修改要求

- 不写入 CC Switch 数据库，不收集或输出 API Key，不把请求正文或项目内容写入日志。
- 不将 `.runtime/`、`.tools/`、个人配置、真实供应商信息、凭据、备份或会话提交到仓库。
- 历史过滤应保留工具配对及可读内容；不能通过静默丢弃不可迁移上下文来掩盖错误。
- 模型保护不能把超时/模糊结果表述为确认降智，不能将相对权重显示为置信度。
- 修改转发、锁定、持久化或恢复行为时，为实际故障场景补充回归验证；纯样式修改应验证桌面和窄屏布局。
- 更新第三方参考库时，记录固定提交、许可证与 SHA-256，并同步修改运行时校验值；不要通过取消完整性校验完成升级。
- 截图和文档案例使用虚构数据，保持文档与实际启动器接口一致。

Pull Request 请说明具体问题、修改后的行为、验证方式和仍存在的限制。不要把真实私有日志作为重现材料。

## 许可

提交自己的贡献表示你同意按本仓库的 [MIT License](LICENSE) 授权该贡献。第三方代码必须保留原署名与许可，并在 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) 中记录来源。
