import { getNextTaskInTree, isSubtreeCompleted } from './scheduling';

describe('getNextTaskInTree', () => {
  it('根节点有子任务时按 sortOrder 找到第一个未完成叶子', () => {
    const next = getNextTaskInTree('root', [
      { id: 'root', parentId: null, status: 'PLAN_APPROVED', sortOrder: 0 },
      { id: 'a', parentId: 'root', status: 'COMPLETED', sortOrder: 0 },
      { id: 'b', parentId: 'root', status: 'PENDING', sortOrder: 1 },
    ]);
    expect(next?.id).toBe('b');
  });

  it('非根节点有子任务时，优先执行其未完成叶子', () => {
    const next = getNextTaskInTree('a', [
      { id: 'root', parentId: null, status: 'PLAN_APPROVED', sortOrder: 0 },
      { id: 'a', parentId: 'root', status: 'PENDING', sortOrder: 0 },
      { id: 'a-1', parentId: 'a', status: 'PENDING', sortOrder: 0 },
    ]);
    expect(next?.id).toBe('a-1');
  });

  it('队首 FAILED 时阻断后续兄弟（返回 null）', () => {
    const next = getNextTaskInTree('root', [
      { id: 'root', parentId: null, status: 'PLAN_APPROVED', sortOrder: 0 },
      { id: 'a', parentId: 'root', status: 'FAILED', sortOrder: 0 },
      { id: 'b', parentId: 'root', status: 'PENDING', sortOrder: 1 },
    ]);
    expect(next).toBeNull();
  });
});

describe('isSubtreeCompleted', () => {
  it('根节点：子树全完成即返回 true', () => {
    expect(
      isSubtreeCompleted('root', [
        { id: 'root', parentId: null, status: 'PLAN_APPROVED', sortOrder: 0 },
        { id: 'a', parentId: 'root', status: 'COMPLETED', sortOrder: 0 },
        { id: 'b', parentId: 'root', status: 'COMPLETED', sortOrder: 1 },
      ]),
    ).toBe(true);
  });

  it('非根节点：若有子任务则以子树完成判定', () => {
    expect(
      isSubtreeCompleted('a', [
        { id: 'root', parentId: null, status: 'PLAN_APPROVED', sortOrder: 0 },
        { id: 'a', parentId: 'root', status: 'COMPLETED', sortOrder: 0 },
        { id: 'a-1', parentId: 'a', status: 'COMPLETED', sortOrder: 0 },
      ]),
    ).toBe(true);
    expect(
      isSubtreeCompleted('a', [
        { id: 'root', parentId: null, status: 'PLAN_APPROVED', sortOrder: 0 },
        { id: 'a', parentId: 'root', status: 'PLAN_APPROVED', sortOrder: 0 },
        { id: 'a-1', parentId: 'a', status: 'COMPLETED', sortOrder: 0 },
      ]),
    ).toBe(true);
  });
});
