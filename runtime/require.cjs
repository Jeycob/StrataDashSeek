'use strict';
// Service dependencies live outside versioned application releases.
const fs=require('node:fs'),path=require('node:path'),{createRequire}=require('node:module'),{fileURLToPath}=require('node:url');
function runtimeResolver(){
 const configured=process.env.HOMEAI_RUNTIME;
 if(configured&&!path.isAbsolute(configured))throw Error('HOMEAI_RUNTIME must be an absolute runtime directory');
 const anchor=configured?path.join(configured,'package.json'):fs.existsSync('/data/harness/runtime/package.json')?'/data/harness/runtime/package.json':__filename;
 if(configured&&!fs.statSync(anchor).isFile())throw Error('Configured runtime manifest is unavailable');
 return createRequire(anchor);
}
function runtimeRequire(name){return runtimeResolver()(name);}
function resolveRuntime(name){return runtimeResolver().resolve(name);}
function isMain(url,entry=process.argv[1]){
 if(!entry)return false;
 try{return fs.realpathSync(fileURLToPath(url))===fs.realpathSync(path.resolve(entry));}catch{return false;}
}
function serviceDataRoot(){
 const explicit=process.env.HOMEAI_ROOT,runtime=process.env.HOMEAI_RUNTIME;
 if(explicit){if(!path.isAbsolute(explicit))throw Error('HOMEAI_ROOT must be an absolute data directory');return explicit;}
 if(runtime){if(!path.isAbsolute(runtime))throw Error('HOMEAI_RUNTIME must be an absolute runtime directory');return path.dirname(runtime);}
 return fs.existsSync('/data/harness/runtime/package.json')?'/data/harness':null;
}
module.exports={runtimeRequire,resolveRuntime,isMain,serviceDataRoot};
