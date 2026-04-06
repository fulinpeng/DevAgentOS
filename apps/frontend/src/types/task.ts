export type RootTaskRow = {
  id: string
  name: string
  status: string
  childCount: number
  createdAt: string
  /** low | medium | high */
  riskLevel: string
}

export type TaskNode = {
  id: string
  name: string
  status: string
  role: string | null
  parentId: string | null
  sortOrder: number
  parameters: unknown
  result: unknown
  createdAt: string
  updatedAt: string
  /** 后端详情/待审批列表附带 */
  parameterSourceLabel?: string
  approvalReason?: string | null
  /** low | medium | high */
  riskLevel?: string
}

export type TaskDetailResponse = {
  task: TaskNode
  children: TaskNode[]
}

export type LogEntry = {
  step: string
  time: string
  meta?: Record<string, unknown>
}

/** POST /task/create 响应（两阶段流程下 subTasks 通常为空，子任务在「生成计划」后才有） */
export type CreateTaskResponse = {
  parentTask: { id: string; name: string; status: string }
  subTasks: Array<{ id: string; name: string; status: string }>
}
