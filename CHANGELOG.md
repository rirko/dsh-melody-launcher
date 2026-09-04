# 更新日志

本文件记录 DSH 旋律启动器（dsh-melody-launcher）的版本变更。格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本语义遵循 [Semantic Versioning](https://semver.org/lang/zh-CN/)。

## [v0.4.3] - 2026-08-29

### 新增功能

- **Codex ACP 后端**：Copilot 现在可选择 `Codex ACP`，通过 Codex App Server 的 JSONL 协议进行多轮对话，并调用本机 Codex 工具。命令执行、文件修改、权限审批、工具输出和思考过程会在同一会话中展示。
- 新增 Codex App Server 客户端与传输层，支持 `initialize`、`thread/start`、`turn/start`、`turn/interrupt`、多轮线程复用和服务器请求兜底。

### Bug 修复

- 修复 Codex 在一轮工具调用后停止的问题：启动器持续等待 `turn/completed`，并正确响应工具执行、文件修改、权限与宿主请求。
- 修复 Codex 进程退出、EOF、stdin/stdout 错误或 code 0 意外断开后，会话停留在 `running` 的问题；pending turn、审批和修改队列锁会同步释放。
- 修复消息事件到达顺序导致的对话看起来被截断的问题；最终回答与工具日志按时间恢复顺序。
- 加固 DSH ACP 传输层：异常流关闭、重复关闭、晚注册监听和子进程树清理更稳定。
- 恢复插件页搜索栏位置，并调整 Copilot 窄宽度下的响应式布局。

### 测试

- 新增 Codex 协议、请求兜底、transport 生命周期、会话集成、UI 和 code 0 退出回归测试。
- 全套 681 项测试通过，47 项依赖真实环境的测试按惯例跳过；`tsc --noEmit` 与 `vite build` 通过。

## [v0.4.2] - 2026-08-26

### Bug 修复

- **启动器自动更新静默失效**：未登录 GitHub 或匿名 API 额度耗尽时，更新检查直连 `api.github.com` 被限流（403）后直接进入 error 状态，顶部不显示任何更新入口。现在直连失败时按序走镜像（`gh-proxy.com` 等）读取 Release 元数据，检测恢复正常。
- **启动器自动更新残留 apply 脚本**：替换脚本在 `move` 失败时提前 `exit /b 1` 跳过自删，userData 里残留 `apply-*.cmd`。现在替换失败同样清理脚本自身。
- **开发模式误覆盖 Electron 二进制**：以 `npm run dev`（`node_modules\electron\dist\electron.exe`）运行时点击更新，替换脚本会把下载的便携版安装包 move 到 Electron 可执行文件上，破坏开发环境。现在非便携模式（无 `PORTABLE_EXECUTABLE_FILE`）直接拒绝应用更新并给出明确提示。
- **便携版更新弹出黑色终端**：替换脚本经 `cmd.exe` detached 启动时 Windows 强制新建可见控制台窗口。改用 `wscript` 静默执行，不再弹窗。
- **DSH 已是最新仍显示「更新 DSH」按钮**：资源市场 deepseek-harness 行只要检测到已安装就固定显示「更新 DSH」。现在按真实版本状态显示「已是最新」（置灰）或「更新 DSH」。
- **相同 DSH 版本重复安装崩溃**：对已由 pnpm 管理（node_modules 走 junction 链接）的版本目录执行 `npm install --prefix` 重装，npm 依赖树解析在 `@npmcli/arborist Link.matches` 崩溃。现在目标版本与已安装版本一致时直接跳过重装，新版本会安装到全新目录。

### 测试

- 新增启动器更新：`wscript` 替换、开发模式保护、镜像 fallback、脚本失败清理等 4 项测试。
- 全套 592 项测试通过，`tsc --noEmit` 通过。

## [v0.4.1] - 2026-08-26

> 本版本统一 Profile 与整合包运行模型，并补充非标准 DSH 发行版导入能力。插件物理包继续复用共享池，各 Profile 保持独立依赖链接层、启用状态和加载顺序。

### 新增功能

- **非标准整合包导入**：识别标准 Profile、meta-repo 和独立 DSH 发行版，解析 `config/bundles.json`、workspace 清单及仓库内插件目录，创建隔离 Profile。
- **来源匹配与安装**：优先使用 DSH Market，未命中时使用固定 GitHub commit 或整合包本地源码，并记录整合包来源、仓库 commit、实际安装来源和插件收据。
- **共享插件池**：Profile 之间复用物理插件本体，同时保留各自的 pnpm 链接层和激活序列；补齐和卸载不会误删其他 Profile 的引用。
- **Profile 仓库来源信息**：导入预览展示发行版类型、DSH 版本、插件分类、来源匹配结果和跳过项，支持 npm 仓库补全及 GitHub 插件恢复。

### Bug 修复

- 修复 GitHub 插件来源、npm 元数据和整合包根 commit 混用导致的安装目标错误。
- 修复共享插件清单在不同 Profile 间消失、Profile 切换后误报缺失依赖以及本地来源无法复用的问题。
- 修复窗口首次从启动页切换到管理页或从托盘恢复时右侧空白、透明窗口重绘不完整的问题。
- 修复 Copilot 拖拽边界释放不稳定、边界阴影归属错误以及侧边操作按钮不跟随宽度变化的问题。
- 启动页文字统一为白色叠加混合效果，改善不同背景下的可读性。

### 测试

- 新增并更新 Profile、插件来源、共享插件池、非标准整合包、进程和运行时测试。

## [v0.4.0] - 2026-08-25（预览版）

> 本版本为桌面端**大版本预览更新**：重构 Copilot 对话体验、补齐 DSH Market 下载可靠性、引入官方推荐整合包「DSH Web UI」一键安装，并修复多项兼容性与稳定性问题。预览版供尝鲜，发现问题欢迎在运行日志或讨论区反馈。

### 新增功能

- **官方推荐整合包「DSH Web UI」**：一键安装 `@linxin666/dsh-web-ui-all@latest` 全家桶（任务看板、Git 图谱、宠物、皮肤中心等）。新用户首次点击「下载 DSH」时弹窗询问是否同时安装；老用户首次「启动 DSH」时弹窗提示并默认暂时停用其它插件以免兼容性冲突（仅提示一次）；安装后置为官方默认皮肤。整合包固定显示在「DSH Web App」下方（官方推荐行），随时可在启动项管理中关闭；设置页新增「下载官方推荐整合包」按钮。
- **Copilot 流式输出**：对话输出改为真正的逐块流式（对 dsh-acp 打补丁，逐块转发 `assistant/chunk`），不再等整条消息结束才出现；思考（reasoning）内容默认收起，可展开查看。
- **Copilot 输入快捷键**：按 Enter 直接发送，Ctrl+Enter 换行。
- **运行日志灵动岛**：只在 DSH 启动时自动弹出，随后自动收回（切页、DSH Market 目录同步不再误触发）。
- **DSH Market 下载反馈**：下载进度条直观区分「下载中 / 安装中 / 完成」，失败原因可读；每个插件行新增「打开插件文件夹」按钮。
- **官方推荐弹窗视觉重设计**：hero 渐变图标头、要点列表、警告条与主次按钮的新样式。
- **主页底部显示官方用户QQ群**；头部「运行中」芯片与「停止 DSH」按钮拉开间距。

### Bug 修复

- **Copilot 工具调用报错 `unknown tool ""`**：工具名被置空导致调用失败，已修复。
- **Copilot 面板打开时 Profile/整合包页排版错乱**：工作区被 Copilot 列挤压导致布局溢出，已按窗口宽度做响应式适配。
- **DSH Market 下载失败、重复下载循环**：网络请求改为国内镜像（npmmirror）优先；npm 源失败自动回退；原生包 postinstall 直连 GitHub 拖死的问题通过 `--ignore-scripts` 回退解决；下载/安装增加总超时兜底，装完自动激活，清理 pnpm `allowBuilds` 残留。
- **Copilot 不出流式**：dsh-acp 只转发结尾整条消息，补丁改为逐块转发。
- **官方推荐整合包安装后与真实插件行重复**：从插件列表隐藏真实行，仅保留固定推荐行。
- **Web UI 内置「检查更新」失败**：Web 端更新器用系统 pnpm 直操作 Profile，与启动器插件仓库（store）不一致导致 `ERR_PNPM_UNEXPECTED_STORE` 拒绝工作。现在安装插件/离线补齐 Profile 时会同步项目级 `.npmrc` 的 `store-dir` 与镜像 `registry`，并向 DSH 子进程注入相同的 pnpm 环境变量，内置更新器可正常升级全家桶。
- **撤掉最小化/还原动画**：回到原生窗口行为。

### 测试

- 全套 588 项测试通过（47 项 e2e 依赖真实环境按惯例跳过），`tsc --noEmit` 与 `vite build` 通过。

## [v0.3.7] - 2026-08-24

### 新增功能

- **系统托盘与后台运行**：新增系统托盘图标（悬停提示「DSH 旋律启动器」），左键单击唤起主窗口，右键菜单提供「显示主窗口」与「退出」。点击标题栏 × 或 Alt+F4 不再结束进程，仅隐藏到托盘继续后台运行（DSH 运行时等子进程不受影响）；首次隐藏时弹一次气泡提示。真正的退出只走托盘右键「退出」，复用既有 `before-quit` 清理链路（停止 DSH 运行时、回收子进程树、还原 AI 凭据锁），并在 `will-quit` 移除托盘图标避免通知区残留。
- **单实例唤起**：启动时通过 `requestSingleInstanceLock()` 加锁，再次双击 exe 时新进程立即退出，已运行实例收到 `second-instance` 事件后唤起前台窗口（恢复最小化并短暂置顶抢焦点），不再多开。

### 测试

- 全套 569 项测试通过（47 项 e2e 依赖真实环境按惯例跳过），`tsc --noEmit` 与 `vite build` 通过。

## [v0.3.6] - 2026-08-24

### 新增功能

- **Copilot 模型切换选择器**：输入框上方新增模型下拉选择器，枚举 DeepSeek 官方与全部已配置的自定义 API 模型；缺密钥或协议不兼容的选项置灰并标注。切换到某模型后立即持久化到当前会话（`provider|model`），下一条消息按新模型重启 agent 实例；面板每次打开时刷新候选列表。新增 `ai-sessions:set-model` IPC 通道，前端乐观更新、失败回滚并通过 Toast 提示。
- **自定义第三方 API 接入 Copilot**：ACP 运行时只注册了 `deepseek-official` 一个适配器（OpenAI 兼容 `/chat/completions`，支持 `DEEPSEEK_BASE_URL` 覆盖端点）。现在自定义 API 统一映射到该适配器：以用户填写的第三方端点作为 `DEEPSEEK_BASE_URL`、自定义密钥作为 `DEEPSEEK_API_KEY`、模型名直传实际模型标识注入子进程，绕开 `no adapter registered for provider "…"` 报错。模型解析优先级：`agent-default-model` 指定的自定义 provider → DeepSeek 官方 Key → 第一个带本地密钥、OpenAI 兼容协议的自定义 provider。

### Bug 修复

- **Copilot 打开时缩小窗口，启动项管理页排版错乱**：工作区宽度 = 窗口宽 − 侧栏 − Copilot 列，默认 1380 管理窗口打开 Copilot 后工作区仅剩约 742px，低于管理页两列布局下限（940px），页面横向溢出。修复：≤1250px 时 Copilot 从网格列改为悬浮覆盖（工作区恢复完整宽度）；≤1578px 且 Copilot 打开时提前应用管理页/插件列表/仓库行的中等宽度适配（单列布局、隐藏详情列）。
- **切换到 DSH Market 页时运行日志灵动岛自动弹出**：市场目录拉取与更新检查的合成进度曾经同时进入日志列表与 `installProgress` 状态，被当成安装活动触发自动弹出，并在同步期间短暂锁定 Profile/整合包切换。修复：真实子进程输出（`onRuntimeOutput`）才触发"新日志即活动"；目录同步/更新检查只写日志行，带插件名的安装/更新/卸载操作照旧进入安装活动路径。
- **Copilot 面板字号过小、不随窗口放大自适应**：对话正文、输入框、标签、工具消息、按钮统一接入 `clamp()` 动态字号（约 12px → 15.5px 随窗口宽度缩放）；Markdown 标题改用 em 相对单位跟随缩放；行高调整为 1.6 倍字号。
- **GitHub 账号对话框「API 额度」行排版突兀**：原为带边框背景的独立小盒，与上方「授权范围」裸标题行风格不统一。改为与之一致的分区结构：标题行（左标题/右数字）+ 剩余额度进度条（带无障碍标记），三区视觉节奏统一。
- **窗口聚焦切回时 GitHub 页总是「正在读取 GitHub」转圈**：聚焦 → 重新拉取登录状态（新对象）→ 内联 `onError` 新引用 → 加载 effect 被无谓重跑。修复：`onError` 改为稳定引用（`useCallback`）；GitHub 页已有数据时走静默刷新路径（列表原地保留、不显示 loading），仅首次加载显示转圈。
- **GitHub 空列表提示排版**：去掉「还没有找到基于 Melody Launcher 的提交。」左侧多余图标；补齐空态样式，左内边距 47px 与「最近提交」标题文字精确齐头。

### 测试

- 新增 `tests/copilot-api.test.ts`、`tests/copilot-sessions.test.ts` 共 21 项：自定义 API → `deepseek-official` 映射、`agent-default-model` 优先级、按 provider/model 解析、会话模型持久化/清空/格式校验、模型候选枚举。
- 全套 569 项测试通过（47 项 e2e 依赖真实环境按惯例跳过），`tsc --noEmit` 与 `vite build` 通过。

## [v0.3.5] - 2026-08-23

- **API 配置弹窗底部按钮被裁切**：矮窗口（启动器首屏 900×560）下弹窗限高未计入标签栏高度，底部按钮栏被 `overflow: hidden` 裁掉；改为纵向 flex 布局，仅表单区域滚动。
- **启动卡死在「正在读取 DSH 配置」**：凭据文件为 `version/refs` 新格式时 `credentials:deepseek-status` IPC 失败导致启动 `Promise.all` 整体失败；凭据状态读取失败时降级为「未配置」并提示，不再阻塞启动。
- **管理界面顶栏「未启动」左侧半个小方形**：统计盒被压缩导致「打开配置目录」方形按钮被边框裁掉一半；统计/状态盒改为不可压缩。
- **「默认配置」图块样式统一**：350px 大圆角胶囊改为与相邻芯片一致（260px、32px 高、6px 圆角、去阴影），下拉框同步收紧。
- **顶栏窄窗口响应式**：新增 1320px 断点，切换器与右侧按钮随窗口宽度同步渐进收缩，1380→860px 区间不再挤爆。
- **预设残留删不掉、刷新按钮不生效**：新增预设卸载全链路（`presets:uninstall` IPC + 预设行二次确认删除按钮 + 路径/名称安全校验）；「刷新」改为同步重读 Skill、应用加载项与预设。
- **资源市场仓库行四列缩放**：语言/活跃度列固定宽、内容靠左，操作按钮左对齐紧贴活跃度列，表头与各行严格对齐，窗口缩放不再错位。
