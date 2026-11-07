/**
 * 下载 GitHub Release 资产（如插件的 `.tgz` 安装包）到内存。
 * Node 内置 fetch 会自动跟随 objects.githubusercontent.com 的重定向，
 * 与 skill-install 的 codeload 下载一样流式限速，避免超大资产被打进内存。
 */

function assertHttpsReleaseUrl(url: string): void {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    throw new Error('Release 下载地址无效。')
  }
  if (parsed.protocol !== 'https:') throw new Error('Release 下载地址必须是 https 链接。')
}

export async function downloadReleaseAsset(
  url: string,
  maxBytes: number,
  onProgress?: (received: number, total: number | null) => void,
  fetchImpl?: typeof fetch,
  signal?: AbortSignal,
): Promise<Buffer> {
  assertHttpsReleaseUrl(url)
  const doFetch = fetchImpl ?? fetch
  const response = await doFetch(url, {
    headers: { 'User-Agent': 'DSH-Launcher' },
    redirect: 'follow',
    signal,
  })
  if (!response.ok || !response.body) {
    throw new Error(`下载 Release 资产失败（HTTP ${response.status}）。`)
  }
  const declaredSize = Number(response.headers.get('content-length'))
  if (Number.isFinite(declaredSize) && declaredSize > maxBytes) {
    throw new Error('Release 安装包过大，已停止下载。')
  }
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let received = 0
  try {
    while (true) {
      // 换源守卫在读到慢流数据前就 abort 了：这里每次读取后都检查，
      // 让不感知 signal 的响应体也能被及时打断。
      signal?.throwIfAborted()
      const chunk = await reader.read()
      if (chunk.done) break
      signal?.throwIfAborted()
      received += chunk.value.byteLength
      if (received > maxBytes) {
        await reader.cancel().catch(() => undefined)
        throw new Error('Release 安装包过大，已停止下载。')
      }
      chunks.push(chunk.value)
      onProgress?.(received, Number.isFinite(declaredSize) && declaredSize > 0 ? declaredSize : null)
    }
  } catch (error) {
    await reader.cancel().catch(() => undefined)
    throw error
  }
  const size = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0)
  return Buffer.concat(chunks, size)
}
