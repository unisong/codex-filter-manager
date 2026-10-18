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

- `web/assets/` 中的 `workbench-theme.css`、`current-selection.js`、`favicon.svg` 与 `magpie-workbench/web/` 中的对应文件
- `src/guard-evidence.cjs` 与 `magpie-workbench/server/evidence.cjs`
- `src/portable-web-search.mjs` 与 `magpie-workbench/history/portable-web-search.mjs`
- `vendor/modeltrace/` 与 `magpie-workbench/vendor/modeltrace/`，`LICENSE` 与 `magpie-workbench/LICENSE`

`magpie-workbench/history/codex-history.middleware.js` 是经过审阅的历史钩子基线，SHA-256 固定在 `history/PROVENANCE.json`，不要直接修改。

## 生成文件与隐私

- `magpie-workbench/workbench.middleware.js` 只能用 `node magpie-workbench/tools/build-middleware.mjs` 从源码生成。正在被 Magpie 引用的副本会写入本机暂停规则和探针凭据，提交前必须重新构建。
- 不提交 `.runtime/`、`.tools/`、`dist/`、Magpie 或 Codex 配置、API Key、会话文件、真实日志和真实供应商信息。截图和测试只使用虚构数据。

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
