import importlib.util,pathlib,unittest
spec=importlib.util.spec_from_file_location('guard',pathlib.Path(__file__).with_name('idle-guard.py'));guard=importlib.util.module_from_spec(spec);spec.loader.exec_module(guard)
class Safety(unittest.TestCase):
    def check(self,expected,**updates):
        values={'now':1000,'last':600,'lifecycle':{'at':1000000,'active':0,'lastActivity':600000},'model':{'busy':False,'queued':0},'jobs':False,'lease_until':0}
        values.update(updates);self.assertEqual(guard.decide(**values)[0],expected)
    def test_idle(self):self.check(True)
    def test_tool_gap_during_turn(self):self.check(False,lifecycle={'at':1000000,'active':1,'lastActivity':600000})
    def test_build_after_model_finishes(self):self.check(False,jobs=True)
    def test_busy_model(self):self.check(False,model={'busy':True,'queued':0})
    def test_queued(self):self.check(False,model={'busy':False,'queued':1})
    def test_unknown_model(self):self.check(False,model={})
    def test_failed_heartbeat(self):self.check(False,lifecycle={'at':900000,'active':0,'lastActivity':600000})
    def test_recent_user_action(self):self.check(False,lifecycle={'at':1000000,'active':0,'lastActivity':950000})
    def test_maintenance(self):self.check(False,lease_until=1100)
    def test_recent_job_end(self):self.check(False,last=990)
    def test_application_build_holds_idle(self):self.check(False,applications={'at':1000000,'active':1})
    def test_stale_application_heartbeat_holds_idle(self):self.check(False,applications={'at':900000,'active':0})
    def test_idle_application_worker_allows_sleep(self):self.check(True,applications={'at':1000000,'active':0})
    def test_worker_transition_holds_sleep(self):self.check(False,applications={'at':1000000,'active':0,'worker':{'pid':99,'phase':'saving'}})
    def test_awake_lease_holds_sleep(self):self.check(False,applications={'at':1000000,'active':0,'holdUntil':1100000})
    def test_stopped_worker_error_does_not_run_up_gpu_bill(self):self.check(True,applications={'at':1000000,'active':0,'worker':{'pid':None,'phase':'error'}})
    def test_only_verified_docker_infrastructure_is_passive(self):
        p={10:{'args':['/data/harness/node/bin/node','/data/harness/app/vast/apps-service.cjs','/data/harness/apps-config.json'],'cwd':'/data/harness/workspaces','ppid':1},11:{'args':['qemu-system-x86_64','-name','stratadashseek-docker','-drive','file=/data/harness/docker-worker/volume.raw,format=raw,if=virtio,cache=writeback'],'cwd':'/data/harness/docker-worker','ppid':10},12:{'args':['gcc','main.c'],'cwd':'/data/harness/workspaces','ppid':10}}
        a={'at':1000000,'servicePid':10,'worker':{'pid':11}}
        self.assertEqual(guard.passive_worker_processes(p,a,1000),{10,11})
        p[11]['ppid']=1
        self.assertEqual(guard.passive_worker_processes(p,a,1000),{10,11})
        self.assertEqual(guard.passive_worker_processes(p,a,1030),set())
        p[11]['args']=['qemu-system-x86_64','other-job']
        self.assertEqual(guard.passive_worker_processes(p,a,1000),{10})
    def test_recent_application_completion_restarts_idle_clock(self):self.check(False,applications={'at':1000000,'active':0,'lastActivity':950000})
    def test_preview_and_esbuild_child_do_not_hold_idle(self):
        p={10:{'args':['node','/x/vite/bin/vite.js','--host','127.0.0.1'],'cwd':'/data/harness/workspaces/app','ppid':1},11:{'args':['esbuild','--service'],'cwd':'/data/harness/workspaces/app','ppid':10}}
        self.assertEqual(guard.preview_processes(p),{10,11})
    def test_real_vite_build_remains_active(self):
        p={10:{'args':['node','/x/vite/bin/vite.js','build'],'cwd':'/data/harness/workspaces/app','ppid':1}}
        self.assertEqual(guard.preview_processes(p),set())
    def test_unknown_compiler_is_not_exempt(self):
        p={10:{'args':['node','apps/api/src/server.js'],'cwd':'/data/harness/workspaces/app','ppid':1},11:{'args':['gcc','main.c'],'cwd':'/data/harness/workspaces/app','ppid':1}}
        self.assertEqual(guard.preview_processes(p),{10})
    def test_external_server_is_not_workspace_preview(self):
        p={10:{'args':['node','apps/api/src/server.js'],'cwd':'/srv/important','ppid':1}}
        self.assertEqual(guard.preview_processes(p),set())
    def test_verified_home_server_can_idle_but_unknown_script_cannot(self):
        p={10:{'args':['node','src/index.js'],'cwd':'/data/harness/home/HomeAI/server','ppid':1}}
        self.assertEqual(guard.preview_processes(p),{10})
        p[10]['args']=['node','src/build.js']
        self.assertEqual(guard.preview_processes(p),set())
    def test_shell_preview_wrapper_requires_no_other_job(self):
        shell={'args':['bash','-c','node /x/vite/bin/vite.js --host 127.0.0.1'],'cwd':'/data/harness/workspaces/app','ppid':1}
        p={9:shell,10:{'args':['node','/x/vite/bin/vite.js'],'cwd':'/data/harness/workspaces/app','ppid':9}}
        self.assertEqual(guard.preview_processes(p),{9,10})
        p[11]={'args':['npm','test'],'cwd':'/data/harness/workspaces/app','ppid':9}
        self.assertEqual(guard.preview_processes(p),{10})
if __name__=='__main__':unittest.main()
