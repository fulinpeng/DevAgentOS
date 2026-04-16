import { getRunCommandFailureText, looksLikeCompileOrTypeError } from '../run-command-failure-text';
import { MissingScriptRepairSkill } from './missing-script.skill';
import { LongRunningCommandRepairSkill } from './long-running-command.skill';
import { PathSandboxRepairSkill } from './path-sandbox.skill';
import { RunCommandBasicRepairSkill } from './run-command-basic.skill';
import { TypeScriptBuildRepairSkill } from './typescript-build.skill';

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
});

