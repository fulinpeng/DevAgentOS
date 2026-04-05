import { RiskLevel } from '@ai-orchestrator/shared';
import { evaluateRisk, resolveRiskLevelForDisplay } from './risk-policy';

describe('evaluateRisk', () => {
  it('名称含 delete → HIGH（优先于 llm）', () => {
    expect(
      evaluateRisk({
        name: 'delete account',
        parameters: { source: 'llm' },
      }),
    ).toBe(RiskLevel.HIGH);
  });

  it('source === llm → MEDIUM', () => {
    expect(
      evaluateRisk({
        name: 'build login',
        parameters: { source: 'llm' },
      }),
    ).toBe(RiskLevel.MEDIUM);
  });

  it('source === rule → LOW', () => {
    expect(
      evaluateRisk({
        name: 'build login',
        parameters: { source: 'rule', feature: 'x' },
      }),
    ).toBe(RiskLevel.LOW);
  });

  it('无 source → LOW', () => {
    expect(evaluateRisk({ name: 'x', parameters: {} })).toBe(RiskLevel.LOW);
  });
});

describe('resolveRiskLevelForDisplay', () => {
  it('优先使用已写入的 riskLevel', () => {
    expect(
      resolveRiskLevelForDisplay({
        name: 'delete x',
        parameters: { riskLevel: RiskLevel.MEDIUM },
      }),
    ).toBe(RiskLevel.MEDIUM);
  });
});
