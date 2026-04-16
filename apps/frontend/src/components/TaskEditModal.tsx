import { useEffect, useState } from 'react'
import { apiPatch } from '../api/client'
import type { TaskDetailResponse, TaskNode } from '../types/task'

type Props = {
  open: boolean
  onClose: () => void
  task: TaskNode | null
  onSaved: (detail: TaskDetailResponse) => void
}

export function TaskEditModal({ open, onClose, task, onSaved }: Props) {
  const [name, setName] = useState('')
  const [describe, setDescribe] = useState('')
  const [role, setRole] = useState('')
  const [sortOrder, setSortOrder] = useState(0)
  const [paramsJson, setParamsJson] = useState('{}')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  useEffect(() => {
    if (!open || !task) {
      return
    }
    setErr(null)
    setName(task.name)
    const p = task.parameters
    if (p && typeof p === 'object' && !Array.isArray(p)) {
      const r = p as Record<string, unknown>
      const td =
        typeof r.taskDescription === 'string' ? r.taskDescription.trim() : ''
      setDescribe(td)
    } else {
      setDescribe('')
    }
    setRole(task.role ?? '')
    setSortOrder(task.sortOrder)
    setParamsJson(JSON.stringify(task.parameters ?? {}, null, 2))
  }, [open, task])

  async function save() {
    if (!task) {
      return
    }
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
    setBusy(true)
    setErr(null)
    try {
      const detail = await apiPatch<TaskDetailResponse>(`/task/${task.id}`, {
        name: name.trim(),
        role: role.trim(),
        sortOrder,
        parameters: {
          ...parameters,
          taskDescription: describe.trim(),
        },
      })
      onSaved(detail)
      onClose()
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  if (!open || !task) {
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
        aria-labelledby="edit-modal-title"
        onClick={(e) => e.stopPropagation()}
        style={{ maxWidth: 560 }}
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
          <h2 id="edit-modal-title" style={{ margin: 0, fontSize: '1.15rem' }}>
            编辑任务
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
          未开始执行的任务可修改名称、角色、顺序与 parameters（JSON）。角色留空将清空。
        </p>
        {err ? <p className="error">{err}</p> : null}
        <label className="form-field">
          <span>名称 name</span>
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            disabled={busy}
            placeholder="简短标题（用于列表展示）"
            autoComplete="off"
          />
        </label>
        <label className="form-field">
          <span>描述 describe / taskDescription</span>
          <textarea
            value={describe}
            onChange={(e) => setDescribe(e.target.value)}
            rows={5}
            disabled={busy}
            placeholder="这里填写给 LLM 的详细任务描述"
            autoComplete="off"
          />
        </label>
        <label className="form-field">
          <span>角色 role（可选）</span>
          <input
            type="text"
            value={role}
            onChange={(e) => setRole(e.target.value)}
            disabled={busy}
            placeholder="frontend / backend …"
            autoComplete="off"
          />
        </label>
        <label className="form-field">
          <span>顺序 sortOrder</span>
          <input
            type="number"
            value={sortOrder}
            onChange={(e) => setSortOrder(Number(e.target.value))}
            disabled={busy}
          />
        </label>
        <label className="form-field">
          <span>parameters（JSON 对象）</span>
          <textarea
            value={paramsJson}
            onChange={(e) => setParamsJson(e.target.value)}
            rows={12}
            disabled={busy}
            style={{ fontFamily: 'ui-monospace, monospace', fontSize: '0.82rem' }}
          />
        </label>
        <div className="btn-row" style={{ marginTop: 12 }}>
          <button
            type="button"
            className="btn btn-primary"
            disabled={busy || !name.trim() || !describe.trim()}
            onClick={() => void save()}
          >
            {busy ? '保存中…' : '保存'}
          </button>
        </div>
      </div>
    </div>
  )
}
