import { useEffect, useState } from 'react'
import { apiGet } from '../api/client'
import type { LogEntry } from '../types/task'

type Props = {
  taskId: string
  /** 说明当前页是主任务还是子任务，避免误以为日志含全部子任务 */
  scopeHint?: string
}

/**
 * 递归处理日志 meta：保留 JSON 结构，仅隐藏名为 `content` 的字段正文（多为 writeFile 整文件）。
 */
function redactContentFields(value: unknown): unknown {
  if (value === null || value === undefined) {
    return value
  }
  if (Array.isArray(value)) {
    return value.map((item) => redactContentFields(item))
  }
  if (typeof value === 'object') {
    const o = value as Record<string, unknown>
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(o)) {
      if (k === 'content') {
        if (typeof v === 'string') {
          const n = v.length
          out[k] = n === 0 ? '' : `[已省略 content，共 ${n} 字符]`
        } else if (v !== null && typeof v === 'object') {
          out[k] = '[已省略 content（对象/数组）]'
        } else {
          out[k] = v
        }
      } else {
        out[k] = redactContentFields(v)
      }
    }
    return out
  }
  return value
}

function formatLogMeta(meta: Record<string, unknown>): string {
  return JSON.stringify(redactContentFields(meta), null, 2)
}

export function TaskLogs({ taskId, scopeHint }: Props) {
  const [logs, setLogs] = useState<LogEntry[] | null>(null)
  const [err, setErr] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    apiGet<LogEntry[]>(`/task/${taskId}/logs`)
      .then((data) => {
        if (!cancelled) setLogs(data)
      })
      .catch((e: Error) => {
        if (!cancelled) setErr(e.message)
      })
    return () => {
      cancelled = true
    }
  }, [taskId])

  if (err) {
    return <p className="error">日志加载失败：{err}</p>
  }
  if (!logs) {
    return <p>日志加载中…</p>
  }

  return (
    <div className="panel logs-panel">
      <h3>执行日志（Redis）</h3>
      {scopeHint ? (
        <p className="muted" style={{ marginTop: 0, maxWidth: 640 }}>
          {scopeHint}
        </p>
      ) : null}
      {logs.length === 0 ? (
        <p className="muted">暂无日志</p>
      ) : (
        <ul className="log-list">
          {logs.map((entry, i) => (
            <li key={`${entry.time}-${i}`} className="log-line">
              <span className="log-time">
                [{new Date(entry.time).toLocaleString()}]
              </span>{' '}
              <code>{entry.step}</code>
              {entry.meta ? (
                <pre className="log-meta">{formatLogMeta(entry.meta)}</pre>
              ) : null}
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
