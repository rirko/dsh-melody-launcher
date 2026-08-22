import { ChevronDown, ChevronUp } from 'lucide-react'
import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react'
import { RuntimeView, type RuntimeViewProps } from '../views/RuntimeView'
import type { RuntimeDrawerMode } from '../types'
import { clampRuntimeDrawerHeight, nextRuntimeDrawerMode } from '../lib/runtime-drawer'
import { isInstallProgressActive } from '../lib/install-progress'

interface RuntimeDrawerProps extends Omit<RuntimeViewProps, 'compact'> {
  mode: RuntimeDrawerMode
  height: number
  onModeChange: (mode: RuntimeDrawerMode) => void
  onHeightChange: (height: number) => void
  onUserInteraction?: () => void
}

export function RuntimeDrawer({ mode, height, onModeChange, onHeightChange, onUserInteraction, installProgress, runtime, logs, ...runtimeProps }: RuntimeDrawerProps) {
  const [resizing, setResizing] = useState(false)
  const dragStart = useRef<{ y: number; height: number } | null>(null)
  const activeDownload = isInstallProgressActive(installProgress)
  const failedDownload = installProgress?.phase === 'error'
  const downloadPercent = Math.max(0, Math.min(100, installProgress?.percent ?? 0))
  const downloadName = installProgress ? formatInstallName(installProgress) : ''
  const idle = !activeDownload && !failedDownload && !runtime.running
  const runningText = runtime.running ? `${runtime.applicationAddonName ?? 'DSH'} 正在运行` : ''

  useEffect(() => {
    if (!resizing) return
    const handleMove = (event: PointerEvent) => {
      const start = dragStart.current
      if (!start) return
      const nextHeight = clampRuntimeDrawerHeight(start.height + start.y - event.clientY)
      onHeightChange(nextHeight)
    }
    const handleUp = () => {
      dragStart.current = null
      setResizing(false)
    }
    window.addEventListener('pointermove', handleMove)
    window.addEventListener('pointerup', handleUp, { once: true })
    return () => {
      window.removeEventListener('pointermove', handleMove)
      window.removeEventListener('pointerup', handleUp)
    }
  }, [onHeightChange, resizing])

  const cycleMode = () => {
    onModeChange(nextRuntimeDrawerMode(mode))
  }

  const startResize = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (mode === 'hidden') return
    event.preventDefault()
    dragStart.current = { y: event.clientY, height }
    setResizing(true)
  }

  const heightStyle = mode === 'expanded' ? '100%' : mode === 'hidden' ? undefined : `${height}px`
  const modeLabel = mode === 'hidden' ? '完全隐藏' : mode === 'half' ? '半隐藏' : '完全展示'

  return (
    <section
      className={`runtime-drawer runtime-drawer-${mode} ${resizing ? 'resizing' : ''}`}
      style={heightStyle ? { height: heightStyle } : undefined}
      aria-label="运行与日志"
      onPointerDown={onUserInteraction}
      onWheel={onUserInteraction}
    >
      {mode !== 'hidden' && <div className="runtime-drawer-resize" role="separator" aria-label="调整运行日志高度" onPointerDown={startResize} />}
      <button type="button" className="runtime-drawer-handle" onClick={cycleMode} aria-expanded={mode !== 'hidden'} aria-label={`运行与日志，当前${modeLabel}，点击切换`} title={`运行与日志 · ${modeLabel}`}>
        <span className={`runtime-drawer-handle-copy ${idle ? 'idle' : ''}`}>
          <strong>{idle ? '运行与日志 · 无活动内容' : activeDownload || failedDownload ? downloadName : '运行与日志'}</strong>
          {!idle && <small>{activeDownload ? `${progressStatus(installProgress?.phase)} · ${downloadPercent}%` : failedDownload ? '下载失败' : runningText}</small>}
        </span>
        {activeDownload && <span className="runtime-drawer-handle-progress" aria-label={`下载进度 ${downloadPercent}%`}><span style={{ width: `${downloadPercent}%` }} /></span>}
        <span
          className="runtime-drawer-handle-chevron"
          title={mode === 'half' ? '收回运行与日志' : undefined}
          onClick={event => {
            if (mode !== 'half') return
            event.stopPropagation()
            onModeChange('hidden')
          }}
        >
          {mode === 'hidden' ? <ChevronUp size={16} /> : <ChevronDown size={16} />}
        </span>
      </button>
      {mode !== 'hidden' && (
        <div className="runtime-drawer-content">
          <RuntimeView runtime={runtime} logs={logs} installProgress={installProgress} compact={mode === 'half'} {...runtimeProps} />
        </div>
      )}
    </section>
  )
}

function formatInstallName(progress: NonNullable<RuntimeDrawerProps['installProgress']>): string {
  const source = progress.repository.split('/').filter(Boolean).at(-1) ?? progress.repository
  const kind = progress.kind === 'dsh' ? 'DSH' : progress.kind === 'application' ? '应用加载项' : progress.kind === 'skill' ? 'Skill' : progress.kind === 'preset' ? '预设' : '插件'
  return `${kind} · ${source}`
}

function progressStatus(phase: NonNullable<RuntimeDrawerProps['installProgress']>['phase']): string {
  if (phase === 'preparing' || phase === 'resolving') return '即将下载'
  if (phase === 'downloading') return '正在下载'
  if (phase === 'building') return '正在构建'
  if (phase === 'configuring' || phase === 'verifying') return '正在完成安装'
  if (phase === 'error') return '下载失败'
  return '已完成'
}
