// 整合包（Pack）导出：从 profile 的 node_modules 收集插件本体，组合成可导出的压缩包。
// 纯函数 + fs，不依赖 Electron。

import { access } from 'node:fs/promises'
import path from 'node:path'
import type { PackManifest } from '../src/types'
import { isSafePackageName } from './profile'
import { buildPackZip, buildPackZipToFile } from './pack-zip'

export interface PackBodyCollection {
  bodies: Map<string, string>
  missing: string[]
}

async function exists(target: string): Promise<boolean> {
  try {
    await access(target)
    return true
  } catch {
    return false
  }
}

/**
 * 收集 profile 内 node_modules 中每个包名对应的目录；scoped 包为 node_modules/@scope/pkg，缺失的记入 missing。
 * packageName 必须通过安全校验，且拼接后的路径不得越出 node_modules，防止路径穿越。
 */
export async function collectPackBodies(
  packProfileDir: string,
  packageNames: string[],
): Promise<PackBodyCollection> {
  const bodies = new Map<string, string>()
  const missing: string[] = []
  const nodeModulesDir = path.join(packProfileDir, 'node_modules')
  for (const packageName of packageNames) {
    if (!isSafePackageName(packageName)) {
      missing.push(packageName)
      continue
    }
    const directory = path.join(nodeModulesDir, ...packageName.split('/'))
    const relative = path.relative(nodeModulesDir, directory)
    if (relative === '' || relative.startsWith('..') || path.isAbsolute(relative)) {
      missing.push(packageName)
      continue
    }
    if (await exists(directory)) bodies.set(packageName, directory)
    else missing.push(packageName)
  }
  return { bodies, missing }
}

/** 组合出导出用的压缩包字节；缺失的本体会被跳过并返回其包名。 */
export async function buildPackExport(
  packProfileDir: string,
  manifest: PackManifest,
  packageNames: string[],
): Promise<{ zip: Uint8Array; missing: string[] }> {
  const { bodies, missing } = await collectPackBodies(packProfileDir, packageNames)
  return { zip: buildPackZip(manifest, bodies), missing }
}

/** 流式把导出包写入指定文件；缺失的本体会被跳过并返回其包名。 */
export async function buildPackExportToFile(
  packProfileDir: string,
  manifest: PackManifest,
  packageNames: string[],
  outputPath: string,
  presetDirs: Map<string, string> = new Map(),
): Promise<{ zipPath: string; missing: string[] }> {
  const { bodies, missing } = await collectPackBodies(packProfileDir, packageNames)
  await buildPackZipToFile(manifest, bodies, outputPath, presetDirs)
  return { zipPath: outputPath, missing }
}
