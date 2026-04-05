import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { apiGet } from '../api/client'
import type { RootTaskRow } from '../types/task'

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
      <h2>任务列表（主任务）</h2>
      <table className="data-table">
        <thead>
          <tr>
            <th>名称</th>
            <th>状态</th>
            <th>子任务数</th>
            <th>创建时间</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {rows.length === 0 ? (
            <tr>
              <td colSpan={5}>暂无数据</td>
            </tr>
          ) : (
            rows.map((r) => (
              <tr key={r.id}>
                <td>{r.name}</td>
                <td>
                  <code>{r.status}</code>
                </td>
                <td>{r.childCount}</td>
                <td>{new Date(r.createdAt).toLocaleString()}</td>
                <td>
                  <Link to={`/task/${r.id}`}>详情</Link>
                </td>
              </tr>
            ))
          )}
        </tbody>
      </table>
    </div>
  )
}
