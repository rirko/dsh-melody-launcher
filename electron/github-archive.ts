import { get as httpsGet } from 'node:https'

export function githubArchiveUrl(repository: string, revision: string): string {
  const encodedRepository = repository.split('/').map(encodeURIComponent).join('/')
  if (/^[a-f0-9]{40}$/i.test(revision)) return `https://codeload.github.com/${encodedRepository}/zip/${revision}`
  const encodedRevision = revision.split('/').map(encodeURIComponent).join('/')
  return `https://codeload.github.com/${encodedRepository}/zip/refs/heads/${encodedRevision}`
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
