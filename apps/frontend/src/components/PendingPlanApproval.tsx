import { useCallback, useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { apiGet, apiPost } from '../api/client'
import type { PendingPlanApprovalRow } from '../types/task'

export function PendingPlanApproval() {
  const [rows, setRows] = useState<PendingPlanApprovalRow[] | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [busyId, setBusyId] = useState<string | null>(null)

  const load = useCallback(() => {
    setErr(null)
    return apiGet<PendingPlanApprovalRow[]>('/task/pending-plan-approval')
      .then(setRows)
      .catch((e: Error) => setErr(e.message))
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  async function approvePlan(id: string) {
    setBusyId(id)
    setErr(null)
    try {
      await apiPost(`/task/approve-plan/${id}`)
      await load()
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
    } finally {
      setBusyId(null)
    }
  }

  async function rejectPlan(id: string) {
    setBusyId(id)
    setErr(null)
    try {
      await apiPost(`/task/reject-plan/${id}`)
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
        <h2>待审计划（主任务）</h2>
        <p className="muted" style={{ marginTop: 0 }}>
          对应后端 <code>WAITING_PLAN_APPROVAL</code>：已生成子任务，等待批准或驳回计划。
        </p>
        {err ? <p className="error">{err}</p> : null}
        <table className="data-table">
          <thead>
            <tr>
              <th>主任务</th>
              <th>子任务数</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 ? (
              <tr>
                <td colSpan={3}>暂无待审计划</td>
              </tr>
            ) : (
              rows.map((r) => (
                <tr key={r.id}>
                  <td>{r.name}</td>
                  <td>{r.children?.length ?? 0}</td>
                  <td>
                    <div className="btn-row">
                      <button
                        type="button"
                        className="btn btn-primary"
                        disabled={busyId === r.id}
                        onClick={() => void approvePlan(r.id)}
                      >
                        批准计划
                      </button>
                      <button
                        type="button"
                        className="btn btn-danger"
                        disabled={busyId === r.id}
                        onClick={() => void rejectPlan(r.id)}
                      >
                        驳回计划
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
