import contract from '../vast/project-execution-mode.cjs';
const { canonical, validateProjection } = contract;
const failure = code => Object.assign(Error(code), { code });

// A trusted composition argument, never part of manager/settings/HTTP config.
// Production passes createExecutionModeContract().bindForService(...); tests
// explicitly provide a fixture binding. No environment or missing-file default.
export function bindProjectExecution(binding) {
  if (!binding || typeof binding !== 'object' || typeof binding.assertUnchanged !== 'function') throw failure('PROJECT_EXECUTION_BINDING_REQUIRED');
  const snapshot = validateProjection(binding.snapshot), expected = canonical(snapshot), check = binding.assertUnchanged.bind(binding);
  const assertUnchanged = () => {
    if (canonical(validateProjection(check())) !== expected) throw failure('PROJECT_EXECUTION_BINDING_CHANGED');
    return snapshot;
  };
  assertUnchanged();
  return Object.freeze({ snapshot, assertUnchanged });
}
