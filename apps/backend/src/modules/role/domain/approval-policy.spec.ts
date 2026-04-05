import {
  approvalReason,
  shouldRequireApproval,
  taskParameterSource,
} from './approval-policy';

describe('shouldRequireApproval', () => {
  it('已 grant 则不再要求审批', () => {
    expect(
      shouldRequireApproval({
        name: 'x',
        parameters: { source: 'llm', approvalGranted: true },
      }),
    ).toBe(false);
  });

  it('source === llm → true', () => {
    expect(
      shouldRequireApproval({
        name: 'build login',
        parameters: { source: 'llm' },
      }),
    ).toBe(true);
  });

  it('name 含 delete → true', () => {
    expect(
      shouldRequireApproval({
        name: 'delete user records',
        parameters: { source: 'rule' },
      }),
    ).toBe(true);
  });

  it('纯 rule 且无 delete → false', () => {
    expect(
      shouldRequireApproval({
        name: 'build login',
        parameters: { source: 'rule', feature: 'login' },
      }),
    ).toBe(false);
  });
});

describe('approvalReason / taskParameterSource', () => {
  it('approvalReason 对 MEDIUM（LLM）有说明', () => {
    const t = { name: 'a', parameters: { source: 'llm' } };
    expect(approvalReason(t)).toContain('中风险');
    expect(taskParameterSource(t)).toBe('llm');
  });

  it('taskParameterSource rule', () => {
    expect(
      taskParameterSource({
        name: 'a',
        parameters: { source: 'rule' },
      }),
    ).toBe('rule');
  });
});
