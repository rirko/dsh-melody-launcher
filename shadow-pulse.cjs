const fs = require('fs')
let n = 0
function patch(file, from, to, tag) {
  let s = fs.readFileSync(file, 'utf8')
  if (!s.includes(from)) throw new Error('NO MATCH [' + file + ']: ' + tag)
  s = s.split(from).join(to)
  fs.writeFileSync(file, s)
  n++
  console.log('ok:', tag)
}

// 1. window-shadow.ts：阴影页支持 lift 脉冲 + 控制器 pulse() + 导出
patch('electron/window-shadow.ts',
  '      .shadow {\n        position: absolute;\n        inset: ${SHADOW_MARGIN}px;\n        border-radius: 14px;\n        box-shadow: 0 10px 28px rgba(22, 32, 26, .25), 0 2px 9px rgba(22, 32, 26, .16);\n      }',
  '      .shadow {\n        position: absolute;\n        inset: ${SHADOW_MARGIN}px;\n        border-radius: 14px;\n        box-shadow: 0 10px 28px rgba(22, 32, 26, .25), 0 2px 9px rgba(22, 32, 26, .16);\n        transition: transform .32s ease, opacity .32s ease;\n      }\n      .shadow.lift { transform: scale(.955); opacity: .38; }',
  'shadow html lift style')

patch('electron/window-shadow.ts',
  'interface WindowShadowController {\n  shadow: BrowserWindow\n  sync(): void\n  showBehind(): void\n}',
  'interface WindowShadowController {\n  shadow: BrowserWindow\n  sync(): void\n  showBehind(): void\n  /** 模式翻转时的「抬升-回落」脉冲：影子随卡片抬起而收拢变淡。 */\n  pulse(): void\n}',
  'controller interface')

patch('electron/window-shadow.ts',
  '    showBehind() {\n      if (window.isDestroyed() || shadow.isDestroyed() || window.isMinimized() || !window.isVisible()) return\n      this.sync()\n      shadow.showInactive()',
  '    pulse() {\n      if (window.isDestroyed() || shadow.isDestroyed()) return\n      void shadow.webContents.executeJavaScript(\n        "const s=document.querySelector(\'.shadow\');s.classList.add(\'lift\');setTimeout(()=>s.classList.remove(\'lift\'),620)",\n      ).catch(() => undefined)\n    },\n    showBehind() {\n      if (window.isDestroyed() || shadow.isDestroyed() || window.isMinimized() || !window.isVisible()) return\n      this.sync()\n      shadow.showInactive()',
  'controller pulse impl')

patch('electron/window-shadow.ts',
  'export function syncWindowShadow(window: BrowserWindow): void {\n  controllers.get(window)?.sync()\n}',
  'export function syncWindowShadow(window: BrowserWindow): void {\n  controllers.get(window)?.sync()\n}\n\n/** 模式翻转时的阴影脉冲（卡片抬起，影子收拢变淡后恢复）。 */\nexport function pulseWindowShadow(window: BrowserWindow): void {\n  controllers.get(window)?.pulse()\n}',
  'export pulseWindowShadow')

// 2. constants.ts：通道
patch('src/constants.ts',
  "  windowFlipPulse: 'window:flip-pulse',", "  windowFlipPulse: 'window:flip-pulse',", 'noop-anchor')
// 上面若无锚点则追加：用两种策略
{
  let s = fs.readFileSync('src/constants.ts', 'utf8')
  if (!s.includes("windowFlipPulse")) {
    const anchor = '  windowClose: \'window:close\','
    if (!s.includes(anchor)) throw new Error('NO MATCH: constants anchor')
    s = s.replace(anchor, anchor + '\n  windowFlipPulse: \'window:flip-pulse\',')
    fs.writeFileSync('src/constants.ts', s)
  }
  console.log('ok: constants channel')
  n++
}

// 3. preload.ts
patch('electron/preload.ts',
  '  closeWindow: () => ipcRenderer.invoke(IPC.windowClose),',
  '  closeWindow: () => ipcRenderer.invoke(IPC.windowClose),\n  pulseWindowShadow: () => ipcRenderer.invoke(IPC.windowFlipPulse),',
  'preload method')

// 4. types.ts：LauncherApi 声明合并
patch('src/types.ts',
  '/** 轮椅模式所需的渲染端 API 增量（声明合并进 LauncherApi）。 */\nexport interface LauncherApi {',
  '/** 轮椅模式所需的渲染端 API 增量（声明合并进 LauncherApi）。 */\nexport interface LauncherApi {\n  /** 模式翻转时通知主进程：阴影窗播放「抬升-回落」脉冲。 */\n  pulseWindowShadow(): Promise<void>',
  'types LauncherApi')

// 5. demo-api.ts：桩
patch('src/demo-api.ts',
  '  presetsBuiltin: async () => [],',
  '  presetsBuiltin: async () => [],\n  pulseWindowShadow: async () => undefined,',
  'demo-api stub')

// 6. ipc.ts：导入 + handler
patch('electron/ipc.ts',
  "import { matchSkillsShTarget } from './skills-sh'",
  "import { matchSkillsShTarget } from './skills-sh'\nimport { pulseWindowShadow } from './window-shadow'",
  'ipc import')
patch('  ipcMain.handle(IPC.windowClose, () => {',
  '  // 模式翻转：通知阴影窗播放抬升脉冲（卡片抬起，影子收拢）。\n  ipcMain.handle(IPC.windowFlipPulse, () => {\n    const window = deps.getWindow()\n    if (window) pulseWindowShadow(window)\n  })\n  ipcMain.handle(IPC.windowClose, () => {',
  'ipc handler')

// 7. App.tsx：翻转开始时调用
patch('src/App.tsx',
  "    modeFlipRef.current = direction\n    // View Transitions 优先",
  "    modeFlipRef.current = direction\n    void api.pulseWindowShadow().catch(() => undefined)\n    // View Transitions 优先",
  'App pulse call')

console.log('total:', n)
