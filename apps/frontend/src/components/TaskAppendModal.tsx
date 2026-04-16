import { useEffect, useState } from 'react'
import { apiPost } from '../api/client'
import type { AppendTaskResponse } from '../types/task'

function parametersForAppendDefaults(
  raw: unknown,
): Record<string, unknown> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return {}
  }
  const o = { ...(raw as Record<string, unknown>) }
  delete o.workerResumeSteps
  // 子任务应有独立说明，勿沿用父任务 parameters 里的长描述
  delete o.taskDescription
  return o
}

type Props = {
  open: boolean
  onClose: () => void
  sourceTaskId: string
  defaultRole: string | null
  /** 打开弹窗时填入 parameters 文本框的默认值（一般为当前页任务的 parameters） */
  defaultParameters: unknown
  onDone: (newTaskId: string) => void
  onReload: () => Promise<void>
}

export function TaskAppendModal({
  open,
  onClose,
  sourceTaskId,
  defaultRole,
  defaultParameters,
  onDone,
  onReload,
}: Props) {
  const [name, setName] = useState('')
  const [taskDescription, setTaskDescription] = useState('')
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
    setTaskDescription('')
    setRole(defaultRole ?? '')
    const base = parametersForAppendDefaults(defaultParameters)
    setParamsJson(JSON.stringify(base, null, 2))
  }, [open, defaultRole, defaultParameters])

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
      setErr('请填写任务名称')
      return
    }
    const desc = taskDescription.trim()
    if (desc) {
      parameters = { ...parameters, taskDescription: desc }
      const hasGoal =
        (typeof parameters.workflowGoal === 'string' &&
          parameters.workflowGoal.trim() !== '') ||
        (typeof parameters.goal === 'string' && parameters.goal.trim() !== '')
      if (!hasGoal) {
        parameters = { ...parameters, goal: desc }
      }
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
          <span>任务名称</span>
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            disabled={busy}
            autoComplete="off"
            placeholder="列表与任务树中显示的短标题"
          />
        </label>
        <label className="form-field">
          <span>任务描述</span>
          <textarea
            value={taskDescription}
            onChange={(e) => setTaskDescription(e.target.value)}
            rows={5}
            disabled={busy}
            placeholder="详细需求与验收要点（推荐填写）；留空时 Worker 主要参考任务名称，也可仅在下方 JSON 中写 taskDescription"
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
          <span>parameters（JSON，默认已复制当前任务的 parameters，可改）</span>
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
