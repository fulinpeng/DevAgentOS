import { Link, Navigate, Route, Routes } from 'react-router-dom'
import { EditTask } from './components/EditTask'
import { NewTask } from './components/NewTask'
import { PendingApproval } from './components/PendingApproval'
import { PendingPlanApproval } from './components/PendingPlanApproval'
import { TaskDetail } from './components/TaskDetail'
import { TaskList } from './components/TaskList'
import './App.css'

export default function App() {
  return (
    <div className="console-app">
      <header className="console-header">
        <h1>DevAgentOS 控制台</h1>
        <p className="muted">
          任务列表 · 待审计划 · 待审批执行 · 任务树 · Redis 日志
        </p>
        <nav className="header-nav">
          <Link to="/">任务列表</Link>
          <Link to="/new-task">新建任务</Link>
          <Link to="/pending-plan-approval">待审计划</Link>
          <Link to="/pending-approval">待审批执行</Link>
        </nav>
      </header>
      <main className="console-main">
        <Routes>
          <Route path="/" element={<TaskList />} />
          <Route path="/new-task" element={<NewTask />} />
          <Route
            path="/pending-plan-approval"
            element={<PendingPlanApproval />}
          />
          <Route path="/pending-approval" element={<PendingApproval />} />
          <Route path="/task/:id/edit" element={<EditTask />} />
          <Route path="/task/:id" element={<TaskDetail />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </main>
    </div>
  )
}
