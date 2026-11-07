# dsh-launcher 仓库结构分析报告

> 本报告合并两份已有分析，并按当前本地工作区重新核对了文件数量、Git 状态、工程配置和测试结果。代码统计不包含 `node_modules/`、`dist/`、`dist-electron/` 与 `release/` 等生成目录。

## 1. 项目概况

- **项目名称**：`dsh-launcher`，产品名称为 DSH Launcher，仓库名为 `dsh-melody-launcher`
- **定位**：面向 DeepSeek Harness（DSH）的 Windows 桌面启动器、插件管理器和资源市场
- **技术形态**：Electron + React + TypeScript + Vite 的桌面应用
- **当前 package 版本**：`0.3.3`
- **发布形态**：Windows portable executable，发布到 GitHub Release，不是 npm 公共包
- **Git remote**：`https://github.com/rirko/dsh-melody-launcher.git`
- **当前分支**：`main`
- **许可证**：仓库没有 `LICENSE` 文件，README 明确说明目前默认保留所有权利

## 2. 当前仓库状态

截至本次分析：

- 最新本地提交：`6b3eefa chore: prepare v0.3.3 release`
- 当前 HEAD 提交数：152
- 本地 `main` 已合并远端 `v0.3.2` 发布提交，并包含本轮待发布改动
- 当前可见最新 tag：`v0.3.2`
- `package.json` 与 `package-lock.json` 已同步为 `0.3.3`，准备发布 `v0.3.3`
- 工作区当前干净。此前的 4 个未提交文件已分别整理为以下本地提交：

```text
5817f81 fix: protect DSH core dependencies and recover GitHub auth
2cc1d84 docs: add repository structure report
```

连同此前的 `25f50ba` 窗口阴影修复，这 4 个提交构成本地待发布范围；代码改动涉及 AI 安装适配的 DSH 核心依赖保护、GitHub 401 自动重新验证和窗口阴影层级修复。

## 3. 仓库规模

按当前工作区实际扫描结果：

| 目录 | 文件数 | 行数 | 作用 |
|---|---:|---:|---|
| `electron/` | 57 | 16,675 | Electron 主进程和业务服务 |
| `src/` | 40 | 9,589 | React 渲染层 |
| `tests/` | 60 | 10,666 | Vitest 单元、集成和环境测试 |
| **合计** | **157** | **36,930** | TypeScript/TSX 源码与测试 |

其中：

- `src/` 包含 17 个 `.ts` 文件和 23 个 `.tsx` 文件；
- `tests/` 主要是 `.ts` 测试文件，并包含少量 TSX 测试代码；
- `styles.css` 不计入上述 TypeScript 行数，约 5,400 行 CSS；
- 主要大文件包括 `electron/ai-install.ts`、`electron/pack.ts`、`electron/installer.ts`、`src/demo-api.ts`、`src/views/DiscoverView.tsx` 和 `src/styles.css`。

## 4. 顶层目录

```text
dsh-launcher/
├── .github/                 # CI、Release、Issue/PR 模板、Dependabot
├── bin/                     # npm 启动入口脚本
├── build/                   # electron-builder 图标资源
├── catalog/                 # 共享资源分类索引和说明
├── electron/                # Electron 主进程
├── public/                  # 启动背景和图标等静态资源
├── src/                     # React 渲染进程
├── tests/                   # 测试套件
├── dist/                    # 本地前端构建产物，已忽略
├── dist-electron/           # 本地 Electron 构建产物，已忽略
├── release/                 # 本地打包产物，已忽略
├── package.json             # 依赖、脚本、Electron Builder 配置
├── package-lock.json        # npm 锁文件
├── tsconfig.json            # TypeScript 配置
├── vite.config.ts           # Vite/Electron 构建配置
├── START-DSH-LAUNCHER.cmd  # Windows 开发启动脚本
├── README.md
└── README.en.md
```

`catalog/index.xml` 当前是空索引，内容只有 `dsh-catalog schema="1"` 根节点；这代表共享分类库尚未积累条目，不代表 catalog 功能不存在。

## 5. 技术栈与构建

来自当前 `package.json` 的版本：

| 层面 | 当前配置 |
|---|---|
| 桌面容器 | Electron `^43.4.0` |
| UI | React `^19.2.8`、React DOM |
| 语言 | TypeScript `^7.0.2` |
| 构建 | Vite `^8.2.1`、`vite-plugin-electron` |
| 测试 | Vitest `^4.1.10`、jsdom `^27.4.0` |
| 打包 | electron-builder `^26.15.3` |
| Node 要求 | `>=20` |
| 发布目标 | Windows `portable` |

主要脚本：

```text
npm run dev       Vite 开发服务器 + Electron 主进程
npm test          Vitest 测试套件
npm run build     tsc --noEmit + Vite 前端、主进程和 preload 构建
npm run preview   浏览器预览服务器
npm run package:win  构建并打包 Windows portable
```

## 6. 架构分层

总体数据流：

```text
React UI
  ↓
src/types.ts / src/constants.ts 共享契约
  ↓
electron/preload.ts contextBridge
  ↓
electron/ipc.ts ipcMain.handle
  ↓
electron/* 领域服务
  ↓
DSH 进程、Profile、本地运行时、GitHub、Node/pnpm
```

### 6.1 共享契约

- `src/types.ts`：定义 `LauncherApi`、Profile、插件、Skill、整合包、运行时、GitHub、AI 会话等类型。
- `src/constants.ts`：定义 IPC 请求通道、事件通道、DSH 包名和仓库常量。
- `electron/preload.ts`：通过 `contextBridge` 暴露白名单 API。
- `electron/ipc.ts`：集中注册渲染层可调用的 IPC handler，并在修改 Profile 前执行跨模块互斥检查。

当前共享常量中约有 97 个 IPC request channel 和 10 个 IPC event channel。

### 6.2 Electron 主进程

`electron/main.ts` 是装配根，负责创建服务、注册 IPC、创建窗口、配置进程监督器和退出清理。

主要模块按领域划分：

- **窗口与进程**：`app-window.ts`、`window-shadow.ts`、`renderer-events.ts`、`process.ts`、`process-supervisor.ts`、`command.ts`
- **DSH 运行时**：`dsh-install.ts`、`dsh-update.ts`、`runtime.ts`、`node-runtime.ts`
- **Profile 与插件**：`profile.ts`、`installer.ts`、`plugin-install.ts`、`plugin-catalog.ts`、`plugin-source.ts`、`plugin-receipts.ts`、`plugin-trial.ts`
- **Skill、预设和应用加载项**：`skill-catalog.ts`、`skill-format.ts`、`skill-install.ts`、`preset-install.ts`、`application-catalog.ts`、`application-addons.ts`、`linked-components.ts`
- **资源发现与共享索引**：`discovery.ts`、`catalog-analysis.ts`、`catalog-index.ts`、`catalog-sync.ts`、`meta-repo-catalog.ts`
- **整合包**：`pack.ts`、`pack-scan.ts`、`pack-zip.ts`、`pack-manifest.ts`、`pack-manifest-store.ts`、`pack-registry.ts`、`pack-orchestration.ts`、`pack-export.ts`
- **AI 与 Copilot**：`ai-install.ts`、`acp-client.ts`、`ai-repository-source.ts`、`copilot-sessions.ts`
- **GitHub 与更新**：`github-auth.ts`、`github-import.ts`、`github-archive.ts`、`launcher-update.ts`
- **设置与凭据**：`settings.ts`、`credentials.ts`、`custom-api.ts`、`network.ts`

### 6.3 React 渲染层

- `src/main.tsx`：渲染入口。
- `src/App.tsx`：组装导航、页面、对话框、窗口模式和全局状态。
- `src/api/client.ts`：Electron 环境使用 `window.launcher`，浏览器预览回落到 `demo-api.ts`。
- `src/hooks/`：启动器 store、AI 安装、Copilot、整合包安装、异步任务和 Toast 状态。
- `src/views/`：`DiscoverView`、`PluginsView`、`DshMarketView`、`PacksView`、`RuntimeView`、`GitHubView`。
- `src/components/`：顶栏、侧边栏、Copilot、通用控件和对话框。
- `src/styles.css`：当前统一界面样式、窗口外壳、动画和主题。

## 7. 功能地图

1. **DSH 本体**：多路径检测、便携 Node/pnpm 准备、本地安装、GitHub 版本检查和更新提示。
2. **插件管理**：仓库搜索、结构检测、npm/GitHub/file 安装、构建脚本许可、启停、排序、卸载和试运行。
3. **Skill 管理**：GitHub Tree 检测、SKILL.md/flat Skill 识别、安装、启停和描述展示。
4. **应用加载项与预设**：独立管理、伴随启动、协同组件同步开关、进程跟踪和退出清理。
5. **资源市场**：GitHub Topic 搜索、并行检测、长期缓存、远端 catalog/index.xml 同步、`plugin-update` 分支 PR 更新和独立 DSH Market。
6. **整合包**：本地清单、切换、排序、启停同步、YAML/zip 导入导出、离线插件、快照回滚和 Profile 应用。
7. **DSH Copilot**：Markdown 输出、多会话、ACP 运行时、只读并行分析、审批、FIFO 修改队列、Profile 锁、快照、回滚、取消和进程清理。
8. **AI 安装适配保护**：禁止 AI 自行升级 DSH 核心包；任务结束校验 Profile 核心依赖与托管 DSH 版本，不一致时自动回滚并提示用户决定是否更新 DSH。
9. **GitHub 账号**：OAuth Device Flow、访问令牌登录、safeStorage 加密、统一 Authorization、仓库 star、PR/提交记录和共享目录更新。
10. **窗口体验**：无边框透明窗口、独立阴影窗口、启动页/管理页双尺寸、页面切换动画和 Copilot 可调侧栏。

## 8. 测试、CI 与 Release

本地最近一次验证结果：

- `npm test`：505 项通过，47 项跳过；
- `npm run build`：通过；
- GitHub 认证专项测试：10 项通过。

CI 工作流 `.github/workflows/ci.yml` 包含：

- Ubuntu/Windows × Node 20/22 测试矩阵；
- Windows Node 20 类型检查与构建；
- 测试和构建成功后打包 Windows portable，并上传 artifact。

Release 工作流 `.github/workflows/release.yml` 在 `v*` tag 上运行：

1. 校验 tag 与 `package.json` 版本一致；
2. 安装依赖并运行测试；
3. 打包 portable exe；
4. 创建或覆盖 GitHub Release 并上传 exe。

## 9. 安全设计

当前代码已经具备以下安全边界：

- 渲染层使用 `contextIsolation`、`sandbox` 和 `nodeIntegration: false`；
- 主进程 API 只通过 `contextBridge` 暴露；
- IPC 参数对包名、Profile、仓库名和路径进行校验；
- GitHub token 使用 Electron `safeStorage` 加密，渲染层不接触明文；
- AI 任务对凭据文件加锁移出工作区，并对写入、安装和执行操作要求审批；
- 下载的 Node 运行时执行 SHA-256 完整性校验；
- 外链打开限制为 HTTP/HTTPS；
- 启动器记录并清理由自身启动的进程树。

仍需注意：Windows portable 版本没有商业代码签名证书，可能触发 SmartScreen 未知发布者提示；`koffi` 等 native/FFI 依赖需要持续关注跨平台兼容性。

## 10. 主要问题与建议

### P0：先处理本地发布状态（已完成）

本地改动已经按代码修复、文档报告和此前窗口修复整理，并已合并远端 `v0.3.2` 发布提交。当前版本已提升为 `0.3.3`，待推送 `main` 并创建对应的 `v0.3.3` tag/release。

### P1：同步版本和 README 技术徽章

README 徽章仍显示 Electron 33、React 18、TypeScript 5.7、Vite 6、Vitest 2，而当前依赖是 Electron 43、React 19、TypeScript 7、Vite 8、Vitest 4。

### P1：明确 npm 分发定位

README 仍提供 `npx dsh-melody-launcher` 和 `npm install -g dsh-melody-launcher`，但当前 `package.json`：

- `name` 是 `dsh-launcher`；
- 没有 `bin` 字段；
- `private: true`；
- 实际发布流程是 GitHub Release portable exe。

如果不做 npm 分发，应删除或弱化 npm 安装说明；如果要做 npm 分发，则需要统一包名、`bin`、`files` 和发布流程。

### P1：更新 README 项目结构

README 的项目树只列出少量早期代表性文件，当前 `electron/` 已有 57 个模块，且已经包含 catalog、pack、Copilot、GitHub、DSH Market、应用加载项和更新服务。建议保留高层目录，避免维护完整逐文件树。

### P1：补充许可证决策

当前没有 `LICENSE`。如果项目希望外部复用和贡献，应补充 MIT、Apache-2.0 或其他明确许可证；否则应在发布说明中明确“保留所有权利”。

### P2：工程规范

当前未发现 `.gitattributes`、`.editorconfig`、ESLint 或 Prettier 配置。Git 已出现 LF/CRLF 转换警告。建议至少增加 `.gitattributes`，统一 Windows `.cmd` 与 TypeScript/Markdown 的换行策略，并在 CI 加入 lint/format 检查。

### P2：拆分大模块和资源

`ai-install.ts`、`pack.ts`、`installer.ts`、`demo-api.ts` 和 `DiscoverView.tsx` 已较大。后续可继续按协议、校验、安装编排和持久化职责拆分；`launcher-background.png` 也可评估压缩或转换格式。

### P2：分支治理

远端存在较多 feature、fix 和 catalog-sync 分支。已合并分支应定期清理，catalog 同步分支可以设置自动过期策略，并为 `main` 启用 PR、CI 和审查保护。

### P3：双语 README 同步

`README.md` 与 `README.en.md` 内容较大，建议确定一个 source of truth，或把易漂移的版本徽章和项目结构改为自动生成/高层描述。

## 11. 总结

这个仓库已经是一个具备完整桌面应用形态的 DSH 工具，而不是早期原型：

- 主进程与渲染进程边界清楚；
- IPC 契约集中，便于审查；
- 插件、Skill、应用加载项、整合包、市场和 Copilot 已形成完整工作流；
- 测试、CI 和 Release 基础较完整；
- 当前主要风险在工程治理和发布信息同步，而不是核心架构不可用。

建议优先顺序：先处理未提交/未推送改动，再同步版本与 README，明确许可证和 npm 分发定位，随后补工程规范、拆分大模块并清理分支。
