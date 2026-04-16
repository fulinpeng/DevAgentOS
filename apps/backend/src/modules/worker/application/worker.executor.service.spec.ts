import {
  findMissingPackageScriptForVerification,
  fingerprintRepairWriteIntentsForTest,
  sanitizeRepairStepsByPolicy,
  shouldSkipReplayingFailedStepAfterRepairForTest,
} from './worker.executor.service';

describe('sanitizeRepairStepsByPolicy', () => {
  it('rejects repeated writes to the same file', () => {
    const result = sanitizeRepairStepsByPolicy(
      {
        stepIndex: 0,
        step: { action: 'runCommand', args: { command: 'pnpm run build' } },
        tool: 'runCommand',
        error: 'Command failed: pnpm run build\n',
        data: { stderr: 'error TS1234: bad config\n' },
      },
      [
        {
          action: 'writeFile',
          args: { path: 'tsconfig.json', content: '{"a":1}', overwriteExisting: true },
        },
        {
          action: 'writeFile',
          args: { path: 'tsconfig.json', content: '{"a":2}', overwriteExisting: true },
        },
      ],
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain('same file multiple times');
    }
  });

  it('rejects touching protected tsconfig without direct error evidence', () => {
    const result = sanitizeRepairStepsByPolicy(
      {
        stepIndex: 0,
        step: { action: 'runCommand', args: { command: 'pnpm run build' } },
        tool: 'runCommand',
        error: 'Command failed: pnpm run build\n',
        data: { stderr: "src/App.tsx(1,1): error TS2304: Cannot find name 'foo'\n" },
      },
      [
        {
          action: 'readFile',
          args: { path: 'tsconfig.json' },
        },
        {
          action: 'writeFile',
          args: { path: 'tsconfig.json', content: '{"compilerOptions":{}}', overwriteExisting: true },
        },
      ],
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain('protected files');
      expect(result.reason).toContain('tsconfig.json');
    }
  });

  it('allows vite.config.ts for test-toolchain compile failures', () => {
    const result = sanitizeRepairStepsByPolicy(
      {
        stepIndex: 0,
        step: { action: 'runCommand', args: { command: 'pnpm run build' } },
        tool: 'runCommand',
        error: 'Command failed: pnpm run build\n',
        data: {
          stderr:
            "src/__tests__/setup.ts(1,10): error TS2305: Module 'vitest/config' has no exported member 'configure'\n",
        },
      },
      [
        {
          action: 'readFile',
          args: { path: 'vite.config.ts' },
        },
        {
          action: 'writeFile',
          args: {
            path: 'vite.config.ts',
            content: 'export default {}',
            overwriteExisting: true,
          },
        },
      ],
    );
    expect(result.ok).toBe(true);
  });

  it('still rejects unrelated protected vite.config.ts writes', () => {
    const result = sanitizeRepairStepsByPolicy(
      {
        stepIndex: 0,
        step: { action: 'runCommand', args: { command: 'pnpm run build' } },
        tool: 'runCommand',
        error: 'Command failed: pnpm run build\n',
        data: {
          stderr: "src/App.tsx(1,1): error TS2304: Cannot find name 'foo'\n",
        },
      },
      [
        {
          action: 'writeFile',
          args: {
            path: 'vite.config.ts',
            content: 'export default {}',
            overwriteExisting: true,
          },
        },
      ],
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain('vite.config.ts');
    }
  });

  it('allows package.json update when validation script is missing', () => {
    const result = sanitizeRepairStepsByPolicy(
      {
        stepIndex: 0,
        step: { action: 'runCommand', args: { command: 'pnpm run test' } },
        tool: 'runCommand',
        error: 'Command failed: pnpm run test\n',
        data: {
          stderr:
            'ERR_PNPM_RECURSIVE_EXEC_FIRST_FAIL Command "test" not found\n',
        },
      },
      [
        {
          action: 'writeFile',
          args: {
            path: 'package.json',
            content: '{"scripts":{"test":"vitest run"}}',
            overwriteExisting: true,
          },
        },
      ],
    );
    expect(result.ok).toBe(true);
  });
});

describe('findMissingPackageScriptForVerification', () => {
  it('flags pnpm run test when package.json has no test script', () => {
    const missing = findMissingPackageScriptForVerification(
      [
        { action: 'writeFile', args: { path: 'src/foo.test.ts', content: 'x' } },
        { action: 'runCommand', args: { command: 'pnpm run test' } },
      ],
      ['build'],
    );
    expect(missing).toEqual({
      stepIndex: 1,
      command: 'pnpm run test',
      script: 'test',
    });
  });

  it('does not flag direct pnpm exec vitest run', () => {
    const missing = findMissingPackageScriptForVerification(
      [{ action: 'runCommand', args: { command: 'pnpm exec vitest run' } }],
      ['build'],
    );
    expect(missing).toBeNull();
  });

  it('does not flag existing verify script', () => {
    const missing = findMissingPackageScriptForVerification(
      [{ action: 'runCommand', args: { command: 'pnpm run verify' } }],
      ['build', 'verify'],
    );
    expect(missing).toBeNull();
  });

  it('skips replaying unsafe_full_overwrite failed step after repair', () => {
    expect(
      shouldSkipReplayingFailedStepAfterRepairForTest({
        stepIndex: 0,
        step: {
          action: 'writeFile',
          args: { path: 'src/__tests__/setup.ts', content: 'x' },
        },
        tool: 'writeFile',
        error:
          'unsafe_full_overwrite: 目标文件已存在。为避免整文件覆盖导致功能丢失，默认禁止直接 writeFile 覆盖；请先 readFile 后做最小改动，并显式传 overwriteExisting=true。',
      }),
    ).toBe(true);
  });

  it('skips replaying failed runCommand when fix already reran same command', () => {
    expect(
      shouldSkipReplayingFailedStepAfterRepairForTest(
        {
          stepIndex: 0,
          step: { action: 'runCommand', args: { command: 'pnpm run build' } },
          tool: 'runCommand',
          error: 'Command failed: pnpm run build\n',
        },
        { action: 'runCommand', args: { command: 'pnpm run build' } },
        [{ action: 'runCommand', args: { command: 'pnpm run build' } }],
      ),
    ).toBe(true);
  });

  it('builds same fingerprint for same write intent', () => {
    const failure = {
      stepIndex: 0,
      step: { action: 'runCommand', args: { command: 'pnpm run build' } },
      tool: 'runCommand',
      error: 'Command failed: pnpm run build\n',
      data: { stderr: 'error TS2305\n' },
    } as const;
    const fp1 = fingerprintRepairWriteIntentsForTest(failure, [
      { action: 'readFile', args: { path: 'src/setupTests.ts' } },
      {
        action: 'writeFile',
        args: { path: 'src/setupTests.ts', content: 'fixed', overwriteExisting: true },
      },
    ]);
    const fp2 = fingerprintRepairWriteIntentsForTest(failure, [
      {
        action: 'writeFile',
        args: { path: 'src/setupTests.ts', content: 'fixed', overwriteExisting: true },
      },
    ]);
    expect(fp1).toBe(fp2);
  });
});
