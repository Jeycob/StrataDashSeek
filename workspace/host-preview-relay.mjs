import net from 'node:net';

// Private UDS transport only. connect is a trusted verified-own-peer callback,
// never a destination from a request. No local HTTP bytes cross before proof.
export async function createPreviewRelay({socketPath,connect,assertCurrent}){
 if(typeof connect!=='function'||typeof assertCurrent!=='function')throw Error('PREVIEW_RELAY_BINDING_REQUIRED');
 const connections=new Set();let closed=false;
 const destroyConnections=()=>{for(const close of [...connections])close();};
 const server=net.createServer({pauseOnConnect:true},local=>{
  const controller=new AbortController();let peer,ended=false;
  const close=()=>{if(ended)return;ended=true;controller.abort();local.destroy();peer?.close();connections.delete(close);};
  connections.add(close);local.on('error',close);local.once('close',close);local.setTimeout(30000,close);
  void(async()=>{
   try{
    if(closed)throw Error('PREVIEW_RELAY_CLOSED');assertCurrent();
    peer=await connect({deadline:Date.now()+2500,signal:controller.signal});
    if(ended||closed){peer.close();return;}assertCurrent();
    if(peer.socket.bytesWritten!==0)throw Error('PREVIEW_RELAY_EARLY_BYTES');
    peer.socket.on('error',close);Promise.resolve(peer.done).then(close,close);
    local.pipe(peer.socket).pipe(local);peer.socket.resume();local.resume();
   }catch{close();}
  })();
 });
 try{await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(socketPath,()=>{server.removeListener('error',reject);resolve();});});}
 catch(error){closed=true;destroyConnections();server.close();throw error;}
 return{socketPath,destroyConnections,async close(){if(closed)return;closed=true;destroyConnections();await new Promise(resolve=>server.close(resolve));}};
}
