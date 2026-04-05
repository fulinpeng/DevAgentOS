import { MAX_LLM_SUBTASKS } from './task-split.constants';
import { aiSplitTask, splitTask, splitTaskRuleBased } from './task-split';

describe('splitTaskRuleBased', () => {
  it('按 features 拆分为子任务', () => {
    expect(
      splitTaskRuleBased({
        name: 'build web',
        parameters: { features: ['login'] },
      }),
    ).toEqual([
      {
        name: 'build login',
        role: 'frontend',
        order: 0,
        parameters: { feature: 'login', parentName: 'build web', source: 'rule' },
      },
    ]);
  });

  it('多个 feature 保持 order', () => {
    const r = splitTaskRuleBased({
      name: 'build a web page',
      parameters: { features: ['login', 'dashboard'] },
    });
    expect(r).toHaveLength(2);
    expect(r[0].order).toBe(0);
    expect(r[1].order).toBe(1);
  });

  it('无 features 返回空', () => {
    expect(splitTaskRuleBased({ name: 'x' })).toEqual([]);
  });
});

describe('splitTask（LLM + fallback）', () => {
  it('无 LLM 时走规则', () => {
    expect(
      splitTask(
        { name: 'build web', parameters: { features: ['login'] } },
        null,
      ),
    ).toEqual(
      splitTaskRuleBased({
        name: 'build web',
        parameters: { features: ['login'] },
      }),
    );
  });

  it('合法 LLM JSON 优先，并写入 model / promptVersion', () => {
    const llm = JSON.stringify([
      { name: 'build login page', role: 'frontend' },
      { name: 'build dashboard page', role: 'frontend' },
    ]);
    const r = splitTask(
      {
        name: 'build a web page',
        parameters: { features: ['login', 'dashboard'] },
      },
      llm,
      { llmModel: 'qwen-turbo', promptVersion: 'v1' },
    );
    expect(r).toHaveLength(2);
    expect(r[0].parameters.source).toBe('llm');
    expect(r[0].parameters.model).toBe('qwen-turbo');
    expect(r[0].parameters.promptVersion).toBe('v1');
  });

  it('非法 LLM 输出触发 fallback', () => {
    const r = splitTask(
      { name: 'x', parameters: { features: ['a'] } },
      'not json',
    );
    expect(r).toEqual(
      splitTaskRuleBased({ name: 'x', parameters: { features: ['a'] } }),
    );
  });

  it(`超过 ${MAX_LLM_SUBTASKS} 条子任务 → fallback`, () => {
    const arr = Array.from({ length: MAX_LLM_SUBTASKS + 1 }, () => ({
      name: 'build f0 page',
      role: 'frontend' as const,
    }));
    const r = splitTask(
      { name: 'p', parameters: { features: ['f0'] } },
      JSON.stringify(arr),
      { llmModel: 'x' },
    );
    expect(r).toEqual(
      splitTaskRuleBased({ name: 'p', parameters: { features: ['f0'] } }),
    );
  });

  it('子任务 name 超长 → fallback', () => {
    const long = 'a'.repeat(101);
    const r = splitTask(
      { name: 'p', parameters: { features: ['x'] } },
      JSON.stringify([{ name: long, role: 'frontend' }]),
    );
    expect(r[0].name).toBe('build x');
  });

  it('子任务 name 未锚定任一 feature → fallback', () => {
    const r = splitTask(
      { name: 'p', parameters: { features: ['login'] } },
      JSON.stringify([{ name: 'do something else', role: 'frontend' }]),
    );
    expect(r[0].name).toBe('build login');
  });
});

describe('aiSplitTask', () => {
  it('解析 markdown 代码块内的 JSON', () => {
    const raw = '```json\n[{"name":"x page","role":"frontend"}]\n```';
    expect(
      aiSplitTask(raw, 'p', { featureTokens: ['x'], promptVersion: 'v1' }),
    ).toEqual([
      {
        name: 'x page',
        role: 'frontend',
        order: 0,
        parameters: {
          source: 'llm',
          parentName: 'p',
          llmIndex: 0,
          promptVersion: 'v1',
        },
      },
    ]);
  });

  it('role 仅允许 frontend/backend/data', () => {
    expect(
      aiSplitTask(
        JSON.stringify([{ name: 'a', role: 'admin' }]),
        'p',
        { featureTokens: ['a'] },
      ),
    ).toBeNull();
  });

  it('缺字段或非数组返回 null', () => {
    expect(aiSplitTask('[]', 'p', { featureTokens: [] })).toBeNull();
    expect(
      aiSplitTask(JSON.stringify([{ name: 'a' }]), 'p', {
        featureTokens: ['a'],
      }),
    ).toBeNull();
  });
});
