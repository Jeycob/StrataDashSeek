import test from 'node:test';
import assert from 'node:assert/strict';
import {boundedJSON} from './request-json.mjs';

const bytes = value => new TextEncoder().encode(value);
function streamed(chunks, headers = {}) {
  let cancelled = false;
  const request = new Request('https://fixture.invalid/login', {method: 'POST', headers, duplex: 'half',
    body: new ReadableStream({pull(controller) { if (chunks.length) controller.enqueue(chunks.shift()); else controller.close(); }, cancel() { cancelled = true; }})});
  return {request, cancelled: () => cancelled};
}
test('JSON split inside a multibyte character decodes only after bounded byte collection', async () => {
  const encoded = bytes('{"name":"žluťoučký"}');
  const {request} = streamed([...encoded].map(value => Uint8Array.of(value)));
  assert.deepEqual(await boundedJSON(request, {maxBytes: encoded.length}), {name: 'žluťoučký'});
});
test('undeclared and falsely small declared streams are bounded in bytes and cancelled', async () => {
  for (const headers of [{}, {'content-length': '1'}]) {
    const fixture = streamed([bytes('"'), bytes('ž'.repeat(512)), bytes('ignored')], headers);
    await assert.rejects(boundedJSON(fixture.request), {status: 413, code: 'BODY_TOO_LARGE'});
    assert.equal(fixture.cancelled(), true);
  }
});
test('an oversized declaration is rejected without pulling the source', async () => {
  let pulled = 0, cancelled = false;
  const request = {headers: new Headers({'content-length': '1025'}), body: new ReadableStream({pull() { pulled++; }, cancel() {cancelled = true;}}, {highWaterMark: 0})};
  await assert.rejects(boundedJSON(request), {status: 413});
  assert.equal(pulled, 0); assert.equal(cancelled, true);
});
test('empty, malformed JSON and invalid UTF-8 are client errors', async () => {
  for (const chunks of [[], [bytes('{')], [Uint8Array.of(0xff)]]) {
    await assert.rejects(boundedJSON(streamed(chunks).request), {status: 400, code: 'INVALID_JSON'});
  }
});
test('a stalled stream times out even if its cancellation hook never resolves', async () => {
  let cancelled = false;
  const request = {headers: new Headers(), body: new ReadableStream({cancel() { cancelled = true; return new Promise(() => {}); }})};
  await assert.rejects(boundedJSON(request, {timeoutMs: 20}), {status: 408, code: 'BODY_TIMEOUT'});
  assert.equal(cancelled, true);
});
test('an aborted request cancels its pending read', async () => {
  const controller = new AbortController(); let cancelled = false;
  const request = {headers: new Headers(), signal: controller.signal, body: new ReadableStream({cancel() {cancelled = true;}})};
  const pending = boundedJSON(request); controller.abort();
  await assert.rejects(pending, {status: 408, code: 'BODY_ABORTED'});
  assert.equal(cancelled, true);
});
