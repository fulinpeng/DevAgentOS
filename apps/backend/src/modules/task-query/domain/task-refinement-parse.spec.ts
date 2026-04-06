import {
  parseRefinementLlmOutput,
  refinePayloadFromValue,
} from './task-refinement-parse';

describe('task-refinement-parse', () => {
  it('parses fenced JSON from LLM', () => {
    const raw = '```json\n{"description":"d","parameters":{},"steps":[{"action":"run","args":{}}]}\n```';
    const r = parseRefinementLlmOutput(raw);
    expect(r).toEqual({
      description: 'd',
      parameters: {},
      steps: [{ action: 'run', args: {} }],
    });
  });

  it('rejects invalid steps', () => {
    expect(
      refinePayloadFromValue({
        description: 'x',
        parameters: {},
        steps: [{ action: '', args: {} }],
      }),
    ).toBeNull();
  });

  it('accepts refinePayloadFromValue for stored data', () => {
    const r = refinePayloadFromValue({
      description: 'ok',
      parameters: { a: 1 },
      steps: [{ action: 'writeFile', args: { path: 'x' } }],
    });
    expect(r?.steps[0].action).toBe('writeFile');
  });
});
