export type RootTaskRow = {
  id: string
  name: string
  status: string
  childCount: number
  createdAt: string
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
