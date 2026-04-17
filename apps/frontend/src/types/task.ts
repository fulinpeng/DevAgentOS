export type RootTaskRow = {
  id: string
  name: string
  status: string
  childCount: number
  createdAt: string
  /** low | medium | high */
  riskLevel: string
  hasChildren?: boolean
  isCoordinatorNode?: boolean
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
  hasChildren?: boolean
  isCoordinatorNode?: boolean
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

/** POST /workflow/generate/:id */
export type GeneratePlanResponse = {
  parentTask: { id: string; name: string; status: string }
  subTasks: Array<{ id: string; name: string; status: string }>
  splitHint?: string
}

/** GET /task/pending-plan-approval（主任务 WAITING_PLAN_APPROVAL + children） */
export type PendingPlanApprovalRow = {
  id: string
  name: string
  status: string
  children: TaskNode[]
}

/** GET /task/:taskId/versions — 任务微调草稿 */
export type TaskVersionRow = {
  id: string
  taskId: string
  version: number
  data: unknown
  isActive: boolean
  createdAt: string
}

/** POST /task/:id/rerun — FAILED 重置并重新执行 */
export type TaskRerunResponse = {
  task: { id: string; name: string; status: string }
  workerResult: { success: boolean; result: Record<string, unknown> }
  idempotent?: boolean
  pausedForApproval?: boolean
  workerPaused?: boolean
}

/** POST /task/refine/:taskId/execute — 同任务重跑（先置 PENDING 再 Role） */
export type ExecuteRefinementResponse = {
  task: { id: string; name: string; status: string }
  workerResult: { success: boolean; result: Record<string, unknown> }
  idempotent?: boolean
  pausedForApproval?: boolean
  workerPaused?: boolean
}

/** POST /task/:id/append — 新建子任务并执行 */
export type AppendTaskResponse = {
  newTask: { id: string; name: string; status: string }
  coordinator?: {
    parent: { id: string; status: string }
    executedTaskIds: string[]
  }
}
