import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { isSafePackageName, isSafeProfileName } from './profile'
import { resolveStandalonePluginDirectory } from './standalone-plugin-links'
import { assertStandaloneNativeCompatibility, validateStandaloneNativeRuntime, type StandaloneNativeRuntime } from './standalone-plugin-native'

interface ProfileManifest {
  dependencies?: Record<string, string>
  devDependencies?: Record<string, string>
  optionalDependencies?: Record<string, string>
  peerDependencies?: Record<string, string>
  dsh?: { profile?: { bundles?: unknown } }
}

interface PluginManifest {
  dsh?: { standalone?: { schemaVersion?: unknown; dshVersion?: unknown; nativeRuntime?: unknown } }
}

const EXACT_VERSION = /^v?\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/
const normalizeVersion = (value: string) => value.trim().replace(/^v/i, '')

async function readJson<T>(filename: string): Promise<T | null> {
  try { return JSON.parse(await readFile(filename, 'utf8')) as T } catch { return null }
}

/** Private host links cannot follow another DSH version or an unverified replacement host. */
export async function assertStandalonePluginRuntime(
  dshHome: string,
  profileName: string,
  version: string | null,
  replacement = false,
  nativeRuntime?: () => Promise<StandaloneNativeRuntime>,
): Promise<void> {
  if (!isSafeProfileName(profileName)) return
  const profileDirectory = path.join(dshHome, 'profiles', profileName)
  const profile = await readJson<ProfileManifest>(path.join(profileDirectory, 'package.json'))
  if (!profile || !Array.isArray(profile.dsh?.profile?.bundles)) return
  const dependencies = { ...profile.peerDependencies, ...profile.devDependencies, ...profile.optionalDependencies, ...profile.dependencies }
  let actualNativeRuntime: Promise<StandaloneNativeRuntime> | undefined
  for (const packageName of profile.dsh.profile.bundles) {
    if (typeof packageName !== 'string' || !isSafePackageName(packageName)) continue
    let manifest = await readJson<PluginManifest>(path.join(profileDirectory, 'node_modules', ...packageName.split('/'), 'package.json'))
    if (!manifest && typeof dependencies[packageName] === 'string') {
      const directory = await resolveStandalonePluginDirectory(dshHome, packageName, dependencies[packageName], profileDirectory)
      if (directory) manifest = await readJson<PluginManifest>(path.join(directory, 'package.json'))
    }
    const marker = manifest?.dsh?.standalone
    if (marker === undefined) continue
    if (!marker || marker.schemaVersion !== 1 || typeof marker.dshVersion !== 'string' || !EXACT_VERSION.test(marker.dshVersion)) {
      throw new Error(`独立复合插件「${packageName}」的宿主版本信息无效，请重新导入。`)
    }
    const required = normalizeVersion(marker.dshVersion)
    if (replacement) {
      throw new Error(`独立复合插件「${packageName}」要求 DSH ${required}，无法验证替代宿主的运行时版本。请停用替代宿主或此插件。`)
    }
    if (!version || normalizeVersion(version) !== required) {
      throw new Error(`独立复合插件「${packageName}」要求 DSH ${required}，当前 Profile 为${version ? ` DSH ${version}` : '自动选择版本'}。请先选择对应 DSH 版本或停用此插件。`)
    }
    if (marker.nativeRuntime !== undefined) {
      validateStandaloneNativeRuntime(marker.nativeRuntime)
      if (!nativeRuntime) throw new Error(`无法确认独立复合插件「${packageName}」的原生依赖兼容性，请先选择对应 Node 运行时。`)
      actualNativeRuntime ??= nativeRuntime()
      assertStandaloneNativeCompatibility(marker.nativeRuntime, await actualNativeRuntime)
    }
  }
}
