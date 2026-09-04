import { describe, expect, it } from 'vitest'
import { isNpmVersionUnavailableError } from '../electron/npm-install'

describe('npm version fallback detection', () => {
  it('matches a missing version for the requested package', () => {
    expect(isNpmVersionUnavailableError(
      new Error('[ERR_PNPM_NO_MATCHING_VERSION] No matching version found for dsh-at-file@0.6.0'),
      'dsh-at-file',
      '0.6.0',
    )).toBe(true)
  })

  it('does not treat an unrelated dependency failure as the requested package missing', () => {
    expect(isNpmVersionUnavailableError(
      new Error('[ERR_PNPM_NO_MATCHING_VERSION] No matching version found for transitive-dependency@1.0.0 while installing dsh-at-file@0.6.0'),
      'dsh-at-file',
      '0.6.0',
    )).toBe(false)
  })
})
