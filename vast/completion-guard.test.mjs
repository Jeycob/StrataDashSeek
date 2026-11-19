import test from 'node:test';
import assert from 'node:assert/strict';
import { apply, isProgressOnly, shouldContinue } from './completion-guard.mjs';

const message = text => ({ content: [{ type: 'text', text }], source: { provider: 'strata-vast', replayState: { response: { stopReason: 'stop' } } } });
const state = () => ({ turn: 1, tools: 1, lastToolFailed: false, continuations: 0, message: message('Now the stylesheet.') });
const options = () => ({ turn: 1, signal: new AbortController().signal, inbox: { nextStep: [], nextTurn: [] }, providers: new Set(['strata-vast']), maxContinuations: 2 });
const probeProgress = 'WebGL2 funguje i v headless Chromium (SwiftShader) — můžu tedy ověřit render reálnými screenshoty. Teď napíšu samotnou hru.';

test('recognizes the observed premature ending and short action promises', () => {
  for (const text of ['Now the stylesheet.', 'Next the tests.', "I'll now add the stylesheet.", 'Let me run the tests.', 'Teď doplním styly.']) assert.equal(isProgressOnly(text), true, text);
});
test('does not turn ordinary answers, finished work or blockers into extra work', () => {
  for (const text of ['Now the stylesheet is complete.', 'Done. All tests passed.', 'Next steps: deploy this when ready.', "I'll need your permission.", 'Let me explain the design.', 'Teď potřebuji souhlas.', 'Now the stylesheet?', 'Use CSS for styling.', '', 'I will add '+ 'details '.repeat(50)]) assert.equal(isProgressOnly(text), false, text);
});
test('recognizes a final action promise after a short successful probe report', () => {
  for (const text of [probeProgress, "WebGL2 works in headless Chromium. I'll now write the game.", 'The renderer works.\nLet me implement the controls.', 'WebGL2 funguje.\n\nTeď napíšu samotnou hru.']) assert.equal(isProgressOnly(text), true, text);
});
test('a progress preface cannot hide completion, a blocker, quotation or a conditional offer', () => {
  for (const text of [
    "The requested game is finished. I'll add more levels.",
    'The requested game is ready. I will add more levels.',
    "The app was delivered. I'll add another feature.",
    'The issue is resolved. Let me create a new module.',
    'Hra je hotová. Teď přidám další úrovně.',
    'WebGL funguje, ale potřebuji souhlas. Teď napíšu samotnou hru.',
    'WebGL works? Teď napíšu samotnou hru.',
    'The remaining step is: "Teď napíšu samotnou hru."',
    "The log says 'Ready. Teď napíšu samotnou hru.'",
    'The log says: “Ready. Teď napíšu samotnou hru.”',
    'WebGL works.\n> Teď napíšu samotnou hru.',
    'WebGL works. `Teď napíšu samotnou hru.`',
    "The app is ready at http://localhost:3000. I'll run more tests.",
    "WebGL works. I'll write the game if requested.",
    'WebGL funguje. Teď napíšu hru, pokud budeš chtít.',
    "WebGL works. I'll write it tomorrow.",
    "WebGL works. I'll create it after approval.",
    'WebGL funguje. Teď napíšu hru. Zde je výsledek.',
    'Details '.repeat(40) + '. Teď napíšu hru.',
  ]) assert.equal(isProgressOnly(text), false, text);
});
test('requires successful tools, explicit stop and the configured model provider', () => {
  assert.equal(shouldContinue(state(), options()), true);
  for (const change of [{ tools: 0 }, { lastToolFailed: true }, { turn: 2 }, { continuations: 2 }, { hitTokenLimit: true }]) assert.equal(shouldContinue({ ...state(), ...change }, options()), false);
  for (const change of [{ provider: 'deepseek' }, { replayState: { response: { stopReason: 'length' } } }]) assert.equal(shouldContinue({ ...state(), message: { ...message('Now the stylesheet.'), source: { ...message('').source, ...change } } }, options()), false);
});
test('honors user cancellation, queued input and actual tool calls', () => {
  const aborted = AbortSignal.abort();
  for (const change of [{ signal: aborted }, { inbox: { nextStep: [{}], nextTurn: [] } }, { inbox: { nextStep: [], nextTurn: [{}] } }]) assert.equal(shouldContinue(state(), { ...options(), ...change }), false);
  assert.equal(shouldContinue({ ...state(), message: { ...message('Now the stylesheet.'), content: [{ type: 'tool-call' }] } }, options()), false);
});

test('accepts SDK reasoning with progress text but never classifies hidden reasoning as the answer', () => {
  const reasoning = { type: 'reasoning', text: 'Done. Synthetic hidden reasoning; not a user-visible completion.' };
  const check = content => shouldContinue({ ...state(), message: { ...message(probeProgress), content } }, options());
  const text = { type: 'text', text: probeProgress };
  assert.equal(check([reasoning, text]), true);
  assert.equal(check([text]), true);
  for (const content of [
    [{ type: 'reasoning', text: probeProgress }],
    [reasoning, { type: 'text', text: 'Done. The game is complete.' }],
    ...[null, {}, { type: 'reasoning' }, { type: 'reasoning', text: 42 }, { type: 'text' },
      { type: 'tool-call' }, { type: 'image' }, { type: 'file' }, { type: 'unknown', text: 'metadata' }].map(block => [block, text]),
    { length: 1 },
  ]) assert.equal(check(content), false, JSON.stringify(content));
});
test('the observed probe response still honors every runtime continuation gate', () => {
  const observed = { ...state(), message: message(probeProgress) };
  assert.equal(shouldContinue(observed, options()), true);
  for (const change of [{ tools: 0 }, { lastToolFailed: true }, { turn: 2 }, { continuations: 2 }, { hitTokenLimit: true }]) assert.equal(shouldContinue({ ...observed, ...change }, options()), false);
  for (const change of [{ signal: AbortSignal.abort() }, { inbox: { nextStep: [{}], nextTurn: [] } }, { inbox: { nextStep: [], nextTurn: [{}] } }]) assert.equal(shouldContinue(observed, { ...options(), ...change }), false);
  for (const change of [{ provider: 'deepseek' }, { replayState: { response: { stopReason: 'length' } } }]) assert.equal(shouldContinue({ ...observed, message: { ...observed.message, source: { ...observed.message.source, ...change } } }, options()), false);
  assert.equal(shouldContinue({ ...observed, message: { ...observed.message, content: [{ type: 'tool-call' }] } }, options()), false);
});
for (const progress of ['Now the stylesheet.', probeProgress]) test('same-turn steering is capped, isolated and reset: ' + progress.slice(0, 24), () => {
  const hooks = new Map(), session = { id: 'test-a' }, other = { id: 'test-b' }, steers = [];
  apply({ on(type, fn) { hooks.set(type, fn); } });
  const observe = hooks.get('session/event'), stop = hooks.get('agent/turn-stopping');
  const agent = { session, inbox: options().inbox, steer(x) { steers.push(x); } };
  const tool = turn => observe(session, { type: 'tool/result', data: { turn, message: { isError: false } } });
  const answer = turn => observe(session, { type: 'assistant/message', data: { turn, message: message(progress) } });
  tool(1); answer(1);
  stop({ agent: { ...agent, session: other }, turn: 1 }); assert.equal(steers.length, 0);
  for (let i = 0; i < 4; i++) { answer(1); stop({ agent, turn: 1 }); }
  assert.equal(steers.length, 2); assert.notEqual(steers[0].id, steers[1].id);
  assert.equal(steers[0].source.kind, 'homeai-completion-guard'); assert.match(steers[1].content[0].text, /2\/2/);
  observe(session, { type: 'turn/end', data: { turn: 1 } });
  stop({ agent, turn: 1 }); assert.equal(steers.length, 2);
  tool(2); answer(2); stop({ agent, turn: 2 }); assert.equal(steers.length, 3);
});
