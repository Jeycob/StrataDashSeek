// Frozen source is read/hash-verified in place. Never copy prompts/fixtures,
// import their modules, invoke freeze.mjs, or run their acceptance tools here.
import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
export const sourceManifestSHA='42fd252df7390ea830b9225b08e0d3f48b49b5358b94dfc7dee4f262d02e832f';
export const qaManifestSHA='0f3aefd09c40868109a3972c41a4d417d088181cb8066b8fe8701c2a9cf02e4a';
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const need=(value,code)=>{if(!value)throw Object.assign(Error(code),{code});};
export function frozenInputs({frozenRoot,qaRoot}){
 return{async verify(record){
  const read=async file=>{const stat=await fs.lstat(file);need(stat.isFile()&&!stat.isSymbolicLink(),'FROZEN_REGULAR_FILE_REQUIRED');return fs.readFile(file);};
  const manifestBytes=await read(path.join(frozenRoot,'manifest.json')),qaBytes=await read(path.join(qaRoot,'product-qa-manifest.json'));
  need(sha(manifestBytes)===sourceManifestSHA&&sha(qaBytes)===qaManifestSHA,'FROZEN_MANIFEST_CHANGED');
  const manifest=JSON.parse(manifestBytes),qa=JSON.parse(qaBytes),verified=[];
  for(const [root,rows]of[[frozenRoot,manifest.files],[qaRoot,qa.files]])for(const row of rows){const file=path.resolve(root,row.path),bytes=await read(file);need(bytes.length===row.bytes&&sha(bytes)===row.sha256,'FROZEN_FILE_CHANGED');verified.push({path:file,sha256:row.sha256,bytes:bytes.length});}
  const promptPath='prompts/'+record.scenario+'.txt',pin=manifest.files.find(row=>row.path===promptPath);
  need(pin&&pin.sha256===record.identity.promptSha256&&record.identity.manifestSha256===sourceManifestSHA,'PROMPT_REFERENCE_CHANGED');
  const prompt=await read(path.join(frozenRoot,promptPath));need(sha(prompt)===pin.sha256,'PROMPT_CHANGED_AFTER_VERIFICATION');
  return{unchanged:true,prompt,verified,sourceManifestSHA,qaManifestSHA};
 }};
}
