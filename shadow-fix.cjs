const fs = require('fs')
let n = 0
function insertAfterLine(file, anchor, insertion, tag) {
  let s = fs.readFileSync(file, 'utf8')
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

// 1. 修复被破坏的 .shadow 规则 + 加 lift 规则（注意到原文件用 ${SHADOW_MARGIN} 插值）
replaceOnce('electron/window-shadow.ts',
  '      $1\n        transition: transform .32s ease, opacity .32s ease;\n      }',
  '      .shadow {\n        position: absolute;\n        inset: ${SHADOW_MARGIN}px;\n        border-radius: 14px;\n        box-shadow: 0 10px 28px rgba(22, 32, 26, .25), 0 2px 9px rgba(22, 32, 26, .16);\n        transition: transform .32s ease, opacity .32s ease;\n      }\n      .shadow.lift { transform: scale(.955); opacity: .38; }',
  'repair .shadow rule')

// 2. 控制器接口加 pulse
replaceOnce('electron/window-shadow.ts',
  '  showBehind(): void\n}',
  '  showBehind(): void\n  /** 模式翻转时的「抬升-回落」脉冲：影子随卡片抬起而收拢变淡。 */\n  pulse(): void\n}',
  'controller interface')

// 3. pulse 实现（插在 showBehind 方法前）
insertAfterLine('electron/window-shadow.ts',
  '  const controller: WindowShadowController = {',
  '    pulse() {\n      if (window.isDestroyed() || shadow.isDestroyed()) return\n      void shadow.webContents.executeJavaScript(\n        "const s=document.querySelector(\'.shadow\');s.classList.add(\'lift\');setTimeout(()=>s.classList.remove(\'lift\'),620)",\n      ).catch(() => undefined)\n    },\n',
  'controller pulse impl')

// 4. 导出 pulseWindowShadow（追加到文件末尾）
{
  let s = fs.readFileSync('electron/window-shadow.ts', 'utf8')
  if (!s.includes('export function pulseWindowShadow')) {
    s = s.replace(/\s*$/, '\n\n/** 模式翻转时的阴影脉冲（卡片抬起，影子收拢变淡后恢复）。 */\nexport function pulseWindowShadow(window: BrowserWindow): void {\n  controllers.get(window)?.pulse()\n}\n')
    fs.writeFileSync('electron/window-shadow.ts', s)
  }
  n++
  console.log('ok: export pulseWindowShadow')
}

// 5. constants 通道
{
  let s = fs.readFileSync('src/constants.ts', 'utf8')
  if (!s.includes('windowFlipPulse')) {
    insertAfterLine('src/constants.ts', "  windowClose: 'window:close',", "  windowFlipPulse: 'window:flip-pulse',", 'constants channel')
  } else { n++; console.log('ok: constants channel (already)') }
}

// 6. preload 方法
insertAfterLine('electron/preload.ts',
  '  closeWindow: () => ipcRenderer.invoke(IPC.windowClose),',
  '  pulseWindowShadow: () => ipcRenderer.invoke(IPC.windowFlipPulse),',
  'preload method')

// 7. types 声明合并
insertAfterLine('src/types.ts',
  'export interface LauncherApi {',
  '  /** 模式翻转时通知主进程：阴影窗播放「抬升-回落」脉冲。 */\n  pulseWindowShadow(): Promise<void>',
  'types LauncherApi')

// 8. demo-api 桩
insertAfterLine('src/demo-api.ts',
  '  presetsBuiltin: async () => [],',
  '  pulseWindowShadow: async () => undefined,',
  'demo-api stub')

// 9. ipc handler + import
insertAfterLine('electron/ipc.ts',
  '  ipcMain.handle(IPC.windowClose, () => {',
  '  // 模式翻转：通知阴影窗播放抬升脉冲（卡片抬起，影子收拢）。\n  ipcMain.handle(IPC.windowFlipPulse, () => {\n    const window = deps.getWindow()\n    if (window) pulseWindowShadow(window)\n  })',
  'ipc handler')
{
  let s = fs.readFileSync('electron/ipc.ts', 'utf8')
  if (!s.includes("from './window-shadow'")) {
    insertAfterLine('electron/ipc.ts', "import { matchSkillsShTarget } from './skills-sh'", "import { pulseWindowShadow } from './window-shadow'", 'ipc import')
  } else { n++; console.log('ok: ipc import (already)') }
}

// 10. App 翻转时调用
{
  let s = fs.readFileSync('src/App.tsx', 'utf8')
  if (!s.includes('api.pulseWindowShadow()')) {
    insertAfterLine('src/App.tsx', '    modeFlipRef.current = direction', '    void api.pulseWindowShadow().catch(() => undefined)', 'App pulse call')
  } else { n++; console.log('ok: App pulse call (already)') }
}

console.log('total:', n)
