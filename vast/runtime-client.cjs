'use strict';
const fs=require('node:fs'),path=require('node:path');
const root=fs.realpathSync(path.join(__dirname,'..')),expectedCommit=path.basename(root);
const required=process.platform==='linux'&&/^\/data\/harness\/releases\/[a-f0-9]{40}$/.test(root)||process.env.HARNESS_RUNTIME_ADMISSION_REQUIRED==='1';
let client;function get(){return client??=import('../workspace/runtime-admission.mjs').then(({createRuntimeAdmission})=>createRuntimeAdmission({expectedCommit,production:required}));}
module.exports={required,async admit(operation,options){return(await get()).admit(operation,options);},async status(options){return(await get()).status(options);}};
