import { splitTask } from './task-split';

describe('splitTask', () => {
  it('按 features 拆分为子任务，name 为 build {feature}，role 为 frontend', () => {
    expect(
      splitTask({
        name: 'build web',
        parameters: { features: ['login'] },
      }),
    ).toEqual([
      {
        name: 'build login',
        role: 'frontend',
        order: 0,
        parameters: { feature: 'login', parentName: 'build web' },
      },
    ]);
  });

  it('多个 feature 保持顺序 order', () => {
    const r = splitTask({
      name: 'build a web page',
      parameters: { features: ['login', 'dashboard'] },
    });
    expect(r).toHaveLength(2);
    expect(r[0].order).toBe(0);
    expect(r[1].order).toBe(1);
    expect(r[0].name).toBe('build login');
    expect(r[1].name).toBe('build dashboard');
  });

  it('无 features 或空数组返回空', () => {
    expect(splitTask({ name: 'x' })).toEqual([]);
    expect(splitTask({ name: 'x', parameters: {} })).toEqual([]);
    expect(splitTask({ name: 'x', parameters: { features: [] } })).toEqual([]);
  });
});
