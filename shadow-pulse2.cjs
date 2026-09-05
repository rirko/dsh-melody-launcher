const fs = require('fs')
let n = 0
function patch(file, pattern, to, tag) {
  let s = fs.readFileSync(file, 'utf8')
  const re = new RegExp(pattern)
  if (!re.test(s)) throw new Error('NO MATCH [' + file + ']: ' + tag)
  s = s.replace(re, () => to)
  fs.writeFileSync(file, s)
  n++
  console.log('ok:', tag)
}

// 1. window-shadow.ts
patch('electron/window-shadow.ts',
  '(\\.shadow \\{[^}]*box-shadow: 0 10px 28px rgba\\(22, 32, 26, \\.25\\), 0 2px 9px rgba\\(22, 32, 26, \\.16\\);)',
  '$1\n        transition: transform .32s ease, opacity .32s ease;',
  'shadow transition style')
patch('electron/window-shadow.ts',
  '(\\.shadow \\{[^}]*\\})',
  '$1\n      .shadow.lift { transform: scale(.955); opacity: .38; }',
  'shadow lift rule')
patch('electron/window-shadow.ts',
  'interface WindowShadowController \\{\r?\\n  shadow: BrowserWindow\\r?\\n  sync\\(\\): void\\r?\\n  showBehind\\(\\): void\\r?\\n\\}',
  'interface WindowShadowController {\n  shadow: BrowserWindow\n  sync(): void\n  showBehind(): void\n  /** 模式翻转时的「抬升-回落」脉冲：影子随卡片抬起而收拢变淡。 */\n  pulse(): void\n}',
  'controller interface')
patch('electron/window-shadow.ts',
  '(    showBehind\\(\\) \\{\\r?\\n)',
  '    pulse() {\n      if (window.isDestroyed() || shadow.isDestroyed()) return\n      void shadow.webContents.executeJavaScript(\n        "const s=document.querySelector(\'.shadow\');s.classList.add(\'lift\');setTimeout(()=>s.classList.remove(\'lift\'),620)",\n      ).catch(() => undefined)\n    },\n',
  'controller pulse impl')
patch('electron/window-shadow.ts',
  '(export function syncWindowShadow\\(window: BrowserWindow\\): void \\{\\r?\\n  controllers\\.get\\(window\\)\\?\\.sync\\(\\)\\r?\\n\\})',
  '$1\n\n/** 模式翻转时的阴影脉冲（卡片抬起，影子收拢变淡后恢复）。 */\nexport function pulseWindowShadow(window: BrowserWindow): void {\n  controllers.get(window)?.pulse()\n}',
  'export pulseWindowShadow')

// 2. constants.ts
{
  let s = fs.readFileSync('src/constants.ts', 'utf8')
  if (!s.includes('windowFlipPulse')) {
    const anchor = "  windowClose: 'window:close',"
    if (!s.includes(anchor)) throw new Error('NO MATCH: constants anchor')
    s = s.replace(anchor, anchor + '\r\n  windowFlipPulse: \'window:flip-pulse\',')
    fs.writeFileSync('src/constants.ts', s)
  }
  n++
  console.log('ok: constants channel')
}

// 3. preload.ts
patch('electron/preload.ts',
  "(  closeWindow: \\(\\) => ipcRenderer\\.invoke\\(IPC\\.windowClose\\),\\r?\\n)",
  "$1  pulseWindowShadow: () => ipcRenderer.invoke(IPC.windowFlipPulse),\r\n",
  'preload method')

// 4. types.ts
patch('src/types.ts',
  '(/\\*\\* 轮椅模式所需的渲染端 API 增量（声明合并进 LauncherApi）。 \\*/\\r?\\nexport interface LauncherApi \\{\\r?\\n)',
  '$1  /** 模式翻转时通知主进程：阴影窗播放「抬升-回落」脉冲。 */\n  pulseWindowShadow(): Promise<void>\n',
  'types LauncherApi')

// 5. demo-api.ts
patch('src/demo-api.ts',
  '(  presetsBuiltin: async \\(\\) => \\[\\],\\r?\\n)',
  '$1  pulseWindowShadow: async () => undefined,\r\n',
  'demo-api stub')

// 6. ipc.ts
patch('electron/ipc.ts',
  "(  ipcMain\\.handle\\(IPC\\.windowClose, \\(\\) => \\{\\r?\\n)",
  '  // 模式翻转：通知阴影窗播放抬升脉冲（卡片抬起，影子收拢）。\r\n  ipcMain.handle(IPC.windowFlipPulse, () => {\r\n    const window = deps.getWindow()\r\n    if (window) pulseWindowShadow(window)\r\n  })\r\n$1',
  'ipc handler')
{
  let s = fs.readFileSync('electron/ipc.ts', 'utf8')
  if (!s.includes("pulseWindowShadow } from './window-shadow'")) {
    s = s.replace("import { matchSkillsShTarget } from './skills-sh'",
      "import { matchSkillsShTarget } from './skills-sh'\nimport { pulseWindowShadow } from './window-shadow'")
    fs.writeFileSync('electron/ipc.ts', s)
  }
  n++
  console.log('ok: ipc import')
}

// 7. App.tsx
patch('src/App.tsx',
  '(    modeFlipRef\\.current = direction\\r?\\n)(    // View Transitions 优先)',
  '$1    void api.pulseWindowShadow().catch(() => undefined)\r\n$2',
  'App pulse call')

console.log('total:', n)
