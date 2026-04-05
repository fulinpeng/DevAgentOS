import { useCallback, useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { apiGet, apiPost } from '../api/client'
import type { TaskNode } from '../types/task'
import { riskShort } from './RiskBadge'

export function PendingApproval() {
  const [rows, setRows] = useState<TaskNode[] | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [busyId, setBusyId] = useState<string | null>(null)

  const load = useCallback(() => {
    setErr(null)
    return apiGet<TaskNode[]>('/task/pending-approval')
      .then(setRows)
      .catch((e: Error) => setErr(e.message))
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  async function approve(id: string) {
    setBusyId(id)
    setErr(null)
    try {
      await apiPost(`/task/approve/${id}`)
      await load()
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
    } finally {
      setBusyId(null)
    }
  }

  async function reject(id: string) {
    setBusyId(id)
    setErr(null)
    try {
      await apiPost(`/task/reject/${id}`)
      await load()
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
    } finally {
      setBusyId(null)
    }
  }

  if (err && !rows) {
    return <p className="error">加载失败：{err}</p>
  }
  if (!rows) {
    return <p>加载中…</p>
  }

  return (
    <div>
      <nav className="breadcrumb">
        <Link to="/">← 任务列表</Link>
      </nav>

      <div className="panel">
        <h2>待审批任务</h2>
        {err ? <p className="error">{err}</p> : null}
        <table className="data-table">
          <thead>
            <tr>
              <th>名称</th>
              <th>来源</th>
              <th>风险</th>
              <th>审批说明</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 ? (
              <tr>
                <td colSpan={5}>暂无待审批任务</td>
              </tr>
            ) : (
              rows.map((r) => (
                <tr key={r.id}>
                  <td>{r.name}</td>
                  <td>{r.parameterSourceLabel ?? '—'}</td>
                  <td>{r.riskLevel ? riskShort(r.riskLevel) : '—'}</td>
                  <td className="muted" style={{ maxWidth: 280 }}>
                    {r.approvalReason ?? '—'}
                  </td>
                  <td>
                    <div className="btn-row">
                      <button
                        type="button"
                        className="btn btn-primary"
                        disabled={busyId === r.id}
                        onClick={() => void approve(r.id)}
                      >
                        批准
                      </button>
                      <button
                        type="button"
                        className="btn btn-danger"
                        disabled={busyId === r.id}
                        onClick={() => void reject(r.id)}
                      >
                        拒绝
                      </button>
                      <Link to={`/task/${r.id}`}>详情</Link>
                    </div>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </div>
  )
}
