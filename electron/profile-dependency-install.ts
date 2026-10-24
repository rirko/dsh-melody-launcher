import type { CommandResult } from './command'

export interface ProfileDependencyInstallOptions {
  profileName: string
  profileDirectory: string
  storeDirectory: string
  registry: string
  execute: (args: string[]) => Promise<CommandResult>
  onOfflineMiss?: () => void
}

/** Only incomplete offline caches justify retrying against the configured registry. */
export async function installProfileDependencies(options: ProfileDependencyInstallOptions): Promise<void> {
  const args = [
    'install', '--dir', options.profileDirectory,
    '--ignore-scripts', '--prod', '--no-frozen-lockfile',
    '--config.auto-install-peers=false', '--store-dir', options.storeDirectory,
    `--registry=${options.registry}`, '--fetch-timeout=600000',
  ]
  let result = await options.execute([...args, '--offline'])
  if (result.exitCode !== 0 && /\bERR_PNPM_(?:NO_OFFLINE_META|NO_OFFLINE_TARBALL|NO_OFFLINE_PACKAGE|OFFLINE_META_NOT_FOUND)\b/.test(result.output)) {
    options.onOfflineMiss?.()
    result = await options.execute(args)
  }
  if (result.exitCode !== 0) {
    const detail = result.output.trim().slice(-6000)
    throw new Error(`Profile「${options.profileName}」依赖补齐失败（退出码 ${result.exitCode}）：${detail || '命令未返回错误详情。'}`)
  }
}
