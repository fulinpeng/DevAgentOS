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
});

describe('decideExecution', () => {
  it('仅 PENDING 为 true', () => {
    expect(decideExecution({ status: 'PENDING' })).toBe(true);
    expect(decideExecution({ status: 'RUNNING' })).toBe(false);
    expect(decideExecution({ status: 'COMPLETED' })).toBe(false);
  });
});
