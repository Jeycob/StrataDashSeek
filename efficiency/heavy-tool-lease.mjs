// The SDK passes the same scheduler-owned execution to middleware and the
// actual tool body. Keep lifetime bookkeeping outside its public JSON value.
const leases = new WeakMap();

export function bindHeavyToolLease(execution, permit, onSettled = () => {}) {
  if (leases.has(execution)) throw new Error('Heavy tool lease already bound');
  let holders = 1, released = false;
  const retain = () => {
    if (released) throw new Error('Heavy tool lease already settled');
    holders++;
    return holder();
  };
  function holder() {
    let done = false;
    return () => {
      if (done) return;
      done = true;
      if (--holders !== 0) return;
      released = true;
      leases.delete(execution);
      try { onSettled(); } finally { permit.release(); }
    };
  }
  leases.set(execution, { retain });
  return holder();
}

// An explicit background job retains the existing admission, never asks for a
// second permit while holding the first. Release only after process.done.
export function retainHeavyToolLease(execution) {
  return leases.get(execution)?.retain() ?? (() => {});
}
