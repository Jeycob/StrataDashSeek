import { WorkbenchError } from './policy.mjs';
import { retainHeavyToolLease } from '../efficiency/heavy-tool-lease.mjs';
import {launchFor,custodyReader} from './project-custody.mjs';

export const DEFAULT_PROJECT_JOB_LIFETIME_MS = 300000;
export const MAX_PROJECT_JOB_LIFETIME_MS = 600000;
export const projectJobLifetime = timeoutMs => Math.min(MAX_PROJECT_JOB_LIFETIME_MS, Math.max(1000, timeoutMs ?? DEFAULT_PROJECT_JOB_LIFETIME_MS));
const evidenceId=value=>typeof value==='string'&&/^[\x21-\x7e]{1,256}$/.test(value)?value:null;
export const projectBackgroundSchema = { type: 'object', properties: { kind: { type: 'string', const: 'background' }, jobId: { type: 'string' }, cwd: { type: 'string' } }, required: ['kind', 'jobId', 'cwd'], additionalProperties: false };
export function renderProjectBackground(args, value) {
  return [{ type: 'text', text: `Started background job ${value.jobId}. Maximum lifetime: ${projectJobLifetime(args.timeoutMs)}ms. Read status/logs with job_output or job_list; stop this owned job with job_kill. Other build/test commands wait while this job runs: run those checks before starting a long-lived server, or stop this job first. Do not use nohup, setsid or process-name kills.` }];
}

// Only SDK-owned handles are retained. Never discover/adopt arbitrary PIDs or
// use a process name as an authority to signal another program.
export function createProjectProcessStarter(ctx, { setTimer = setTimeout, clearTimer = clearTimeout, execute = spec => ctx.shell.execute(spec), assertActive = () => {} } = {}) {
  const active = new Map(); let disposed = false;
  async function dispose() {
    if (disposed && active.size === 0) return;
    disposed = true;
    const entries = [...active.values()];
    for (const entry of entries) {
      try { entry.jobs.kill(entry.id, entry.owner, 'project executor disposed'); }
      catch { entry.cancel('project executor disposed'); }
    }
    await Promise.all(entries.map(entry => entry.done));
  }
  ctx.effect?.(() => dispose, 'managed project background processes');

  async function start({ cwd, spec, adaptations = [], hardDeadline }, execution, args) {
    assertActive();
    execution.signal.throwIfAborted();
    if (disposed) throw new WorkbenchError('PROJECT_EXECUTOR_DISPOSED', 'Project command execution is shutting down.');
    const owner = execution.agent?.id;
    const call=Object.freeze({callId:evidenceId(execution.callId),rootCallId:evidenceId(execution.rootCallId??execution.callId),toolName:evidenceId(execution.name)});
    if (!owner) throw new WorkbenchError('PROJECT_JOB_OWNER_REQUIRED', 'Background commands require their executing conversation.');
    const jobs = typeof ctx.get === 'function' ? ctx.get('jobs') : ctx.jobs;
    if (!jobs || typeof jobs.start !== 'function') throw new WorkbenchError('PROJECT_JOBS_UNAVAILABLE', 'Background commands require the SDK job registry and job_output/job_kill controller. Use a bounded foreground command until they are available.', 503);
    const admittedAt=Date.now();
    if(hardDeadline!==undefined&&(!Number.isSafeInteger(hardDeadline)||hardDeadline-admittedAt<1000))throw new WorkbenchError('PROJECT_CUSTODY_DEADLINE','Original job lifetime has expired.');
    const lifetimeMs = Math.min(projectJobLifetime(args.timeoutMs),hardDeadline===undefined?Infinity:hardDeadline-admittedAt),expiresAt=Math.floor(admittedAt+lifetimeMs);
    const releaseAdmission = retainHeavyToolLease(execution);
    const launch=launchFor(spec);
    let resolveCapture,rejectCapture,identity,stdout;
    const captured=launch?new Promise((resolve,reject)=>{resolveCapture=resolve;rejectCapture=reject;}):null;
    void captured?.catch(()=>{});
    const controller = new AbortController(); let process, id, timer, done, settled = false, stopReason;
    const cancel = reason => {
      if (settled || controller.signal.aborted) return;
      stopReason = reason ?? 'project job cancelled';
      controller.abort(stopReason);
      process?.kill();
    };
    const abortBeforeCommit = () => cancel('tool call aborted before background ownership was committed');
    execution.signal.addEventListener('abort', abortBeforeCommit, { once: true });
    try {
      assertActive();
      execution.signal.throwIfAborted();
      id = jobs.start({
        kind: 'bash', owner, label: args.description.replace(/\s+/gu, ' ').slice(0, 240),
        toolCall: { callId: execution.callId, rootCallId: execution.rootCallId ?? execution.callId }, outputLimitBytes: 16000,
        output: ['stdout', 'stderr'].map(channel => ({ channel, read(fromByte) {
          return process === undefined || launch&&channel==='stdout'&&!stdout ? { text: '', nextOffset: fromByte, lossy: false } : (channel==='stdout'&&stdout?stdout:process.observed[channel]).readFrom(fromByte);
        } })),
        run(handle) {
          // Defer spawning until synchronous registry admission/commit completes.
          // Cancellation while admission runs then prevents even shell.execute.
          done = Promise.resolve().then(async () => {
            try {
              controller.signal.throwIfAborted();
              assertActive();
              for (const adaptation of adaptations) handle.append(adaptation + '\n', { channel: 'stdout' });
              process = await execute({ ...spec, onExpiry: 'none', timeoutMs: lifetimeMs, signal: controller.signal });
              if (controller.signal.aborted) process.kill();
              assertActive();
              if(launch){
                const reader=custodyReader(process,launch,{signal:controller.signal});stdout=reader.stdout;
                identity=await reader.ready;controller.signal.throwIfAborted();assertActive();resolveCapture(identity);
              }
              await process.done;
              const result = { exitCode: process.exitCode, signal: process.signal ?? null, lifetimeMs, lifetimeExpired: stopReason?.startsWith('project job lifetime limit') ?? false,
                ...(process.sandbox ? { sandbox: { mode: process.sandbox.mode, denied: Boolean(process.sandbox.denied), runnerFailed: Boolean(process.sandbox.runnerFailed) } } : {}) };
              const sandboxNote = process.sandbox?.runnerFailed ? '; sandbox runner failed before command execution' : process.sandbox?.denied ? '; sandbox denied file access' : '';
              return process.sandbox?.runnerFailed ? { status: 'failed', detail: 'sandbox runner failed before command execution', result } : process.status === 'killed'
                ? { status: 'killed', detail: (stopReason ?? (process.signal ? 'signal: ' + process.signal : 'killed before exit')) + sandboxNote, result }
                : { status: 'completed', detail: 'exit code: ' + process.exitCode + sandboxNote, result };
            } catch (error) {
              rejectCapture?.(error);
              // A failed preparation must release any handle it published.
              if (process) { process.kill(); await process.done; }
              return { status: controller.signal.aborted ? 'killed' : 'failed', detail: stopReason ?? (error instanceof Error ? error.message : String(error)) };
            } finally {
              rejectCapture?.(new WorkbenchError('PROJECT_CUSTODY_EXITED','Custody process is no longer active.'));
              settled = true; if (timer !== undefined) clearTimer(timer);
              if (id !== undefined) active.delete(id);
              releaseAdmission();
            }
          });
          return { done, cancel };
        },
      });
    } catch (error) {
      cancel('background registration did not commit');
      if (done) await done;
      releaseAdmission();
      throw error;
    } finally { execution.signal.removeEventListener('abort', abortBeforeCommit); }
    if (execution.signal.aborted) {
      try { jobs.kill(id, owner, 'tool call aborted before background acknowledgement'); }
      catch { cancel('tool call aborted before background acknowledgement'); }
      await done; execution.signal.throwIfAborted();
    }
    const entry = { id, owner, jobs, done, cancel, captured, launch, expiresAt,call,identity:()=>identity, current:()=>!settled&&!controller.signal.aborted&&process?.status==='running' }; active.set(id, entry);
    timer = setTimer(() => {
      if (settled) return;
      const reason = 'project job lifetime limit reached after ' + lifetimeMs + 'ms';
      try { jobs.kill(id, owner, reason); } catch { cancel(reason); }
    }, lifetimeMs);
    timer?.unref?.();
    return { kind: 'background', jobId: id, cwd };
  }
  async function custodyFor(id,owner,{signal}={}){
    const entry=active.get(id);
    if(!entry||entry.owner!==owner||!entry.captured)throw new WorkbenchError('PROJECT_CUSTODY_UNAVAILABLE','No private custody for this exact owned job.');
    let abort;
    const cancelled=signal?new Promise((_,reject)=>{
      abort=()=>{try{entry.jobs.kill(id,owner,'custody acknowledgement aborted');}catch{entry.cancel('custody acknowledgement aborted');}void entry.done.then(()=>reject(new WorkbenchError('PROJECT_CUSTODY_ABORTED','Custody acknowledgement aborted.')));};
      if(signal.aborted)abort();else signal.addEventListener('abort',abort,{once:true});
    }):null;
    try{
      await (cancelled?Promise.race([entry.captured,cancelled]):entry.captured);
      if(signal?.aborted)throw new WorkbenchError('PROJECT_CUSTODY_ABORTED','Custody acknowledgement aborted.');
      const assertCurrent=()=>{assertActive();if(active.get(id)!==entry||!entry.current())throw new WorkbenchError('PROJECT_CUSTODY_EXPIRED','Captured wrapper is no longer current.');};
      assertCurrent();return Object.freeze({jobId:id,owner,identity:entry.identity(),context:entry.launch.context,done:entry.done,assertCurrent,expiresAt:entry.expiresAt,restartSeed:entry.launch.restartSeed,call:entry.call});
    }catch(error){
      try{entry.jobs.kill(id,owner,'custody capture failed');}catch{entry.cancel('custody capture failed');}
      await entry.done;throw error;
    }finally{if(abort)signal.removeEventListener('abort',abort);}
  }
  function producerFor(id,owner){const entry=active.get(id);if(!entry||entry.owner!==owner||!entry.launch)throw new WorkbenchError('PROJECT_CUSTODY_UNAVAILABLE','No exact owned producer.');return Object.freeze({done:entry.done,expiresAt:entry.expiresAt,call:entry.call});}
  async function stopOwned(id,owner){const entry=active.get(id);if(!entry||entry.owner!==owner)throw new WorkbenchError('PROJECT_CUSTODY_UNAVAILABLE','No exact owned producer.');try{entry.jobs.kill(id,owner,'owned preview cleanup');}catch{entry.cancel('owned preview cleanup');}await entry.done;}
  return { start, dispose, custodyFor,producerFor,stopOwned };
}
