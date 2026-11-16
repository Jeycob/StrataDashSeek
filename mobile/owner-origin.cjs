'use strict';
// Browser authority checks precede runtime admission and every upstream write.
function ownerRequestAllowed(request,origin,{upgrade=false}={}){
 const headers=request.headers||{},given=headers.origin,cookie=headers.cookie;
 if(given!==undefined&&given!==origin)return false;
 if(upgrade&&given!==origin)return false;
 const api=/^\/(?:api(?:\/|$)|phone\/api(?:\/|$))/.test(String(request.url||'').split('?')[0]);
 if(!api)return true;
 if(typeof cookie==='string'){
  const names=new Set();for(const part of cookie.split(';')){const name=part.trim().split('=')[0];if(!name.startsWith('dsh-auth-'))continue;if(names.has(name))return false;names.add(name);}
  if(!['GET','HEAD','OPTIONS'].includes(request.method)&&given!==origin)return false;
 }
 if(headers['sec-fetch-site']&&headers['sec-fetch-site']!=='same-origin'&&given!==origin)return false;
 return true;
}
function ownerResponseHeaders(headers){
 const out={...headers};for(const key of Object.keys(out))if(key.toLowerCase().startsWith('access-control-'))delete out[key];
 if(out['set-cookie'])out['set-cookie']=out['set-cookie'].map(value=>{
  const parts=value.split(';').map(x=>x.trim());if(!parts[0].startsWith('dsh-auth-'))return /;\s*secure(?:;|$)/i.test(value)?value:value+'; Secure';
  return parts.filter((x,i)=>i===0||!/^(?:domain|path|samesite|secure|httponly)(?:=|$)/i.test(x)).join('; ')+'; Path=/; HttpOnly; Secure; SameSite=Strict';
 });
 out['referrer-policy']='no-referrer';out['origin-agent-cluster']='?1';out['permissions-policy']='document-domain=()';return out;
}
module.exports={ownerRequestAllowed,ownerResponseHeaders};
