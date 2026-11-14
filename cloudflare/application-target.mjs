export function applicationTarget(env, value) {
 if(value===null)return null;
 if(!/^[1-9][0-9]{3,4}$/.test(value))throw Error('Invalid application port');
 const port=Number(value),first=Number(env.APPLICATION_FIRST_PORT||18080),count=Number(env.APPLICATION_PORT_COUNT||8);
 if(!Number.isInteger(first)||first<1024||!Number.isInteger(count)||count<1||count>32||first+count>65536||port<first||port>=first+count)throw Error('Application port is outside the configured pool');
 const host=env.APPLICATION_HOST||'',parts=host.split('.').map(Number);
 if(parts.length!==4||parts.some(n=>!Number.isInteger(n)||n<0||n>255)||parts[0]!==100||parts[1]<64||parts[1]>127||parts.join('.')!==host)throw Error('Application preview requires its separate private Tailscale address');
 return 'http://'+host+':'+port+'/';
}
