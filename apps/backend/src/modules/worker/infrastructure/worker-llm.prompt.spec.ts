import { projectRootLeafName } from './worker-llm.prompt';

describe('projectRootLeafName', () => {
  it('returns last segment for Windows absolute paths', () => {
    expect(projectRootLeafName('C:\\Users\\flp\\Desktop\\aaa\\imgShow')).toBe(
      'imgShow',
    );
  });

  it('returns last segment for POSIX paths', () => {
    expect(projectRootLeafName('/home/u/proj')).toBe('proj');
  });
});
