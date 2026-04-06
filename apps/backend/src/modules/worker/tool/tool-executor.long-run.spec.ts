import { isLongRunningDevServerCommand } from './tool-executor';

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
