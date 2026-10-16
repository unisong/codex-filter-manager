# 参与开发

欢迎提交可复现的兼容性问题、文档改进与修复。请先阅读 [README](README.md)、[模型保护边界](MODEL-GUARD.md) 和 [安全说明](SECURITY.md)。

## 环境与启动

开发需要 Node.js 24+，核心运行时没有第三方 npm 依赖。Windows 启动器面向 Windows 10 / 11 的 x64 / ARM64，PowerShell 脚本应兼容系统自带的 Windows PowerShell 5.1。

CC Switch 模式启动会接管当前用户的 Codex 配置；Magpie 模式安装本地中间件并保持 Codex 配置只读。开发与验证应使用独立临时目录、模拟 CC Switch 数据库和 Magpie 配置文件；不要让测试操作正式会话、数据库、供应商余额或真实项目。

## 目录与职责

| 文件 | 用途 |
| --- | --- |
| `filter.cjs` | 后台生命周期、启动/停止、配置接入 |
| `config.cjs` | CC Switch 发现、只读策略、精确地址恢复 |
| `magpie.cjs` | Magpie 只读供应商发现、请求路由与隔离规则 |
| `magpie-plugin-store.cjs` | 维护 Magpie 中本工具的插件条目与管理页规则 |
| `magpie-plugin/` | 原生请求钩子及与独立代理共用的历史清理算法 |
| `proxy.cjs` | HTTP/SSE 转发、历史清理、429 重试 |
| `management.cjs` | 本机管理 API、规则与页面 |
| `dashboard.html` | 不依赖前端构建的可视化页面 |
| `guard.cjs` | 指纹检查、通过缓存、锁定和检测历史 |
| `guard-evidence.cjs` | 逐样本与汇总评分、数字证据结构校验 |
| `guard-retry.cjs` | 整次检测共享重试预算与可取消退避 |
| `guard-service.cjs` | 路由上下文、请求授权与引擎衔接 |
| `guard-transport.cjs` | 探针请求、完整响应验证与缓存预算 |
| `vendor/modeltrace/` | 固定版本的第三方出题器、评分器、参考库与许可 |
| `start.ps1`、`Start.bat` 等 | Windows 一键启动、停止和状态入口 |

## 本地验证

```powershell
npm test
```

默认测试只访问临时配置/数据库和本机 mock HTTP 服务，不请求真实模型。若直接运行 Node 测试，可显式指定工作区之外的临时目录：

```powershell
$env:PI_SCRATCH_DIR = Join-Path $env:TEMP 'codex-filter-tests'
New-Item -ItemType Directory -Force $env:PI_SCRATCH_DIR | Out-Null
node --test *.test.cjs
```

浏览器测试是可选的开发工具，需另行准备 Python 和 Playwright。运行 `python -m playwright install chromium` 安装测试浏览器；也可通过环境变量 `CHROME_PATH` 指向本机 Chrome 可执行文件。测试默认使用 Playwright 管理的 Chromium。

```powershell
python -m pip install playwright
python .\dashboard-check.py
python .\guard-dashboard-check.py
python .\magpie-dashboard-check.py
```

这些脚本使用模拟供应商数据，不应连接正式页面或读取真实凭据。`live-check.cjs` 与 `live-guard-check.cjs` 属于**明确手动执行的真实供应商检查**，可能调用模型并计费，不应放入 CI 或默认测试链。

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
