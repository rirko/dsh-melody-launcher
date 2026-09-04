import { existsSync } from 'node:fs'
import path from 'node:path'
import type { AppSettings, RuntimeOutput } from '../src/types'
import { runCommand, type CommandOptions, type CommandResult, type OutputLevel } from './command'
import { withExecutableDirectoryOnPath } from './process'
import type { NodeRuntime, PnpmRuntime } from './node-runtime'

/**
 * Options used to run maintenance against the launcher's private pnpm store.
 * The store is content addressed, so package-level deletion must be delegated
 * to pnpm rather than removing files from `files/` by name.
 */
export interface PnpmStorePrunerOptions {
  storeRoot: string
  readSettings: () => Promise<AppSettings>
  prepareNodeRuntime: () => Promise<NodeRuntime>
  preparePnpmRuntime: (nodeRuntime: NodeRuntime) => Promise<PnpmRuntime>
  /** Read-only resolvers used by uninstall so cache cleanup never downloads a runtime. */
  resolveNodeRuntime?: () => Promise<NodeRuntime | null>
  resolvePnpmRuntime?: (nodeRuntime: NodeRuntime) => Promise<PnpmRuntime | null>
  emitOutput: (level: RuntimeOutput['level'], text: string) => void
  runCommand?: (executable: string, args: string[], options: CommandOptions) => Promise<CommandResult>
}

const STORE_PRUNE_IDLE_TIMEOUT_MS = 5 * 60 * 1000

/**
 * Create a callback suitable for InstallerOptions.purgePnpmStore.
 *
 * `pnpm store prune` is intentionally used instead of `pnpm remove` or a
 * direct recursive delete. It only removes content-addressed entries that no
 * longer have package links, preserving packages still referenced by another
 * Profile. The command itself is local and does not resolve registry metadata;
 * offline config is also set in the environment as a guard against future
 * pnpm behavior changes.
 */
export function createPnpmStorePruner(options: PnpmStorePrunerOptions): (requestedStoreRoot: string) => Promise<void> {
  const execute = options.runCommand ?? runCommand
  const expectedRoot = path.resolve(options.storeRoot)

  return async (requestedStoreRoot: string): Promise<void> => {
    const actualRoot = path.resolve(requestedStoreRoot)
    if (actualRoot !== expectedRoot) {
      throw new Error('拒绝清理未由启动器管理的 pnpm store。')
    }

    // A missing store is already fully clean. Avoid preparing runtimes or
    // spawning pnpm in that case, which also keeps first-run uninstall local.
    if (!existsSync(actualRoot)) return

    const settings = await options.readSettings()
    const nodeRuntime = options.resolveNodeRuntime
      ? await options.resolveNodeRuntime()
      : await options.prepareNodeRuntime()
    if (!nodeRuntime) throw new Error('未找到已安装的 Node.js，已跳过 pnpm 缓存清理（不会联网下载运行时）。')
    const pnpmRuntime = options.resolvePnpmRuntime
      ? await options.resolvePnpmRuntime(nodeRuntime)
      : await options.preparePnpmRuntime(nodeRuntime)
    if (!pnpmRuntime) throw new Error('未找到已安装的 pnpm，已跳过 pnpm 缓存清理（不会联网下载运行时）。')
    const environment = withExecutableDirectoryOnPath(
      pnpmRuntime.executable,
      withExecutableDirectoryOnPath(nodeRuntime.node, {
        ...process.env,
        DSH_HOME: settings.dshHome,
        CI: 'true',
        npm_config_yes: 'true',
        NPM_CONFIG_YES: 'true',
        PNPM_CONFIG_YES: 'true',
        COREPACK_ENABLE_DOWNLOAD_PROMPT: '0',
        NPM_CONFIG_UPDATE_NOTIFIER: 'false',
        // `store prune` is local already; these flags make the no-network
        // contract explicit if pnpm ever consults a config during startup.
        npm_config_offline: 'true',
        NPM_CONFIG_OFFLINE: 'true',
        pnpm_config_offline: 'true',
        PNPM_CONFIG_OFFLINE: 'true',
        npm_config_store_dir: actualRoot,
        NPM_CONFIG_STORE_DIR: actualRoot,
        pnpm_config_store_dir: actualRoot,
        PNPM_CONFIG_STORE_DIR: actualRoot,
        // pnpm's default metadata cache is `%LOCALAPPDATA%\\pnpm-cache` on
        // Windows. Keep prune scoped to the launcher's store; otherwise a
        // "complete uninstall" could delete cache entries used by unrelated
        // projects on this machine.
        npm_config_cache: path.join(actualRoot, '.metadata-cache'),
        NPM_CONFIG_CACHE: path.join(actualRoot, '.metadata-cache'),
        pnpm_config_cache_dir: path.join(actualRoot, '.metadata-cache'),
        PNPM_CONFIG_CACHE_DIR: path.join(actualRoot, '.metadata-cache'),
        FORCE_COLOR: '0',
      }),
    )

    const commandOptions: CommandOptions = {
      // The store is the narrowest stable working directory. It exists by
      // construction above; using it avoids depending on a deleted workspace.
      cwd: actualRoot,
      env: environment,
      inactivityTimeoutMs: STORE_PRUNE_IDLE_TIMEOUT_MS,
      onOutput: (text, level: OutputLevel) => options.emitOutput(level, text),
    }
    const result = await execute(
      pnpmRuntime.executable,
      // pnpm 11 does not accept `--offline` for the `store` command. The
      // equivalent config is supplied in the environment above; adding the
      // flag here would make every complete uninstall fail with UNKNOWN_OPTION.
      ['store', 'prune', '--store-dir', actualRoot],
      commandOptions,
    )
    if (result.exitCode !== 0) {
      const detail = result.output.slice(-4_000).trim()
      throw new Error(`pnpm store prune 失败（代码 ${result.exitCode}）${detail ? `：${detail}` : ''}`)
    }
  }
}
