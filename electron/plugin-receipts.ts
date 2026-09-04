import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises'
import path from 'node:path'
import type { PluginInstallSource } from '../src/types'

export interface PluginInstallReceipt {
  repository: string
  packageName: string
  profileName: string
  source: PluginInstallSource
  subdirectory: string | null
  version: string | null
  commit: string
  defaultBranch?: string
  targetId?: string
  installedAt: string
  packName?: string
  packRepository?: string
  packCommit?: string | null
  componentId?: string
  actualSource?: 'market' | 'npm' | 'github' | 'local'
}
interface ReceiptFile {
  version: 1
  installs: PluginInstallReceipt[]
}

async function readReceiptFile(filePath: string): Promise<ReceiptFile> {
  try {
    const value = JSON.parse(await readFile(filePath, 'utf8')) as Partial<ReceiptFile>
    return {
      version: 1,
      installs: Array.isArray(value.installs) ? value.installs : [],
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    return { version: 1, installs: [] }
  }
}

async function writeReceiptFile(filePath: string, value: ReceiptFile): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true })
  const temporaryPath = `${filePath}.tmp`
  await writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
  try {
    await rename(temporaryPath, filePath)
  } catch {
    await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
    await unlink(temporaryPath).catch(() => undefined)
  }
}

export async function readPluginReceipts(filePath: string): Promise<PluginInstallReceipt[]> {
  return (await readReceiptFile(filePath)).installs
}

export async function recordPluginInstall(filePath: string, receipt: PluginInstallReceipt): Promise<void> {
  const current = await readReceiptFile(filePath)
  const installs = current.installs.filter(item => !(
    item.profileName === receipt.profileName && item.packageName === receipt.packageName
  ))
  installs.push(receipt)
  await writeReceiptFile(filePath, { version: 1, installs })
}

export async function removePluginReceipt(filePath: string, profileName: string, packageName: string): Promise<void> {
  const current = await readReceiptFile(filePath)
  const installs = current.installs.filter(item => !(
    item.profileName === profileName && item.packageName === packageName
  ))
  if (installs.length === current.installs.length) return
  await writeReceiptFile(filePath, { version: 1, installs })
}
