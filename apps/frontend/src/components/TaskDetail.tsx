import { useCallback, useEffect, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { apiGet, apiPost } from '../api/client'
import type { TaskDetailResponse, TaskNode } from '../types/task'
import { RiskBadge } from './RiskBadge'
import { TaskLogs } from './TaskLogs'

function TaskRow({ t, depth }: { t: TaskNode; depth: number }) {
  return (
    <tr style={{ background: depth > 0 ? 'rgba(0,0,0,0.03)' : undefined }}>
      <td style={{ paddingLeft: `${8 + depth * 16}px` }}>
        {depth > 0 ? '└ ' : ''}
        {t.name}
      </td>
      <td>
        <code>{t.status}</code>
      </td>
      <td>{t.role ?? '—'}</td>
      <td>{t.parameterSourceLabel ?? '—'}</td>
      <td>
        {t.riskLevel ? <RiskBadge level={t.riskLevel} /> : '—'}
      </td>
      <td>
        <Link to={`/task/${t.id}`}>查看</Link>
      </td>
    </tr>
  )
}

export function TaskDetail() {
  const { id } = useParams<{ id: string }>()
  const [data, setData] = useState<TaskDetailResponse | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [actionErr, setActionErr] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const reload = useCallback(() => {
    if (!id) return Promise.resolve()
    return apiGet<TaskDetailResponse>(`/task/${id}`).then(setData)
  }, [id])

  useEffect(() => {
    if (!id) return
    let cancelled = false
    setErr(null)
    apiGet<TaskDetailResponse>(`/task/${id}`)
      .then((d) => {
        if (!cancelled) setData(d)
      })
      .catch((e: Error) => {
        if (!cancelled) setErr(e.message)
      })
    return () => {
      cancelled = true
    }
  }, [id])

  async function approve() {
    if (!id) return
    setBusy(true)
    setActionErr(null)
    try {
      await apiPost(`/task/approve/${id}`)
      await reload()
    } catch (e) {
      setActionErr(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  async function reject() {
    if (!id) return
    setBusy(true)
    setActionErr(null)
    try {
      await apiPost(`/task/reject/${id}`)
      await reload()
    } catch (e) {
      setActionErr(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  if (!id) {
    return <p>无效任务 ID</p>
  }
  if (err) {
    return <p className="error">加载失败：{err}</p>
  }
  if (!data) {
    return <p>加载中…</p>
  }

  const { task, children } = data

  return (
    <div>
      <nav className="breadcrumb">
        <Link to="/">← 列表</Link>
      </nav>

      <div className="panel">
        <h2>任务树</h2>
        <p className="muted">
          当前节点：<strong>{task.name}</strong>（{task.id}）
        </p>
        <p className="muted">
          来源：<strong>{task.parameterSourceLabel ?? '—'}</strong>
          {task.riskLevel ? (
            <>
              {' '}
              · <RiskBadge level={task.riskLevel} />
            </>
          ) : null}
          {task.approvalReason ? (
            <>
              {' '}
              · {task.approvalReason}
            </>
          ) : null}
        </p>
        {task.status === 'WAITING_APPROVAL' ? (
          <div className="approval-actions">
            {actionErr ? <p className="error">{actionErr}</p> : null}
            <div className="btn-row">
              <button
                type="button"
                className="btn btn-primary"
                disabled={busy}
                onClick={() => void approve()}
              >
                批准执行
              </button>
              <button
                type="button"
                className="btn btn-danger"
                disabled={busy}
                onClick={() => void reject()}
              >
                拒绝
              </button>
            </div>
          </div>
        ) : null}
        <table className="data-table">
          <thead>
            <tr>
              <th>名称</th>
              <th>状态</th>
              <th>角色</th>
              <th>来源</th>
              <th>风险</th>
              <th />
            </tr>
          </thead>
          <tbody>
            <TaskRow t={task} depth={0} />
            {children.map((c) => (
              <TaskRow key={c.id} t={c} depth={1} />
            ))}
          </tbody>
        </table>
      </div>

      <TaskLogs taskId={id} />
    </div>
  )
}
