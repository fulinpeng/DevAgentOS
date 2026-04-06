import { decideExecution, routeRoleExecution } from './execution-policy';

describe('routeRoleExecution', () => {
  it('PENDING → execute', () => {
    expect(routeRoleExecution({ status: 'PENDING' })).toBe('execute');
  });

  it('COMPLETED → return_completed（幂等）', () => {
    expect(routeRoleExecution({ status: 'COMPLETED' })).toBe(
      'return_completed',
    );
  });

  it('RUNNING → reject_running', () => {
    expect(routeRoleExecution({ status: 'RUNNING' })).toBe('reject_running');
  });

  it('WAITING_APPROVAL → blocked_approval', () => {
    expect(routeRoleExecution({ status: 'WAITING_APPROVAL' })).toBe(
      'blocked_approval',
    );
  });

  it('FAILED → blocked_failed', () => {
    expect(routeRoleExecution({ status: 'FAILED' })).toBe('blocked_failed');
  });

  it('CREATED → blocked_plan', () => {
    expect(routeRoleExecution({ status: 'CREATED' })).toBe('blocked_plan');
  });

  it('WAITING_PLAN_APPROVAL → blocked_plan', () => {
    expect(routeRoleExecution({ status: 'WAITING_PLAN_APPROVAL' })).toBe(
      'blocked_plan',
    );
  });

  it('PLAN_GENERATED → blocked_plan', () => {
    expect(routeRoleExecution({ status: 'PLAN_GENERATED' })).toBe(
      'blocked_plan',
    );
  });

  it('PLAN_APPROVED → blocked_plan（由 Coordinator 驱动，不经 Role 直跑主任务）', () => {
    expect(routeRoleExecution({ status: 'PLAN_APPROVED' })).toBe(
      'blocked_plan',
    );
  });
});

describe('decideExecution', () => {
  it('仅 PENDING 为 true', () => {
    expect(decideExecution({ status: 'PENDING' })).toBe(true);
    expect(decideExecution({ status: 'RUNNING' })).toBe(false);
    expect(decideExecution({ status: 'COMPLETED' })).toBe(false);
    expect(decideExecution({ status: 'WAITING_APPROVAL' })).toBe(false);
    expect(decideExecution({ status: 'FAILED' })).toBe(false);
    expect(decideExecution({ status: 'CREATED' })).toBe(false);
    expect(decideExecution({ status: 'PLAN_APPROVED' })).toBe(false);
  });
});
