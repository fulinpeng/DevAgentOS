import { getNextTask } from './scheduling';

describe('getNextTask', () => {
  it('按 sortOrder 取第一个未完成的子任务', () => {
    const next = getNextTask([
      { id: '2', status: 'COMPLETED', sortOrder: 1 },
      { id: '1', status: 'PENDING', sortOrder: 0 },
    ]);
    expect(next?.id).toBe('1');
  });

  it('全部完成返回 null', () => {
    expect(
      getNextTask([
        { id: '1', status: 'COMPLETED', sortOrder: 0 },
        { id: '2', status: 'COMPLETED', sortOrder: 1 },
      ]),
    ).toBeNull();
  });

  it('队首 FAILED 时返回 null（中止后续）', () => {
    expect(
      getNextTask([
        { id: '1', status: 'FAILED', sortOrder: 0 },
        { id: '2', status: 'PENDING', sortOrder: 1 },
      ]),
    ).toBeNull();
  });

  it('WAITING_APPROVAL 仍作为下一个节点返回（由 Role 侧幂等挡执行）', () => {
    const next = getNextTask([
      { id: '1', status: 'COMPLETED', sortOrder: 0 },
      { id: '2', status: 'WAITING_APPROVAL', sortOrder: 1 },
    ]);
    expect(next?.id).toBe('2');
  });
});
