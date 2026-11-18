import {isMain} from '../runtime/require.cjs';
import {readJson,validateContract,digest,confined} from './core.mjs';
import {validatePlan,resolveBaseURL} from './browser.mjs';
import {validateBrowserServer} from './browser-server-contract.mjs';
import {safeInspectionCode} from './browser-server-diagnostic.mjs';

// Executed by the existing confined SDK project runner, never a host fs read
// of a model-supplied command. The host compares these exact contract hashes.
export async function inspectBrowserServer({workspace,contractPath,checkId,env=process.env}){
  const contract=validateContract(await readJson(workspace,contractPath));
  const check=contract.checks.find(c=>c.id===checkId);
  if(check?.kind!=='browser'||!check.server)throw Object.assign(Error('No explicit browser server on this check.'),{code:'BROWSER_SERVER_UNDECLARED'});
  const server=validateBrowserServer(check.server),plan=validatePlan(await readJson(workspace,check.plan));
  if(!env.HARNESS_QUALITY_ALLOWED_PORTS)throw Object.assign(Error('Assigned project ports are required.'),{code:'BROWSER_SERVER_PORTS_UNAVAILABLE'});
  const base=resolveBaseURL(plan.baseURL,{...env,...check.env});
  if(base.hostname!=='127.0.0.1')throw Object.assign(Error('Owned peer attribution requires the exact IPv4 loopback endpoint.'),{code:'BROWSER_SERVER_IPV4_REQUIRED'});
  await confined(workspace,check.cwd??'.');
  return{checkId,contractHash:digest(JSON.stringify(contract)),planHash:digest(JSON.stringify(plan)),server,cwd:check.cwd??'.',env:check.env??{},port:Number(base.port||(base.protocol==='https:'?443:80))};
}
if(isMain(import.meta.url)){
  try{
    const [workspace,contractPath,checkId,...rest]=process.argv.slice(2);
    if(!workspace||!contractPath||!checkId||rest.length)throw Error('Invalid browser server inspection arguments.');
    console.log(JSON.stringify(await inspectBrowserServer({workspace,contractPath,checkId})));
  }catch(error){console.log(JSON.stringify({code:safeInspectionCode(error.code)}));process.exitCode=1;}
}
