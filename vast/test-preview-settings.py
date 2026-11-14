import unittest,tempfile,pathlib,json,types
from preview_settings import PreviewSettings
class PreviewTests(unittest.TestCase):
    def fixture(self,enabled=False):
        d=tempfile.TemporaryDirectory();self.addCleanup(d.cleanup);root=pathlib.Path(d.name);calls=[]
        def run(args,**kwargs):calls.append(args);return types.SimpleNamespace(returncode=0)
        p=PreviewSettings(root,run);p.config.write_text(json.dumps({'enabled':enabled}));return p,calls
    def request(self,p,**changes):p.request.parent.mkdir(parents=True,exist_ok=True);p.request.write_text(json.dumps({'id':'a'*16,'enabled':True,**changes}))
    def test_only_eight_approved_private_ports_can_be_enabled(self):
        p,calls=self.fixture();self.request(p);p.tick(100)
        self.assertEqual(len(calls),8)
        for n,c in enumerate(calls):
            self.assertIn('--tcp='+str(18080+n),c);self.assertEqual(c[-1],'tcp://127.0.0.1:'+str(18180+n));self.assertNotIn('funnel',c);self.assertNotIn('reset',c)
        self.assertTrue(p.read(p.status)['enabled']);p.tick(101);self.assertEqual(len(calls),8)
    def test_disabling_never_resets_the_harness_service(self):
        p,calls=self.fixture(True);self.request(p,enabled=False);p.tick(100)
        self.assertEqual(len(calls),8);self.assertTrue(all(c[-1]=='off' for c in calls));self.assertFalse(p.read(p.status)['enabled'])
    def test_browser_cannot_supply_ports_or_commands(self):
        p,calls=self.fixture();self.request(p,port=443)
        with self.assertRaises(ValueError):p.tick(100)
        self.assertEqual(calls,[])
    def test_non_boolean_request_is_rejected(self):
        p,calls=self.fixture();self.request(p,enabled='true')
        with self.assertRaises(ValueError):p.tick(100)
        self.assertEqual(calls,[])
    def test_failed_change_reports_error_and_restores_previous_choice(self):
        p,calls=self.fixture();self.request(p)
        def run(args,**kwargs):calls.append(args);return types.SimpleNamespace(returncode=1 if len(calls)==2 else 0)
        p.run=run;p.tick(100);status=p.read(p.status);self.assertFalse(status['verified']);self.assertFalse(status['enabled']);self.assertTrue(status['error']);self.assertTrue(all(c[-1]=='off' for c in calls[2:]))
if __name__=='__main__':unittest.main()
