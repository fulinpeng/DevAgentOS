import type { FormEvent } from 'react'
import { useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { apiPost } from '../api/client'
import type { CreateTaskResponse } from '../types/task'

function parseFeatures(raw: string): string[] | undefined {
  const s = raw.trim()
  if (!s) return undefined
  return s
    .split(/[,，]/)
    .map((x) => x.trim())
    .filter(Boolean)
}

export function NewTask() {
  const navigate = useNavigate()
  const [name, setName] = useState('')
  const [features, setFeatures] = useState('')
  const [outputDir, setOutputDir] = useState('')
  const [err, setErr] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  async function onSubmit(e: FormEvent) {
    e.preventDefault()
    setErr(null)
    const n = name.trim()
    if (!n) {
      setErr('请填写任务名称')
      return
    }
    const featureList = parseFeatures(features)
    setBusy(true)
    try {
      const params: Record<string, unknown> = {}
      if (featureList && featureList.length > 0) {
        params.features = featureList
      }
      const od = outputDir.trim()
      if (od) {
        params.outputDir = od
      }
      const body: { name: string; parameters?: Record<string, unknown> } = {
        name: n,
      }
      if (Object.keys(params).length > 0) {
        body.parameters = params
      }
      const res = await apiPost<CreateTaskResponse>('/task/create', body)
      navigate(`/task/${res.parentTask.id}`, { replace: true })
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div>
      <nav className="breadcrumb">
        <Link to="/">← 任务列表</Link>
      </nav>

      <div className="panel">
        <h2>新建任务</h2>
        <p className="muted">
          仅创建需求（CREATED）。生成子任务请点击详情页「生成计划」；填写 features 后生成时会走
          LLM 拆分（需 DASHSCOPE_API_KEY）。
        </p>

        <form className="new-task-form" onSubmit={(e) => void onSubmit(e)}>
          {err ? <p className="error">{err}</p> : null}

          <label className="form-field">
            <span>任务名称</span>
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="例如：build a web page"
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
              {busy ? '创建中…' : '创建并进入详情'}
            </button>
            <Link to="/">取消</Link>
          </div>
        </form>
      </div>
    </div>
  )
}
