import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { getRunCommandFailureText, looksLikeCompileOrTypeError } from '../run-command-failure-text';
import { MissingScriptRepairSkill } from './missing-script.skill';
import { MissingValidationScriptRepairSkill } from './missing-validation-script.skill';
import { LongRunningCommandRepairSkill } from './long-running-command.skill';
import { MissingAcceptanceVerifyRepairSkill } from './missing-acceptance-verify.skill';
import { PathSandboxRepairSkill } from './path-sandbox.skill';
import { ReadFileEnoentRepairSkill } from './readfile-enoent.skill';
import { RunCommandBasicRepairSkill } from './run-command-basic.skill';
import { TypeScriptBuildRepairSkill } from './typescript-build.skill';
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

  it('looksLikeCompileOrTypeError detects never[] / implicit any messages', () => {
    expect(
      looksLikeCompileOrTypeError(
        "src/pages/Home.tsx(16,15): error TS2345: Argument of type 'Foo[]' is not assignable to parameter of type 'SetStateAction<never[]>'.",
      ),
    ).toBe(true);
    expect(
      looksLikeCompileOrTypeError(
        "src/pages/Home.tsx(19,25): error TS7006: Parameter 'e' implicitly has an 'any' type.",
      ),
    ).toBe(true);
  });

  it('looksLikeCompileOrTypeError detects tsc output', () => {
    expect(
      looksLikeCompileOrTypeError(
        "src/App.tsx(5,1): error TS6133: 'SearchBar' is declared but its value is never read.",
      ),
    ).toBe(true);
    expect(
      looksLikeCompileOrTypeError(
        "src/App.tsx(2,18): error TS2307: Cannot find module './pages/Home'",
      ),
    ).toBe(true);
    expect(getRunCommandFailureText({ stepIndex: 0, step: { action: 'runCommand', args: {} }, tool: 'runCommand', error: 'Command failed', data: { stderr: 'error TS1484:' } }).includes('TS1484')).toBe(true);
  });

  it('looksLikeCompileOrTypeError detects vite import-analysis resolution errors', () => {
    expect(
      looksLikeCompileOrTypeError(
        'Error: Failed to resolve import "./App" from "src/App.test.tsx". Does the file exist? Plugin: vite:import-analysis',
      ),
    ).toBe(true);
  });

  it('looksLikeCompileOrTypeError detects vitest + jest-dom matcher setup errors', () => {
    expect(
      looksLikeCompileOrTypeError(
        "FAIL src/App.test.tsx > App routing > renders\nError: Invalid Chai property: toBeInTheDocument",
      ),
    ).toBe(true);
  });

  it('run-command-basic skill defers compile failures (does not suggest pnpm install)', async () => {
    const skill = new RunCommandBasicRepairSkill();
    const m = skill.match({
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
    expect(m.score).toBe(0);
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

  it('run-command-basic defers vitest jest-dom matcher errors (no pnpm install)', async () => {
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
    expect(skill.match({ ...baseContext, failure }).score).toBe(0);
    expect(await skill.plan({ ...baseContext, failure })).toBeNull();
  });

  it('typescript-build skill matches runCommand with stderr TS errors', () => {
    const skill = new TypeScriptBuildRepairSkill(null as never);
    const m = skill.match({
      ...baseContext,
      failure: {
        stepIndex: 0,
        step: { action: 'runCommand', args: { command: 'pnpm run build' } },
        tool: 'runCommand',
        error: 'Command failed: pnpm run build\n',
        data: {
          stderr:
            "src/router/index.tsx(12,15): error TS2739: Type '{}' is missing the following properties from type 'DetailPageProps': imageUrl, title, description\n",
        },
      },
    });
    expect(m.score).toBeGreaterThan(0.8);
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
    expect(skill.match({ ...baseContext, failure }).score).toBe(0);
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
    expect(missingScript.match({ ...baseContext, failure }).score).toBe(0);
    expect(await missingScript.plan({ ...baseContext, failure })).toBeNull();
    expect(basic.match({ ...baseContext, failure }).score).toBe(0);
    expect(await basic.plan({ ...baseContext, failure })).toBeNull();
  });

  it('missing-validation-script skill matches absent test script', () => {
    const skill = new MissingValidationScriptRepairSkill(null as never);
    const m = skill.match({
      ...baseContext,
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
    expect(m.score).toBeGreaterThan(0.9);
    expect(m.reason).toContain('missing validation script');
  });

  it('missing-validation-script matches when stderr is empty but error line shows pnpm run test', () => {
    const skill = new MissingValidationScriptRepairSkill(null as never);
    const m = skill.match({
      ...baseContext,
      failure: {
        stepIndex: 0,
        step: { action: 'runCommand', args: { command: 'pnpm run test' } },
        tool: 'runCommand',
        error: 'Command failed: pnpm run test\n',
        data: {},
      },
    });
    expect(m.score).toBeGreaterThan(0.9);
    expect(m.reason).toContain('missing validation script');
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

  it('missing-validation-script skill also matches absent vitest script', async () => {
    const missingScript = new MissingScriptRepairSkill();
    const validationSkill = new MissingValidationScriptRepairSkill(null as never);
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
    expect(missingScript.match({ ...baseContext, failure }).score).toBe(0);
    const m = validationSkill.match({ ...baseContext, failure });
    expect(m.score).toBeGreaterThan(0.9);
    expect(m.reason).toContain('missing validation script');
    expect(await missingScript.plan({ ...baseContext, failure })).toBeNull();
  });

  it('missing-acceptance-verify skill matches planning failures before execution', () => {
    const skill = new MissingAcceptanceVerifyRepairSkill(null as never);
    const m = skill.match({
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
    expect(m.score).toBeGreaterThan(0.9);
    expect(m.reason).toContain('acceptance');
  });
});

