// A supervisor supplies a process generation and an admission fence. No provider credentials here.
const idleMs = 300_000;
const maxGapMs = 15_000;
const model = 'inkling-2-mini';
const metricTypes = new Map([
  ['basalt_requests_running', 'gauge'], ['basalt_requests_waiting', 'gauge'],
  ['basalt_requests_finished_total', 'counter'], ['basalt_generation_tokens_total', 'counter'],
]);

export function parseBasaltMetrics(text) {
  if (typeof text !== 'string' || text.length > 1024 * 1024) throw Error('Invalid Basalt metrics response');
  const types = new Map(), series = new Map();
  const finished = new Map();
  for (const line of text.split(/\r?\n/)) {
    const declaration = /^# TYPE (\S+) (\S+)$/.exec(line);
    if (declaration && metricTypes.has(declaration[1])) {
      if (types.has(declaration[1]) || declaration[2] !== metricTypes.get(declaration[1])) throw Error('Invalid metric type');
      types.set(declaration[1], declaration[2]);
      continue;
    }
    const name = line.split(/[\s{]/, 1)[0];
    if (!metricTypes.has(name)) continue;
    const match = /^\w+\{([^{}]+)\}\s+(\d+(?:\.\d+)?(?:[Ee][+-]?\d+)?)$/.exec(line);
    if (!match || !Number.isSafeInteger(Number(match[2]))) throw Error('Invalid Basalt counter or gauge');
    const labels = new Map();
    for (const part of match[1].split(',')) {
      const pair = /^(\w+)="([^"\\]+)"$/.exec(part);
      if (!pair || labels.has(pair[1])) throw Error('Invalid metric labels');
      labels.set(pair[1], pair[2]);
    }
    if (labels.get('model_name') !== model) throw Error('Unexpected Basalt model');
    const value = Number(match[2]);
    if (name === 'basalt_requests_finished_total') {
      const reason = labels.get('finished_reason');
      if (!reason || labels.size !== 2 || finished.has(reason)) throw Error('Invalid Basalt completion series');
      finished.set(reason, value);
    } else {
      if (labels.size !== 1 || series.has(name)) throw Error('Invalid Basalt model series');
      series.set(name, value);
    }
  }
  for (const name of metricTypes.keys()) {
    if (!types.has(name) || (name !== 'basalt_requests_finished_total' && !series.has(name))) throw Error('Incomplete Basalt metrics');
  }
  const tokens = series.get('basalt_generation_tokens_total');
  if (!finished.size && tokens !== 0) throw Error('Missing Basalt completion series');
  const completed = [...finished.values()].reduce((a, b) => a + b, 0);
  if (!Number.isSafeInteger(completed)) throw Error('Invalid completion total');
  return { completed, tokens, busy: series.get('basalt_requests_running') > 0 || series.get('basalt_requests_waiting') > 0 };
}

export async function readBasaltMetrics(signal) {
  const response = await fetch('http://127.0.0.1:8080/metrics?format=prometheus', { signal, redirect: 'error', cache: 'no-store' });
  if (!response.ok) throw Error('Basalt metrics unavailable');
  return parseBasaltMetrics(await response.text());
}

// readGeneration is the supervisor's fresh identity for the instance, boot and both service incarnations.
export function createLabObserver({ activity, readGeneration }) {
  return async signal => {
    const generation = await readGeneration(signal);
    const [native, engine] = await Promise.all([activity.read(signal), readBasaltMetrics(signal)]);
    if (await readGeneration(signal) !== generation) throw Error('Lab services changed during observation');
    signal.throwIfAborted();
    return { generation, native, engine };
  };
}

// Call tick every five seconds. tryFence must close every work ingress while still allowing observations.
// The lease must survive until the provider transition is reconciled; see idle-stop.md.
export function createIdleGuard({ observe, tryFence, now = () => performance.now() }) {
  let prior, since, last;
  let checking = false, attempted = false;
  function reset() { prior = since = last = undefined; }
  async function sample() {
    const started = now();
    const state = await observe(AbortSignal.timeout(4000));
    const at = now();
    const { generation, native, engine } = state ?? {};
    if (!Number.isFinite(started) || !Number.isFinite(at) || at < started || at - started > 5000 ||
        typeof generation !== 'string' || !generation || typeof native?.epoch !== 'string' || !native.epoch ||
        typeof native.busy !== 'boolean' || typeof engine?.busy !== 'boolean' ||
        ![native.revision, engine.completed, engine.tokens].every(n => Number.isSafeInteger(n) && n >= 0)) {
      throw Error('Invalid idle observation');
    }
    return { at, generation, busy: native.busy || engine.busy,
      key: JSON.stringify([generation, native.epoch, native.revision, engine.completed, engine.tokens]) };
  }
  return {
    async tick() {
      if (attempted) return 'stop-outcome-pending';
      if (checking) return 'sampling';
      checking = true;
      try {
        const current = await sample();
        if (current.busy) { reset(); return 'busy'; }
        if (prior !== current.key || last === undefined || current.at < last || current.at - last > maxGapMs) {
          since = current.at;
        }
        prior = current.key;
        last = current.at;
        if (last - since < idleMs) return 'countdown';
        if (!tryFence) return 'idle-without-fence';
        const lease = await tryFence(current.generation, AbortSignal.timeout(4000));
        if (!lease) { reset(); return 'admission-open'; }
        let committed = false;
        try {
          const final = await sample();
          if (final.busy || final.key !== current.key || final.at < last || final.at - last > maxGapMs) {
            reset();
            return 'changed-during-drain';
          }
          // A timeout can follow a successful provider request. Never submit a second stop here.
          attempted = committed = true;
          await lease.commitStop();
          return 'stop-submitted';
        } finally {
          if (!committed) await lease.reopen();
        }
      } catch {
        reset();
        return attempted ? 'stop-outcome-pending' : 'unknown';
      } finally { checking = false; }
    },
  };
}
