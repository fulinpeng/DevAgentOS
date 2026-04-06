/** 与 API / DB JSON `parameters.riskLevel` 一致（小写） */
export const RiskLevel = {
  LOW: 'low',
  MEDIUM: 'medium',
  HIGH: 'high',
} as const;

export type RiskLevel = (typeof RiskLevel)[keyof typeof RiskLevel];
