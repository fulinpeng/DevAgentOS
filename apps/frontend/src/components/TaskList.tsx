import { useCallback, useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { apiDelete, apiGet } from '../api/client'
import type { RootTaskRow, TaskDetailResponse, TaskNode } from '../types/task'
import { riskShort } from './RiskBadge'

function prettyJson(value: unknown): string {
  return JSON.stringify(value ?? {}, null, 2)
}

function shortTaskName(name: string, max = 20): string {
  const n = name.trim()
  if (n.length <= max) {
    return n
  }
  return `${n.slice(0, max)}…`
}

function TaskConfigModal({
  open,
  task,
  onClose,
}: {
  open: boolean
  task: TaskNode | null
  onClose: () => void
}) {
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
        aria-labelledby="task-config-modal-title"
        onClick={(e) => e.stopPropagation()}
        style={{ maxWidth: 720 }}
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
          <div>
            <h2
              id="task-config-modal-title"
              style={{ margin: 0, fontSize: '1.15rem' }}
            >
              任务配置
            </h2>
            <p className="muted" style={{ margin: '6px 0 0', fontSize: '0.88rem' }}>
              {task.name} · <code>{task.id}</code>
            </p>
          </div>
          <button
            type="button"
            className="btn"
            aria-label="关闭"
            onClick={() => onClose()}
          >
            关闭
          </button>
        </div>

        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(2, minmax(0, 1fr))',
            gap: 12,
            marginBottom: 12,
          }}
        >
          <div className="panel" style={{ margin: 0 }}>
            <strong>基础信息</strong>
            <p className="muted" style={{ margin: '8px 0 0' }}>
              状态：<code>{task.status}</code>
            </p>
            <p className="muted" style={{ margin: '8px 0 0' }}>
              角色：<code>{task.role ?? '—'}</code>
            </p>
            <p className="muted" style={{ margin: '8px 0 0' }}>
              来源：<code>{task.parameterSourceLabel ?? '—'}</code>
            </p>
            <p className="muted" style={{ margin: '8px 0 0' }}>
              顺序：<code>{task.sortOrder}</code>
            </p>
          </div>
          <div className="panel" style={{ margin: 0 }}>
            <strong>时间信息</strong>
            <p className="muted" style={{ margin: '8px 0 0' }}>
              创建：{new Date(task.createdAt).toLocaleString()}
            </p>
            <p className="muted" style={{ margin: '8px 0 0' }}>
              更新：{new Date(task.updatedAt).toLocaleString()}
            </p>
            {task.approvalReason ? (
              <p className="muted" style={{ margin: '8px 0 0' }}>
                审批原因：{task.approvalReason}
              </p>
            ) : null}
          </div>
        </div>

        <label className="form-field">
          <span>parameters</span>
          <textarea
            readOnly
            value={prettyJson(task.parameters)}
            rows={12}
            style={{ fontFamily: 'ui-monospace, monospace', fontSize: '0.82rem' }}
          />
        </label>

        <label className="form-field">
          <span>result</span>
          <textarea
            readOnly
            value={prettyJson(task.result)}
            rows={10}
            style={{ fontFamily: 'ui-monospace, monospace', fontSize: '0.82rem' }}
          />
        </label>
      </div>
    </div>
  )
}

export function TaskList() {
  const [rows, setRows] = useState<RootTaskRow[] | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [deletingId, setDeletingId] = useState<string | null>(null)
  const [configTask, setConfigTask] = useState<TaskNode | null>(null)
  const [configLoading, setConfigLoading] = useState(false)

  const reload = useCallback(() => {
    return apiGet<RootTaskRow[]>('/task/list').then(setRows)
  }, [])

  useEffect(() => {
    let cancelled = false
    setErr(null)
    reload()
      .catch((e: Error) => {
        if (!cancelled) setErr(e.message)
      })
    return () => {
      cancelled = true
    }
  }, [reload])

  async function removeRow(id: string, name: string) {
    if (
      !window.confirm(
        `确定删除主任务「${name}」？将同时删除其全部子任务与相关数据，且不可恢复。`,
      )
    ) {
      return
    }
    setDeletingId(id)
    setErr(null)
    try {
      await apiDelete(`/task/${id}`)
      await reload()
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
    } finally {
      setDeletingId(null)
    }
  }

  async function openConfig(id: string) {
    setConfigLoading(true)
    setErr(null)
    try {
      const detail = await apiGet<TaskDetailResponse>(`/task/${id}`)
      setConfigTask(detail.task)
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
    } finally {
      setConfigLoading(false)
    }
  }

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
        <strong>已完成</strong>的任务可<strong>微调</strong>；追加任务可在详情页任务树下操作。
      </p>
      <table className="data-table">
        <thead>
          <tr>
            <th>名称</th>
            <th>状态</th>
            <th>风险</th>
            <th>子任务数</th>
            <th>创建时间</th>
            <th>操作</th>
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
                <td title={r.name}>{shortTaskName(r.name)}</td>
                <td>
                  <code>{r.status}</code>
                </td>
                <td>{riskShort(r.riskLevel)}</td>
                <td>{r.childCount}</td>
                <td>{new Date(r.createdAt).toLocaleString()}</td>
                <td>
                  <Link to={`/task/${r.id}`}>详情</Link>
                  {' · '}
                  <button
                    type="button"
                    className="btn"
                    style={{ fontSize: '0.82rem', padding: '2px 8px' }}
                    disabled={configLoading}
                    onClick={() => void openConfig(r.id)}
                  >
                    {configLoading && configTask?.id !== r.id ? '读取中…' : '配置'}
                  </button>
                  {' · '}
                  {r.status === 'COMPLETED' ? (
                    <Link to={`/task/${r.id}?refine=1`}>微调</Link>
                  ) : (
                    <span className="muted" title="仅已完成任务可微调">
                      微调
                    </span>
                  )}
                  {r.status === 'CREATED' ? (
                    <>
                      {' · '}
                      <Link to={`/task/${r.id}/edit`}>编辑</Link>
                    </>
                  ) : null}
                  {' · '}
                  <button
                    type="button"
                    className="btn btn-danger"
                    style={{ fontSize: '0.82rem', padding: '2px 8px' }}
                    disabled={deletingId === r.id || r.status === 'RUNNING'}
                    title={
                      r.status === 'RUNNING'
                        ? 'RUNNING 时不可删除'
                        : '删除主任务及全部子任务'
                    }
                    onClick={() => void removeRow(r.id, r.name)}
                  >
                    {deletingId === r.id ? '删除中…' : '删除'}
                  </button>
                </td>
              </tr>
            ))
          )}
        </tbody>
      </table>
      <TaskConfigModal
        open={configTask !== null}
        task={configTask}
        onClose={() => setConfigTask(null)}
      />
    </div>
  )
}
