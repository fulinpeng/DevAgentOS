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
});
