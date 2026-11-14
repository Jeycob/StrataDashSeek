export const name='homeai-bounded-request-recovery';
export function isPayloadTooLarge(failure){const text=failure?.message||'';return /^\s*413\b/.test(text)&&/payload[_ ]too[_ ]large|request body too large|body.{0,30}length limit/i.test(text)&&!/maximum context|context[_ -]length|context window/i.test(text);}
export function apply(ctx,config={}){const providers=new Set(config.providers||['strata-vast']);ctx.on('agent/request-error',async(input,next)=>{if(providers.has(input.provider)&&isPayloadTooLarge(input.failure))return undefined;return next();},{prepend:true,global:true});}
