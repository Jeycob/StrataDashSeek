import importlib.util,pathlib,unittest,json
spec=importlib.util.spec_from_file_location('migration',pathlib.Path(__file__).with_name('session-migration.py'));migration=importlib.util.module_from_spec(spec);spec.loader.exec_module(migration)
class Migration(unittest.TestCase):
    def test_windows_prefix_normalizes_both_sides(self):self.assertEqual(migration.map_windows_path(r'C:\Users\Alice\projects\demo',{'C:/Users/Alice/projects':'/data/projects'}),'/data/projects/demo')
    def test_case_and_directory_boundary(self):
        self.assertEqual(migration.map_windows_path('c:/USERS/alice/projects/demo',{r'C:\Users\Alice\projects':'/data/projects'}),'/data/projects/demo')
        self.assertEqual(migration.map_windows_path('C:/Users/Alice/projects-backup',{'C:/Users/Alice/projects':'/data/projects'}),'C:/Users/Alice/projects-backup')
    def test_header_has_its_own_complete_frame(self):
        header={'type':'session','id':'fixture'};event={'type':'turn/start','seq':1};encoded=migration.encode_session_rows([header,event]);first=migration.compress_frame((json.dumps(header)+'\n').encode());self.assertTrue(encoded.startswith(first));self.assertGreater(len(encoded),len(first))
if __name__=='__main__':unittest.main()
