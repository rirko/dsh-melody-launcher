const fs = require('fs')
let n = 0
function insertAfterLine(file, anchor, insertion, tag) {
  let s = fs.readFileSync(file, 'utf8')
  const marker = insertion.trim().split('\n')[0]
  if (s.includes(marker)) { n++; console.log('ok (already):', tag); return }
  const i = s.indexOf(anchor)
  if (i < 0) throw new Error('anchor not found: ' + tag)
  const lineEnd = s.indexOf('\n', i + anchor.length)
  const at = lineEnd < 0 ? s.length : lineEnd + 1
  s = s.slice(0, at) + insertion + s.slice(at)
  fs.writeFileSync(file, s)
  n++
  console.log('ok:', tag)
}
function replaceOnce(file, from, to, tag) {
  let s = fs.readFileSync(file, 'utf8')
  if (!s.includes(from)) throw new Error('anchor not found: ' + tag)
  s = s.replace(from, to)
  fs.writeFileSync(file, s)
  n++
  console.log('ok:', tag)
}

const file = 'electron/window-shadow.ts'
let ws = fs.readFileSync(file, 'utf8')
// 1. $1 残骸修复（若在）
if (ws.includes('      $1\n')) {
  replaceOnce(file, '      $1\n',
    '      .shadow {\n        position: absolute;\n        inset: ${SHADOW_MARGIN}px;\n        border-radius: 14px;\n        box-shadow: 0 10px 28px rgba(22, 32, 26, .25), 0 2px 9px rgba(22, 32, 26, .16);\n',
    'repair rule head')
}
// 2. lift 规则
if (!ws.includes('.shadow.lift')) {
  insertAfterLine(file, 'transition: transform .32s ease, opacity .32s ease;',
    '      .shadow.lift { transform: scale(.955); opacity: .38; }',
    'lift rule')
}
// 3. 控制器接口加 pulse
if (!ws.includes('  pulse(): void')) {
  insertAfterLine(file, '  showBehind(): void',
    '\n  /** 模式翻转时的「抬升-回落」脉冲：影子随卡片抬起而收拢变淡。 */\n  pulse(): void',
    'controller interface')
}
// 4. pulse 实现
if (!ws.includes("s.classList.add('lift')")) {
  insertAfterLine(file, '  const controller: WindowShadowController = {',
    '    pulse() {\n      if (window.isDestroyed() || shadow.isDestroyed()) return\n      void shadow.webContents.executeJavaScript(\n        "const s=document.querySelector(\'.shadow\');s.classList.add(\'lift\');setTimeout(()=>s.classList.remove(\'lift\'),620)",\n      ).catch(() => undefined)\n    },\n',
    'controller pulse impl')
}
// 5. 导出
if (!ws.includes('export function pulseWindowShadow')) {
  ws = ws.replace(/\s*$/, '\n\n/** 模式翻转时的阴影脉冲（卡片抬起，影子收拢变淡后恢复）。 */\nexport function pulseWindowShadow(window: BrowserWindow): void {\n  controllers.get(window)?.pulse()\n}\n')
  fs.writeFileSync(file, ws)
  n++
  console.log('ok: export pulseWindowShadow')
} else { n++; console.log('ok: export (already)') }

// 6. constants
if (!fs.readFileSync('src/constants.ts', 'utf8').includes('windowFlipPulse')) {
  insertAfterLine('src/constants.ts', "  windowClose: 'window:close',", "  windowFlipPulse: 'window:flip-pulse',", 'constants channel')
} else { n++; console.log('ok: constants (already)') }
// 7. preload
if (!fs.readFileSync('electron/preload.ts', 'utf8').includes('pulseWindowShadow')) {
  insertAfterLine('electron/preload.ts',
    '  closeWindow: () => ipcRenderer.invoke(IPC.windowClose),',
    '  pulseWindowShadow: () => ipcRenderer.invoke(IPC.windowFlipPulse),',
    'preload method')
} else { n++; console.log('ok: preload (already)') }
// 8. types
if (!fs.readFileSync('src/types.ts', 'utf8').includes('pulseWindowShadow(): Promise<void>')) {
  insertAfterLine('src/types.ts',
    'export interface LauncherApi {',
    '  /** 模式翻转时通知主进程：阴影窗播放「抬升-回落」脉冲。 */\n  pulseWindowShadow(): Promise<void>',
    'types LauncherApi')
} else { n++; console.log('ok: types (already)') }
// 9. demo-api
if (!fs.readFileSync('src/demo-api.ts', 'utf8').includes('pulseWindowShadow')) {
  insertAfterLine('src/demo-api.ts',
    '  presetsBuiltin: async () => [],',
    '  pulseWindowShadow: async () => undefined,',
    'demo-api stub')
} else { n++; console.log('ok: demo-api (already)') }
// 10. ipc handler
if (!fs.readFileSync('electron/ipc.ts', 'utf8').includes('IPC.windowFlipPulse')) {
  insertAfterLine('electron/ipc.ts',
    '  ipcMain.handle(IPC.windowClose, () => {',
    '  // 模式翻转：通知阴影窗播放抬升脉冲（卡片抬起，影子收拢）。\n  ipcMain.handle(IPC.windowFlipPulse, () => {\n    const window = deps.getWindow()\n    if (window) pulseWindowShadow(window)\n  })',
    'ipc handler')
} else { n++; console.log('ok: ipc handler (already)') }
// 11. ipc import
if (!fs.readFileSync('electron/ipc.ts', 'utf8').includes("from './window-shadow'")) {
  insertAfterLine('electron/ipc.ts', "import { matchSkillsShTarget } from './skills-sh'", "import { pulseWindowShadow } from './window-shadow'", 'ipc import')
} else { n++; console.log('ok: ipc import (already)') }
// 12. App 调用
if (!fs.readFileSync('src/App.tsx', 'utf8').includes('api.pulseWindowShadow()')) {
  insertAfterLine('src/App.tsx', '    modeFlipRef.current = direction', '    void api.pulseWindowShadow().catch(() => undefined)', 'App pulse call')
} else { n++; console.log('ok: App call (already)') }

console.log('total:', n)
