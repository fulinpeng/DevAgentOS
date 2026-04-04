export type TaskStatus = 'pending' | 'running' | 'completed';

export interface Task {
  id: string;
  name: string;
  status: TaskStatus;
}
