const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {createPushServer}=require('./webpush-server.cjs');
test('retired migration registration receives no duplicate push',async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'harness-push-retired-'));const sent=[];
 fs.writeFileSync(path.join(dir,'webpush-subscriptions.json'),JSON.stringify({version:1,installations:{old:{retiredAt:1,subscription:{endpoint:'https://web.push.apple.com/mock-retired'}},current:{subscription:{endpoint:'https://web.push.apple.com/mock-active'}}}}));
 const adapter={generateVAPIDKeys:()=>({publicKey:'test-public',privateKey:'test-private'}),setVapidDetails(){},async sendNotification(subscription){sent.push(subscription.endpoint);return {statusCode:201};}};
 const service=createPushServer({publicHost:'fixture.example.ts.net',secretDir:dir},adapter);await service.publish('done','fixture-completed');await service.publish('done','fixture-completed');assert.deepEqual(sent,['https://web.push.apple.com/mock-active']);assert.equal(service.stats.accepted,1);
});
