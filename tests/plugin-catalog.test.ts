import { describe, expect, it } from 'vitest'
import { analyzeRepository } from '../electron/plugin-catalog'

const commit = 'a'.repeat(40)

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

function mockFetch(routes: Record<string, Response | (() => Response)>): typeof fetch {
  return (async (input: string | URL | Request) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
    const route = routes[url]
    if (!route) return json({ message: `No route for ${url}` }, 404)
    return typeof route === 'function' ? route() : route.clone()
  }) as typeof fetch
}

function commitUrl(repository: string): string {
  return `https://api.github.com/repos/${repository}/commits/main`
}

function treeUrl(repository: string): string {
  return `https://api.github.com/repos/${repository}/git/trees/${commit}?recursive=1`
}

function rawUrl(repository: string, filePath: string): string {
  return `https://raw.githubusercontent.com/${repository}/${commit}/${filePath}`
}

describe('repository plugin analysis', () => {
  it('prefers a verified npm release for a root bundle', async () => {
    const repository = 'demo/root-plugin'
    const manifest = {
      name: '@demo/root-plugin',
      version: '1.2.0',
      repository: `https://github.com/${repository}`,
      dsh: { bundle: { patch: './cordis.patch.yml' }, client: { platform: 'web' } },
      engines: { node: '>=22.19' },
    }
    const analysis = await analyzeRepository(repository, 'main', 'web', mockFetch({
      [commitUrl(repository)]: json({ sha: commit }),
      [rawUrl(repository, 'package.json')]: json(manifest),
      [treeUrl(repository)]: json({ tree: [
        { path: 'package.json', type: 'blob' },
        { path: 'cordis.patch.yml', type: 'blob' },
      ] }),
      ['https://registry.npmjs.org/%40demo%2Froot-plugin/latest']: json(manifest),
    }))

    expect(analysis.installability).toBe('ready')
    expect(analysis.targets[0]).toMatchObject({
      packageName: '@demo/root-plugin',
      source: 'npm',
      profileName: 'web',
      subdirectory: null,
    })
  })

  it('finds a private bundle in a repository subdirectory', async () => {
    const repository = 'demo/skin-collection'
    const analysis = await analyzeRepository(repository, 'main', 'web', mockFetch({
      [commitUrl(repository)]: json({ sha: commit }),
      [rawUrl(repository, 'package.json')]: json({}, 404),
      [treeUrl(repository)]: json({ tree: [
        { path: 'maid/package.json', type: 'blob' },
        { path: 'maid/cordis.patch.yml', type: 'blob' },
      ] }),
      [rawUrl(repository, 'maid/package.json')]: json({
        name: '@demo/maid-skin',
        version: '0.1.0',
        private: true,
        dsh: { bundle: { patch: './cordis.patch.yml' }, client: { platform: 'web' } },
      }),
    }))

    expect(analysis.installability).toBe('ready')
    expect(analysis.targets[0]).toMatchObject({
      source: 'archive-subdirectory',
      subdirectory: 'maid',
      profileName: 'web',
    })
  })

  it('uses the official Release tgz for a private source-only github plugin', async () => {
    const repository = 'demo/super-injector'
    const manifest = {
      name: '@demo/super-injector',
      version: '0.3.3',
      private: true,
      dsh: { bundle: { patch: './cordis.patch.yml' }, client: { platform: 'web' } },
    }
    const analysis = await analyzeRepository(repository, 'main', 'web', mockFetch({
      [commitUrl(repository)]: json({ sha: commit }),
      [rawUrl(repository, 'package.json')]: json(manifest),
      [treeUrl(repository)]: json({ tree: [
        { path: 'package.json', type: 'blob' },
        { path: 'cordis.patch.yml', type: 'blob' },
      ] }),
      ['https://registry.npmjs.org/%40demo%2Fsuper-injector/latest']: json({}, 404),
      ['https://api.github.com/repos/demo/super-injector/releases?per_page=10']: json([
        {
          tag_name: 'v0.3.3',
          draft: false,
          prerelease: false,
          assets: [
            { name: 'demo-super-injector-0.3.3.tgz', browser_download_url: 'https://example.com/demo-super-injector-0.3.3.tgz' },
          ],
        },
      ]),
    }))

    expect(analysis.installability).toBe('ready')
    expect(analysis.targets[0]).toMatchObject({
      packageName: '@demo/super-injector',
      source: 'release',
      tarballUrl: 'https://example.com/demo-super-injector-0.3.3.tgz',
      version: '0.3.3',
    })
    expect(analysis.releaseAnalysis).toMatchObject({ state: 'none', releaseTag: 'v0.3.3', assets: [] })
  })

  it('reports executable assets from the latest stable Release without treating tgz as executable', async () => {
    const repository = 'demo/desktop-plugin'
    const manifest = {
      name: '@demo/desktop-plugin',
      version: '1.0.0',
      private: true,
      dsh: { bundle: { patch: './cordis.patch.yml' }, client: { platform: 'web' } },
    }
    const analysis = await analyzeRepository(repository, 'main', 'web', mockFetch({
      [commitUrl(repository)]: json({ sha: commit }),
      [rawUrl(repository, 'package.json')]: json(manifest),
      [treeUrl(repository)]: json({ tree: [
        { path: 'package.json', type: 'blob' },
        { path: 'cordis.patch.yml', type: 'blob' },
      ] }),
      ['https://api.github.com/repos/demo/desktop-plugin/releases?per_page=10']: json([
        {
          tag_name: 'v1.1.0',
          name: 'Desktop 1.1.0',
          published_at: '2026-08-22T00:00:00Z',
          draft: false,
          prerelease: false,
          assets: [
            { name: 'desktop-plugin-1.1.0-win-x64.exe', browser_download_url: 'https://example.com/desktop.exe', size: 1234, content_type: 'application/vnd.microsoft.portable-executable' },
            { name: 'desktop-plugin-1.1.0.tgz', browser_download_url: 'https://example.com/desktop.tgz', size: 2345, content_type: 'application/gzip' },
            { name: 'desktop-plugin-1.1.0-linux-x64.AppImage', browser_download_url: 'https://example.com/desktop.AppImage', size: 3456, content_type: 'application/octet-stream' },
          ],
        },
        {
          tag_name: 'v1.2.0-rc.1',
          draft: false,
          prerelease: true,
          assets: [{ name: 'desktop-preview.exe', browser_download_url: 'https://example.com/preview.exe' }],
        },
      ]),
    }))

    expect(analysis.releaseAnalysis).toMatchObject({
      state: 'found',
      releaseTag: 'v1.1.0',
      releaseName: 'Desktop 1.1.0',
    })
    expect(analysis.releaseAnalysis?.assets).toEqual([
      expect.objectContaining({ name: 'desktop-plugin-1.1.0-win-x64.exe', kind: 'exe', platform: 'windows', size: 1234 }),
      expect.objectContaining({ name: 'desktop-plugin-1.1.0-linux-x64.AppImage', kind: 'appimage', platform: 'linux', size: 3456 }),
    ])
    expect(analysis.releaseAnalysis?.assets.some(asset => asset.name.endsWith('.tgz'))).toBe(false)
  })

  it('keeps plugin detection successful when the Release endpoint has no usable result', async () => {
    const repository = 'demo/no-release-assets'
    const analysis = await analyzeRepository(repository, 'main', 'web', mockFetch({
      [commitUrl(repository)]: json({ sha: commit }),
      [rawUrl(repository, 'package.json')]: json({
        name: '@demo/no-release-assets',
        version: '1.0.0',
        private: true,
        dsh: { bundle: { patch: './cordis.patch.yml' } },
      }),
      [treeUrl(repository)]: json({ tree: [
        { path: 'package.json', type: 'blob' },
        { path: 'cordis.patch.yml', type: 'blob' },
      ] }),
      ['https://api.github.com/repos/demo/no-release-assets/releases?per_page=10']: json({ message: 'not found' }, 404),
    }))

    expect(analysis.installability).toBe('ready')
    expect(analysis.releaseAnalysis).toMatchObject({ state: 'none', assets: [] })
  })

  it('deduplicates package names and ignores scaffold placeholders', async () => {
    const repository = 'demo/plugin-collection'
    const skinManifest = {
      name: '@demo/skin',
      version: '2.0.0',
      repository: `https://github.com/${repository}`,
      dsh: { bundle: { patch: './cordis.patch.yml' }, client: { platform: 'web' } },
    }
    const templateManifest = {
      name: '@demo/dsh-client-ui-__NAME__',
      version: '0.0.0',
      private: true,
      dsh: { bundle: { patch: './cordis.patch.yml' }, client: { platform: 'web' } },
    }
    const analysis = await analyzeRepository(repository, 'main', 'web', mockFetch({
      [commitUrl(repository)]: json({ sha: commit }),
      [rawUrl(repository, 'package.json')]: json({}, 404),
      [treeUrl(repository)]: json({ tree: [
        { path: 'packages/skin/package.json', type: 'blob' },
        { path: 'packages/skin/cordis.patch.yml', type: 'blob' },
        { path: 'legacy/packages/skin/package.json', type: 'blob' },
        { path: 'legacy/packages/skin/cordis.patch.yml', type: 'blob' },
        { path: 'scripts/plugin-template/package.json', type: 'blob' },
        { path: 'scripts/plugin-template/cordis.patch.yml', type: 'blob' },
      ] }),
      [rawUrl(repository, 'packages/skin/package.json')]: json(skinManifest),
      [rawUrl(repository, 'legacy/packages/skin/package.json')]: json(skinManifest),
      [rawUrl(repository, 'scripts/plugin-template/package.json')]: json(templateManifest),
      ['https://registry.npmjs.org/%40demo%2Fskin/latest']: json(skinManifest),
    }))

    expect(analysis.installability).toBe('ready')
    expect(analysis.targets).toHaveLength(1)
    expect(analysis.targets[0]).toMatchObject({
      packageName: '@demo/skin',
      source: 'npm',
      subdirectory: 'packages/skin',
    })
  })

  it('separates dynamic session plugins from persistent bundles', async () => {
    const repository = 'demo/dynamic-plugin'
    const analysis = await analyzeRepository(repository, 'main', 'web', mockFetch({
      [commitUrl(repository)]: json({ sha: commit }),
      [rawUrl(repository, 'package.json')]: json({
        name: 'dynamic-plugin',
        dsh: { type: 'dynamic-plugin', host: './host.js', client: './client.js' },
      }),
    }))

    expect(analysis.installability).toBe('dynamic')
    expect(analysis.targets).toEqual([])
  })

  it('rejects the full DeepSeek Harness workspace as a plugin', async () => {
    const repository = 'demo/harness-desktop'
    const analysis = await analyzeRepository(repository, 'main', 'web', mockFetch({
      [commitUrl(repository)]: json({ sha: commit }),
      [rawUrl(repository, 'package.json')]: json({
        name: '@deepseek-ai/dsh-root',
        private: true,
        workspaces: ['packages/*'],
      }),
    }))

    expect(analysis.installability).toBe('application')
    expect(analysis.targets).toEqual([])
  })

  it('falls back to a published root plugin when GitHub API quota is exhausted', async () => {
    const repository = 'demo/dsh-tui'
    const manifest = {
      name: '@demo/dsh-tui',
      version: '0.6.1',
      repository: `https://github.com/${repository}.git`,
      dsh: { bundle: { patch: './cordis.patch.yml' } },
    }
    const analysis = await analyzeRepository(repository, 'main', 'web', mockFetch({
      [commitUrl(repository)]: json({ message: 'rate limited' }, 403),
      ['https://raw.githubusercontent.com/demo/dsh-tui/main/package.json']: json(manifest),
      ['https://registry.npmjs.org/%40demo%2Fdsh-tui/latest']: json(manifest),
    }))

    expect(analysis).toMatchObject({ installability: 'ready' })
    expect(analysis.targets[0]).toMatchObject({
      packageName: '@demo/dsh-tui',
      source: 'npm',
      profileName: 'cc-tui',
      commit: 'main',
    })
  })
})
