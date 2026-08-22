import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  readPackRegistry,
  removePackRecord,
  toPackStatus,
  upsertPackRecord,
  writePackRegistry,
  type PackRecord,
} from '../electron/pack-registry'

let temporaryDirectory = ''

afterEach(async () => {
  if (temporaryDirectory) await rm(temporaryDirectory, { recursive: true, force: true })
  temporaryDirectory = ''
})

async function makeRegistryPath(): Promise<string> {
  if (!temporaryDirectory) {
    temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), 'dsh-pack-registry-'))
  }
  return path.join(temporaryDirectory, 'packs.json')
}

function makeRecord(overrides: Partial<PackRecord> = {}): PackRecord {
  return {
    id: 'pack-example',
    name: '示例整合包',
    description: '示例描述',
    version: '1.0.0',
    dshVersion: '0.1.0-rc.7',
    source: 'created',
    installedAt: '2026-08-16T00:00:00.000Z',
    updatedAt: '2026-08-16T00:00:00.000Z',
    state: 'complete',
    plugins: [{ packageName: '@demo/plugin', enabled: true, version: '1.0.0' }],
    ...overrides,
  }
}

describe('pack registry 读写', () => {
  it('往返读写：写入的记录可原样读出', async () => {
    const registryPath = await makeRegistryPath()
    const records = [
      makeRecord(),
      makeRecord({ id: 'pack-other', name: '另一个整合包', source: 'zip' }),
    ]
    await writePackRegistry(registryPath, records)
    expect(await readPackRegistry(registryPath)).toEqual(records)
  })

  it('文件不存在时返回空数组', async () => {
    const registryPath = await makeRegistryPath()
    expect(await readPackRegistry(path.join(registryPath, 'missing.json'))).toEqual([])
  })

  it('JSON 损坏时返回空数组而不抛错', async () => {
    const registryPath = await makeRegistryPath()
    await writeFile(registryPath, '{ 这不是合法 JSON', 'utf8')
    expect(await readPackRegistry(registryPath)).toEqual([])
  })

  it('信封结构非法（无 records 字段）时返回空数组', async () => {
    const registryPath = await makeRegistryPath()
    await writeFile(registryPath, JSON.stringify({ version: 1 }), 'utf8')
    expect(await readPackRegistry(registryPath)).toEqual([])
  })
})

describe('upsertPackRecord', () => {
  it('新 id 追加到末尾并落盘', async () => {
    const registryPath = await makeRegistryPath()
    const first = makeRecord()
    await upsertPackRecord(registryPath, first)
    const next = await upsertPackRecord(registryPath, makeRecord({ id: 'pack-other', name: '另一个' }))
    expect(next.map(item => item.id)).toEqual(['pack-example', 'pack-other'])
    expect(await readPackRegistry(registryPath)).toEqual(next)
  })

  it('同 id 幂等覆盖（保留原位置）', async () => {
    const registryPath = await makeRegistryPath()
    await upsertPackRecord(registryPath, makeRecord())
    await upsertPackRecord(registryPath, makeRecord({ id: 'pack-other', name: '另一个' }))
    const updated = await upsertPackRecord(registryPath, makeRecord({ version: '1.1.0' }))
    expect(updated).toHaveLength(2)
    expect(updated[0]).toMatchObject({ id: 'pack-example', version: '1.1.0' })
    expect(await readPackRegistry(registryPath)).toEqual(updated)
  })
})

describe('removePackRecord', () => {
  it('按 id 删除并落盘', async () => {
    const registryPath = await makeRegistryPath()
    const a = makeRecord({ id: 'pack-a' })
    const b = makeRecord({ id: 'pack-b' })
    await writePackRegistry(registryPath, [a, b])
    const remaining = await removePackRecord(registryPath, 'pack-a')
    expect(remaining).toEqual([b])
    expect(await readPackRegistry(registryPath)).toEqual([b])
  })

  it('删除不存在的 id 时保持磁盘不变', async () => {
    const registryPath = await makeRegistryPath()
    const records = [makeRecord({ id: 'pack-a' })]
    await writePackRegistry(registryPath, records)
    const remaining = await removePackRecord(registryPath, 'pack-nope')
    expect(remaining).toEqual(records)
    expect(await readPackRegistry(registryPath)).toEqual(records)
  })
})

describe('toPackStatus', () => {
  it('enabled 反映当前 profile 是否为该整合包', () => {
    const record = makeRecord()
    expect(toPackStatus(record, 'pack-example').enabled).toBe(true)
    expect(toPackStatus(record, 'pack-other').enabled).toBe(false)
  })

  it('字段完整映射', () => {
    const record = makeRecord({ source: 'manifest', state: 'partial' })
    expect(toPackStatus(record, 'pack-other')).toEqual({
      id: 'pack-example',
      name: '示例整合包',
      description: '示例描述',
      version: '1.0.0',
      dshVersion: '0.1.0-rc.7',
      source: 'manifest',
      enabled: false,
      state: 'partial',
      plugins: [{ packageName: '@demo/plugin', enabled: true, version: '1.0.0' }],
      installedAt: '2026-08-16T00:00:00.000Z',
      updatedAt: '2026-08-16T00:00:00.000Z',
    })
  })

  it('partial/failed 记录的失败明细透传到 PackStatus', () => {
    const failures = [
      { packageName: '@demo/broken', reason: '清单中缺少该插件的来源，无法联网安装' },
      { packageName: '@demo/offline', reason: '无来源记录，无法重新安装' },
    ]
    const record = makeRecord({ state: 'partial', failures })
    expect(toPackStatus(record, 'pack-other').failures).toEqual(failures)
  })

  it('完整包不携带 failures（undefined 时省略）', () => {
    const record = makeRecord()
    expect(toPackStatus(record, 'pack-other').failures).toBeUndefined()
  })
})
