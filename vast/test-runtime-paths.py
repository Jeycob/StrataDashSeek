import unittest,tempfile,pathlib,os,json
from runtime_paths import RuntimePaths

class RuntimeSecurity(unittest.TestCase):
    def fixture(self):
        d=tempfile.TemporaryDirectory(prefix='harness-python-rootio-');self.addCleanup(d.cleanup)
        root=pathlib.Path(d.name);root.chmod(0o755);r=RuntimePaths(root,account=(65534,65534))
        (root/'state').mkdir(mode=0o755);return root,r

    def test_hardlink_and_symlink_outputs_cannot_mutate_root_victim(self):
        root,r=self.fixture();victim=root/'victim';victim.write_text('ROOT_FIXTURE');victim.chmod(0o600);target=r.public/'idle-status.json'
        for link in ('symlink','hardlink'):
            if link=='symlink':target.symlink_to(victim)
            else:os.link(victim,target)
            with self.assertRaises(ValueError):r.publish('idle-status.json',{'at':1,'canStop':False})
            self.assertEqual(victim.read_text(),'ROOT_FIXTURE');self.assertEqual(victim.stat().st_uid,0);self.assertEqual(victim.stat().st_mode&0o777,0o600);target.unlink()

    def test_root_writer_rejects_writable_parent(self):
        root,r=self.fixture();r.public.chmod(0o777)
        with self.assertRaises(ValueError):r.publish('idle-status.json',{'at':1})
        r.public.chmod(0o755)

    def test_agent_read_drops_uid_and_cannot_follow_parent_into_private_state(self):
        root,r=self.fixture();r.write(r.private/'activity.json',{'secret':'PRIVATE_FIXTURE'})
        (root/'state/applications').symlink_to(r.private,target_is_directory=True)
        with self.assertRaises(ValueError):r.read_agent('applications/activity.json')
        (root/'state/maintenance.json').write_text(json.dumps({'until':123}))
        self.assertEqual(r.read_agent('maintenance.json')['until'],123)

    def test_public_idle_fields_never_copy_logs_or_credential_fields(self):
        root,r=self.fixture();secret='SYNTHETIC_PYTHON_TOKEN';r.publish('idle-status.json',{'at':1,'reason':'https://fixture.invalid/?token='+secret,'harnessLog':secret,'password':secret})
        text=(r.public/'idle-status.json').read_text();self.assertNotIn(secret,text);self.assertNotIn('harnessLog',text)
        self.assertEqual((r.private/'idle-status.json').stat().st_mode&0o777,0o600)

if __name__=='__main__':unittest.main()
