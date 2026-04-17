import { refineRepairTriageAfterLlm } from './repair-triage-refine';

const baseNarrative = {
  taskName: 't',
  taskRole: null,
  taskDescription: '',
  workflowGoal: '',
  workflowDescription: '',
};

describe('refineRepairTriageAfterLlm', () => {
  it('rewrites typescript-build to vitest-rtl-assertion for Vitest DOM miss without TS', () => {
    const failureText = `Command failed: pnpm run test
Failed Tests 1
FAIL src/App.test.tsx > x
TestingLibraryElementError: Unable to find an element with the text: Foo.`;
    const ctx = {
      taskId: '1',
      projectRoot: '/p',
      workflowTechStack: [] as string[],
      taskTechStack: [] as string[],
      attempt: 1,
      maxAttempts: 3,
      remainingSteps: [],
      history: [],
      narrative: baseNarrative,
      executedStepsPreview: [],
      failure: {
        stepIndex: 0,
        step: { action: 'runCommand', args: { command: 'pnpm run test' } },
        tool: 'runCommand',
        error: failureText,
        data: {} as Record<string, unknown>,
      },
    };
    const refined = refineRepairTriageAfterLlm(ctx, {
      skillId: 'typescript-build',
      focusPaths: [],
      rationale: 'wrong',
    });
    expect(refined?.skillId).toBe('vitest-rtl-assertion');
  });

  it('fills vitest-rtl when triage null but output is Vitest failure', () => {
    const ctx = {
      taskId: '1',
      projectRoot: '/p',
      workflowTechStack: [] as string[],
      taskTechStack: [] as string[],
      attempt: 1,
      maxAttempts: 3,
      remainingSteps: [],
      history: [],
      narrative: baseNarrative,
      executedStepsPreview: [],
      failure: {
        stepIndex: 0,
        step: { action: 'runCommand', args: { command: 'pnpm run test' } },
        tool: 'runCommand',
        error: 'Command failed\nFailed Tests 1\nFAIL src/App.test.tsx',
        data: {},
      },
    };
    const refined = refineRepairTriageAfterLlm(ctx, null);
    expect(refined?.skillId).toBe('vitest-rtl-assertion');
  });
});
