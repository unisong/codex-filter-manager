# 仓库维护规则

以下规则适用于本仓库的所有改动。

## 目录

- 根目录只保留用户入口（`Start.bat`、`Stop.bat`、`Status.bat`、`Diagnose.bat`、`filter.cjs`）、项目配置和顶层文档。新增根目录文件前，先更新 `scripts/release-check.cjs` 中的根目录白名单并说明原因。
- 自动测试、浏览器检查和测试数据放在 `tests/`；完整 Magpie 插件的测试放在 `magpie-workbench/test/`。
- 启动、打包、截图、手动连通性检查等脚本放在 `scripts/`；Magpie 插件随包工具放在 `magpie-workbench/tools/`。
- CC Switch 服务代码放在 `src/`，其页面与静态资源放在 `web/`；完整 Magpie 插件必须在 `magpie-workbench/` 内自包含，不能在运行时引用该目录之外的文件。
- 文档放在 `docs/`，截图放在 `docs/images/`。只保留被文档或截图脚本引用的图片。

## 共享副本

Magpie 从插件目录单独加载，所以少量文件有意保留为副本。修改任一方时同步另一方，`release-check` 会校验它们一致：

- `web/assets/` 中的 `workbench-theme.css`、`current-selection.js`、`service-controls.js`、`favicon.svg` 与 `magpie-workbench/web/` 中的对应文件
- `src/updater.cjs` 与 `magpie-workbench/server/updater.cjs`，`scripts/windows/install-update.ps1` 与 `magpie-workbench/tools/install-update.ps1`
- `src/guard-evidence.cjs` 与 `magpie-workbench/server/evidence.cjs`
- `src/portable-web-search.mjs` 与 `magpie-workbench/history/portable-web-search.mjs`
- `vendor/modeltrace/` 与 `magpie-workbench/vendor/modeltrace/`，`LICENSE` 与 `magpie-workbench/LICENSE`

`magpie-workbench/history/codex-history.middleware.js` 是经过审阅的历史钩子基线，SHA-256 固定在 `history/PROVENANCE.json`，不要直接修改。

## 生成文件与隐私

- `magpie-workbench/workbench.middleware.js` 只能用 `node magpie-workbench/tools/build-middleware.mjs` 从源码生成。正在被 Magpie 引用的副本会写入本机暂停规则和探针凭据，提交前必须重新构建。
- 发布包只能用 `python scripts/package-release.py` 生成。它只读取已提交的 HEAD，按 `.gitattributes` 转换换行，不读取工作区文件；暂存区有未提交改动时拒绝打包。
- 不提交 `.runtime/`、`.tools/`、`dist/`、Magpie 或 Codex 配置、API Key、会话文件、真实日志和真实供应商信息。截图和测试只使用虚构数据。
- 公开内容不得出现真实供应商、中转站或网关账号的名称、ID 与域名。范围包括源码与注释、测试、文档、截图、提交说明、标签说明、Release 标题与正文。兼容功能按协议或模型族描述（例如“针对 DeepSeek 的协议转码兼容”），测试使用 `demo`、`relay-a.example` 等虚构数据。第三方署名可在 README 致谢、`THIRD_PARTY_NOTICES.md` 与 `vendor/*/` 来源记录中保留上游仓库地址；只用于注明来源，不把其仓库名用作供应商示例。
- 不在代码里为某个供应商 ID 写默认规则或特殊分支；发布版本不预置规则，所有过滤、兼容与保护开关默认关闭。
- 维护者可在本机 `.runtime/private-terms.txt` 逐行记录需要避开的名称（该文件不提交）。`npm run release:check` 会用它扫描暂存文件；提交说明和 Release 正文先写入 `.runtime/` 下的临时文件，再用 `npm run release:check -- --text <文件>` 检查。

## 验证

提交前运行：

```powershell
npm test
node magpie-workbench/tools/build-middleware.mjs
node --test magpie-workbench/test/*.test.mjs
powershell -File tests/launcher/launcher-check.ps1
npm run release:check
```

修改页面时，再运行 `CONTRIBUTING.md` 中列出的浏览器检查。默认测试不得请求真实模型；`scripts/live-*.cjs` 只能由维护者手动运行。

修改更新器时运行 `python tests/update-install-check.py`，验证成功安装、失败恢复、校验与路径限制。更新器不得覆盖 `.runtime/`、`.tools/`、Git 源码检出或正在被 Magpie 加载的插件；下载来源固定为本仓库正式 Release。
