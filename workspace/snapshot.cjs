'use strict';
// Emit only a sanitized configuration snapshot. Raw rollback copies stay private.
const fs=require('node:fs'),crypto=require('node:crypto'),{createRequire}=require('node:module');
const R='/data/harness',yaml=createRequire(R+'/runtime/node_modules/@deepseek-ai/dsh/package.json')('yaml');
function scrub(value,key=''){
 if(/key|token|password|secret|authorization|tailscaleAutoLoginUsers/i.test(key))return value?'<REDACTED>':value;
 if(Array.isArray(value))return value.map(v=>scrub(v));
 if(value&&typeof value==='object')return Object.fromEntries(Object.entries(value).map(([k,v])=>[k,scrub(v,k)]));
 return value;
}
const text=fs.readFileSync(R+'/home/.dsh/profiles/web/cordis.patch.yml','utf8'),doc=yaml.parseDocument(text);
if(doc.errors.length)throw doc.errors[0];
const snapshot={at:new Date().toISOString(),profileSha256:crypto.createHash('sha256').update(text).digest('hex'),profile:scrub(doc.toJSON()),development:JSON.parse(fs.readFileSync(R+'/state/development.json','utf8'))};
console.log(JSON.stringify(snapshot,null,2));
