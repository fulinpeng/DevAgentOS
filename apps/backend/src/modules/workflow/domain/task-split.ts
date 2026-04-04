/**
 * 纯领域逻辑：无 Nest / Prisma / Redis。
 */

export type WorkflowSplitInput = {
  name: string;
  parameters?: Record<string, unknown>;
};

export type SubTaskSpec = {
  name: string;
  role: string;
  order: number;
  parameters: Record<string, unknown>;
};

const FRONTEND_ROLE = 'frontend';

function isNonEmptyStringArray(value: unknown): value is string[] {
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    value.every((item) => typeof item === 'string')
  );
}

/**
 * parameters.features 存在且为非空 string[] 时，每个 feature 生成一条子任务。
 * 子任务 name: "build {feature}"，role: frontend。
 */
export function splitTask(task: WorkflowSplitInput): SubTaskSpec[] {
  const features = task.parameters?.features;
  if (!isNonEmptyStringArray(features)) {
    return [];
  }
  return features.map((feature, index) => ({
    name: `build ${feature}`,
    role: FRONTEND_ROLE,
    order: index,
    parameters: { feature, parentName: task.name },
  }));
}
