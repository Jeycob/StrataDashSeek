const quote=value=>"'"+value.replaceAll("'","'\\''")+"'";
const fail=code=>Object.assign(Error(code),{code});
export function installProjectVerification(ctx,manager,runProjectCommand){
 ctx.on('workspace-runtime/verify-command',async({kind,execution,projectRoot,sourceHash})=>{
  execution.signal.throwIfAborted();
  if(!['all','build','test','browser','acceptance'].includes(kind))throw fail('INVALID_VERIFICATION_KIND');
  const owner=manager.ownerAgent(execution.agent),record=manager.data.sessions[owner?.id];
  if(!record||record.legacy||record.nativeWorktree||record.independentRepository!==true||record.root!==projectRoot)throw fail('PROJECT_RUNTIME_NOT_ISOLATED');
  const review=await manager.review(owner.id);
  if(!sourceHash||review?.sourceHash!==sourceHash)throw fail('STALE_VERIFICATION');
  if(!Array.isArray(record.ports)||record.ports.length!==4||record.ports.some(p=>!Number.isInteger(p)||p<1024||p>65535))throw fail('PROJECT_RUNTIME_PORTS_INVALID');
  const command='HARNESS_QUALITY_ALLOWED_PORTS='+quote(record.ports.join(','))+' exec '+['/opt/code-server/lib/node','/opt/homeai/quality/cli.mjs','verify','--workspace','/workspace','--kind',kind].map(quote).join(' ');
  return runProjectCommand({command,description:'Verify isolated project '+kind,workdir:'.',timeoutMs:120000},execution);
 },{global:true});
}
