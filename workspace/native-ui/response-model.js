// The SDK exposes routes only when every billed attempt in this completed turn
// is attributed. The current picker may name another model and is never used.
function CompletedResponseModel({turn}){
 const cs=useLanguage()==='cs',tail=turn.data.get('turn-tail');
 const valid=value=>typeof value?.provider==='string'&&value.provider.length>0&&typeof value?.model==='string'&&value.model.length>0;
 const routes=tail?.tokenUsage?.routes,complete=Array.isArray(routes)&&routes.length>0&&routes.every(valid);
 const label=cs?'Modely použité v tomto běhu':'Models used in this turn';
 const routeText=value=>value.provider+' / '+value.model;
 return h('div',{className:'harness-response-model',style:{overflowWrap:'anywhere'}},complete?label+': '+routes.map(routeText).join(', '):cs?'Údaje o použitých modelech jsou neúplné nebo nedostupné.':'Used model metadata is incomplete or unavailable.');
}
function installResponseModel(ctx){
 ctx.effect(()=>ctx.slots.inject('conversation.chat.turnTail',()=>ctx.slots.register({name:'conversation.chat.turnTail',id:'homeai.response-model',order:110},CompletedResponseModel)),'native-workbench: response model');
}
