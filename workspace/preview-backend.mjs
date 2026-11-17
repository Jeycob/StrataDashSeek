import path from 'node:path';
import {runtimeRequire} from '../runtime/require.cjs';

// Preparation only, no target execution and no backend selection override.
// Accept only the actual installed Landlock launcher's returned argv; bwrap
// and arbitrary configured runners keep ordinary background execution.
export async function sameHostCustodyBackend(ctx,policy,signal){
 if(typeof ctx.sandbox?.confine!=='function')return false;
 try{
  const {launcherPath}=runtimeRequire('@deepseek-ai/node-addon-system/landlock-run');
  const argv=['bash','-c',':'],prepared=await ctx.sandbox.confine(argv,policy,signal);signal.throwIfAborted();
  if(!Array.isArray(prepared?.argv)||prepared.argv.length<5||prepared.argv.slice(-4).join('\0')!==['--',...argv].join('\0'))return false;
  return path.isAbsolute(prepared.argv[0])&&prepared.argv[0]===launcherPath();
 }catch(error){signal.throwIfAborted();return false;}
}
