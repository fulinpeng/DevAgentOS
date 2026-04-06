import { useCallback, useEffect, useMemo, useState } from 'react'
import { Link, useLocation, useParams } from 'react-router-dom'
import { apiGet, apiPatch, apiPost } from '../api/client'
import type {
  GeneratePlanResponse,
  TaskDetailResponse,
  TaskNode,
} from '../types/task'
import { RiskBadge } from './RiskBadge'
import { TaskLogs } from './TaskLogs'

function getDescriptionPreview(params: unknown): string | undefined {
  if (params && typeof params === 'object' && 'description' in params) {
    const d = (params as { description?: unknown }).description
    if (typeof d === 'string' && d.trim().length > 0) {
      return d.trim()
    }
  }
  return undefined
}

function TaskRow({
  t,
  depth,
  queueIndex,
  queueTotal,
}: {
  t: TaskNode
  depth: number
  /** 子任务在串行队列中的序号（1-based），主任务不传 */
  queueIndex?: number
  queueTotal?: number
}) {
  const rowBg =
    t.status === 'RUNNING' || t.status === 'WORKER_PAUSED'
      ? 'rgba(255, 193, 7, 0.12)'
      : depth > 0
        ? 'rgba(0,0,0,0.03)'
        : undefined
  const serialHint =
    depth === 0
      ? '—'
      : queueIndex !== undefined && queueTotal !== undefined
        ? queueIndex === 1
          ? `队首（共 ${queueTotal} 步串行）`
          : `上一子任务完成后执行（第 ${queueIndex}/${queueTotal} 步）`
        : '—'
  return (
    <tr style={{ background: rowBg }}>
      <td>{depth === 0 ? '—' : t.sortOrder}</td>
      <td style={{ paddingLeft: `${8 + depth * 16}px` }}>
        {depth > 0 ? '└ ' : ''}
        {t.name}
      </td>
      <td>
        <code>{t.status}</code>
      </td>
      <td className="muted" style={{ fontSize: '0.88rem', maxWidth: 220 }}>
        {serialHint}
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
  const splitHintFromNav = (location.state as { splitHint?: string } | null)
    ?.splitHint
  const [splitHintFromGenerate, setSplitHintFromGenerate] = useState<
    string | null
  >(null)
  const [data, setData] = useState<TaskDetailResponse | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [actionErr, setActionErr] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const splitHintBanner =
    splitHintFromGenerate ?? splitHintFromNav ?? undefined

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

  const descriptionForPlan = useMemo(
    () => (data ? getDescriptionPreview(data.task.parameters) : undefined),
    [data],
  )

  async function generatePlan() {
    if (!id) return
    setBusy(true)
    setActionErr(null)
    setSplitHintFromGenerate(null)
    try {
      const res = await apiPost<GeneratePlanResponse>(
        `/workflow/generate/${id}`,
      )
      setSplitHintFromGenerate(res.splitHint ?? null)
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

  async function continueWorker() {
    if (!id) return
    setBusy(true)
    setActionErr(null)
    try {
      await apiPost(`/role/execute/${id}`)
      await reload()
    } catch (e) {
      setActionErr(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  async function markRunningAsWorkerPaused() {
    if (!id) return
    setBusy(true)
    setActionErr(null)
    try {
      await apiPatch(`/task/${id}/status`, { status: 'WORKER_PAUSED' })
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
    Boolean(descriptionForPlan && descriptionForPlan.length > 0)

  const workerPauseResult =
    task.result !== null &&
    typeof task.result === 'object' &&
    !Array.isArray(task.result)
      ? (task.result as Record<string, unknown>)
      : null
  const remainingStepCount = Array.isArray(workerPauseResult?.remainingSteps)
    ? workerPauseResult.remainingSteps.length
    : 0

  return (
    <div>
      <nav className="breadcrumb">
        <Link to="/">← 列表</Link>
      </nav>

      {splitHintBanner ? (
        <div className="panel" style={{ marginBottom: 16 }}>
          <p className="muted" style={{ margin: 0 }}>
            <strong>生成计划提示：</strong>
            {splitHintBanner}
          </p>
        </div>
      ) : null}

      {task.status === 'WORKER_PAUSED' ? (
        <div className="panel" style={{ marginBottom: 16 }}>
          <h2>Worker 暂停（可续跑）</h2>
          <p className="muted" style={{ marginTop: 0 }}>
            常见原因：<code>runCommand</code> 超过约 10 分钟未结束（如网络/包管理器卡住）。任务已标为{' '}
            <code>WORKER_PAUSED</code>，未终止整条工作流；处理完环境后可在下方继续。
          </p>
          {workerPauseResult?.pauseReason ? (
            <p className="muted">
              原因码：<code>{String(workerPauseResult.pauseReason)}</code>
              {remainingStepCount > 0 ? (
                <>
                  {' '}
                  · 待执行步骤数：<strong>{remainingStepCount}</strong>
                </>
              ) : null}
            </p>
          ) : null}
          {actionErr ? <p className="error">{actionErr}</p> : null}
          <div className="btn-row" style={{ flexWrap: 'wrap', gap: 8 }}>
            <button
              type="button"
              className="btn btn-primary"
              disabled={busy}
              onClick={() => void continueWorker()}
            >
              继续执行（从断点续跑）
            </button>
          </div>
        </div>
      ) : null}

      {task.status === 'RUNNING' ? (
        <div className="panel" style={{ marginBottom: 16 }}>
          <h2>长时间 RUNNING？</h2>
          <p className="muted" style={{ marginTop: 0 }}>
            若前端仍显示 RUNNING 但实际已卡住（例如子进程已死锁），可手动标为 WORKER_PAUSED，再按暂停面板的续跑流程处理。
          </p>
          {actionErr ? <p className="error">{actionErr}</p> : null}
          <div className="btn-row" style={{ flexWrap: 'wrap', gap: 8 }}>
            <button
              type="button"
              className="btn btn-danger"
              disabled={busy}
              onClick={() => void markRunningAsWorkerPaused()}
            >
              标为 WORKER_PAUSED（人工救急）
            </button>
          </div>
        </div>
      ) : null}

      {isRoot ? (
        <div className="panel" style={{ marginBottom: 16 }}>
          <h2>计划（Plan）</h2>
          {task.status === 'CREATED' ? (
            <p className="muted" style={{ marginTop: 0 }}>
              <Link to={`/task/${task.id}/edit`}>编辑草稿</Link>
              （名称、goal、description、projectType、outputDir）
            </p>
          ) : null}
          <p className="muted">
            状态：<code>{task.status}</code>
            {descriptionForPlan ? (
              <>
                {' '}
                · 已填详细需求（预览）：{' '}
                {descriptionForPlan.length > 120
                  ? `${descriptionForPlan.slice(0, 120)}…`
                  : descriptionForPlan}
              </>
            ) : (
              <>
                {' '}
                · 未填写 parameters.description，请先
                <Link to={`/task/${task.id}/edit`}> 编辑任务草稿 </Link>
                补充自然语言需求后再生成计划
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
                    ? '需要 parameters.description 非空（自然语言详细需求）'
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
                <p className="muted" style={{ margin: '0 0 8px', maxWidth: 520 }}>
                  子任务按 sortOrder / 依赖顺序由后端 Coordinator 依次调用 Role/Worker 执行；请点下方按钮启动。
                </p>
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
        {isRoot && children.length > 0 ? (
          <div
            className="muted"
            style={{
              marginBottom: '0.75rem',
              padding: '0.65rem 0.75rem',
              background: 'rgba(0,0,0,0.04)',
              borderRadius: 6,
              maxWidth: 720,
            }}
          >
            <strong>串行执行说明：</strong>
            Coordinator 按下方「顺序」列（对应数据库 <code>sortOrder</code>
            ）<strong>一次只跑一个</strong>子任务；上一项为{' '}
            <code>COMPLETED</code> 后才会启动下一项。因此多个子任务为{' '}
            <code>PENDING</code> 时表示<strong>在排队</strong>，并非未调度。
            若某项长期 <code>RUNNING</code>，整条链会停在该项。
            <br />
            <strong>中途报错去哪看：</strong>Worker 步骤级日志（如{' '}
            <code>step_fail</code>、<code>step_success</code>）记在<strong>该子任务</strong>
            名下。请点对应行的「查看」进入子任务页，滚动到「执行日志」；主任务页底部日志<strong>不含</strong>
            各子任务的 Worker 明细。若子任务最终仍为 <code>COMPLETED</code>
            ，说明后续步骤已把流程拉回成功，历史失败仍可在该子任务日志中查看。
          </div>
        ) : null}
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
              <th>顺序</th>
              <th>名称</th>
              <th>状态</th>
              <th>串行关系</th>
              <th>角色</th>
              <th>来源</th>
              <th>风险</th>
              <th />
            </tr>
          </thead>
          <tbody>
            <TaskRow t={task} depth={0} />
            {children.map((c, i) => (
              <TaskRow
                key={c.id}
                t={c}
                depth={1}
                queueIndex={i + 1}
                queueTotal={children.length}
              />
            ))}
          </tbody>
        </table>
      </div>

      <TaskLogs
        taskId={id}
        scopeHint={
          isRoot && children.length > 0
            ? '当前为主任务：此处仅主任务相关 Redis 日志，不含各子任务的 Worker 步骤。若要看某子任务中途报错，请打开该子任务的详情页查看执行日志。'
            : !isRoot
              ? '此为当前子任务的执行日志。中途失败会留下 step_fail（及 meta 中的 error）；若之后又出现 step_success，说明后续步骤已恢复。'
              : undefined
        }
      />
    </div>
  )
}
