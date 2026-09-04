/** 判断 npm/pnpm 是否明确报告了指定版本不存在。 */
export function isNpmVersionUnavailableError(error: unknown, packageName: string, version: string): boolean {
  const text = error instanceof Error ? error.message : String(error)
  const packageToken = `${packageName}@${version}`.toLowerCase()
  const hasVersionError = /err_pnpm_no_matching_version|etarget|no matching version found|no match found for version|notarget/i.test(text)
  // 要求“版本不存在”语句直接指向当前包，避免把深层依赖的错误误判为主包不存在。
  const normalized = text.toLowerCase()
  return hasVersionError && (
    normalized.includes(`no matching version found for ${packageToken}`)
    || normalized.includes(`no match found for version ${packageToken}`)
  )
}
