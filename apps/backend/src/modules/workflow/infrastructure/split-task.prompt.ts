/**
 * LLM 拆分任务：仅输出结构化 JSON，不参与系统决策。
 */

import { WORKFLOW_SPLIT_PROMPT_VERSION } from '../domain/task-split.constants';

export const SPLIT_TASK_SYSTEM_PROMPT = `You are a task decomposition assistant inside an orchestration system.
You MUST respond with ONLY a valid JSON array (no markdown, no code fences, no explanation).
Each element must be an object with exactly two string fields:
- "name": concise subtask title in English
- "role": one of "frontend", "backend", "data" only

Do not include any other keys. Do not control execution or state.`;

export function buildSplitTaskUserPayload(name: string, features: string[]): string {
  return [
    'Decompose the following parent task into subtasks aligned with the given features.',
    `Prompt schema version: ${WORKFLOW_SPLIT_PROMPT_VERSION}`,
    'Input JSON:',
    JSON.stringify({ name, features }, null, 2),
    '',
    'Output JSON array example shape:',
    '[{"name":"build login page","role":"frontend"},{"name":"build dashboard page","role":"frontend"}]',
  ].join('\n');
}
