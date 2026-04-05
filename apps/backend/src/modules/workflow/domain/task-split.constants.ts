/** Prompt / 防护版本，便于审计与 A/B */
export const WORKFLOW_SPLIT_PROMPT_VERSION = 'v1';

/** LLM 子任务条数上限，防止打爆 DB/调度 */
export const MAX_LLM_SUBTASKS = 10;

/** 单条子任务标题长度上限 */
export const MAX_LLM_SUBTASK_NAME_LENGTH = 100;
