import test from 'node:test';
import assert from 'node:assert/strict';
import { apply, isProgressOnly, shouldContinue } from './completion-guard.mjs';

const message = text => ({ content: [{ type: 'text', text }], source: { provider: 'strata-vast', replayState: { response: { stopReason: 'stop' } } } });
const state = () => ({ turn: 1, tools: 1, lastToolFailed: false, continuations: 0, message: message('Now the stylesheet.') });
const options = () => ({ turn: 1, signal: new AbortController().signal, inbox: { nextStep: [], nextTurn: [] }, providers: new Set(['strata-vast']), maxContinuations: 2 });

test('recognizes the observed premature ending and short action promises', () => {
  for (const text of ['Now the stylesheet.', 'Next the tests.', "I'll now add the stylesheet.", 'Let me run the tests.', 'Teď doplním styly.']) assert.equal(isProgressOnly(text), true, text);
});
test('does not turn ordinary answers, finished work or blockers into extra work', () => {
  for (const text of ['Now the stylesheet is complete.', 'Done. All tests passed.', 'Next steps: deploy this when ready.', "I'll need your permission.", 'Let me explain the design.', 'Teď potřebuji souhlas.', 'Now the stylesheet?', 'Use CSS for styling.', '', 'I will add '+ 'details '.repeat(50)]) assert.equal(isProgressOnly(text), false, text);
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
test('same-turn steering is capped, isolated by session, and reset for a later turn', () => {
  const hooks = new Map(), session = { id: 'test-a' }, other = { id: 'test-b' }, steers = [];
  apply({ on(type, fn) { hooks.set(type, fn); } });
  const observe = hooks.get('session/event'), stop = hooks.get('agent/turn-stopping');
  const agent = { session, inbox: options().inbox, steer(x) { steers.push(x); } };
  const tool = turn => observe(session, { type: 'tool/result', data: { turn, message: { isError: false } } });
  const answer = turn => observe(session, { type: 'assistant/message', data: { turn, message: message('Now the stylesheet.') } });
  tool(1); answer(1);
  stop({ agent: { ...agent, session: other }, turn: 1 }); assert.equal(steers.length, 0);
  for (let i = 0; i < 4; i++) { answer(1); stop({ agent, turn: 1 }); }
  assert.equal(steers.length, 2); assert.notEqual(steers[0].id, steers[1].id);
  assert.equal(steers[0].source.kind, 'homeai-completion-guard'); assert.match(steers[1].content[0].text, /2\/2/);
  observe(session, { type: 'turn/end', data: { turn: 1 } });
  stop({ agent, turn: 1 }); assert.equal(steers.length, 2);
  tool(2); answer(2); stop({ agent, turn: 2 }); assert.equal(steers.length, 3);
});
