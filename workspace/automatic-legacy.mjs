// Migration of the reviewed legacy ACK contract (including e782): its captured
// SDK batch promise drains all started tool bodies. ACK says nothing about QA.
const call=value=>typeof value==='string'&&/^automatic-review-[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(value);
const terminal=new Set(['completed','failed','killed']);
export async function reconcileLegacyAutomatic(manager,id,bound){
 const record=manager.data.sessions[id],budget=manager.budgets.get(id),a=budget?.automatic,agent=manager.ctx.agents.get(id),callId=a?.activeCallId;
 if(!a||a.operation||!a.uncertain||a.terminalAcknowledged!==true||!call(callId)||a.version!==1||a.lastAutomaticOutcome||budget.blocked?.code!=='AUTOMATIC_VERIFICATION_UNCERTAIN')return false;
 const current=()=>manager.data.sessions[id]===record&&manager.budgets.get(id)===budget&&budget.automatic===a&&a.activeCallId===callId&&a.uncertain&&budget.blocked?.code==='AUTOMATIC_VERIFICATION_UNCERTAIN'&&a.terminalAcknowledged===true&&!manager.automaticInFlight?.has(id)&&manager.ctx.agents.get(id)===agent;
 if(!current()||agent?.status!=='idle'||manager.ownerAgent(agent)!==agent)return false;
 if(!await bound(manager.resultWork.get(id)??Promise.resolve(),Date.now()+1000)||!current())return false;
 const jobs=manager.ctx.jobs??manager.ctx.get?.('jobs');
 if(typeof jobs?.list!=='function'||!Array.isArray(agent.inbox?.nextTurn)||!Array.isArray(agent.inbox?.nextStep)||agent.inbox.nextTurn.length||agent.inbox.nextStep.length)return false;
 manager.execution.assertUnchanged();const root=record.root,rows=jobs.list(id);
 if(!Array.isArray(rows)||rows.length>128||rows.some(row=>row.owner===id&&!terminal.has(row.status))||!current()||record.root!==root)return false;
 manager.execution.assertUnchanged();
 // Separate NEGATIVE audit entry, never a fabricated final observer receipt.
 a.legacyRecovery={version:1,contract:'captured-sdk-batch-terminal-ack-v1',ownerId:id,root,callId,outcome:'TERMINAL_OUTCOME_UNKNOWN',at:Date.now(),verificationState:'required'};
 record.budget=budget;if(!await bound(manager.save(),Date.now()+1000)||!current()||record.root!==root||agent.status!=='idle'||agent.inbox.nextTurn.length||agent.inbox.nextStep.length||jobs.list(id).some(row=>row.owner===id&&!terminal.has(row.status)))return false;
 delete a.uncertain;delete a.activeCallId;delete a.reason;budget.blocked=null;a.phase='working';
 // nextCheckAt and all counters/proofs/errors/history/files stay unchanged.
 a.recovery={state:'reconciling',code:'AUTOMATIC_LEGACY_FRESH_VERIFICATION_REQUIRED',canContinue:false};
 return bound(manager.save(),Date.now()+1000);
}
