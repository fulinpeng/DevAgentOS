import { useEffect, useState } from 'react'
import { apiGet } from '../api/client'
import type { LogEntry } from '../types/task'

type Props = { taskId: string }

export function TaskLogs({ taskId }: Props) {
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
      {logs.length === 0 ? (
        <p className="muted">暂无日志</p>
      ) : (
        <ul className="log-list">
          {logs.map((entry, i) => (
            <li key={`${entry.time}-${i}`}>
              <span className="log-time">
                [{new Date(entry.time).toLocaleString()}]
              </span>{' '}
              <code>{entry.step}</code>
              {entry.meta && (
                <pre className="log-meta">{JSON.stringify(entry.meta, null, 2)}</pre>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
