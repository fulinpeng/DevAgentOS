import { useEffect, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { apiGet } from '../api/client'
import type { TaskDetailResponse, TaskNode } from '../types/task'
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

  useEffect(() => {
    if (!id) return
    let cancelled = false
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
        <table className="data-table">
          <thead>
            <tr>
              <th>名称</th>
              <th>状态</th>
              <th>角色</th>
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
