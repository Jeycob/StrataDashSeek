import test from 'node:test'; import assert from 'node:assert/strict';
import { sameRequestOrigin, boundedJSON } from './http.mjs';
test('owner fetch keeps explicit origin check despite Harness synthetic internal URL',()=>{
 const req=(origin,host)=>new Request('http://dsh.internal/api/workbench',{headers:{...(origin?{Origin:origin}:{}),...(host?{Host:host}:{})}});
 assert.equal(sameRequestOrigin(req('https://host.ts.net','host.ts.net')),true);
 assert.equal(sameRequestOrigin(req('http://127.0.0.1:3194','127.0.0.1:3194')),true);
 for(const [origin,host]of [['https://evil.test','host.ts.net'],[null,'host.ts.net'],['null','host.ts.net'],['https://host.ts.net',null],['file:///etc/passwd','host.ts.net']])assert.equal(sameRequestOrigin(req(origin,host)),false);
});
test('JSON requests are bounded before decoding',async()=>{
 assert.deepEqual(await boundedJSON(new Request('http://test',{method:'POST',body:'{"ok":true}'})),{ok:true});
 await assert.rejects(boundedJSON(new Request('http://test',{method:'POST',body:'{"long":"abcdef"}'}),5),e=>e.status===413);
});
