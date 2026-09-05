const fs = require('fs')
const file = 'electron/window-shadow.ts'
let s = fs.readFileSync(file, 'utf8')
let n = 0
function must(from, to, tag) {
  if (!s.includes(from)) throw new Error('NO MATCH: ' + tag)
  s = s.split(from).join(to)
  n++
  console.log('ok:', tag)
}

// 1. sync() 改为爆发计数确认（≥2 次连续 sync 才判定真拖动并隐藏），聚焦/显示时强制恢复
must(`    sync() {
      if (window.isDestroyed() || shadow.isDestroyed()) return
      shadow.setBounds(shadowBounds(window.getBounds()), false)
      // move/resize 事件爆发 = 正在拖动或拖拽边框：影子暂隐，停稳后淡回。
      void shadow.webContents.executeJavaScript(
        "const s=document.querySelector('.shadow');s.classList.add('drag-hide')",
      ).catch(() => undefined)
      if (dragHideTimer) clearTimeout(dragHideTimer)
      dragHideTimer = setTimeout(() => {
        dragHideTimer = null
        void shadow.webContents.executeJavaScript(
          "const s=document.querySelector('.shadow');s.classList.remove('drag-hide')",
        ).catch(() => undefined)
      }, 160)
    },`, `    sync() {
      if (window.isDestroyed() || shadow.isDestroyed()) return
      shadow.setBounds(shadowBounds(window.getBounds()), false)
      // move/resize 事件爆发 = 正在拖动或拖拽边框：连续 ≥2 次才判定为真拖动，
      // 影子暂隐避免异步跟手脱钩；启动/聚焦时的单次 sync 不隐藏。
      burstCount += 1
      if (burstCount >= 2 && !dragHidden) {
        dragHidden = true
        void shadow.webContents.executeJavaScript(
          "const s=document.querySelector('.shadow');s.classList.add('drag-hide')",
        ).catch(() => undefined)
      }
      if (dragHideTimer) clearTimeout(dragHideTimer)
      dragHideTimer = setTimeout(() => {
        dragHideTimer = null
        burstCount = 0
        this.restoreShadow()
      }, 180)
    },
    restoreShadow() {
      burstCount = 0
      if (dragHideTimer) {
        clearTimeout(dragHideTimer)
        dragHideTimer = null
      }
      if (!dragHidden) return
      dragHidden = false
      void shadow.webContents.executeJavaScript(
        "const s=document.querySelector('.shadow');s.classList.remove('drag-hide')",
      ).catch(() => undefined)
    },`)

// 2. 声明爆发计数变量
must('  // 拖动/缩放进行中收起影子：独立阴影窗跟手是异步的，移动中难免脱钩；\n  // 停稳 160ms 后淡回。隐藏状态每次爆发只通知一次，不逐 move 打 executeJavaScript。\n  let dragHidden = false\n  let dragHideTimer: NodeJS.Timeout | null = null',
  '  // 拖动/缩放进行中收起影子：独立阴影窗跟手是异步的，移动中难免脱钩——\n  // 连续 ≥2 次 sync 判定为真拖动后暂隐，停稳 180ms 淡回；聚焦/显示强制恢复。',
  'burst comment')

// 3. showBehind：同步之后强制恢复（聚焦/显示永远有影子）
must('    showBehind() {\n      if (window.isDestroyed() || shadow.isDestroyed() || window.isMinimized() || !window.isVisible()) return\n      this.sync()',
  '    showBehind() {\n      if (window.isDestroyed() || shadow.isDestroyed() || window.isMinimized() || !window.isVisible()) return\n      this.sync()\n      this.restoreShadow()',
  'showBehind restore')

// 4. dragHidden/dragHideTimer 声明补回（若上一步注释替换吞掉了变量声明）
if (!s.includes('let dragHidden = false')) {
  must('  const controller: WindowShadowController = {',
    '  let dragHidden = false\n  let dragHideTimer: NodeJS.Timeout | null = null\n\n  const controller: WindowShadowController = {',
    'drag state vars')
}
// 5. burstCount 声明
if (!s.includes('let burstCount = 0')) {
  must('  let dragHideTimer: NodeJS.Timeout | null = null',
    '  let burstCount = 0\n  let dragHideTimer: NodeJS.Timeout | null = null',
    'burstCount decl')
}

fs.writeFileSync(file, s)
console.log('total:', n)
