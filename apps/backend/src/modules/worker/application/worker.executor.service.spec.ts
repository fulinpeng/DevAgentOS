import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  coerceWriteFileStepsForExistingTargets,
  dedupeConsecutiveIdenticalRunCommands,
  findMissingPackageScriptForVerification,
  fingerprintRepairWriteIntentsForTest,
  repairPlanTouchesBusinessFilesForTest,
  repairPlanIsMeaningfulForValidationFailureForTest,
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

  it('allows protected tsconfig.* during compile-related pnpm run build failures', () => {
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
          args: { path: 'tsconfig.app.json' },
        },
        {
          action: 'writeFile',
          args: {
            path: 'tsconfig.app.json',
            content: '{"compilerOptions":{}}',
            overwriteExisting: true,
          },
        },
      ],
    );
    expect(result.ok).toBe(true);
  });

  it('rejects touching protected tsconfig when build output is not compile-like', () => {
    const result = sanitizeRepairStepsByPolicy(
      {
        stepIndex: 0,
        step: { action: 'runCommand', args: { command: 'pnpm run build' } },
        tool: 'runCommand',
        error: 'Command failed: pnpm run build\n',
        data: { stderr: 'Killed\nOut of memory\n' },
      },
      [
        {
          action: 'writeFile',
          args: {
            path: 'tsconfig.json',
            content: '{}',
            overwriteExisting: true,
          },
        },
        {
          action: 'writeFile',
          args: {
            path: 'package.json',
            content: '{}',
            overwriteExisting: true,
          },
        },
      ],
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain('protected files');
      expect(result.reason).toContain('tsconfig.json');
      expect(result.reason).toContain('package.json');
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

  it('allows package.json during compile-related pnpm run build failures', () => {
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
          action: 'writeFile',
          args: {
            path: 'package.json',
            content: '{"dependencies":{"react":"^18"}}',
            overwriteExisting: true,
          },
        },
      ],
    );
    expect(result.ok).toBe(true);
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

  it('allows protected file rewrite when failure is unsafe_full_overwrite on same path', () => {
    const result = sanitizeRepairStepsByPolicy(
      {
        stepIndex: 4,
        step: {
          action: 'writeFile',
          args: { path: 'src/app.tsx', content: 'new content' },
        },
        tool: 'writeFile',
        error:
          'unsafe_full_overwrite: 目标文件已存在。为避免整文件覆盖导致功能丢失，默认禁止直接 writeFile 覆盖；请先 readFile 后做最小改动，并显式传 overwriteExisting=true。',
        data: {},
      },
      [
        { action: 'readFile', args: { path: 'src/app.tsx' } },
        {
          action: 'writeFile',
          args: {
            path: 'src/app.tsx',
            content: 'new content',
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

  it('skips replaying unsafe_full_overwrite failed step after repair (same path only)', () => {
    const failure = {
      stepIndex: 0,
      step: {
        action: 'writeFile',
        args: { path: 'src/__tests__/setup.ts', content: 'x' },
      },
      tool: 'writeFile' as const,
      error:
        'unsafe_full_overwrite: 目标文件已存在。为避免整文件覆盖导致功能丢失，默认禁止直接 writeFile 覆盖；请先 readFile 后做最小改动，并显式传 overwriteExisting=true。',
    };
    expect(
      shouldSkipReplayingFailedStepAfterRepairForTest(failure, {
        action: 'writeFile',
        args: { path: 'src/__tests__/setup.ts', content: 'x' },
      }),
    ).toBe(true);
  });

  it('does not skip next writeFile when path differs from unsafe_full_overwrite failure', () => {
    expect(
      shouldSkipReplayingFailedStepAfterRepairForTest(
        {
          stepIndex: 0,
          step: { action: 'writeFile', args: { path: 'src/a.ts', content: 'x' } },
          tool: 'writeFile',
          error: 'unsafe_full_overwrite: 目标文件已存在',
        },
        { action: 'writeFile', args: { path: 'src/b.ts', content: 'y' } },
      ),
    ).toBe(false);
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

describe('dedupeConsecutiveIdenticalRunCommands', () => {
  it('collapses back-to-back identical runCommand steps', () => {
    const steps = [
      { action: 'writeFile', args: { path: 'a.ts', content: '1' } },
      { action: 'runCommand', args: { command: 'pnpm run build' } },
      { action: 'runCommand', args: { command: 'pnpm run build' } },
    ];
    expect(dedupeConsecutiveIdenticalRunCommands(steps)).toEqual([
      { action: 'writeFile', args: { path: 'a.ts', content: '1' } },
      { action: 'runCommand', args: { command: 'pnpm run build' } },
    ]);
  });

  it('keeps non-consecutive duplicate runCommands', () => {
    const steps = [
      { action: 'runCommand', args: { command: 'pnpm run build' } },
      { action: 'readFile', args: { path: 'x' } },
      { action: 'runCommand', args: { command: 'pnpm run build' } },
    ];
    expect(dedupeConsecutiveIdenticalRunCommands(steps)).toEqual(steps);
  });
});

describe('coerceWriteFileStepsForExistingTargets', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'dao-worker-'));
    mkdirSync(join(dir, 'src', 'pages'), { recursive: true });
    writeFileSync(join(dir, 'src/pages/HomePage.tsx'), 'old', 'utf8');
    writeFileSync(join(dir, 'src/pages/TodoDetailPage.tsx'), 'old2', 'utf8');
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('prepends readFile and sets overwriteExisting for writes to existing files', () => {
    const steps = [
      {
        action: 'writeFile',
        args: { path: 'src/pages/HomePage.tsx', content: 'new' },
      },
    ];
    const out = coerceWriteFileStepsForExistingTargets(dir, steps);
    expect(out).toEqual([
      { action: 'readFile', args: { path: 'src/pages/HomePage.tsx' } },
      {
        action: 'writeFile',
        args: {
          path: 'src/pages/HomePage.tsx',
          content: 'new',
          overwriteExisting: true,
        },
      },
    ]);
  });

  it('does not duplicate read when write is already preceded by readFile same path', () => {
    const steps = [
      { action: 'readFile', args: { path: 'src/pages/TodoDetailPage.tsx' } },
      {
        action: 'writeFile',
        args: { path: 'src/pages/TodoDetailPage.tsx', content: 'x' },
      },
    ];
    const out = coerceWriteFileStepsForExistingTargets(dir, steps);
    expect(out).toEqual([
      { action: 'readFile', args: { path: 'src/pages/TodoDetailPage.tsx' } },
      {
        action: 'writeFile',
        args: {
          path: 'src/pages/TodoDetailPage.tsx',
          content: 'x',
          overwriteExisting: true,
        },
      },
    ]);
  });

  it('leaves writeFile unchanged when target file does not exist', () => {
    const steps = [
      { action: 'writeFile', args: { path: 'src/new-file.tsx', content: 'x' } },
    ];
    const out = coerceWriteFileStepsForExistingTargets(dir, steps);
    expect(out).toEqual(steps);
  });
});

describe('repairPlanTouchesBusinessFilesForTest', () => {
  it('returns true when writeFile touches src business files', () => {
    expect(
      repairPlanTouchesBusinessFilesForTest([
        { action: 'writeFile', args: { path: 'src/hooks/useTodos.ts', content: 'x' } },
      ]),
    ).toBe(true);
  });

  it('returns false for only tests/config writes', () => {
    expect(
      repairPlanTouchesBusinessFilesForTest([
        { action: 'writeFile', args: { path: 'src/App.test.tsx', content: 'x' } },
        { action: 'writeFile', args: { path: 'src/setupTests.ts', content: 'x' } },
        { action: 'writeFile', args: { path: 'vitest.config.ts', content: 'x' } },
      ]),
    ).toBe(false);
  });
});

describe('repairPlanIsMeaningfulForValidationFailureForTest', () => {
  it('accepts test file writes for validation command failures', () => {
    expect(
      repairPlanIsMeaningfulForValidationFailureForTest('pnpm run test', [
        { action: 'writeFile', args: { path: 'src/App.test.tsx', content: 'x' } },
      ]),
    ).toBe(true);
  });

  it('rejects config-only writes for validation command failures', () => {
    expect(
      repairPlanIsMeaningfulForValidationFailureForTest('pnpm run test', [
        { action: 'writeFile', args: { path: 'vite.config.ts', content: 'x' } },
      ]),
    ).toBe(false);
  });
});
