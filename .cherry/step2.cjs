const fs = require('fs')
const T = '.cherry'
let log = []
function read(p) { return fs.readFileSync(p, 'utf8') }
function write(p, s) { fs.writeFileSync(p, s) }
function patch(file, from, to, tag) {
  let s = read(file)
  if (!s.includes(from)) throw new Error('NO MATCH: ' + tag)
  s = s.replace(from, to)
  write(file, s)
  log.push('ok: ' + tag)
}
const CRLF = '\r\n'

// ---------- 3. installer.ts ----------
{
  const f = 'electron/installer.ts'
  patch(f,
    "import { analyzeSkillRepository } from './skill-catalog'",
    "import { analyzeSkillRepository, analyzeSkillRepositoryFromArchive } from './skill-catalog'" + CRLF +
    "import { createSkillMarketCacheStore, SKILL_MARKET_CACHE_TTL_MS } from './skill-market-cache'",
    'installer: imports')
  patch(f, '  skillSourceRoot: string', '  skillSourceRoot: string' + CRLF + '  /** 技能市场归档分析磁盘缓存（C 端设置页）。 */' + CRLF + '  skillMarketCachePath?: string', 'installer: options')
  patch(f, '  analyzeSkill(fullName: string, defaultBranch: string): Promise<SkillRepositoryAnalysis>',
    '  analyzeSkill(fullName: string, defaultBranch: string): Promise<SkillRepositoryAnalysis>' + CRLF +
    '  /** C 端技能市场：归档式检测（绕开 api.github.com 限流）与免重析安装。 */' + CRLF +
    '  analyzeSkillArchive(fullName: string, defaultBranch: string): Promise<SkillRepositoryAnalysis>' + CRLF +
    '  installSkillFromMarket(request: { repository: string; target: SkillInstallTarget }): Promise<SkillInstallResult>',
    'installer: interface')
  const analyzeBlock = read(`${T}/inst-analyze.txt`)
  patch(f, '  const analyzeSkill = async (fullName: string, defaultBranch: string, bypassCache = false)',
    analyzeBlock.replace(/\n/g, CRLF) + CRLF + CRLF + '  const analyzeSkill = async (fullName: string, defaultBranch: string, bypassCache = false)',
    'installer: analyzeSkillArchive impl')
  patch(f, '    analyzeSkill,', '    analyzeSkill,' + CRLF + '    analyzeSkillArchive,', 'installer: return')
  const marketBlock = read(`${T}/inst-market.txt`)
  patch(f, '    async installSkillPinned({ repository, target }): Promise<InstalledSkill> {',
    marketBlock.replace(/\n/g, CRLF) + CRLF + CRLF + '    async installSkillPinned({ repository, target }): Promise<InstalledSkill> {',
    'installer: installSkillFromMarket')
}

// ---------- 4. preset-install.ts ----------
{
  const f = 'electron/preset-install.ts'
  let s = read(f)
  if (!s.includes("from 'yaml'")) {
    s = s.replace(/(import AdmZip from 'adm-zip'\r?\n)/, (m) => m + "import { parse } from 'yaml'\r\n")
  }
  s = s.replace("import type { InstalledPreset, PresetInstallTarget } from '../src/types'",
    "import type { BuiltinAgentPreset, Dirent, InstalledPreset, PresetInstallTarget } from '../src/types'")
  write(f, s)
  log.push('ok: preset-install imports')
  patch(f, "const PRESET_MANIFEST = 'preset.yml'\r\n", '', 'preset: drop dup check noop')
  if (!read(f).includes('PRESET_MANIFEST')) {
    let s2 = read(f)
    s2 = s2.replace(/(import \{ isSkillName \} from '\.\/skill-format'\r?\n)/, (m) => m + CRLF + "const PRESET_MANIFEST = 'preset.yml'" + CRLF)
    write(f, s2)
  }
  const builtin = read(`${T}/preset-builtin.txt`)
  let s3 = read(f)
  write(f, s3.replace(/\s*$/, '\r\n\r\n') + builtin.replace(/\n/g, CRLF).replace(/\s*$/, '\r\n'))
  log.push('ok: preset-install readBuiltinAgentPresets appended')
}

// ---------- 5. runtime-versions.ts ----------
{
  const f = 'electron/runtime-versions.ts'
  let s = read(f)
  if (!s.includes('export function dshVersionRoot')) {
    s = s.replace(/\s*$/, '\r\n\r\n') + '/** DSH 托管版本的安装根目录（整合包导入自动补装用）。 */\r\nexport function dshVersionRoot(runtimeRoot: string, version: string): string {\r\n  return path.join(runtimeRoot, \'versions\', normalizeDshVersion(version))\r\n}\r\n'
    write(f, s)
  }
  log.push('ok: runtime-versions dshVersionRoot')
}

fs.writeFileSync('.cherry/log2.txt', log.join('\n'))
console.log(log.join('\n'))
