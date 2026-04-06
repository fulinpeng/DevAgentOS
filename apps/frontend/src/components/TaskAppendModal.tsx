import { useEffect, useState } from 'react'
import { apiPost } from '../api/client'
import type { AppendTaskResponse } from '../types/task'

type Props = {
  open: boolean
  onClose: () => void
  sourceTaskId: string
  defaultRole: string | null
  onDone: (newTaskId: string) => void
  onReload: () => Promise<void>
}

export function TaskAppendModal({
  open,
  onClose,
  sourceTaskId,
  defaultRole,
  onDone,
  onReload,
}: Props) {
  const [name, setName] = useState('')
  const [role, setRole] = useState('')
  const [paramsJson, setParamsJson] = useState('{}')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  useEffect(() => {
    if (!open) {
      return
    }
    setErr(null)
    setName('')
    setRole(defaultRole ?? '')
    setParamsJson('{}')
  }, [open, defaultRole])

  async function submit() {
    let parameters: Record<string, unknown> | undefined
    try {
      const p = JSON.parse(paramsJson.trim() || '{}') as unknown
      if (
        p === null ||
        typeof p !== 'object' ||
        Array.isArray(p)
      ) {
        throw new Error('parameters 须为 JSON 对象')
      }
      parameters = p as Record<string, unknown>
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
      return
    }
    if (!name.trim()) {
      setErr('请填写子任务名称')
      return
    }
    setBusy(true)
    setErr(null)
    try {
      const res = await apiPost<AppendTaskResponse>(
        `/task/${sourceTaskId}/append`,
        {
          name: name.trim(),
          role: role.trim() || undefined,
          parameters,
        },
      )
      await onReload()
      onClose()
      onDone(res.newTask.id)
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
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
        aria-labelledby="append-modal-title"
        onClick={(e) => e.stopPropagation()}
        style={{ maxWidth: 520 }}
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
          <h2 id="append-modal-title" style={{ margin: 0, fontSize: '1.15rem' }}>
            追加任务
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
          在当前工作流父节点下<strong>新建一条子任务</strong>并尝试执行。须已生成计划（根任务至少有一条子任务）。
        </p>
        {err ? <p className="error">{err}</p> : null}
        <label className="form-field">
          <span>子任务名称</span>
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            disabled={busy}
            autoComplete="off"
          />
        </label>
        <label className="form-field">
          <span>角色 role（可选，默认沿用当前节点）</span>
          <input
            type="text"
            value={role}
            onChange={(e) => setRole(e.target.value)}
            disabled={busy}
            autoComplete="off"
          />
        </label>
        <label className="form-field">
          <span>parameters（JSON）</span>
          <textarea
            value={paramsJson}
            onChange={(e) => setParamsJson(e.target.value)}
            rows={8}
            disabled={busy}
            style={{ fontFamily: 'ui-monospace, monospace', fontSize: '0.82rem' }}
          />
        </label>
        <div className="btn-row" style={{ marginTop: 12 }}>
          <button
            type="button"
            className="btn btn-primary"
            disabled={busy || !name.trim()}
            onClick={() => void submit()}
          >
            {busy ? '提交中…' : '创建并执行'}
          </button>
        </div>
      </div>
    </div>
  )
}
