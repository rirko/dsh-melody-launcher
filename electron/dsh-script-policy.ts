import { existsSync } from 'node:fs'
import { readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'

/** DSH 用于本地终端能力的官方依赖，必须执行 postinstall 才能恢复 spawn helper。 */
export const DSH_SUBPROCESS_LOCAL_PACKAGE = '@deepseek-ai/dsh-subprocess-local'

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * 在托管 DSH 的项目根保留 npm 的现有配置，并精确允许 DSH 核心依赖脚本。
 * 不写用户级 .npmrc，也不放开其他依赖的生命周期脚本。
 */
export async function ensureDshScriptPolicy(manifestPath: string): Promise<void> {
  const content = await readFile(manifestPath, 'utf8')
  const manifest = JSON.parse(content) as Record<string, unknown>
  const current = isRecord(manifest.allowScripts) ? manifest.allowScripts : {}
  if (current[DSH_SUBPROCESS_LOCAL_PACKAGE] === true) return
  manifest.allowScripts = { ...current, [DSH_SUBPROCESS_LOCAL_PACKAGE]: true }
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
}

export function dshScriptPackageManifest(runtimeRoot: string): string {
  return path.join(runtimeRoot, 'node_modules', ...DSH_SUBPROCESS_LOCAL_PACKAGE.split('/'), 'package.json')
}

export function hasDshScriptPackage(runtimeRoot: string): boolean {
  return existsSync(dshScriptPackageManifest(runtimeRoot))
}
