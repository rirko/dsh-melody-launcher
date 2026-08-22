import { AppWindow, CircleAlert, CircleCheck, CircleStop, ExternalLink, LoaderCircle, Pause, Play, SquareTerminal, Wrench } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import type { AppSettings, InstallProgress, InstalledApplicationAddon, RuntimeOutput, RuntimeState } from '../types'

/** 运行与日志页：进程状态、启动参数与实时输出。 */

export interface RuntimeViewProps {
  runtime: RuntimeState
  settings: AppSettings
  logs: RuntimeOutput[]
  installProgress: InstallProgress | null
  busy: boolean
  onToggleRuntime: () => void
  onPauseDownload: () => void
  onOpenHarness: () => void
  onClearLogs: () => void
  onRepairRuntime: () => void
  aiActive: boolean
  activeRuntimeReplacement: InstalledApplicationAddon | null
  compact?: boolean
}

export function RuntimeView({
  runtime,
  settings,
  logs,
  installProgress,
  busy,
  onToggleRuntime,
  onPauseDownload,
  onOpenHarness,
  onClearLogs,
  onRepairRuntime,
  aiActive,
  activeRuntimeReplacement,
  compact = false,
}: RuntimeViewProps) {
  const logEnd = useRef<HTMLDivElement>(null)
  const progressSample = useRef<{ repository: string; bytes: number; timestamp: number } | null>(null)
  const [downloadSpeed, setDownloadSpeed] = useState(0)

  const downloadVisible = installProgress !== null && installProgress.phase !== 'complete'
  const downloadActive = downloadVisible && installProgress?.phase !== 'error'
  const downloadFailed = downloadVisible && installProgress?.phase === 'error'
  const canPauseDownload = downloadActive && installProgress?.kind === 'dsh'
  const downloadPercent = installProgress?.percent ?? 0
  const downloadName = installProgress ? formatInstallName(installProgress) : ''
  const downloadStatus = installProgress ? progressStatus(installProgress.phase) : ''
  const downloadSize = installProgress ? formatDownloadSize(installProgress) : ''

  useEffect(() => {
    if (!installProgress || installProgress.phase === 'complete' || installProgress.phase === 'error' || installProgress.downloadedBytes == null) {
      progressSample.current = null
      setDownloadSpeed(0)
      return
    }
    const now = Date.now()
    const bytes = installProgress.downloadedBytes
    const previous = progressSample.current
    if (!previous || previous.repository !== installProgress.repository || bytes < previous.bytes) {
      progressSample.current = { repository: installProgress.repository, bytes, timestamp: now }
      setDownloadSpeed(0)
      return
    }
    const elapsed = now - previous.timestamp
    if (elapsed < 250) return
    const instant = Math.max(0, Math.round((bytes - previous.bytes) * 1000 / elapsed))
    progressSample.current = { repository: installProgress.repository, bytes, timestamp: now }
    setDownloadSpeed(current => current > 0 ? Math.round(current * 0.65 + instant * 0.35) : instant)
  }, [installProgress?.repository, installProgress?.phase, installProgress?.downloadedBytes])

  // 新日志到达时保持视图贴在底部。
  useEffect(() => {
    logEnd.current?.scrollIntoView?.({ block: 'nearest' })
  }, [logs])

  if (compact) {
    // 保留完整终端输出，由半隐藏抽屉内的日志框负责滚动，调整抽屉高度时可显示更多记录。
    const compactLogs = logs
    return (
      <div className="runtime-compact-page">
        <div className="runtime-compact-log" role="log" aria-live="polite">
            {compactLogs.length === 0 ? <div className="log-empty"><SquareTerminal size={19} /><span>暂无输出</span></div> : compactLogs.map((log, index) => (
              <div className={`log-line ${log.level}`} key={`${log.timestamp}-${index}`}>
                <time>{new Date(log.timestamp).toLocaleTimeString('zh-CN', { hour12: false })}</time>
                <span className="log-channel">{log.channel === 'plugin' ? 'PLUGIN' : log.channel === 'test' ? 'TEST' : log.channel === 'ai' ? 'COPILOT' : 'DSH'}</span>
                <pre>{log.text}</pre>
              </div>
            ))}
            <div ref={logEnd} />
        </div>
      </div>
    )
  }

  return (
    <div className="page runtime-page">
      <section className={`runtime-band ${runtime.running ? 'running' : ''} ${downloadActive ? 'downloading' : ''} ${downloadFailed ? 'download-error' : ''}`}>
        <div className="runtime-status-icon">{downloadActive ? <LoaderCircle className="spin" size={25} /> : downloadFailed ? <CircleAlert size={25} /> : activeRuntimeReplacement ? <AppWindow size={25} /> : runtime.running ? <CircleCheck size={25} /> : <CircleStop size={25} />}</div>
        <div className="runtime-copy"><span>{downloadVisible ? downloadName : runtime.running ? `${runtime.applicationAddonName ?? 'DSH'} 正在运行` : 'DSH 当前已停止'}</span><strong>{downloadVisible ? downloadStatus : runtime.running ? runtime.url ?? (runtime.launchMode === 'application-replacement' ? '桌面宿主已启动' : '正在等待 Web 地址…') : activeRuntimeReplacement ? `准备启动 ${activeRuntimeReplacement.name}` : '准备从本地启动'}</strong></div>
        <div className="runtime-metadata">{downloadVisible ? <><span>下载速度 <strong>{formatRate(downloadSpeed)}</strong></span><span>下载大小 <strong>{downloadSize}</strong></span><span>下载进度 <strong>{downloadPercent}%</strong></span></> : <><span>配置 <strong>{activeRuntimeReplacement?.name ?? settings.profileName}</strong></span><span>{runtime.pid ? `PID ${runtime.pid}` : '无活动进程'}{activeRuntimeReplacement ? ' · 应用宿主' : ` · 端口 ${runtime.port ?? settings.webPort}`}</span></>}</div>
        {runtime.url && <button type="button" className="secondary-button" onClick={onOpenHarness}>打开工作台<ExternalLink size={15} /></button>}
        {!runtime.running && runtime.lastFailure && (
          <button type="button" className="secondary-button accent runtime-repair-button" onClick={onRepairRuntime} disabled={busy || aiActive} title="调用 DSH Flash 模型分析最近一次启动错误并尝试修复">
            {aiActive ? <LoaderCircle className="spin" size={16} /> : <Wrench size={16} />}
            AI 分析并修复
          </button>
        )}
        <button type="button" className={`primary-command ${runtime.running ? 'stop' : ''}`} onClick={canPauseDownload ? onPauseDownload : onToggleRuntime} disabled={canPauseDownload ? false : busy}>
          {canPauseDownload ? <Pause size={17} /> : busy ? <LoaderCircle className="spin" size={17} /> : runtime.running ? <CircleStop size={17} /> : <Play size={17} fill="currentColor" />}
          {canPauseDownload ? '暂停' : runtime.running ? '停止' : '启动'}
        </button>
        {downloadActive && <div className="runtime-download-progress"><div><span>{installProgress?.message}</span><strong>{downloadPercent}%</strong></div><div className="progress-track"><span style={{ width: `${Math.max(0, Math.min(100, downloadPercent))}%` }} /></div></div>}
      </section>

      <div className="launch-facts">
        <div><span>启动命令</span><code>{activeRuntimeReplacement ? `${activeRuntimeReplacement.packageName}@${activeRuntimeReplacement.version}` : `${settings.launchExecutable} ${settings.launchArgs.join(' ')}`}</code></div>
        <div><span>工作目录</span><code>{settings.workspace}</code></div>
        <div><span>DSH_HOME</span><code>{settings.dshHome}</code></div>
        <div><span>启动模式</span><code>{activeRuntimeReplacement ? '应用加载项替代 Web' : runtime.port ? `Web · ${runtime.port}（当前）` : `Web · ${settings.webPort}（首选）`}</code></div>
      </div>

      <section className="log-panel">
        <header><div><SquareTerminal size={17} /><strong>运行日志</strong><span>{logs.length} 条</span></div><button type="button" onClick={onClearLogs} disabled={logs.length === 0}>清空</button></header>
        <div className="log-output" role="log" aria-live="polite">
          {logs.length === 0 ? (
            <div className="log-empty"><SquareTerminal size={22} /><span>启动 DSH 后，输出会显示在这里。</span></div>
          ) : logs.map((log, index) => (
            <div className={`log-line ${log.level}`} key={`${log.timestamp}-${index}`}>
              <time>{new Date(log.timestamp).toLocaleTimeString('zh-CN', { hour12: false })}</time>
              <span className="log-channel">{log.channel === 'plugin' ? 'PLUGIN' : log.channel === 'test' ? 'TEST' : log.channel === 'ai' ? 'COPILOT' : 'DSH'}</span>
              <pre>{log.text}</pre>
            </div>
          ))}
          <div ref={logEnd} />
        </div>
      </section>
    </div>
  )
}

function formatInstallName(progress: InstallProgress): string {
  const source = progress.repository.split('/').filter(Boolean).at(-1) ?? progress.repository
  const kind = progress.kind === 'dsh' ? 'DSH' : progress.kind === 'application' ? '应用加载项' : progress.kind === 'skill' ? 'Skill' : progress.kind === 'preset' ? '预设' : '插件'
  return `${kind} · ${source}`
}

function progressStatus(phase: InstallProgress['phase']): string {
  if (phase === 'preparing' || phase === 'resolving') return '即将下载'
  if (phase === 'downloading') return '正在下载'
  if (phase === 'building') return '正在构建'
  if (phase === 'configuring' || phase === 'verifying') return '正在完成安装'
  if (phase === 'error') return '下载失败'
  return '已完成'
}

function formatDownloadSize(progress: InstallProgress): string {
  const downloaded = progress.downloadedBytes
  const total = progress.totalBytes
  if (downloaded == null && total == null) return '大小待定'
  if (total == null) return `${formatBytes(downloaded ?? 0)} / 未知大小`
  return `${formatBytes(downloaded ?? 0)} / ${formatBytes(total)}`
}

function formatRate(bytesPerSecond: number): string {
  return bytesPerSecond > 0 ? `${formatBytes(bytesPerSecond)}/秒` : '计算中'
}

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '0 B'
  if (bytes < 1024) return `${Math.round(bytes)} B`
  const units = ['KB', 'MB', 'GB']
  let value = bytes / 1024
  let unit = units[0]
  for (let index = 0; index < units.length - 1 && value >= 1024; index += 1) {
    value /= 1024
    unit = units[index + 1]!
  }
  return `${value.toFixed(value >= 100 ? 0 : value >= 10 ? 1 : 2)} ${unit}`
}
