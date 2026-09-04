const fs = require('fs')
const T = '.cherry'
let log = []
function read(p) { return fs.readFileSync(p, 'utf8') }
function write(p, s) { fs.writeFileSync(p, s) }
function mustPatch(file, from, to, tag) {
  let s = read(file)
  if (!s.includes(from)) throw new Error('NO MATCH: ' + tag)
  s = s.replace(from, to)
  write(file, s)
  log.push('ok: ' + tag)
}

// ---------- 1. github-archive.ts ----------
{
  const f = 'electron/github-archive.ts'
  mustPatch(f,
    'export function githubArchiveUrl(repository: string, revision: string): string {',
    [
      'export function applyGitHubMirror(url: string, mirror?: string): string {',
      "  const trimmed = mirror?.trim().replace(/[\\/]+$/, '')",
      "  return trimmed ? `${trimmed}/${url}` : url",
      '}',
      '',
      'export function githubArchiveUrl(repository: string, revision: string, mirror?: string): string {',
    ].join('\n'),
    'gh: signature + applyGitHubMirror')
  let s = read(f)
  s = s.replace("  if (/^[a-f0-9]{40}$/i.test(revision)) return `https://codeload.github.com/${encodedRepository}/zip/${revision}`",
    "  if (/^[a-f0-9]{40}$/i.test(revision)) return applyGitHubMirror(`https://codeload.github.com/${encodedRepository}/zip/${revision}`, mirror)")
  s = s.replace("  return `https://codeload.github.com/${encodedRepository}/zip/refs/heads/${encodedRevision}`",
    "  return applyGitHubMirror(`https://codeload.github.com/${encodedRepository}/zip/refs/heads/${encodedRevision}`, mirror)")
  const add = read(`${T}/gh-archive-add.txt`)
  const fnStart = add.indexOf('/**')
  s = s.replace(/\s*$/, '\n\n') + add.slice(fnStart >= 0 ? fnStart : add.indexOf('export async function fetchGitHubArchiveBytes')).replace(/\s*$/, '\n')
  write(f, s)
  log.push('ok: gh: fetchGitHubArchiveBytes appended')
}

// ---------- 2. skill-catalog.ts ----------
{
  const f = 'electron/skill-catalog.ts'
  let s = read(f)
  if (!s.includes("from 'adm-zip'")) {
    const firstImport = s.match(/^import[^\n]+\n/)
    s = s.replace(firstImport[0], "import AdmZip from 'adm-zip'\n" + firstImport[0])
  }
  if (!s.includes('fetchGitHubArchiveBytes')) {
    s = s.replace(/(import \{[^\}]*\} from '\.\/github-archive'\n)/, (m) => m.includes('downloadGitHubArchive')
      ? m.replace("from './github-archive'", "as GH from './github-archive'").replace(' as GH', '') && m
      : m)
    // 简化：直接追加一行导入
    s = s.replace(/(import AdmZip from 'adm-zip'\n)/, (m) => m + "import { fetchGitHubArchiveBytes } from './github-archive'\n")
  }
  if (!/const MAX_ARCHIVE_BYTES/.test(s)) {
    s = s.replace(/(const MAX_FILES = [0-9_]+\n)/, (m) => m + 'const MAX_ARCHIVE_BYTES = 64 * 1024 * 1024\n')
  }
  const archive = read(`${T}/sc-archive.txt`)
  write(f, s.replace(/\s*$/, '\n\n') + archive.replace(/\s*$/, '\n'))
  log.push('ok: skill-catalog archive block appended')
}

fs.writeFileSync('.cherry/log.txt', log.join('\n'))
console.log(log.join('\n'))
