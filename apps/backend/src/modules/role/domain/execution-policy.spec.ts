import { decideExecution } from './execution-policy';

describe('decideExecution', () => {
  it('PENDING 允许执行', () => {
    expect(decideExecution({ status: 'PENDING' })).toBe(true);
  });

  it('RUNNING / COMPLETED 拒绝', () => {
    expect(decideExecution({ status: 'RUNNING' })).toBe(false);
    expect(decideExecution({ status: 'COMPLETED' })).toBe(false);
  });
});
