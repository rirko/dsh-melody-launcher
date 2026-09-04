import { describe, expect, it } from 'vitest'
import { parseDeepSeekBalance } from '../electron/deepseek-balance'
import { NEWS_CACHE_TTL_MS, lookupNewsCache, parseRssFeed } from '../electron/juya-news'

describe('parseDeepSeekBalance', () => {
  it('解析现行官方格式（字符串金额转数字，赠金/充值分列）', () => {
    const parsed = parseDeepSeekBalance({
      is_available: true,
      balance_infos: [
        { currency: 'CNY', total_balance: '110.00', granted_balance: '10.00', topped_up_balance: '100.00' },
      ],
    })
    expect(parsed).toEqual({
      isAvailable: true,
      infos: [{ currency: 'CNY', totalBalance: 110, grantedBalance: 10, toppedUpBalance: 100 }],
    })
  })

  it('兼容旧版单一 balance 字段', () => {
    const parsed = parseDeepSeekBalance({ balance: '5.50' })
    expect(parsed?.isAvailable).toBe(true)
    expect(parsed?.infos[0]?.totalBalance).toBe(5.5)
  })

  it('结构不对返回 null', () => {
    expect(parseDeepSeekBalance(null)).toBeNull()
    expect(parseDeepSeekBalance('nope')).toBeNull()
    expect(parseDeepSeekBalance({ foo: 1 })).toBeNull()
  })
})

const RSS_SAMPLE = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0"><channel>
  <title>Juya AI Daily</title>
  <item>
    <title><![CDATA[模型发布 & 更新]]></title>
    <link>https://example.com/a</link>
    <pubDate>Wed, 03 Sep 2026 08:00:00 GMT</pubDate>
    <description><![CDATA[<p>今天 <b>DeepSeek</b> 发布了……</p>]]></description>
  </item>
  <item>
    <title>Second item</title>
    <link>https://example.com/b</link>
    <pubDate>Tue, 02 Sep 2026 08:00:00 GMT</pubDate>
    <description>plain &amp; simple</description>
  </item>
</channel></rss>`

describe('parseRssFeed', () => {
  it('提取标题/链接/时间/摘要，剥 CDATA 与 HTML 标签、解实体', () => {
    const items = parseRssFeed(RSS_SAMPLE)
    expect(items).toHaveLength(2)
    expect(items[0]).toEqual({
      title: '模型发布 & 更新',
      link: 'https://example.com/a',
      pubDate: 'Wed, 03 Sep 2026 08:00:00 GMT',
      summary: '今天 DeepSeek 发布了……',
    })
    expect(items[1]?.summary).toBe('plain & simple')
  })

  it('橘鸦早报形态：title 即日期、description 为当日摘要', () => {
    const items = parseRssFeed(`<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0"><channel>
  <item>
    <title><![CDATA[2026-09-04]]></title>
    <link>https://daily.juya.uk/2026-09-04</link>
    <pubDate>Fri, 04 Sep 2026 02:21:37 GMT</pubDate>
    <description><![CDATA[<p>OpenAI 发布 …；Anthropic 更新 …</p>]]></description>
  </item>
</channel></rss>`)
    expect(items).toHaveLength(1)
    expect(items[0]?.title).toBe('2026-09-04')
    expect(items[0]?.summary).toBe('OpenAI 发布 …；Anthropic 更新 …')
  })

  it('非 RSS 内容返回空表而不是抛错', () => {
    expect(parseRssFeed('<html>404 not found</html>')).toEqual([])
    expect(parseRssFeed('')).toEqual([])
  })
})

describe('lookupNewsCache', () => {
  const items = [{ title: 't', link: 'l', pubDate: 'd', summary: 's' }]

  it('TTL 内 fresh、超时 stale、无文件/坏结构 miss', () => {
    expect(lookupNewsCache(null, 0).status).toBe('miss')
    expect(lookupNewsCache({ version: 1, fetchedAt: 1000, items }, 1000 + NEWS_CACHE_TTL_MS - 1).status).toBe('fresh')
    expect(lookupNewsCache({ version: 1, fetchedAt: 1000, items }, 1000 + NEWS_CACHE_TTL_MS + 1).status).toBe('stale')
    expect(lookupNewsCache({ version: 1, fetchedAt: 'x', items } as never, 0).status).toBe('miss')
    expect(lookupNewsCache({ version: 1, fetchedAt: 0, items: 'no' } as never, 0).status).toBe('miss')
  })
})
