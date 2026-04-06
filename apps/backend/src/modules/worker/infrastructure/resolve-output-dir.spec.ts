import * as path from 'node:path';
import { resolveWorkerBaseDir } from './resolve-output-dir';

describe('resolveWorkerBaseDir', () => {
  const ws = path.join('/tmp', 'devagent-workspace');

  it('resolves relative path as full segment under workspace (no first-segment truncation)', () => {
    const out = resolveWorkerBaseDir(ws, 'sandbox/my-app');
    expect(out.baseDir).toBe(path.resolve(ws, 'sandbox/my-app'));
    expect(out.projectRoot).toBe(out.baseDir);
  });

  it('normalizes Windows absolute paths', () => {
    const out = resolveWorkerBaseDir(
      '/tmp',
      'C:\\Users\\flp\\Desktop\\aaa',
    );
    expect(out.baseDir).toBe('C:\\Users\\flp\\Desktop\\aaa');
    expect(out.projectRoot).toBe(out.baseDir);
  });

  it('normalizes POSIX absolute paths', () => {
    const out = resolveWorkerBaseDir(ws, '/home/user/proj');
    expect(out.baseDir).toBe(path.normalize('/home/user/proj'));
    expect(out.projectRoot).toBe(out.baseDir);
  });
});
