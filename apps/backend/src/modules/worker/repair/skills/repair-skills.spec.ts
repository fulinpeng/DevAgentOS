import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { MissingScriptRepairSkill } from './missing-script.skill';
import { MissingValidationScriptRepairSkill } from './missing-validation-script.skill';
import { LongRunningCommandRepairSkill } from './long-running-command.skill';
import { MissingAcceptanceVerifyRepairSkill } from './missing-acceptance-verify.skill';
import { PathSandboxRepairSkill } from './path-sandbox.skill';
import { ReadFileEnoentRepairSkill } from './readfile-enoent.skill';
import { RunCommandBasicRepairSkill } from './run-command-basic.skill';
import { UnsafeFullOverwriteRepairSkill } from './unsafe-full-overwrite.skill';

/** 仅占位：真实运行时 narrative 由 WorkerExecutor 从任务 parameters 注入，与具体业务无关 */
const baseNarrative = {
  taskName: 'unit-test-task',
  taskRole: 'general',
  taskDescription: 'Synthetic description for repair skill tests.',
  workflowGoal: 'Synthetic workflow goal for tests.',
  workflowDescription: 'Synthetic workflow description for tests.',
};

const baseContext = {
  taskId: 't1',
  projectRoot: '/tmp/proj',
  workflowTechStack: ['react', 'vite'],
  taskTechStack: ['vite'],
  attempt: 1,
  maxAttempts: 3,
  remainingSteps: [{ action: 'runCommand', args: { command: 'pnpm run build' } }],
  history: [],
  narrative: baseNarrative,
  executedStepsPreview: [] as Array<{
    index: number;
    action: string;
    success: boolean;
    error?: string;
  }>,
};

describe('repair skills', () => {
  it('long-running-command skill rewrites dev to build', async () => {
    const skill = new LongRunningCommandRepairSkill();
    const plan = await skill.plan({
      ...baseContext,
      failure: {
        stepIndex: 0,
        step: { action: 'runCommand', args: { command: 'pnpm run dev' } },
        tool: 'runCommand',
        error: 'run_command_long_running',
      },
    });
    expect(plan?.fixSteps[0]?.args?.command).toBe('pnpm run build');
  });

  it('path-sandbox skill sanitizes ../ path', async () => {
    const skill = new PathSandboxRepairSkill();
    const plan = await skill.plan({
      ...baseContext,
      failure: {
        stepIndex: 1,
        step: { action: 'readFile', args: { path: '../secret/.env' } },
        tool: 'readFile',
        error: 'path escapes sandbox: ../secret/.env',
      },
    });
    expect(plan?.fixSteps[0]?.args?.path).toBe('secret/.env');
  });

  it('unsafe-full-overwrite skill adds readFile and overwriteExisting', async () => {
    const skill = new UnsafeFullOverwriteRepairSkill();
    const plan = await skill.plan({
      ...baseContext,
      failure: {
        stepIndex: 0,
        step: {
          action: 'writeFile',
          args: { path: 'src/__tests__/setup.ts', content: 'next content' },
        },
        tool: 'writeFile',
        error:
          'unsafe_full_overwrite: 目标文件已存在。为避免整文件覆盖导致功能丢失，默认禁止直接 writeFile 覆盖；请先 readFile 后做最小改动，并显式传 overwriteExisting=true。',
      },
    });
    expect(plan?.skillId).toBe('unsafe-full-overwrite');
    expect(plan?.fixSteps).toEqual([
      { action: 'readFile', args: { path: 'src/__tests__/setup.ts' } },
      {
        action: 'writeFile',
        args: {
          path: 'src/__tests__/setup.ts',
          content: 'next content',
          overwriteExisting: true,
        },
      },
    ]);
  });

  it('readfile-enoent skill creates missing file then reads it', async () => {
    const skill = new ReadFileEnoentRepairSkill();
    const plan = await skill.plan({
      ...baseContext,
      failure: {
        stepIndex: 0,
        step: { action: 'readFile', args: { path: 'src/types.ts' } },
        tool: 'readFile',
        error:
          "ENOENT: no such file or directory, open 'C:\\Users\\flp\\Desktop\\aaa\\todoList\\src\\types.ts'",
      },
    });
    expect(plan?.skillId).toBe('readfile-enoent');
    expect(plan?.fixSteps).toEqual([
      {
        action: 'writeFile',
        args: { path: 'src/types.ts', content: '', overwriteExisting: true },
      },
      { action: 'readFile', args: { path: 'src/types.ts' } },
    ]);
  });

  it('run-command-basic does not suggest pnpm install for TS-only compile output', async () => {
    const skill = new RunCommandBasicRepairSkill();
    const plan = await skill.plan({
      ...baseContext,
      failure: {
        stepIndex: 0,
        step: { action: 'runCommand', args: { command: 'pnpm run build' } },
        tool: 'runCommand',
        error: 'Command failed: pnpm run build\n',
        data: {
          stderr:
            "src/App.tsx(5,1): error TS6133: 'SearchBar' is declared but its value is never read.\n",
        },
      },
    });
    expect(plan).toBeNull();
  });

  it('run-command-basic does not suggest pnpm install for jest-dom matcher errors', async () => {
    const skill = new RunCommandBasicRepairSkill();
    const failure = {
      stepIndex: 0,
      step: { action: 'runCommand', args: { command: 'pnpm run test' } },
      tool: 'runCommand',
      error: 'Command failed: pnpm run test\n',
      data: {
        stderr:
          "FAIL src/App.test.tsx > x\nError: Invalid Chai property: toBeInTheDocument\n",
      },
    };
    expect(await skill.plan({ ...baseContext, failure })).toBeNull();
  });

  it('run-command-basic does not suggest pnpm install for describe/localStorage ReferenceError', async () => {
    const skill = new RunCommandBasicRepairSkill();
    const failure = {
      stepIndex: 0,
      step: { action: 'runCommand', args: { command: 'pnpm run test' } },
      tool: 'runCommand',
      error: 'Command failed: pnpm run test\n',
      data: {
        stderr:
          'FAIL src/App.test.tsx\nReferenceError: describe is not defined\nReferenceError: localStorage is not defined\n',
      },
    };
    expect(await skill.plan({ ...baseContext, failure })).toBeNull();
  });

  it('run-command-basic skill suggests pnpm install for missing deps', async () => {
    const skill = new RunCommandBasicRepairSkill();
    const plan = await skill.plan({
      ...baseContext,
      failure: {
        stepIndex: 0,
        step: { action: 'runCommand', args: { command: 'pnpm run build' } },
        tool: 'runCommand',
        error: 'Cannot find module vite',
      },
    });
    expect(plan?.fixSteps[0]?.action).toBe('runCommand');
    expect(plan?.fixSteps[0]?.args?.command).toBe('pnpm install');
  });

  it('run-command-basic should not retry pnpm install after install itself fails', async () => {
    const skill = new RunCommandBasicRepairSkill();
    const failure = {
      stepIndex: 0,
      step: {
        action: 'runCommand',
        args: {
          command:
            'pnpm install @testing-library/react @testing-library/jest-dom @wojtekmaj/enzyme-adapter-react-16',
        },
      },
      tool: 'runCommand',
      error:
        'Command failed: pnpm install @testing-library/react @testing-library/jest-dom @wojtekmaj/enzyme-adapter-react-16\n',
      data: {
        stderr: 'ERR_PNPM_NO_MATCHING_VERSION No matching version found\n',
      },
    };
    expect(await skill.plan({ ...baseContext, failure })).toBeNull();
  });

  it('missing-script skill rewrites to fallback script', async () => {
    const skill = new MissingScriptRepairSkill();
    const plan = await skill.plan({
      ...baseContext,
      failure: {
        stepIndex: 0,
        step: { action: 'runCommand', args: { command: 'pnpm run dev' } },
        tool: 'runCommand',
        error: 'ERR_PNPM_RECURSIVE_EXEC_FIRST_FAIL Command "dev" not found',
      },
    });
    expect(plan?.category).toBe('missing_script');
    expect(plan?.fixSteps[1]?.args?.command).toBe('pnpm run build');
  });

  it('missing validation script should not use missing-script or generic install fallback', async () => {
    const missingScript = new MissingScriptRepairSkill();
    const basic = new RunCommandBasicRepairSkill();
    const failure = {
      stepIndex: 0,
      step: { action: 'runCommand', args: { command: 'pnpm run test' } },
      tool: 'runCommand',
      error: 'Command failed: pnpm run test\n',
      data: {
        stderr:
          'ERR_PNPM_RECURSIVE_EXEC_FIRST_FAIL Command "test" not found\n',
      },
    };
    expect(await missingScript.plan({ ...baseContext, failure })).toBeNull();
    expect(await basic.plan({ ...baseContext, failure })).toBeNull();
  });

  it('missing-validation-script plans via LLM when no local shortcut applies', async () => {
    const skill = new MissingValidationScriptRepairSkill({
      callLLM: async () =>
        '{"fixSteps":[{"action":"runCommand","args":{"command":"pnpm exec vitest run"}}]}',
    } as never);
    const failure = {
      stepIndex: 0,
      step: { action: 'runCommand', args: { command: 'pnpm run test' } },
      tool: 'runCommand',
      error: 'Command failed: pnpm run test\n',
      data: {
        stderr:
          'ERR_PNPM_RECURSIVE_EXEC_FIRST_FAIL Command "test" not found\n',
      },
    };
    const plan = await skill.plan({ ...baseContext, failure });
    expect(plan?.fixSteps?.[0]?.args?.command).toBe('pnpm exec vitest run');
  });

  it('missing-validation-script matches when stderr is empty but error line shows pnpm run test', async () => {
    const skill = new MissingValidationScriptRepairSkill({
      callLLM: async () =>
        '{"fixSteps":[{"action":"runCommand","args":{"command":"pnpm exec vitest run"}}]}',
    } as never);
    const plan = await skill.plan({
      ...baseContext,
      failure: {
        stepIndex: 0,
        step: { action: 'runCommand', args: { command: 'pnpm run test' } },
        tool: 'runCommand',
        error: 'Command failed: pnpm run test\n',
        data: {},
      },
    });
    expect(plan?.reason).toContain('missing validation script');
  });

  it('missing-validation-script prefers pnpm exec vitest run without rewriting package.json', async () => {
    const tempRoot = mkdtempSync(path.join(tmpdir(), 'repair-skill-'));
    try {
      writeFileSync(
        path.join(tempRoot, 'package.json'),
        JSON.stringify(
          {
            name: 'tmp-app',
            scripts: { build: 'vite build' },
            devDependencies: { vitest: '^4.1.0' },
          },
          null,
          2,
        ),
        'utf8',
      );
      const skill = new MissingValidationScriptRepairSkill({
        callLLM: async () => {
          throw new Error('llm should not be called');
        },
      } as never);
      const plan = await skill.plan({
        ...baseContext,
        projectRoot: tempRoot,
        failure: {
          stepIndex: 0,
          step: { action: 'runCommand', args: { command: 'pnpm run test' } },
          tool: 'runCommand',
          error: 'Command failed: pnpm run test\n',
          data: {
            stderr:
              'ERR_PNPM_RECURSIVE_EXEC_FIRST_FAIL Command "test" not found\n',
          },
        },
      });
      expect(plan?.fixSteps).toEqual([
        { action: 'runCommand', args: { command: 'pnpm exec vitest run' } },
      ]);
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it('missing-validation-script handles absent vitest script; missing-script defers', async () => {
    const missingScript = new MissingScriptRepairSkill();
    const validationSkill = new MissingValidationScriptRepairSkill({
      callLLM: async () =>
        '{"fixSteps":[{"action":"readFile","args":{"path":"package.json"}}]}',
    } as never);
    const failure = {
      stepIndex: 0,
      step: { action: 'runCommand', args: { command: 'pnpm run vitest' } },
      tool: 'runCommand',
      error: 'Command failed: pnpm run vitest\n',
      data: {
        stderr:
          'ERR_PNPM_RECURSIVE_EXEC_FIRST_FAIL Command "vitest" not found\n',
      },
    };
    expect(await missingScript.plan({ ...baseContext, failure })).toBeNull();
    const vPlan = await validationSkill.plan({ ...baseContext, failure });
    expect(vPlan?.reason).toContain('missing validation script');
    expect(vPlan?.fixSteps?.[0]?.action).toBe('readFile');
  });

  it('missing-acceptance-verify skill plans when error is worker_llm_missing_acceptance_verify', async () => {
    const skill = new MissingAcceptanceVerifyRepairSkill({
      callLLM: async () =>
        '{"fixSteps":[{"action":"runCommand","args":{"command":"pnpm run build"}}]}',
    } as never);
    const plan = await skill.plan({
      ...baseContext,
      failure: {
        stepIndex: -1,
        step: { action: 'runCommand', args: { command: 'pnpm run build' } },
        tool: 'runCommand',
        error: 'worker_llm_missing_acceptance_verify',
        data: {
          rawPlan: '{"steps":[{"action":"runCommand","args":{"command":"pnpm run build"}}]}',
          packageScripts: ['build'],
          retried: true,
        },
      },
    });
    expect(plan?.skillId).toBe('missing-acceptance-verify');
    expect(plan?.fixSteps?.[0]?.args?.command).toBe('pnpm run build');
  });
});
