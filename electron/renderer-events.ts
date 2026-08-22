import { IPC_EVENTS } from '../src/constants'
import type { AiInstallEvent, AiSessionEvent, DshMarketProgress, InstallProgress, LauncherUpdateProgress, PackProgressEvent, PluginTrialResult, RuntimeOutput, RuntimeState } from '../src/types'
import type { RendererChannel } from './app-window'

/** 主进程主动推送给渲染层的三类事件，统一在这里成形与发送。 */

/** 子进程输出里 CRLF 与尾部空白会让日志面板出现空行。 */
export function normalizeOutputText(text: string): string {
  // npm/pnpm 在非 TTY 子进程里仍可能用单独的 CR 刷新进度；转换成换行，
  // 否则放进 HTML <pre> 后会表现为一条被反复覆盖的“当前状态”。
  return text.replace(/\r\n/g, '\n').replace(/\r/g, '\n').trimEnd()
}

export interface RendererEvents {
  output(source: RuntimeOutput['channel'], level: RuntimeOutput['level'], text: string): void
  runtimeState(state: RuntimeState): void
  installProgress(progress: InstallProgress): void
  launcherUpdateProgress(progress: LauncherUpdateProgress): void
  pluginTrial(result: PluginTrialResult): void
  aiInstallEvent(event: AiInstallEvent): void
  aiSessionEvent(event: AiSessionEvent): void
  packProgress(event: PackProgressEvent): void
  dshMarketProgress(progress: DshMarketProgress): void
}

export function createRendererEvents(
  channel: RendererChannel,
  timestamp: () => string = () => new Date().toISOString(),
): RendererEvents {
  return {
    output(source, level, text) {
      const normalized = normalizeOutputText(text)
      if (!normalized) return
      const payload: RuntimeOutput = { channel: source, level, text: normalized, timestamp: timestamp() }
      channel.send(IPC_EVENTS.runtimeOutput, payload)
    },
    runtimeState(state) {
      channel.send(IPC_EVENTS.runtimeStateChanged, state)
    },
    installProgress(progress) {
      channel.send(IPC_EVENTS.installProgress, progress)
    },
    launcherUpdateProgress(progress) {
      channel.send(IPC_EVENTS.launcherUpdateProgress, progress)
    },
    pluginTrial(result) {
      channel.send(IPC_EVENTS.pluginTrialEvent, result)
    },
    aiInstallEvent(event) {
      channel.send(IPC_EVENTS.aiInstallEvent, event)
    },
    aiSessionEvent(event) {
      channel.send(IPC_EVENTS.aiSessionEvent, event)
    },
    packProgress(event) {
      channel.send(IPC_EVENTS.packProgress, event)
    },
    dshMarketProgress(progress) {
      channel.send(IPC_EVENTS.dshMarketProgress, progress)
    },
  }
}
