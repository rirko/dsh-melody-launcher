import { copyFile, mkdir, readFile, readdir, rm, stat } from 'node:fs/promises'
import path from 'node:path'

/**
 * 启动器主界面插图的自定义资源管理。
 * 用户选择的图片复制进 userData/launcher-assets（时间戳命名，天然破缓存），
 * 渲染层经 launcher-asset:// 协议只读访问，避免把几 MB 的 data URL 塞进设置。
 */

export const LAUNCHER_ASSETS_DIRNAME = 'launcher-assets'
export const MAX_BACKGROUND_BYTES = 8 * 1024 * 1024
const BACKGROUND_NAME = /^background-(\d{10,16})\.(png|jpe?g|webp)$/
const CONTENT_TYPE_BY_EXTENSION: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
}

export function launcherAssetsDir(userData: string): string {
  return path.join(userData, LAUNCHER_ASSETS_DIRNAME)
}

/** 校验背景图文件名（时间戳 + 白名单扩展名）；拒绝路径分隔符与任何穿越写法。 */
export function sanitizeLauncherBackgroundName(name: string): string | null {
  if (typeof name !== 'string' || name.includes('/') || name.includes('\\') || name.includes('..')) return null
  return BACKGROUND_NAME.test(name) ? name : null
}

export function contentTypeForLauncherAsset(name: string): string | null {
  return CONTENT_TYPE_BY_EXTENSION[path.extname(name).toLowerCase()] ?? null
}

/** 把用户选中的图片复制进 assets 目录并清理旧图，返回新文件名。 */
export async function importLauncherBackground(userData: string, sourcePath: string): Promise<string> {
  const extension = path.extname(sourcePath).toLowerCase()
  if (!CONTENT_TYPE_BY_EXTENSION[extension]) throw new Error('仅支持 PNG / JPG / WebP 图片。')
  const sourceStat = await stat(sourcePath)
  if (sourceStat.size === 0) throw new Error('图片文件为空。')
  if (sourceStat.size > MAX_BACKGROUND_BYTES) throw new Error('图片不能超过 8MB，请压缩后重试。')
  const directory = launcherAssetsDir(userData)
  await mkdir(directory, { recursive: true })
  const name = `background-${Date.now()}${extension}`
  await copyFile(sourcePath, path.join(directory, name))
  await pruneBackgrounds(directory, name)
  return name
}

/** 删除全部背景图（恢复默认）。 */
export async function clearLauncherBackgrounds(userData: string): Promise<void> {
  await pruneBackgrounds(launcherAssetsDir(userData), null)
}

async function pruneBackgrounds(directory: string, keep: string | null): Promise<void> {
  let entries: string[]
  try {
    entries = await readdir(directory)
  } catch {
    return
  }
  await Promise.all(entries
    .filter(entry => BACKGROUND_NAME.test(entry) && entry !== keep)
    .map(entry => rm(path.join(directory, entry), { force: true }).catch(() => undefined)))
}

/** 供协议处理器读取背景图；非法文件名或文件缺失返回 null。 */
export async function readLauncherBackground(userData: string, rawName: string): Promise<{ body: Buffer; contentType: string } | null> {
  const name = sanitizeLauncherBackgroundName(rawName)
  const contentType = name ? contentTypeForLauncherAsset(name) : null
  if (!name || !contentType) return null
  try {
    const body = await readFile(path.join(launcherAssetsDir(userData), name))
    return { body, contentType }
  } catch {
    return null
  }
}
