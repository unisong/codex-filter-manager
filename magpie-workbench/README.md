# Magpie 本地工作台

这是 [Codex Filter Manager](https://github.com/unisong/codex-filter-manager) 的全功能 Magpie 工作台源码，随主仓库维护，不再从社区纯过滤仓库发版。源码版本跟随主仓库版本；已安装副本可以暂时保留原版本，源码整理不会自动升级它。

提供原生历史过滤设置页，以及在本机浏览器使用的模型指纹检测、定期观测、异常暂停、记录和诊断。需要支持 server 插件、gateway middleware 与插件页面的 Magpie，已在 0.1.1265 验证。运行使用 Magpie 自带 Bun，不要求另装 Node.js。

## 安装与使用

将主仓库解压到准备长期使用的目录。在 Magpie 中添加本目录，或执行：

```sh
magpie plugin add /path/to/codex-filter-manager/magpie-workbench
```

先备份原 Options，再停用原历史过滤或工作台插件；只启用一份。新安装不预置供应商规则，也不自动添加检测目标。不修改 Codex 的 `base_url`，不要移动正在被 Magpie 引用的目录。

只需要过滤时，在 Magpie 的 **Codex Workbench · 历史过滤** 页面设置，在插件页检查启用状态、调用和错误；无需登录或打开本机工作台。需要模型监测时，Windows 双击 `Open.bat`，其他系统使用 Magpie 的本机控制台入口。该入口仅打开本机页面，不提供推理模型。

工作台的 **设置与诊断 → 版本更新** 支持填写自定义更新下载与暂存目录。目录必须是可写的绝对路径；恢复默认只影响后续更新，不会删除已经下载、准备或备份的文件。

## 维护与边界

完整功能与 UI 的开发、Issue 和 Release 都进入主仓库。社区包 `@magpie-community/middleware-codex-history` 不包含本目录。两者的版本号独立，只有过滤修复需要同步。

```sh
node tools/build-middleware.mjs
node --test test/*.test.mjs
python test/web-check.py
```

构建必须从源码生成公开 `workbench.middleware.js`；不能从正在使用的安装目录复制该文件，它可能包含本机暂停规则和私密探针凭据。详细取样、暂停、数据与诊断说明见 [USAGE.md](docs/USAGE.md)。

本地工作台仍使用本机服务和当前宿主的有限接口，不等同于社区认可的原生模型监测方案。检测可能计费，统计指纹可能误报；暂停仅影响后续请求，Magpie 加载失败或超时可能放行。工作台数据保留在 `~/.config/magpie-model-workbench/`，不要提交此目录或 Magpie 配置。
