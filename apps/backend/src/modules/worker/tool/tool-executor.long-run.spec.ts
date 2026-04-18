import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { isLongRunningDevServerCommand, ToolExecutor } from './tool-executor';

describe('isLongRunningDevServerCommand', () => {
  it('flags dev / preview style commands', () => {
    expect(isLongRunningDevServerCommand('pnpm run dev')).toBe(true);
    expect(isLongRunningDevServerCommand('pnpm run preview')).toBe(true);
    expect(isLongRunningDevServerCommand('npm run dev')).toBe(true);
    expect(isLongRunningDevServerCommand('yarn dev')).toBe(true);
    expect(isLongRunningDevServerCommand('next dev')).toBe(true);
    expect(isLongRunningDevServerCommand('vite')).toBe(true);
    expect(isLongRunningDevServerCommand('vite preview')).toBe(true);
  });

  it('allows build and other finite commands', () => {
    expect(isLongRunningDevServerCommand('pnpm run build')).toBe(false);
    expect(isLongRunningDevServerCommand('vite build')).toBe(false);
    expect(isLongRunningDevServerCommand('vite build --mode production')).toBe(
      false,
    );
    expect(isLongRunningDevServerCommand('pnpm run test')).toBe(false);
    expect(isLongRunningDevServerCommand('pnpm install')).toBe(false);
  });
});

describe('ToolExecutor writeFile overwrite guard', () => {
  it('blocks overwriting existing file by default', async () => {
    const baseDir = mkdtempSync(path.join(tmpdir(), 'worker-tool-'));
    writeFileSync(path.join(baseDir, 'a.txt'), 'old', 'utf8');
    const exec = new ToolExecutor();
    const r = await exec.execute(
      'writeFile',
      { path: 'a.txt', content: 'new' },
      baseDir,
    );
    expect(r.success).toBe(false);
    expect(r.error ?? '').toContain('unsafe_full_overwrite');
  });

  it('allows overwriting when overwriteExisting=true', async () => {
    const baseDir = mkdtempSync(path.join(tmpdir(), 'worker-tool-'));
    writeFileSync(path.join(baseDir, 'a.txt'), 'old', 'utf8');
    const exec = new ToolExecutor();
    const r = await exec.execute(
      'writeFile',
      { path: 'a.txt', content: 'new', overwriteExisting: true },
      baseDir,
    );
    expect(r.success).toBe(true);
    expect(r.data?.overwrittenExisting).toBe(true);
  });
});

describe('ToolExecutor runCommand guardrails', () => {
  it('rejects pnpm exec node -e inline scripts', async () => {
    const baseDir = mkdtempSync(path.join(tmpdir(), 'worker-tool-rc-'));
    const exec = new ToolExecutor();
    const r = await exec.execute(
      'runCommand',
      { command: 'pnpm exec node -e "console.log(1)"' },
      baseDir,
    );
    expect(r.success).toBe(false);
    expect(String(r.error)).toContain('run_command_no_inline_node_eval');
  });

});
