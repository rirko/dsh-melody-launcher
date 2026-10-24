import { describe, expect, it, vi } from 'vitest'
import { installProfileDependencies } from '../electron/profile-dependency-install'

function fixture() {
  return {
    profileName: 'pack-test',
    profileDirectory: '/profiles/pack-test',
    storeDirectory: '/plugin-store',
    registry: 'https://registry.npmmirror.com',
    execute: vi.fn(async (_args: string[]) => ({ exitCode: 0, output: '' })),
    onOfflineMiss: vi.fn(),
  }
}

describe('Profile dependency installation', () => {
  it('reuses the offline cache without running scripts or installing development dependencies', async () => {
    const options = fixture()
    await installProfileDependencies(options)
    expect(options.execute).toHaveBeenCalledOnce()
    expect(options.execute.mock.calls[0][0]).toEqual(expect.arrayContaining([
      '--offline', '--ignore-scripts', '--prod', '--config.auto-install-peers=false',
      '--registry=https://registry.npmmirror.com', '--fetch-timeout=600000',
    ]))
    expect(options.onOfflineMiss).not.toHaveBeenCalled()
  })

  it.each(['ERR_PNPM_NO_OFFLINE_META', 'ERR_PNPM_NO_OFFLINE_TARBALL'])('fetches missing cache entries after %s using the same manifest and store', async code => {
    const options = fixture()
    options.execute.mockResolvedValueOnce({ exitCode: 1, output: `[${code}] Missing dependency` })
    await installProfileDependencies(options)
    expect(options.execute).toHaveBeenCalledTimes(2)
    expect(options.execute.mock.calls[1][0]).toEqual(options.execute.mock.calls[0][0].filter(arg => arg !== '--offline'))
    expect(options.onOfflineMiss).toHaveBeenCalledOnce()
  })

  it('does not retry unrelated failures online and retains the command error', async () => {
    const options = fixture()
    options.execute.mockResolvedValue({ exitCode: 1, output: 'EPERM: cannot write node_modules' })
    await expect(installProfileDependencies(options)).rejects.toThrow('EPERM: cannot write node_modules')
    expect(options.execute).toHaveBeenCalledOnce()
  })

  it('retains registry failures after an offline cache miss', async () => {
    const options = fixture()
    options.execute.mockResolvedValueOnce({ exitCode: 1, output: '[ERR_PNPM_NO_OFFLINE_META] Missing metadata' })
    options.execute.mockResolvedValueOnce({ exitCode: 1, output: 'ERR_PNPM_FETCH_403: package forbidden' })
    await expect(installProfileDependencies(options)).rejects.toThrow('ERR_PNPM_FETCH_403: package forbidden')
  })
})
