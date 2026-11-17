'use strict';
// Explicit local read-only proof. A trusted fixture owner prepares NEW public
// root-owned trees; this nonroot reader never changes modes, ownership or data.
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict'),Module=require('node:module');
const {bindAppsProcess}=require('../apps-execution-mode.cjs'),{executionBindingFixture}=require('./execution-binding.cjs');
assert.equal(process.platform,'linux');assert.notEqual(process.getuid(),0);assert.notEqual(process.geteuid(),0);
const cap=fs.readFileSync('/proc/self/status','utf8').match(/^CapEff:\s*(\S+)/m)[1];assert(/^0+$/.test(cap));
const root=fs.realpathSync(process.argv[2]);assert.equal(path.dirname(root),'/tmp');assert(path.basename(root).startsWith('homeai-apps-default-'));
const f=executionBindingFixture('host-compat'),directory='/data/harness/releases/'+f.binding.snapshot.sourceCommit+'/vast';let bindings=0;
function filesystem(tree){
 const base=path.join(root,tree),host=virtual=>path.join(base,virtual.slice(1));
 return{lstatSync:virtual=>fs.lstatSync(host(virtual)),realpathSync(virtual){const actual=fs.realpathSync(host(virtual));return actual===base?'/':actual.startsWith(base+'/')?'/'+path.relative(base,actual):actual;}};
}
const options={directory,launchId:f.binding.snapshot.launchId,filesystem:filesystem('good'),modeContract:{bindForService(input){bindings++;assert.deepEqual(input,{sourceCommit:f.binding.snapshot.sourceCommit,launchId:f.binding.snapshot.launchId});return f.binding;}}};
assert.equal(bindAppsProcess(options).snapshot.mode,'host-compat');assert.equal(bindings,1);
assert.throws(()=>bindAppsProcess({...options,filesystem:filesystem('writable')}),{code:'PROJECT_EXECUTION_SOURCE_UNSAFE'});assert.equal(bindings,1);
assert.throws(()=>bindAppsProcess({...options,filesystem:filesystem('alias')}),{code:'PROJECT_EXECUTION_SOURCE_INVALID'});assert.equal(bindings,1);
// Reproduce exactly the baseline727 DEFAULT call, in a private Module rather
// than altering the production module/cache or any SDK implementation.
const file=require.resolve('../apps-execution-mode.cjs'),source=fs.readFileSync(file,'utf8'),fixed='if(trustedDirectory)trustedDirectory(actual);else protectedReleaseDirectory(actual,filesystem);',original="(trustedDirectory??require('./runtime-paths.cjs').directoryTree)(actual);";
assert(source.includes(fixed));const legacy=new Module(file,module);legacy.filename=file;legacy.paths=Module._nodeModulePaths(path.dirname(file));legacy._compile(source.replace(fixed,original),file);
assert.throws(()=>legacy.exports.bindAppsProcess(options),/Privileged runtime paths require Linux root/);assert.equal(bindings,1);
console.log(JSON.stringify({uid:process.getuid(),euid:process.geteuid(),capEff:cap,defaultValidator:true,customTrustedDirectory:false,realRootOwnedTreeAccepted:true,realWritableTreeRejected:true,realAliasRejected:true,baseline727RootOnlyCallReproduced:true,filesystemMutations:0}));
