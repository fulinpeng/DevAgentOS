import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { apiGet } from '../api/client'
import type { RootTaskRow } from '../types/task'
import { riskShort } from './RiskBadge'

export function TaskList() {
  const [rows, setRows] = useState<RootTaskRow[] | null>(null)
  const [err, setErr] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    apiGet<RootTaskRow[]>('/task/list')
      .then((data) => {
        if (!cancelled) setRows(data)
      })
      .catch((e: Error) => {
        if (!cancelled) setErr(e.message)
      })
    return () => {
      cancelled = true
    }
  }, [])

  if (err) {
    return <p className="error">加载失败：{err}</p>
  }
  if (!rows) {
    return <p>加载中…</p>
  }

  return (
    <div className="panel">
      <nav className="breadcrumb" style={{ marginBottom: '0.75rem' }}>
        <Link to="/new-task">新建任务</Link>
        <span className="muted"> · </span>
        <Link to="/pending-plan-approval">待审计划</Link>
        <span className="muted"> · </span>
        <Link to="/pending-approval">待审批执行 →</Link>
      </nav>
      <h2>任务列表（主任务）</h2>
      <p className="muted" style={{ marginBottom: '0.75rem' }}>
        本页只显示<strong>根任务</strong>（<code>parentId</code> 为空）。拆计划产生的
        <strong>子任务</strong>不会单独占一行，请点进对应主任务的详情查看任务树。
      </p>
      <table className="data-table">
        <thead>
          <tr>
            <th>名称</th>
            <th>状态</th>
            <th>风险</th>
            <th>子任务数</th>
            <th>创建时间</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {rows.length === 0 ? (
            <tr>
              <td colSpan={6}>
                <p style={{ margin: 0 }}>暂无主任务。</p>
                <p className="muted" style={{ margin: '0.5rem 0 0' }}>
                  若你在数据库里能看到多条 <code>Task</code>，请确认其中有几条{' '}
                  <code>parentId IS NULL</code>
                  ——只有它们会出现在这里；其余是子任务。若根任务应为 0 条却仍显示异常，请核对前端{' '}
                  <code>VITE_API_BASE</code> 与后端是否为同一实例、是否指向同一份{' '}
                  <code>dev.db</code>。
                </p>
              </td>
            </tr>
          ) : (
            rows.map((r) => (
              <tr key={r.id}>
                <td>{r.name}</td>
                <td>
                  <code>{r.status}</code>
                </td>
                <td>{riskShort(r.riskLevel)}</td>
                <td>{r.childCount}</td>
                <td>{new Date(r.createdAt).toLocaleString()}</td>
                <td>
                  <Link to={`/task/${r.id}`}>详情</Link>
                  {r.status === 'CREATED' ? (
                    <>
                      {' · '}
                      <Link to={`/task/${r.id}/edit`}>编辑</Link>
                    </>
                  ) : null}
                </td>
              </tr>
            ))
          )}
        </tbody>
      </table>
    </div>
  )
}
