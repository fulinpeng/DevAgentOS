import {
  getRunCommandFailureText,
  looksLikeCompileOrTypeError,
  looksLikeTestAssertionFailure,
  looksLikeVitestDomOrAssertionFailure,
} from './run-command-failure-text';

describe('run-command-failure-text helpers', () => {
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
    expect(
      getRunCommandFailureText({
        stepIndex: 0,
        step: { action: 'runCommand', args: {} },
        tool: 'runCommand',
        error: 'Command failed',
        data: { stderr: 'error TS1484:' },
      }).includes('TS1484'),
    ).toBe(true);
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

  it('looksLikeCompileOrTypeError is false for TestingLibraryElementError (runtime query miss)', () => {
    const blob =
      'FAIL src/App.test.tsx > flow\nTestingLibraryElementError: Unable to find an element with the text: Prepare sprint demo.';
    expect(looksLikeTestAssertionFailure(blob)).toBe(true);
    expect(looksLikeCompileOrTypeError(blob)).toBe(false);
  });

  it('looksLikeVitestDomOrAssertionFailure matches Failed Tests + FAIL *.test.tsx without TS lines', () => {
    const blob = `Command failed: pnpm run test
Failed Tests 1
FAIL src/App.test.tsx > suite > case
TestingLibraryElementError: Unable to find an element`;
    expect(looksLikeVitestDomOrAssertionFailure(blob)).toBe(true);
    expect(looksLikeCompileOrTypeError(blob)).toBe(false);
  });

  it('looksLikeVitestDomOrAssertionFailure is false when TS errors present', () => {
    const blob =
      'Failed Tests 1\nsrc/App.tsx(1,1): error TS2304: Cannot find name.\nFAIL src/App.test.tsx';
    expect(looksLikeVitestDomOrAssertionFailure(blob)).toBe(false);
  });
});
