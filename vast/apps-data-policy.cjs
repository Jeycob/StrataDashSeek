'use strict';
const path=require('node:path');
const fail=()=>Object.assign(Error('Declare a supported stateless or SQLite dataPolicy in .harness-app.json'),{code:'APP_DATA_POLICY_INVALID',status:409});
const relative=value=>typeof value==='string'&&value.length<=200&&!path.isAbsolute(value)&&!value.includes('\\')&&!value.split('/').some(part=>!part||part==='.'||part==='..'||part.startsWith('.'));
function dataPolicy(value){
 if(value===undefined||value===null)return{kind:'stateless'};
 if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).some(key=>!['kind','volume','mountPath','database','maxBytes','migration'].includes(key)))throw fail();
 if(value.kind==='stateless'){if(Object.keys(value).length!==1)throw fail();return{kind:'stateless'};}
 if(value.kind!=='sqlite'||!/^[a-z][a-z0-9-]{0,31}$/.test(value.volume||'')||!/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,79}$/.test(value.database||'')||typeof value.mountPath!=='string'||!/^\/(?:app|srv|var\/lib)\/[a-zA-Z0-9_./-]{1,100}$/.test(value.mountPath)||value.mountPath.includes('//')||value.mountPath.split('/').some(part=>part==='.'||part==='..')||value.mountPath.endsWith('/'))throw fail();
 const maxBytes=value.maxBytes??64*1024**2;if(!Number.isSafeInteger(maxBytes)||maxBytes<4096||maxBytes>256*1024**2)throw fail();
 let migration=null;
 if(value.migration!==undefined&&value.migration!==null){const m=value.migration;if(!m||typeof m!=='object'||Array.isArray(m)||Object.keys(m).some(key=>!['file','fromVersion','toVersion'].includes(key))||!relative(m.file)||!m.file.endsWith('.sql')||!Number.isInteger(m.fromVersion)||!Number.isInteger(m.toVersion)||m.fromVersion<0||m.toVersion<=m.fromVersion||m.toVersion>2147483647)throw fail();migration={file:m.file,fromVersion:m.fromVersion,toVersion:m.toVersion};}
 return{kind:'sqlite',volume:value.volume,mountPath:value.mountPath,database:value.database,maxBytes,migration};
}
module.exports={dataPolicy};
