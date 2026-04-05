import { Navigate, Route, Routes } from 'react-router-dom'
import { TaskDetail } from './components/TaskDetail'
import { TaskList } from './components/TaskList'
import './App.css'

export default function App() {
  return (
    <div className="console-app">
      <header className="console-header">
        <h1>DevAgentOS 控制台</h1>
        <p className="muted">任务列表 · 任务树 · Redis 执行日志</p>
      </header>
      <main className="console-main">
        <Routes>
          <Route path="/" element={<TaskList />} />
          <Route path="/task/:id" element={<TaskDetail />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </main>
    </div>
  )
}
