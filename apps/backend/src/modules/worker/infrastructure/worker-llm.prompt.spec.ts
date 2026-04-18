import {
  buildWorkerUserContent,
  projectRootLeafName,
  shouldInjectMinimalWorkerScope,
} from './worker-llm.prompt';

describe('projectRootLeafName', () => {
  it('returns last segment for Windows absolute paths', () => {
    expect(projectRootLeafName('C:\\Users\\flp\\Desktop\\aaa\\imgShow')).toBe(
      'imgShow',
    );
  });

  it('returns last segment for POSIX paths', () => {
    expect(projectRootLeafName('/home/u/proj')).toBe('proj');
  });
});

describe('shouldInjectMinimalWorkerScope', () => {
  it('is true when last log is task_prepare_rerun refine_execute_prepare', () => {
    expect(
      shouldInjectMinimalWorkerScope({
        taskDescription: '任意',
        goal: 'g',
        lastExecutionLog: {
          step: 'task_prepare_rerun',
          meta: { source: 'refine_execute_prepare' },
        },
      }),
    ).toBe(true);
  });

  it('is true when taskDescription matches fix test wording', () => {
    expect(
      shouldInjectMinimalWorkerScope({
        taskDescription: '修复 pnpm run test 报错',
        goal: 'g',
      }),
    ).toBe(true);
  });

  it('is true when parameters.workerMinimalScope is true', () => {
    expect(
      shouldInjectMinimalWorkerScope({
        taskDescription: 'x',
        goal: 'g',
        parametersWorkerMinimalScope: true,
      }),
    ).toBe(true);
  });

  it('is false for generic wording', () => {
    expect(
      shouldInjectMinimalWorkerScope({
        taskDescription: '实现用户登录',
        goal: '完成项目',
      }),
    ).toBe(false);
  });
});

describe('buildWorkerUserContent parent context block', () => {
  it('includes parent task info when parentTaskContext provided', () => {
    const text = buildWorkerUserContent({
      taskId: 'child-1',
      taskName: '实现子任务',
      taskDescription: '请获取父级任务描述后继续',
      goal: '完成端到端流程',
      role: 'developer',
      projectRoot: 'C:\\Users\\flp\\Desktop\\aaa\\todoList',
      fileTreeDeep: ['src/App.tsx'],
      importantFiles: { 'src/App.tsx': 'export default function App() {}' },
      parentTaskContext: {
        parentTaskId: 'parent-1',
        parentTaskName: '父任务',
        parentTaskRole: 'architect',
        parentTaskDescription: '定义整体页面交互与数据持久化方案',
      },
    });
    expect(text).toContain('# 父级任务上下文（按当前子任务要求注入）');
    expect(text).toContain('parentTaskId: parent-1');
    expect(text).toContain('定义整体页面交互与数据持久化方案');
  });

  it('includes minimal scope block when minimalScopeHint is true', () => {
    const text = buildWorkerUserContent({
      taskId: 't1',
      taskName: '修测试',
      taskDescription: '修复测试',
      goal: 'g',
      role: null,
      projectRoot: 'C:\\p',
      fileTreeDeep: [],
      importantFiles: {},
      minimalScopeHint: true,
    });
    expect(text).toContain('最小改动模式');
    expect(text).toContain('不要当成从零重做');
  });
});
