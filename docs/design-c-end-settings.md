# 设计：C 端「设置」页（与开发者模式分离）

> 状态：已与产品负责人收敛（2026-08）。术语定义见 [CONTEXT.md](../CONTEXT.md)。
> 本页不含 Code-behind 细节，只记录**为什么这么做**与**做什么**。

## 背景与目标

现有启动器把普通用户(小白)与开发者塞在同一套界面里：启动页一个「管理」按钮进完整管理界面，开发者向的敏感设置（本体目录、启动命令、网络镜像、Copilot 提示词）也都暴露在「启动器设置」面板中。新设计把两者分开：

- C 端在启动页上只看到一个「设置」入口，进去是**简洁的全屏页面**，能管好自己的版本、插件、技能和整合包，且随时能"打开各自的文件夹"。
- 开发者功能整体收归「开发者模式」，低调地待在新设置页角落与原有的「管理」界面里。

## 决策清单（Q = 已问过、R = 推荐被采纳）

### 分层与入口

| # | 决策 | 结论 |
|---|------|------|
| D1 | 启动页右上角/角落新增齿轮「设置」按钮 | Q·R：点开为全屏新页面（简洁管理界面） |
| D2 | 旧设置面板的归宿 | Q：收进新页面角落一个低调的「开发者模式 →」链接，点击弹出原「启动器设置」面板 |
| D3 | 启动页原「管理」按钮 | R：保留原样，作为完整开发入口（资源市场 / DSH Market / GitHub / 运行环境） |
| D4 | 名称 | 新页面就叫「设置」（齿轮），不强推"管理"二字 |
| D5 | 页面结构 | 左侧/顶部 tab：**DSH 版本 · 插件 · 技能 · 整合包**（MCP 本轮不做，见 D9） |
| D6 | 美术风格 | **与现有设置界面统一**：复用现有主题体系（松林/海湾/莓果/石墨）与 styles.css 设计变量，不另造视觉语言 |

### 四个 tab 各自内容

- **DSH 版本**：当前使用版本、已装版本列表（切换「使用」/ 删除 / 打开 `.dsh-runtime/versions` 文件夹）、输入精确版本号下载新版本。复用「运行环境」页 DSH 面板的既有逻辑，**不暴露 Node.js 管理**（Node 是开发者事）。
- **插件**：已装插件列表 + 开关 + 打开插件所在 Profile 的 node_modules 文件夹。安装/卸载/排序不放进 C 端（引导走「开发者模式 → 资源市场」）。
- **技能**：技能列表 + 开关 + 打开 `~/.dsh/skills` 文件夹。获取更多技能引导走「开发者模式 → 资源市场」。顺带可放 **Agent 预设**（`~/.dsh/.agent-presets`，与技能同为独立目录的小资源，开关同样已有后端）——若产品判断预设偏开发者向，可仅放在开发者侧（标注为可反悔项）。
- **整合包**：已装整合包列表（当前启用高亮、可切换）、导入（选 zip → 预览 → 装入为独立 Profile）、导出（见 D7）、删除/打开包对应文件夹。省略 Profile 创建/克隆、仓库导入等开发者操作。

### 整合包（Pack）

| # | 决策 | 结论 |
|---|------|------|
| D7 | 导出内容 | 默认**声明式 + 本体尽量离线**：zip 带 manifest（name/description/version/dshVersion/plugins/skills/presets/applications）+ 插件本体 + 预设目录；**凭据、API Key、GitHub 登录态、代理配置默认不进包** |
| D8 | 导出选项 | 导出前弹**清单勾选**：DSH 版本(声明/可选含运行时本体)、插件、技能、预设、配置、密钥；默认只勾非敏感项 |
| D9 | 导入时 DSH 版本处理 | 整合包声明的 dshVersion **若本机未安装则自动下载并安装**该版本（现状只记录版本号、不补装——这是本轮唯一需要新增的后端行为） |
| D10 | 隔离语义 | 导入即**完整实例化**：自动生成 `pack-` 前缀独立 Profile，插件/配置互不干扰；启动页下拉仍可切换 |

### MCP

- **D11**：本轮**不做 MCP**。已核实本机 DSH（`~/.dsh`）没有 MCP 目录、`settings.yaml` 无 MCP 配置段。将来 DSH 支持 MCP 后，以"带开关的独立目录资源"形态（同插件/技能/预设）加入 C 端设置，入口位置预留即可，不预做 UI。

### Profile 的可见性

- **D12**：Profile 是隔离的真实载体（`~/.dsh/profiles/<名字>/`，含插件启用清单），但 **C 端不出现"Profile"这个词**。C 端只显示「当前使用：XX 整合包 / 默认配置」；原始切换能力保留在启动页既有的「启动配置」下拉。

## 新增/改动清单（给实现阶段的速览）

1. **前端**：新 `SettingsView`（C 端，全屏）：四个 tab + 左下角「开发者模式 →」链接；复用现有组件逻辑（版本列表、开关行、打开文件夹）。
2. **前端**：启动页 LauncherHome 右上角加齿轮「设置」按钮 → 打开新页面（surface）。
3. **后端（新增行为）**：导入整合包时，若 manifest 的 dshVersion 不在 `dshInstalled` 中 → 自动走 `installDshVersion(dshVersion)`，失败给出明确错误、不阻塞其余内容安装。
4. **后端（复用能力）**：导出清单勾选（含密钥选项）基于现有 pack 导出管线扩展入参；"命令/配置"类内容打包范围 = launchArgs/webPort/workspace/uiTheme/network（密钥默认排除）。
5. **不做**：MCP 管理、C 端不上 Node 管理/资源市场/Profile 创建克隆/仓库导入。

## 未决项（可反悔）

- **U1**：Agent 预设是否进 C 端「技能」tab。现推荐：进（同层级小资源，开关已有）。若产品判断其偏开发者向，移出即可，不影响架构。
- **U2**："配置类"导出条目精确清单（launchArgs/workspace/uiTheme 等哪些算"配置"），实现时按最小集走，可后续加项。

## 落地状态（2026-08-31 · 分支 轮椅模式Miyazawai）

已在「轮椅模式Miyazawai」分支上落地首版，R/G：新增 8 个测试全绿，全量 600 测试通过，`tsc --noEmit` 与 `npm run build` 通过：

- **D1/D2/D4**：启动页新增齿轮「设置」→ 全屏 `SettingsView`（新 surface `settings`，`WindowMode` 扩充，尺寸同管理界面）；新页左下角低调「开发者模式 →」打开原「启动器设置」面板，「完整管理界面」链接进管理界面。
- **D5**：四 tab —— DSH 版本 / 插件 / 技能与预设 / 整合包（MCP 本轮不做，见 D11）。
- **D6**：直接复用现有主题变量与 `.switch` 等既有样式，新增样式追加在 styles.css 末尾。
- **D7/D9**（后端）：整合包导入时若声明 dshVersion 未安装，自动补装该版本（`ensureDshVersionInstalled`，与既有 profilesImport 语义一致）。
- **D7**（配置导出）：导出携带 `launcher-config.yaml`（workspace/launchArgs/webPort/openAfterLaunch/uiTheme/network，**不含凭据、路径与 Profile**），导入时校验并入设置。
- **U1**：Agent 预设已进 C 端「技能与预设」tab（含开关 + 逐项打开文件夹）。
- 各 tab 提供「打开文件夹」：DSH 版本文件夹、插件本体（逐项）、技能/预设目录（逐项）。

**后续项（未做，已记录在设计内）**：导出勾选清单对话框与「包含 DSH 运行时 / 包含密钥」高级选项（D8）；MCP 管理（D11，等 DSH 支持）。

### 改版增补（2026-08-31 · commit 0dbdaeb）

- D5 落定为**左竖栏导航**：返回启动页在顶栏左上、窗口三键最右、刷新与开发者模式链接在竖栏底部；顶栏可拖拽。
- 版本 tab 去掉手动输入版本号，改为「可下载版本」列表直接点击下载（内联进度）。
- 插件 tab 子视图「已安装 / DSH Market」，复用 `DshMarketView`（新增 `embedded` prop）。
- 技能 tab 内嵌**技能市场**：双源 = `anthropics/skills`（官方 Apache 2.0）+ DSH 社区仓库（awesome-dsh-skills、dsh-local-skills），走现成 `analyzeCatalogRepository`/`installSkill`，主进程零改动；skills.sh 因 API 强制 Vercel OIDC 认证（实测 401）仅保留浏览外链。

### 改版增补（2026-09-02 · DeepSeek 蓝 + 启动页重设计 + skills.sh 索引）

- **主题**：新增 `deepseek` 蓝（#4D6BFE 系）并设为**默认主题**（`:root` 基座即蓝，forest 收进 data-theme 块可切换）；styles.css 与整合包对话框里的硬编码品牌色全部改 `var()`/`color-mix()`，设置、管理、对话框、两个市场全部跟随主题。
- **品牌资产**：`public/launcher-logo.png`（256×256 RGBA，从 `build/icon.ico` 抽取，与 portable exe 图标同源）+ 重导透明版 `launcher-icon.png`；index.html 补 favicon。
- **启动页**：左 logo 大图（入场动画）+ 右浮起控制卡（状态芯片 / 启动大按钮 / 单行 4 工具按钮 / 启动配置行），窄窗降级。
- **技能市场扩容**：通用技能改为 **skills.sh 目录索引**——主进程 `electron/skills-sh.ts` 用公开 `/api/search?q=` 做多查询聚合（字母/数字/常用词 → 去重 → 按安装量排序，上限 2500），磁盘缓存 `skills-sh-index.json`（24h、stale-while-revalidate）；卡片显示安装量徽章；安装走 `skillMarketInstallByName`（main/master 分支逐个归档分析 + `matchSkillsShTarget` 定位）。DSH 社区两仓库保留归档式直装。skills.sh API 标注 legacy，失败时该栏空态+重试，社区栏不受影响。
- **DSH Market 卡片统一**：与技能市场同几何（minmax(250px,1fr)/radius 10/同投影），星数改药丸徽章（金色星标），meta 增加版本号药丸；工具条搜索框与下拉改主题变量。
