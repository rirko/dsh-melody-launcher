import { get as httpsGet } from 'node:https'

/** gh-proxy 系镜像接受 `<mirror>/<完整原始 URL>` 形式；去掉尾部斜杠避免双斜杠。 */
export function applyGitHubMirror(url: string, mirror?: string): string {
  const trimmed = mirror?.trim().replace(/\/+$/, '')
  return trimmed ? `${trimmed}/${url}` : url
}

export function githubArchiveUrl(repository: string, revision: string, mirror?: string): string {
  const encodedRepository = repository.split('/').map(encodeURIComponent).join('/')
  const direct = /^[a-f0-9]{40}$/i.test(revision)
    ? `https://codeload.github.com/${encodedRepository}/zip/${revision}`
    : `https://codeload.github.com/${encodedRepository}/zip/refs/heads/${revision.split('/').map(encodeURIComponent).join('/')}`
  return applyGitHubMirror(direct, mirror)
}

/**
 * 经 fetch（可为代理感知实现）下载仓库归档字节。
 * 与 downloadGitHubArchive 的区别：走 Chromium 网络栈时可继承系统代理，并支持 GitHub 镜像前缀。
 */
export async function fetchGitHubArchiveBytes(
  repository: string,
  revision: string,
  maxBytes: number,
  fetchImpl: typeof fetch,
  mirror?: string,
): Promise<Buffer> {
  const response = await fetchImpl(githubArchiveUrl(repository, revision, mirror), {
    headers: { 'User-Agent': 'DSH-Launcher' },
    redirect: 'follow',
    signal: AbortSignal.timeout(60_000),
  })
  if (!response.ok || !response.body) throw new Error(`下载仓库压缩包失败（HTTP ${response.status}）。`)
  const reader = response.body.getReader()
  const chunks: Buffer[] = []
  let received = 0
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    received += value.byteLength
    if (received > maxBytes) {
      await reader.cancel().catch(() => undefined)
      throw new Error('仓库压缩包过大，已停止下载。')
    }
    chunks.push(Buffer.from(value))
  }
  return Buffer.concat(chunks, received)
}

export async function downloadGitHubArchive(
  repository: string,
  revision: string,
  maxBytes: number,
  onProgress?: (received: number, total: number | null) => void,
): Promise<Buffer> {
  const url = githubArchiveUrl(repository, revision)
  return new Promise((resolve, reject) => {
    let settled = false
    const fail = (error: Error) => {
      if (settled) return
      settled = true
      reject(error)
    }
    const request = httpsGet(url, { headers: { 'User-Agent': 'DSH-Launcher' } }, response => {
      const status = response.statusCode ?? 0
      if (status < 200 || status >= 300) {
        response.resume()
        fail(new Error(`下载仓库压缩包失败（HTTP ${status}）。`))
        return
      }
      const declaredSize = Number(response.headers['content-length'])
      if (Number.isFinite(declaredSize) && declaredSize > maxBytes) {
        response.resume()
        fail(new Error('仓库压缩包过大，已停止下载。'))
        return
      }

      const chunks: Buffer[] = []
      let received = 0
      response.on('data', (chunk: Buffer) => {
        if (settled) return
        received += chunk.length
        if (received > maxBytes) {
          response.destroy()
          fail(new Error('仓库压缩包过大，已停止下载。'))
          return
        }
        chunks.push(chunk)
        onProgress?.(received, Number.isFinite(declaredSize) && declaredSize > 0 ? declaredSize : null)
      })
      response.once('error', error => fail(error instanceof Error ? error : new Error('下载仓库压缩包失败。')))
      response.once('end', () => {
        if (settled) return
        settled = true
        resolve(Buffer.concat(chunks, received))
      })
    })
    request.once('error', error => fail(error instanceof Error ? error : new Error('下载仓库压缩包失败。')))
    request.setTimeout(30_000, () => request.destroy(new Error('下载仓库压缩包超时，请检查网络后重试。')))
  })
}
