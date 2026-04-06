import { useCallback, useEffect, useState } from 'react'
import { apiGet, apiPost } from '../api/client'
import type {
  ExecuteRefinementResponse,
  TaskVersionRow,
} from '../types/task'

function refinementDescriptionPreview(data: unknown): string {
  if (data && typeof data === 'object' && 'description' in data) {
    const d = (data as { description?: unknown }).description
    if (typeof d === 'string' && d.trim().length > 0) {
      const t = d.trim()
      return t.length > 100 ? `${t.slice(0, 100)}…` : t
    }
  }
  return '—'
}

type Props = {
  open: boolean
  onClose: () => void
  taskId: string
  onReloadParent: () => Promise<void>
}

export function TaskRefinementModal({
  open,
  onClose,
  taskId,
  onReloadParent,
}: Props) {
  const [versions, setVersions] = useState<TaskVersionRow[] | null>(null)
  const [instruction, setInstruction] = useState('')
  const [refineBusy, setRefineBusy] = useState(false)
  const [execBusy, setExecBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  const loadVersions = useCallback(async () => {
    try {
      const rows = await apiGet<TaskVersionRow[]>(`/task/${taskId}/versions`)
      setVersions(rows)
    } catch (e) {
      setVersions([])
      setErr(e instanceof Error ? e.message : String(e))
    }
  }, [taskId])

  useEffect(() => {
    if (!open || !taskId) {
      return
    }
    setErr(null)
    void loadVersions()
  }, [open, taskId, loadVersions])

  const hasActiveVersion = versions?.some((v) => v.isActive) ?? false

  async function submitRefine() {
    if (!instruction.trim()) return
    setRefineBusy(true)
    setErr(null)
    try {
      await apiPost(`/task/refine/${taskId}`, {
        instruction: instruction.trim(),
      })
      setInstruction('')
      await loadVersions()
      await onReloadParent()
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
    } finally {
      setRefineBusy(false)
    }
  }

  async function activate(versionId: string) {
    setRefineBusy(true)
    setErr(null)
    try {
      await apiPost(`/task/version/activate/${versionId}`)
      await loadVersions()
      await onReloadParent()
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
    } finally {
      setRefineBusy(false)
    }
  }

  async function executeRerunOnSameTask() {
    setExecBusy(true)
    setErr(null)
    try {
      await apiPost<ExecuteRefinementResponse>(
        `/task/refine/${taskId}/execute`,
        {},
      )
      await onReloadParent()
      onClose()
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
    } finally {
      setExecBusy(false)
    }
  }

  if (!open) {
    return null
  }

  return (
    <div
      className="modal-backdrop"
      role="presentation"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose()
      }}
    >
      <div
        className="modal-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="refine-modal-title"
        onClick={(e) => e.stopPropagation()}
      >
        <div
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'flex-start',
            gap: 12,
            marginBottom: 12,
          }}
        >
          <h2 id="refine-modal-title" style={{ margin: 0, fontSize: '1.15rem' }}>
            任务微调
          </h2>
          <button
            type="button"
            className="btn"
            aria-label="关闭"
            onClick={() => onClose()}
          >
            关闭
          </button>
        </div>
        <p className="muted" style={{ marginTop: 0, fontSize: '0.88rem' }}>
          仅<strong>已完成（COMPLETED）</strong>任务可微调。生成草稿并<strong>激活</strong>后，可
          <strong>执行重跑</strong>：先将本任务置为 <code>PENDING</code> 并清空历史结果，再在同一任务 ID
          上执行 Worker，日志仍记在本任务下。需要<strong>全新子任务</strong>请用详情页「追加任务」，勿与此混用。
        </p>
        {err ? <p className="error">{err}</p> : null}
        <div style={{ marginBottom: '0.75rem' }}>
          <label
            htmlFor="refine-modal-instruction"
            className="muted"
            style={{ display: 'block', marginBottom: 6, fontSize: '0.88rem' }}
          >
            优化指令
          </label>
          <textarea
            id="refine-modal-instruction"
            rows={4}
            style={{
              width: '100%',
              boxSizing: 'border-box',
              fontFamily: 'inherit',
              fontSize: '0.9rem',
            }}
            placeholder="例如：补充验收步骤、调整输出路径…"
            value={instruction}
            disabled={refineBusy}
            onChange={(e) => setInstruction(e.target.value)}
          />
        </div>
        <div className="btn-row" style={{ marginBottom: '0.75rem' }}>
          <button
            type="button"
            className="btn btn-primary"
            disabled={refineBusy || !instruction.trim()}
            onClick={() => void submitRefine()}
          >
            生成微调草稿
          </button>
        </div>
        {versions && versions.length > 0 ? (
          <div style={{ marginTop: '0.75rem' }}>
            <h3 style={{ fontSize: '0.95rem', margin: '0 0 8px' }}>
              草稿版本
            </h3>
            <table className="data-table">
              <thead>
                <tr>
                  <th>版本</th>
                  <th>描述预览</th>
                  <th>状态</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {versions.map((v) => (
                  <tr key={v.id}>
                    <td>
                      <code>v{v.version}</code>
                    </td>
                    <td
                      className="muted"
                      style={{ fontSize: '0.82rem', maxWidth: 200 }}
                    >
                      {refinementDescriptionPreview(v.data)}
                    </td>
                    <td>
                      {v.isActive ? (
                        <strong>已激活</strong>
                      ) : (
                        <span className="muted">草稿</span>
                      )}
                    </td>
                    <td>
                      {v.isActive ? (
                        <span className="muted">—</span>
                      ) : (
                        <button
                          type="button"
                          className="btn btn-primary"
                          style={{
                            padding: '0.2rem 0.5rem',
                            fontSize: '0.82rem',
                          }}
                          disabled={refineBusy}
                          onClick={() => void activate(v.id)}
                        >
                          激活
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : versions && versions.length === 0 ? (
          <p className="muted" style={{ marginTop: 8, fontSize: '0.88rem' }}>
            尚无微调草稿。
          </p>
        ) : null}
        {hasActiveVersion ? (
          <div
            style={{
              marginTop: '1rem',
              paddingTop: '0.75rem',
              borderTop: '1px solid var(--border, #e5e5e5)',
            }}
          >
            <p className="muted" style={{ marginTop: 0, fontSize: '0.88rem' }}>
              已激活微调版本，可<strong>在本任务上重跑</strong>（先改状态再执行，日志同任务）。
            </p>
            <div className="btn-row">
              <button
                type="button"
                className="btn btn-primary"
                disabled={execBusy || refineBusy}
                onClick={() => void executeRerunOnSameTask()}
              >
                执行重跑（当前任务）
              </button>
            </div>
          </div>
        ) : null}
      </div>
    </div>
  )
}
