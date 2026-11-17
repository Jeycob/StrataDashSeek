// Root qualification fixture only. Always call the real SDK probe before pinning.
export function pinRealLandlock(sandbox){
 const fail=code=>{throw Object.assign(Error(code),{code});};
 if(!sandbox?.internals||typeof sandbox.probeRunner!=='function'||sandbox.selectedRunner!==undefined)fail('PEER_FIXTURE_FRESH_BACKEND_REQUIRED');
 const verdict=sandbox.probeRunner('landlock');
 if(!['full','partial'].includes(verdict))fail('PEER_FIXTURE_LANDLOCK_UNAVAILABLE');
 // A single SDK chain candidate skips automatic probes; the explicit real
 // probe above is therefore required. Never install a fake probe callback.
 sandbox.internals.chain=['landlock'];
 return verdict;
}
