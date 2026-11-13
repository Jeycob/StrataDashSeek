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
if __name__=='__main__':unittest.main()
