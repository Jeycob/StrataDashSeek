import {createHash} from 'node:crypto';
// This is only the protected browser-server inspector's failure envelope.
// Never relay raw project commands, environment, stderr messages or paths.
const FALLBACK='BROWSER_SERVER_INSPECTION_FAILED',LIMIT=1024;
const CODES=new Set(['BROWSER_SERVER_INSPECTION_FAILED','BROWSER_SERVER_UNDECLARED','BROWSER_SERVER_PORTS_UNAVAILABLE','BROWSER_SERVER_IPV4_REQUIRED',
 'INVALID_PATH','OUTSIDE_PROJECT','SYMLINK_REFUSED','INVALID_JSON_FILE','INVALID_CONTRACT','INVALID_CHECK','INVALID_BROWSER_CHECK','INVALID_COMMAND','INVALID_TIMEOUT','INVALID_ENV','INVALID_ARTIFACTS','MISSING_REQUIRED_CHECK',
 'INVALID_BROWSER_SERVER','SHELL_REFUSED','INVALID_BROWSER_URL','PORT_UNAVAILABLE','UNASSIGNED_PORT','INVALID_BROWSER_PLAN','INVALID_VIEWPORT','INVALID_FLOW','EMPTY_BROWSER_FLOW','INVALID_BROWSER_ACTION','INVALID_SELECTOR','INVALID_ROUTE','INVALID_BROWSER_VALUE','EMPTY_ASSERTION','INVALID_ASSERTION','INVALID_SCREENSHOT','SCREENSHOT_REQUIRED',
 'ENOENT','EACCES','EPERM','ENOTDIR','EISDIR','ELOOP','ERR_INVALID_URL']);
const STDERR_CODES=['ERR_MODULE_NOT_FOUND','MODULE_NOT_FOUND','ERR_PACKAGE_PATH_NOT_EXPORTED','ERR_REQUIRE_ESM','ERR_UNKNOWN_FILE_EXTENSION','ERR_ACCESS_DENIED','ENOENT','EACCES','EPERM','SyntaxError','TypeError','ReferenceError'];
export const safeInspectionCode=code=>CODES.has(code)?code:FALLBACK;
function stream(value){
 const available=typeof value?.text==='string',text=available?value.text:'',prefix=Buffer.from(text.slice(0,LIMIT+1)).subarray(0,LIMIT);
 return{available,retainedBytes:prefix.length,retainedSha256:createHash('sha256').update(prefix).digest('hex'),truncated:typeof value?.truncated==='boolean'?value.truncated:null,detailTruncated:text.length>LIMIT||Buffer.byteLength(text)>LIMIT};
}
function detail(code,stderrCodes){
 const message=code==='BROWSER_SERVER_PORTS_UNAVAILABLE'?'Assigned project port metadata is unavailable to the inspector.':code==='BROWSER_SERVER_IPV4_REQUIRED'?'The inspector requires the exact assigned IPv4 loopback endpoint.':code==='BROWSER_SERVER_UNDECLARED'?'This check does not declare an owned browser server.':code===FALLBACK?'Inspector did not return a complete successful inspection.':'Inspector rejected its input: '+code+'.';
 return message+(stderrCodes.length?' Stderr identifiers: '+stderrCodes.join(', ')+'.':'');
}
export function readInspectionDiagnostic(value){
 const known=(v,keys)=>v&&typeof v==='object'&&!Array.isArray(v)&&Object.keys(v).sort().join(',')===[...keys].sort().join(',');
 if(!known(value,['version','code','exitCode','timedOut','aborted','stdout','stderr','stderrCodes','detail'])||value.version!==1||!CODES.has(value.code)||!(value.exitCode===null||Number.isInteger(value.exitCode)&&value.exitCode>=-4095&&value.exitCode<=255)||typeof value.timedOut!=='boolean'||typeof value.aborted!=='boolean'||!Array.isArray(value.stderrCodes)||value.stderrCodes.length>4||new Set(value.stderrCodes).size!==value.stderrCodes.length||value.stderrCodes.some(code=>!STDERR_CODES.includes(code)))return;
 const streams={};
 for(const name of ['stdout','stderr']){
  const s=value[name];if(!known(s,['available','retainedBytes','retainedSha256','truncated','detailTruncated'])||typeof s.available!=='boolean'||!Number.isInteger(s.retainedBytes)||s.retainedBytes<0||s.retainedBytes>LIMIT||typeof s.retainedSha256!=='string'||!/^[a-f0-9]{64}$/.test(s.retainedSha256)||!(s.truncated===null||typeof s.truncated==='boolean')||typeof s.detailTruncated!=='boolean')return;
  streams[name]={...s};
 }
 // Reconstruct the detail, even for an authenticated reply. It is not free text.
 return{version:1,code:value.code,exitCode:value.exitCode,timedOut:value.timedOut,aborted:value.aborted,...streams,stderrCodes:[...value.stderrCodes],detail:detail(value.code,value.stderrCodes)};
}
export function browserServerInspection(result){
 const text=result?.stdout?.text;let data;
 if(typeof text==='string'&&text.length<=32768&&Buffer.byteLength(text)<=32768&&!result.stdout.truncated)try{data=JSON.parse(text);}catch{}
 if(result?.exitCode===0&&!result.timedOut&&!result.aborted&&!result.stdout?.truncated&&!result.stderr?.truncated&&data&&typeof data==='object'&&!Array.isArray(data)&&!Object.hasOwn(data,'code'))return data;
 const code=data&&Object.keys(data).length===1?safeInspectionCode(data.code):FALLBACK;
 const stderrText=typeof result?.stderr?.text==='string'?result.stderr.text.slice(0,LIMIT):'';
 const stderrCodes=STDERR_CODES.filter(code=>new RegExp('\\b'+code+'\\b').test(stderrText)).slice(0,4);
 const inspection=readInspectionDiagnostic({version:1,code,exitCode:Number.isInteger(result?.exitCode)&&result.exitCode>=-4095&&result.exitCode<=255?result.exitCode:null,timedOut:result?.timedOut===true,aborted:result?.aborted===true,stdout:stream(result?.stdout),stderr:stream(result?.stderr),stderrCodes,detail:''});
 throw Object.assign(Error(code),{code,inspection});
}
