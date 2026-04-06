import { useCallback, useEffect, useMemo, useState } from 'react'
import { Link, useLocation, useParams } from 'react-router-dom'
import { apiGet, apiPost } from '../api/client'
import type { TaskDetailResponse, TaskNode } from '../types/task'
import { RiskBadge } from './RiskBadge'
import { TaskLogs } from './TaskLogs'

function getFeaturesFromParameters(params: unknown): string[] | undefined {
  if (params && typeof params === 'object' && 'features' in params) {
    const f = (params as { features?: unknown }).features
    if (Array.isArray(f) && f.every((x) => typeof x === 'string')) {
      return f as string[]
    }
  }
  return undefined
}

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
      <td>{t.riskLevel ? <RiskBadge level={t.riskLevel} /> : '—'}</td>
      <td>
        <Link to={`/task/${t.id}`}>查看</Link>
      </td>
    </tr>
  )
}

export function TaskDetail() {
  const { id } = useParams<{ id: string }>()
  const location = useLocation()
  const splitHint = (location.state as { splitHint?: string } | null)?.splitHint
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

  const isRoot = data?.task.parentId === null

  const featuresForPlan = useMemo(
    () => (data ? getFeaturesFromParameters(data.task.parameters) : undefined),
    [data],
  )

  async function generatePlan() {
    if (!id) return
    setBusy(true)
    setActionErr(null)
    try {
      await apiPost(`/workflow/generate/${id}`)
      await reload()
    } catch (e) {
      setActionErr(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  async function approvePlan() {
    if (!id) return
    setBusy(true)
    setActionErr(null)
    try {
      await apiPost(`/task/approve-plan/${id}`)
      await reload()
    } catch (e) {
      setActionErr(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  async function rejectPlan() {
    if (!id) return
    setBusy(true)
    setActionErr(null)
    try {
      await apiPost(`/task/reject-plan/${id}`)
      await reload()
    } catch (e) {
      setActionErr(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  async function runCoordinator() {
    if (!id) return
    setBusy(true)
    setActionErr(null)
    try {
      await apiPost(`/coordinator/run/${id}`)
      await reload()
    } catch (e) {
      setActionErr(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  async function approveExecution() {
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

  async function rejectExecution() {
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
    const isNotFound =
      err.includes('404') || err.toLowerCase().includes('not found')
    return (
      <div className="panel">
        <p className="error">加载失败：{err}</p>
        {isNotFound ? (
          <p className="muted" style={{ marginTop: '0.75rem' }}>
            说明：该 ID 在当前后端连接的数据库里<strong>没有对应任务</strong>
            （不是「没存库」，而是这条记录已不存在或连错了库）。
            常见情况：执行过 <code>prisma migrate reset</code>、删过{' '}
            <code>prisma/dev.db</code>、换过工作目录/拷贝项目、跑过会清表的测试，或
            创建任务时连的是另一端口/另一台机器上的后端。
          </p>
        ) : null}
        <nav className="breadcrumb" style={{ marginTop: '1rem' }}>
          <Link to="/">← 返回任务列表</Link>
        </nav>
      </div>
    )
  }
  if (!data) {
    return <p>加载中…</p>
  }

  const { task, children } = data
  const canGeneratePlan =
    isRoot &&
    task.status === 'CREATED' &&
    (featuresForPlan?.length ?? 0) > 0

  return (
    <div>
      <nav className="breadcrumb">
        <Link to="/">← 列表</Link>
      </nav>

      {splitHint ? (
        <div className="panel" style={{ marginBottom: 16 }}>
          <p className="muted" style={{ margin: 0 }}>
            <strong>拆分提示：</strong>
            {splitHint}
          </p>
        </div>
      ) : null}

      {isRoot ? (
        <div className="panel" style={{ marginBottom: 16 }}>
          <h2>计划（Plan）</h2>
          {task.status === 'CREATED' ? (
            <p className="muted" style={{ marginTop: 0 }}>
              <Link to={`/task/${task.id}/edit`}>编辑草稿</Link>
              （名称、features、outputDir）
            </p>
          ) : null}
          <p className="muted">
            状态：<code>{task.status}</code>
            {featuresForPlan?.length ? (
              <>
                {' '}
                · features: {featuresForPlan.join(', ')}
              </>
            ) : (
              <>
                {' '}
                · 未配置 features，请先
                <Link to={`/task/${task.id}/edit`}> 编辑任务草稿 </Link>
                填写 features 后再生成计划
              </>
            )}
          </p>
          {actionErr ? <p className="error">{actionErr}</p> : null}
          <div className="btn-row" style={{ flexWrap: 'wrap', gap: 8 }}>
            {task.status === 'CREATED' ? (
              <button
                type="button"
                className="btn btn-primary"
                disabled={busy || !canGeneratePlan}
                title={
                  !canGeneratePlan
                    ? '需要 parameters.features 非空'
                    : undefined
                }
                onClick={() => void generatePlan()}
              >
                生成计划
              </button>
            ) : null}
            {task.status === 'WAITING_PLAN_APPROVAL' ? (
              <>
                <button
                  type="button"
                  className="btn btn-primary"
                  disabled={busy}
                  onClick={() => void approvePlan()}
                >
                  批准计划
                </button>
                <button
                  type="button"
                  className="btn btn-danger"
                  disabled={busy}
                  onClick={() => void rejectPlan()}
                >
                  驳回计划
                </button>
              </>
            ) : null}
            {task.status === 'PLAN_APPROVED' ? (
              <>
                <button
                  type="button"
                  className="btn"
                  disabled
                  title="执行计划独立 API 尚未接入；当前请使用「运行 Coordinator」启动子任务链"
                >
                  执行计划
                </button>
                <button
                  type="button"
                  className="btn btn-primary"
                  disabled={busy}
                  onClick={() => void runCoordinator()}
                >
                  运行 Coordinator
                </button>
              </>
            ) : null}
          </div>
        </div>
      ) : null}

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
        {!isRoot && task.status === 'WAITING_APPROVAL' ? (
          <div className="approval-actions">
            {actionErr ? <p className="error">{actionErr}</p> : null}
            <div className="btn-row">
              <button
                type="button"
                className="btn btn-primary"
                disabled={busy}
                onClick={() => void approveExecution()}
              >
                批准执行
              </button>
              <button
                type="button"
                className="btn btn-danger"
                disabled={busy}
                onClick={() => void rejectExecution()}
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
