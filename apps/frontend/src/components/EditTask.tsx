import type { FormEvent } from 'react'
import { useEffect, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { apiGet, apiPatch } from '../api/client'
import type { TaskDetailResponse } from '../types/task'

function parseFeatures(raw: string): string[] | undefined {
  const s = raw.trim()
  if (!s) return undefined
  return s
    .split(/[,，]/)
    .map((x) => x.trim())
    .filter(Boolean)
}

function featuresToInput(params: unknown): string {
  if (params && typeof params === 'object' && 'features' in params) {
    const f = (params as { features?: unknown }).features
    if (Array.isArray(f) && f.every((x) => typeof x === 'string')) {
      return (f as string[]).join(', ')
    }
  }
  return ''
}

function outputDirFromParams(params: unknown): string {
  if (params && typeof params === 'object' && 'outputDir' in params) {
    const v = (params as { outputDir?: unknown }).outputDir
    if (typeof v === 'string') return v
  }
  return ''
}

export function EditTask() {
  const { id } = useParams<{ id: string }>()
  const navigate = useNavigate()
  const [loading, setLoading] = useState(true)
  const [name, setName] = useState('')
  const [features, setFeatures] = useState('')
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
        setFeatures(featuresToInput(task.parameters))
        setOutputDir(outputDirFromParams(task.parameters))
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
    if (!n) {
      setErr('请填写任务名称')
      return
    }
    const featureList = parseFeatures(features) ?? []
    setBusy(true)
    try {
      const params: Record<string, unknown> = { features: featureList }
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
          仅 <code>CREATED</code> 主任务可改名称、features 与 outputDir；保存后合并写入
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
            <span>Features（生成计划时必填，逗号分隔）</span>
            <input
              type="text"
              value={features}
              onChange={(e) => setFeatures(e.target.value)}
              placeholder="login, dashboard"
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
