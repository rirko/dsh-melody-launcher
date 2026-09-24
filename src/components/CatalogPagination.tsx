import { ChevronLeft, ChevronRight } from 'lucide-react'

/** GitHub 资源市场的分页条。 */

interface CatalogPaginationProps {
  page: number
  pageCount: number
  visibleCount: number
  loading: boolean
  disabled: boolean
  onPageChange: (page: number) => void
  ariaLabel?: string
  summary?: string
}

export function CatalogPagination({ page, pageCount, visibleCount, loading, disabled, onPageChange, ariaLabel = '仓库分页', summary }: CatalogPaginationProps) {
  const normalizedPageCount = Math.max(1, pageCount)
  const controlsDisabled = loading || disabled

  return (
    <div className="catalog-pagination" role="navigation" aria-label={ariaLabel}>
      <p>
        {summary ?? `当前页显示 ${visibleCount} 个候选；每个 GitHub topic 最多开放前 1,000 条`}
      </p>
      <div className="catalog-page-controls">
        <button type="button" disabled={controlsDisabled || page <= 1} onClick={() => onPageChange(page - 1)} aria-label="上一页" title="上一页"><ChevronLeft size={17} /></button>
        <span aria-live="polite">第 {page} / {normalizedPageCount} 页</span>
        <button type="button" disabled={controlsDisabled || page >= normalizedPageCount} onClick={() => onPageChange(page + 1)} aria-label="下一页" title="下一页"><ChevronRight size={17} /></button>
      </div>
    </div>
  )
}
