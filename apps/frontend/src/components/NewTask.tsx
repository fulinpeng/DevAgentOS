import type { FormEvent } from 'react'
import { useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { apiPost } from '../api/client'
import type { CreateTaskResponse } from '../types/task'

export function NewTask() {
  const navigate = useNavigate()
  const [name, setName] = useState('')
  const [goal, setGoal] = useState('')
  const [description, setDescription] = useState('')
  const [projectType, setProjectType] = useState('')
  const [projectRoot, setProjectRoot] = useState('')
  const [err, setErr] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  async function onSubmit(e: FormEvent) {
    e.preventDefault()
    setErr(null)
    const n = name.trim()
    const desc = description.trim()
    if (!n) {
      setErr('请填写任务名称')
      return
    }
    if (!desc) {
      setErr('请填写详细需求（生成计划时由 LLM 按自然语言拆解）')
      return
    }
    setBusy(true)
    try {
      const params: Record<string, unknown> = {
        description: desc,
      }
      const g = goal.trim()
      if (g) {
        params.goal = g
      } else {
        params.goal = n
      }
      const pt = projectType.trim()
      if (pt) {
        params.projectType = pt
      }
      const pr = projectRoot.trim()
      if (pr) {
        params.projectRoot = pr
      }
      const res = await apiPost<CreateTaskResponse>('/task/create', {
        name: n,
        parameters: params,
      })
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
          仅创建需求（CREATED）。在详情页点击「生成计划」时，后端会用 LLM 生成结构化 Workflow（需配置
          DASHSCOPE_API_KEY）。请用自然语言写清需求，无需再填逗号分隔的 features。
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
            <span>目标 goal（可选，默认与名称相同）</span>
            <input
              type="text"
              value={goal}
              onChange={(e) => setGoal(e.target.value)}
              placeholder="例如：交付可登录的后台与仪表盘"
              disabled={busy}
              autoComplete="off"
            />
          </label>

          <label className="form-field">
            <span>详细需求 description（必填）</span>
            <textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="用自然语言写清功能、技术栈、目录约定等，供 LLM 生成执行计划。"
              rows={5}
              required
              disabled={busy}
              autoComplete="off"
            />
          </label>

          <label className="form-field">
            <span>项目类型 projectType（可选，如 web-frontend）</span>
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
            <span>项目根 projectRoot（可选，相对仓库根或本机绝对路径）</span>
            <input
              type="text"
              value={projectRoot}
              onChange={(e) => setProjectRoot(e.target.value)}
              placeholder="sandbox/my-app 或 C:\\Users\\you\\project"
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
