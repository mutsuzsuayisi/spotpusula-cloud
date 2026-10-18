import contextlib
import importlib.util
import io
import json
import sqlite3
import sys
import unittest
from pathlib import Path
from unittest.mock import patch

ROOT=Path(__file__).resolve().parents[1]
sys.path.insert(0,str(ROOT/'scanner'))
import cloud_run

class PrivacyTests(unittest.TestCase):
    def test_private_payload_never_printed_even_on_exception(self):
        marker='PRIVATE_COIN_BALANCE_777777'
        def fail():
            print(marker)
            print(marker,file=sys.stderr)
            raise ValueError(marker)
        out,err=io.StringIO(),io.StringIO()
        with patch.object(cloud_run,'cycle',fail),patch.dict('os.environ',{},clear=True),contextlib.redirect_stdout(out),contextlib.redirect_stderr(err):
            code=cloud_run.main()
        self.assertEqual(code,1)
        self.assertNotIn(marker,out.getvalue()+err.getvalue())

    def test_model_must_return_small_structured_output(self):
        for bad in ['Al BTC', '{"summary":"x","detail":"y","actions":[],"extra":1}',json.dumps({'summary':'x','detail':'x','actions':[{}, {}, {}]})]:
            with self.assertRaises((ValueError,TypeError)):
                cloud_run.validate_answer(bad)
        self.assertEqual(cloud_run.validate_answer('{"summary":"Bekle","detail":"Teyit yok","actions":[]}')['actions'],[])

    def test_execution_quote_is_exact_and_invalid_quotes_are_discarded(self):
        actions=[{'side':'BUY','symbol':'ALTUSDT'}, {'side':'SELL','symbol':'BTCUSDT'}]
        def market(_path, **params):
            self.assertEqual(params['symbol'],'ALTUSDT')
            return {'symbol':'ALTUSDT','bidPrice':'1.000','askPrice':'1.002'}
        with patch.object(cloud_run.time,'time',return_value=1234.5):
            self.assertEqual(cloud_run.execution_quotes(actions,market),
                [{'symbol':'ALTUSDT','bid':1.0,'ask':1.002,'at':1234500,'source':'Binance spot'}])
        self.assertEqual(cloud_run.execution_quotes(actions,
            lambda *_args,**_kwargs:{'symbol':'BTCUSDT','bidPrice':'1','askPrice':'1.1'}),[])
        self.assertEqual(cloud_run.execution_quotes(actions,
            lambda *_args,**_kwargs:{'symbol':'ALTUSDT','bidPrice':'1.1','askPrice':'1'}),[])

    def test_workflow_does_not_export_private_files(self):
        workflow=(ROOT/'.github/workflows/analysis.yml').read_text()
        for forbidden in ['upload-artifact','actions/cache','pull_request_target','set -x','printenv','ACTIONS_STEP_DEBUG']:
            self.assertNotIn(forbidden,workflow)
        self.assertIn('contents: read',workflow)
        self.assertIn('secrets.GEMINI_API_KEY',workflow)

class AtomicityTests(unittest.TestCase):
    def setUp(self):
        self.db=sqlite3.connect(':memory:')
        self.db.executescript((ROOT/'cloud/schema.sql').read_text())

    def commit_report(self,version,token,report):
        with self.db:
            cur=self.db.execute('UPDATE wallet SET body=?,version=version+1,token=? WHERE id=1 AND version=? AND NOT EXISTS(SELECT 1 FROM reports WHERE id=?)',('{}',token,version,report))
            changed=cur.rowcount
            self.db.execute('INSERT INTO reports(id,created,body) SELECT ?,?,? WHERE EXISTS(SELECT 1 FROM wallet WHERE token=?)',(report,'now','{}',token))
            self.db.execute('INSERT INTO events(id,created,kind,body) SELECT ?,?,?,? WHERE EXISTS(SELECT 1 FROM wallet WHERE token=?)',(token,'now','BUY','{}',token))
        return changed

    def test_duplicate_cycle_cannot_create_second_trade(self):
        self.assertEqual(self.commit_report(0,'first','cycle-1'),1)
        self.assertEqual(self.commit_report(1,'second','cycle-1'),0)
        self.assertEqual(self.db.execute('SELECT count(*) FROM events').fetchone()[0],1)

    def test_stale_wallet_update_cannot_overwrite_new_trade(self):
        self.assertEqual(self.commit_report(0,'first','cycle-1'),1)
        self.assertEqual(self.commit_report(0,'stale','cycle-2'),0)
        self.assertEqual(self.db.execute('SELECT version FROM wallet').fetchone()[0],1)

if __name__=='__main__':unittest.main()
