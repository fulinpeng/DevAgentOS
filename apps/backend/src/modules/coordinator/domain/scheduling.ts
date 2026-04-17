/**
 * 纯领域：树形任务调度（无框架依赖）。
 */

/** 与 Prisma `TaskStatus` 对齐（任务状态快照） */
export type TaskStatusSnapshot =
  | 'CREATED'
  | 'PLAN_GENERATED'
  | 'WAITING_PLAN_APPROVAL'
  | 'PLAN_APPROVED'
  | 'PENDING'
  | 'WAITING_APPROVAL'
  | 'RUNNING'
  | 'WORKER_PAUSED'
  | 'COMPLETED'
  | 'FAILED';

export type TaskTreeNodeSnapshot = {
  id: string;
  parentId: string | null;
  status: TaskStatusSnapshot;
  sortOrder: number;
};

/**
 * 树形调度：返回「下一条可执行任务」。
 *
 * 规则：
 * - 同父节点按 sortOrder；
 * - 兄弟队列中，若遇到 FAILED，后续兄弟不再继续（返回 null）；
 * - 非根节点：若自身未 COMPLETED，则优先执行自身；
 * - 根节点：若存在子任务，视作协调节点，不直接执行自身；无子任务时可执行自身。
 */
export function getNextTaskInTree(
  rootTaskId: string,
  nodes: TaskTreeNodeSnapshot[],
): TaskTreeNodeSnapshot | null {
  const byId = new Map(nodes.map((n) => [n.id, n] as const));
  const root = byId.get(rootTaskId);
  if (!root) {
    return null;
  }
  const childrenByParent = new Map<string, TaskTreeNodeSnapshot[]>();
  for (const n of nodes) {
    if (!n.parentId) {
      continue;
    }
    const arr = childrenByParent.get(n.parentId) ?? [];
    arr.push(n);
    childrenByParent.set(n.parentId, arr);
  }
  for (const arr of childrenByParent.values()) {
    arr.sort((a, b) => a.sortOrder - b.sortOrder);
  }

  const BLOCKED = '__BLOCKED__';
  const walk = (node: TaskTreeNodeSnapshot): TaskTreeNodeSnapshot | typeof BLOCKED | null => {
    if (node.status === 'FAILED') {
      return BLOCKED;
    }
    const children = childrenByParent.get(node.id) ?? [];
    if (children.length === 0) {
      if (node.status !== 'COMPLETED') {
        return node;
      }
      return null;
    }
    for (const child of children) {
      if (child.status === 'FAILED') {
        return BLOCKED;
      }
      const next = walk(child);
      if (next === BLOCKED) {
        return BLOCKED;
      }
      if (next) {
        return next;
      }
    }
    return null;
  };

  const next = walk(root);
  if (next === BLOCKED) {
    return null;
  }
  return next;
}

/**
 * 子树是否全部完成（含根）：
 * - 根节点（parentId=null）允许仅以子树完成判定（兼容“主任务为协调节点”场景）；
 * - 非根节点要求自身与子树都完成。
 */
export function isSubtreeCompleted(
  rootTaskId: string,
  nodes: TaskTreeNodeSnapshot[],
): boolean {
  const byId = new Map(nodes.map((n) => [n.id, n] as const));
  const root = byId.get(rootTaskId);
  if (!root) {
    return false;
  }
  const childrenByParent = new Map<string, TaskTreeNodeSnapshot[]>();
  for (const n of nodes) {
    if (!n.parentId) {
      continue;
    }
    const arr = childrenByParent.get(n.parentId) ?? [];
    arr.push(n);
    childrenByParent.set(n.parentId, arr);
  }
  const allDescCompleted = (id: string): boolean => {
    const children = childrenByParent.get(id) ?? [];
    for (const c of children) {
      if (c.status !== 'COMPLETED') {
        return false;
      }
      if (!allDescCompleted(c.id)) {
        return false;
      }
    }
    return true;
  };
  const rootChildren = childrenByParent.get(rootTaskId) ?? [];
  if (!allDescCompleted(rootTaskId)) {
    return false;
  }
  if (rootChildren.length > 0) {
    return true;
  }
  return root.status === 'COMPLETED';
}
