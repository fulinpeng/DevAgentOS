import { buildWorkerUserContent, projectRootLeafName } from './worker-llm.prompt';

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
});
