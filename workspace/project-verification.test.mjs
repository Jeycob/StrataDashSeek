import {isolatedExecutionBinding} from './fixtures/execution-binding.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {installProjectVerification} from './project-verification.mjs';
function fixture(){
 let handler;const calls=[],owner={id:'owner'},execution={agent:{id:'child'},signal:new AbortController().signal};
 const ctx={on(name,fn){assert.equal(name,'workspace-runtime/verify-command');handler=fn;}},record={root:'/projects/owner',independentRepository:true,ports:[4000,4001,4002,4003]},manager={execution:isolatedExecutionBinding(),ownerAgent:()=>owner,data:{sessions:{owner:record}},review:async()=>({sourceHash:'source'})};
 installProjectVerification(ctx,manager,async(args,actual)=>{calls.push({args,execution:actual});return{result:{exitCode:0}};});
 return{run:input=>handler({kind:'all',projectRoot:record.root,sourceHash:'source',execution,...input}),calls,record,manager,execution};
}
test('verification uses fixed guest toolchain, server ports and actual child execution',async()=>{
 const f=fixture();await f.run();assert.equal(f.calls.length,1);assert.equal(f.calls[0].execution,f.execution);
 assert.match(f.calls[0].args.command,/^HARNESS_QUALITY_ALLOWED_PORTS='4000,4001,4002,4003' exec '\/opt\/code-server\/lib\/node' '\/opt\/homeai\/quality\/cli.mjs'/);
 assert.match(f.calls[0].args.command,/'--workspace' '\/workspace' '--kind' 'all'$/);assert.equal(f.calls[0].args.timeoutMs,120000);
});
test('foreign roots, stale source, legacy projects and invalid ports never reach the runner',async()=>{
 for(const change of [f=>({projectRoot:'/projects/other'}),f=>({sourceHash:'stale'}),f=>{f.record.legacy=true;return{};},f=>{f.record.ports[0]='4000;bad';return{};}]){const f=fixture();await assert.rejects(f.run(change(f)));assert.equal(f.calls.length,0);}
});
