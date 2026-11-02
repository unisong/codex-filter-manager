# Magpie 本地工作台

这是 [Codex Filter Manager](https://github.com/unisong/codex-filter-manager) 的全功能 Magpie 工作台源码，随主仓库维护，不再从社区纯过滤仓库发版。源码版本跟随主仓库版本；已安装副本可以暂时保留原版本，源码整理不会自动升级它。

提供原生历史过滤设置页，以及在本机浏览器使用的模型指纹检测、定期观测、异常暂停、记录和诊断。使用 Magpie 的 server 插件、gateway middleware 与插件页面能力，不限定 Magpie 版本号。运行使用 Magpie 自带 Bun，不要求另装 Node.js。

## 安装与使用

推荐使用图形界面安装：

已安装社区纯过滤插件或另一份工作台时，先备份原 Options 并停用旧插件，再加载新目录，只启用一份。

1. 下载并完整解压主仓库的发布包，放在准备长期使用的可写目录。
2. 打开 Magpie **插件 → 发现**，点击右下角、安装按钮左侧的**文件夹图标「从本地加载」**。
3. 选择解压目录里的 **`magpie-workbench` 文件夹**并确认。这里是插件目录，里面有 `package.json`、`Open.bat`、`plugin/`、`web/`；不要选项目根目录或单独的脚本文件。
4. 在 **插件 → 已安装** 中确认工作台已启用且无加载错误。打开 Magpie 导航中的 **Codex Workbench · 历史过滤**，设置供应商开关后点击 **保存更改**。

如果习惯命令行，可以在 **PowerShell 或终端**执行下列命令，把双引号内的路径换成实际插件目录：

```powershell
magpie plugin add "D:\Tools\CodexFilter\magpie-workbench"
```

不要把整条命令粘进 Magpie 的插件输入框；它不是终端。路径有空格也要保留双引号。如果终端找不到 `magpie` 命令，直接用「从本地加载」，无需先配置命令行环境。

新安装不预置供应商规则，也不自动添加检测目标。不修改 Codex 的 `base_url`，不要移动正在被 Magpie 引用的目录。

只需要过滤时，在 Magpie 的 **Codex Workbench · 历史过滤** 页面设置，在插件页检查启用状态、调用和错误；无需登录或打开本机工作台。需要模型监测时，Windows 双击本目录的 `Open.bat`，其他系统使用 Magpie 的本机控制台入口。该入口仅打开已加载插件的本机页面，不负责安装插件，也不提供推理模型；主仓库根目录的 `Start.bat` 只用于 CC Switch。

**DeepSeek Schema** 是针对 DeepSeek 的协议转码兼容。实际上游为 DeepSeek、且拒绝 `automation_update` 的工具 Schema 根联合类型时，仅为该供应商开启。该选项独立于历史过滤，所有供应商默认关闭，并覆盖续聊历史中的 `tool_search_output` 与 `additional_tools`。

工作台的 **设置与诊断 → 版本更新** 支持填写自定义更新下载与暂存目录。目录必须是可写的绝对路径；恢复默认只影响后续更新，不会删除已经下载、准备或备份的文件。

## 维护与边界

完整功能与 UI 的开发、Issue 和 Release 都进入主仓库。社区包 `@magpie-community/middleware-codex-history` 不包含本目录。两者的版本号独立，只有过滤修复需要同步。

```sh
node tools/build-middleware.mjs
node --test test/*.test.mjs
python test/web-check.py
```

构建必须从源码生成公开 `workbench.middleware.js`；不能从正在使用的安装目录复制该文件，它可能包含本机暂停规则和私密探针凭据。修改中间件源码后应从 Magpie 插件页重新安装或重新加载该目录；GitHub 发布包应解压到新目录，不能在运行中的目录内原地覆盖。详细取样、暂停、数据与诊断说明见 [USAGE.md](docs/USAGE.md)。

本地工作台仍使用本机服务和当前宿主的有限接口，不等同于社区认可的原生模型监测方案。检测可能计费，统计指纹可能误报；暂停仅影响后续请求，Magpie 加载失败或超时可能放行。工作台数据保留在 `~/.config/magpie-model-workbench/`，不要提交此目录或 Magpie 配置。
