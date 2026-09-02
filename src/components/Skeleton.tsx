import type { CSSProperties } from 'react'

/**
 * 市场加载骨架卡：与真实卡片同尺寸、扫光提示「正在读取」，
 * 替代生硬的居中转圈。count 控制张数，窄网格自动换行。
 */
export function SkeletonCards({ count }: { count: number }) {
  return (
    <div className="skeleton-grid" aria-hidden="true">
      {Array.from({ length: count }, (_, index) => (
        <div key={index} className="skeleton-card">
          <span className="skeleton-line skeleton-line-title" style={{ width: `${56 + (index % 3) * 12}%` } as CSSProperties} />
          <span className="skeleton-line" style={{ width: '40%' } as CSSProperties} />
          <span className="skeleton-line" style={{ width: `${86 - (index % 2) * 12}%` } as CSSProperties} />
          <span className="skeleton-line" style={{ width: `${62 + (index % 4) * 8}%` } as CSSProperties} />
          <span className="skeleton-block" />
        </div>
      ))}
    </div>
  )
}

/** 紧凑横向骨架条：用于面板内单个数据源的读取占位。 */
export function SkeletonStrip({ label }: { label: string }) {
  return (
    <div className="skeleton-strip" aria-hidden="true">
      <span className="skeleton-line" style={{ width: 120 } as CSSProperties} />
      <span className="skeleton-strip-label">{label}</span>
    </div>
  )
}