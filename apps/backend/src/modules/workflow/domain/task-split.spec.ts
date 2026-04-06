import { MAX_LLM_SUBTASKS } from './task-split.constants';
import {
  aiSplitTask,
  parseWorkflow,
  splitTask,
  splitTaskRuleBased,
} from './task-split';

describe('splitTaskRuleBased', () => {
  it('按 features 拆分为子任务（仅测试保留，生成计划已不再使用）', () => {
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

describe('splitTask（仅 LLM，无规则回退）', () => {
  it('无 LLM 文本时返回空', () => {
    expect(
      splitTask({ name: 'build web', parameters: { features: ['login'] } }, null),
    ).toEqual([]);
    expect(
      splitTask(
        { name: 'build web', parameters: { features: ['login'] } },
        '',
      ),
    ).toEqual([]);
  });

  it('合法 LLM JSON 解析成功，并写入 model / promptVersion', () => {
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

  it('非法 LLM 输出返回空', () => {
    const r = splitTask(
      { name: 'x', parameters: { features: ['a'] } },
      'not json',
    );
    expect(r).toEqual([]);
  });

  it(`超过 ${MAX_LLM_SUBTASKS} 条子任务 → 空`, () => {
    const arr = Array.from({ length: MAX_LLM_SUBTASKS + 1 }, () => ({
      name: 'build f0 page',
      role: 'frontend' as const,
    }));
    const r = splitTask(
      { name: 'p', parameters: { features: ['f0'] } },
      JSON.stringify(arr),
      { llmModel: 'x' },
    );
    expect(r).toEqual([]);
  });

  it('子任务 name 超长 → 空', () => {
    const long = 'a'.repeat(101);
    const r = splitTask(
      { name: 'p', parameters: { features: ['x'] } },
      JSON.stringify([{ name: long, role: 'frontend' }]),
    );
    expect(r).toEqual([]);
  });

  it('子任务 name 未锚定任一 feature → 空', () => {
    const r = splitTask(
      { name: 'p', parameters: { features: ['login'] } },
      JSON.stringify([{ name: 'do something else', role: 'frontend' }]),
    );
    expect(r).toEqual([]);
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

describe('parseWorkflow', () => {
  const valid = {
    goal: 'g',
    description: 'd',
    projectType: 'web-frontend',
    tasks: [
      {
        id: 'a',
        name: 'n1',
        description: 'long desc one',
        type: 'setup',
        dependsOn: [],
      },
      {
        id: 'b',
        name: 'n2',
        description: 'long desc two',
        type: 'feature',
        dependsOn: ['a'],
      },
    ],
  };

  it('合法 JSON 解析成功', () => {
    const w = parseWorkflow(JSON.stringify(valid));
    expect(w).not.toBeNull();
    expect(w!.tasks).toHaveLength(2);
    expect(w!.tasks[0].id).toBe('a');
    expect(w!.tasks[1].dependsOn).toEqual(['a']);
  });

  it('markdown 代码块可剥离', () => {
    const w = parseWorkflow(
      '```json\n' + JSON.stringify(valid) + '\n```',
    );
    expect(w).not.toBeNull();
  });

  it('tasks 少于 2 → null', () => {
    expect(
      parseWorkflow(
        JSON.stringify({
          ...valid,
          tasks: [valid.tasks[0]],
        }),
      ),
    ).toBeNull();
  });

  it('无依赖边（全空 dependsOn）→ null', () => {
    expect(
      parseWorkflow(
        JSON.stringify({
          ...valid,
          tasks: [
            { ...valid.tasks[0], dependsOn: [] },
            { ...valid.tasks[1], dependsOn: [], id: 'b2' },
          ],
        }),
      ),
    ).toBeNull();
  });

  it('非法 type → null', () => {
    expect(
      parseWorkflow(
        JSON.stringify({
          ...valid,
          tasks: [
            valid.tasks[0],
            { ...valid.tasks[1], type: 'invalid' },
          ],
        }),
      ),
    ).toBeNull();
  });

  it('循环依赖 → null', () => {
    expect(
      parseWorkflow(
        JSON.stringify({
          ...valid,
          tasks: [
            {
              id: 'x',
              name: 'a',
              description: 'd',
              type: 'setup',
              dependsOn: ['y'],
            },
            {
              id: 'y',
              name: 'b',
              description: 'd',
              type: 'feature',
              dependsOn: ['x'],
            },
          ],
        }),
      ),
    ).toBeNull();
  });
});
