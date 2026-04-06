import type { FormEvent } from 'react'
import { useEffect, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { apiGet, apiPatch } from '../api/client'
import type { TaskDetailResponse } from '../types/task'

function stringFromParams(params: unknown, key: string): string {
  if (params && typeof params === 'object' && key in params) {
    const v = (params as Record<string, unknown>)[key]
    if (typeof v === 'string') return v
  }
  return ''
}

function outputDirFromParams(params: unknown): string {
  return stringFromParams(params, 'outputDir')
}

export function EditTask() {
  const { id } = useParams<{ id: string }>()
  const navigate = useNavigate()
  const [loading, setLoading] = useState(true)
  const [name, setName] = useState('')
  const [goal, setGoal] = useState('')
  const [description, setDescription] = useState('')
  const [projectType, setProjectType] = useState('')
  const [outputDir, setOutputDir] = useState('')
  const [err, setErr] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [metaErr, setMetaErr] = useState<string | null>(null)

  useEffect(() => {
    if (!id) return
    let cancelled = false
    setErr(null)
    apiGet<TaskDetailResponse>(`/task/${id}`)
      .then((d) => {
        if (cancelled) return
        const { task } = d
        if (task.parentId !== null) {
          setMetaErr('仅主任务可编辑草稿')
          setLoading(false)
          return
        }
        if (task.status !== 'CREATED') {
          setMetaErr(`当前状态为 ${task.status}，仅 CREATED 可编辑`)
          setLoading(false)
          return
        }
        setName(task.name)
        const p = task.parameters
        setGoal(stringFromParams(p, 'goal'))
        setDescription(stringFromParams(p, 'description'))
        setProjectType(stringFromParams(p, 'projectType'))
        setOutputDir(outputDirFromParams(p))
        setLoading(false)
      })
      .catch((e: Error) => {
        if (!cancelled) {
          setErr(e.message)
          setLoading(false)
        }
      })
    return () => {
      cancelled = true
    }
  }, [id])

  async function onSubmit(e: FormEvent) {
    e.preventDefault()
    if (!id) return
    setErr(null)
    const n = name.trim()
    const desc = description.trim()
    if (!n) {
      setErr('请填写任务名称')
      return
    }
    if (!desc) {
      setErr('请填写详细需求 description')
      return
    }
    setBusy(true)
    try {
      const params: Record<string, unknown> = {
        description: desc,
        goal: goal.trim() || n,
      }
      const pt = projectType.trim()
      if (pt) {
        params.projectType = pt
      }
      const od = outputDir.trim()
      if (od) {
        params.outputDir = od
      }
      await apiPatch<TaskDetailResponse>(`/task/${id}`, {
        name: n,
        parameters: params,
      })
      navigate(`/task/${id}`, { replace: true })
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  if (!id) {
    return <p>无效任务 ID</p>
  }
  if (loading) {
    return <p>加载中…</p>
  }
  if (err) {
    return <p className="error">加载失败：{err}</p>
  }
  if (metaErr) {
    return (
      <div className="panel">
        <p className="error">{metaErr}</p>
        <Link to={`/task/${id}`}>返回详情</Link>
      </div>
    )
  }

  return (
    <div>
      <nav className="breadcrumb">
        <Link to="/">← 任务列表</Link>
        <span className="muted"> · </span>
        <Link to={`/task/${id}`}>任务详情</Link>
      </nav>

      <div className="panel">
        <h2>编辑任务草稿</h2>
        <p className="muted">
          仅 <code>CREATED</code> 主任务可改名称、goal、description、projectType 与 outputDir；保存后写入
          parameters。
        </p>

        <form className="new-task-form" onSubmit={(e) => void onSubmit(e)}>
          {err ? <p className="error">{err}</p> : null}

          <label className="form-field">
            <span>任务名称</span>
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              required
              disabled={busy}
              autoComplete="off"
            />
          </label>

          <label className="form-field">
            <span>目标 goal（可选，默认与名称相同）</span>
            <input
              type="text"
              value={goal}
              onChange={(e) => setGoal(e.target.value)}
              disabled={busy}
              autoComplete="off"
            />
          </label>

          <label className="form-field">
            <span>详细需求 description（必填）</span>
            <textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              rows={5}
              required
              disabled={busy}
              autoComplete="off"
            />
          </label>

          <label className="form-field">
            <span>项目类型 projectType（可选）</span>
            <input
              type="text"
              value={projectType}
              onChange={(e) => setProjectType(e.target.value)}
              placeholder="web-frontend"
              disabled={busy}
              autoComplete="off"
            />
          </label>

          <label className="form-field">
            <span>输出目录 outputDir（可选）</span>
            <input
              type="text"
              value={outputDir}
              onChange={(e) => setOutputDir(e.target.value)}
              placeholder="apps/frontend/src"
              disabled={busy}
              autoComplete="off"
            />
          </label>

          <div className="btn-row">
            <button type="submit" className="btn btn-primary" disabled={busy}>
              {busy ? '保存中…' : '保存并返回详情'}
            </button>
            <Link to={`/task/${id}`}>取消</Link>
          </div>
        </form>
      </div>
    </div>
  )
}
