// Entrypoint for an operator-provisioned service under a dedicated guest UID.
import {runPreviewGuestWorker} from './preview-guest-renderer.mjs';

try {
 const server=await runPreviewGuestWorker(process.argv.length===3?Number(process.argv[2]):0);
 server.on('error',()=>{process.stderr.write('PREVIEW_SNAPSHOT_GUEST_LISTENER_FAILED\n');process.exitCode=1;});
 for (const signal of ['SIGTERM','SIGINT']) process.once(signal,()=>server.close());
} catch {
 process.stderr.write('PREVIEW_SNAPSHOT_GUEST_UNAVAILABLE\n');
 process.exitCode=1;
}
