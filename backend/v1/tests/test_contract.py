import asyncio
import importlib.util
import json
import sqlite3
import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))


def load(name):
    spec = importlib.util.spec_from_file_location(name, ROOT / (name + '.py'))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


dispatch = load('node_dispatch')
wrap = load('node_wrap')
merge = load('node_merge')


class Args:
    def __init__(self, params):
        self.params = params


def run(module, params):
    return asyncio.run(module.main(Args(params)))


def envelope(op, data=None, actor=None, request_id='req_test'):
    return {
        'v': 'rhythm-jump/1',
        'request_id': request_id,
        'actor': actor or {'id': 'u1', 'name': '小林'},
        'op': op,
        'data': data if data is not None else {},
    }


def dispatch_request(request):
    result = run(dispatch, {'input': json.dumps(request, ensure_ascii=False)})
    payload = json.loads(result['payload_json'])
    return result, payload


def submit_data(**overrides):
    data = {
        'song_id': 'party-full',
        'chart_version': 3,
        'run_id': 'run_1',
        'score': 65000,
        'max_combo': 40,
        'perfect': 60,
        'good': 10,
        'miss': 24,
    }
    data.update(overrides)
    return data


class DispatchTest(unittest.TestCase):
    def test_valid_score_submit(self):
        out, payload = dispatch_request(envelope('score.submit', submit_data()))
        self.assertEqual(out['op'], 'score.submit')
        self.assertEqual(out['actor'], 'u1')
        self.assertEqual(out['song_id'], 'party-full')
        self.assertEqual(out['chart_version'], 3)
        self.assertEqual(out['run_id'], 'run_1')
        self.assertEqual(out['score'], 65000)
        self.assertTrue(payload['ok'])
        self.assertEqual(payload['song_title'], 'Party Sector')
        self.assertEqual(payload['accuracy'], 70)
        self.assertEqual(payload['actor'], 'u1')

    def test_score_cap_and_statistics(self):
        for data in (
            submit_data(score=99000),
            submit_data(perfect=60, good=10, miss=23),
            submit_data(max_combo=71),
            submit_data(chart_version=2),
            submit_data(song_id='unknown'),
        ):
            out, payload = dispatch_request(envelope('score.submit', data))
            self.assertEqual(out['op'], '')
            self.assertFalse(payload['ok'])
            self.assertEqual(payload['error']['code'], 'INVALID_REQUEST')

    def test_revised_chart_uses_its_own_note_count(self):
        recent = submit_data(chart_version=4, perfect=45, good=10, miss=14, score=50000)
        out, payload = dispatch_request(envelope('score.submit', recent))
        self.assertTrue(payload['ok'])
        self.assertEqual(out['chart_version'], 4)
        _, payload = dispatch_request(envelope('score.submit', submit_data(chart_version=4)))
        self.assertFalse(payload['ok'])
        _, payload = dispatch_request(envelope('leaderboard.list', {
            'song_id': 'party-full', 'chart_version': 4, 'limit': 8,
        }))
        self.assertTrue(payload['ok'])
        self.assertEqual(payload['chart_version'], 4)

    def test_each_new_song_accepts_its_chart_stats(self):
        for song_id, title, count in (
            ('beatucada', 'Beatucada', 32),
            ('into-my-dream', 'Into My Dream', 54),
            ('summer-overload', 'Summer Overload!', 55),
        ):
            data = submit_data(song_id=song_id, chart_version=1, perfect=2,
                               good=1, miss=count - 3, score=2500, max_combo=3)
            _, payload = dispatch_request(envelope('score.submit', data))
            self.assertTrue(payload['ok'])
            self.assertEqual(payload['song_title'], title)
            _, payload = dispatch_request(envelope('score.submit', {**data, 'miss': 66}))
            self.assertFalse(payload['ok'])

    def test_beatucada_repro_accepts_reported_round(self):
        data = submit_data(song_id='beatucada', chart_version=1, score=7500,
                           max_combo=7, perfect=2, good=16, miss=14)
        _, payload = dispatch_request(envelope('score.submit', data))
        self.assertTrue(payload['ok'])
        self.assertEqual(payload['score'], 7500)
        _, board = dispatch_request(envelope('leaderboard.list', {
            'song_id': 'beatucada', 'chart_version': 1, 'limit': 8,
        }))
        self.assertTrue(board['ok'])
        self.assertEqual(board['song_title'], 'Beatucada')

    def test_envelope_errors(self):
        out, payload = dispatch_request({'v': 'wrong', 'request_id': 'r', 'actor': {'id': 'u1', 'name': '小林'}, 'op': 'leaderboard.list', 'data': {'song_id': 'party-full', 'chart_version': 3, 'limit': 8}})
        self.assertFalse(payload['ok'])
        self.assertEqual(payload['error']['code'], 'UNSUPPORTED_VERSION')
        out, payload = dispatch_request(envelope('nope'))
        self.assertEqual(payload['error']['code'], 'UNKNOWN_OPERATION')
        result = run(dispatch, {'input': '{"v":"rhythm-jump/1","v":"x"}'})
        self.assertFalse(json.loads(result['payload_json'])['ok'])

    def test_user_and_leaderboard(self):
        out, payload = dispatch_request(envelope('user.upsert', {'display_name': '阿青'}))
        self.assertEqual(out['op'], 'user.upsert')
        self.assertEqual(out['user_name'], '阿青')
        self.assertTrue(payload['ok'])
        out, payload = dispatch_request(envelope('leaderboard.list', {'song_id': 'party-full', 'chart_version': 3, 'limit': 8}))
        self.assertEqual(out['op'], 'leaderboard.list')
        self.assertEqual(out['limit_n'], 8)
        self.assertEqual(payload['song_title'], 'Party Sector')


def row(user_id, score, played_at, name=None):
    return {
        'user_id': user_id,
        'display_name': name or user_id,
        'score': score,
        'played_at': played_at,
    }


def wrap_params(op, rows, **extra):
    payload = {
        'v': 'rhythm-jump/1', 'request_id': 'req_test', 'op': op, 'ok': True,
        'error': None, 'actor': 'u1', 'user_name': '小林',
        'now_ms': 1794460000000, 'song_id': 'party-full',
        'song_title': 'Party Sector · 完整', 'chart_version': 3,
        'run_id': 'run_1', 'score': 65000, 'accuracy': 70,
        'max_combo': 40, 'perfect': 60, 'good': 10, 'miss': 24, 'limit': 8,
    }
    payload.update(extra)
    return {'payload_json': json.dumps(payload, ensure_ascii=False), 'rows': rows}


class WrapTest(unittest.TestCase):
    def test_best_per_user_tie_and_rank(self):
        rows = [
            row('u1', 100, 10),
            row('u1', 200, 20),
            row('u2', 200, 15),
            row('u3', 300, 30),
        ]
        out = json.loads(run(wrap, wrap_params('leaderboard.list', rows))['response_json'])
        self.assertTrue(out['ok'])
        entries = out['data']['entries']
        self.assertEqual([e['score'] for e in entries], [300, 200, 200])
        self.assertEqual(entries[1]['display_name'], 'u2')
        self.assertEqual(entries[2]['display_name'], 'u1')
        self.assertEqual(out['data']['me'], {'position': 3, 'score': 200})
        self.assertEqual(out['data']['total_players'], 3)
        self.assertEqual(sum(e['is_me'] for e in entries), 1)

    def test_limit_and_me_outside_page(self):
        rows = [row('u%d' % i, 1000 + i, i) for i in range(1, 8)]
        out = json.loads(run(wrap, wrap_params('leaderboard.list', rows, limit=3))['response_json'])
        self.assertEqual(len(out['data']['entries']), 3)
        self.assertEqual(out['data']['me'], {'position': 7, 'score': 1001})

    def test_score_submit_marks_best(self):
        rows = [row('u1', 65000, 20), row('u2', 70000, 10)]
        out = json.loads(run(wrap, wrap_params('score.submit', rows, inserted=1))['response_json'])
        self.assertEqual(out['data']['submitted'], {'score': 65000, 'position': 2, 'is_best': 1})
        out = json.loads(run(wrap, wrap_params('score.submit', rows, score=60000, inserted=1))['response_json'])
        self.assertEqual(out['data']['submitted']['is_best'], 0)

    def test_user_wrap_and_empty(self):
        out = json.loads(run(wrap, wrap_params('user.upsert', []))['response_json'])
        self.assertEqual(out['data']['user']['user_id'], 'u1')
        self.assertEqual(out['data']['user']['display_name'], '小林')
        out = json.loads(run(wrap, wrap_params('leaderboard.list', []))['response_json'])
        self.assertEqual(out['data']['entries'], [])
        self.assertIsNone(out['data']['me'])

    def test_error_passthrough_and_bad_insert(self):
        params = wrap_params('score.submit', [])
        params['inserted'] = 0
        out = json.loads(run(wrap, params)['response_json'])
        self.assertEqual(out['error']['code'], 'DB_ERROR')
        error_payload = json.dumps({'v': 'rhythm-jump/1', 'request_id': 'r', 'op': '', 'ok': False, 'data': None, 'error': {'code': 'INVALID_REQUEST', 'message': 'bad', 'retryable': False}})
        out = json.loads(run(wrap, {'payload_json': error_payload})['response_json'])
        self.assertEqual(out['error']['code'], 'INVALID_REQUEST')


class SqliteIntegrationTest(unittest.TestCase):
    def test_top_rows_from_sqlite_match_wrap(self):
        db = sqlite3.connect(':memory:')
        db.executescript((ROOT / 'schema.sqlite.sql').read_text())
        fields = 'run_id,user_id,display_name,song_id,song_title,chart_version,score,accuracy,max_combo,perfect,good,miss,played_at,score_basis'
        values = [
            ('r1', 'u1', '小林', 'party-full', 'Party Sector · 完整', 3, 65000, 70, 40, 60, 10, 24, 100, 'client_reported'),
            ('r2', 'u2', '阿青', 'party-full', 'Party Sector · 完整', 3, 70000, 80, 60, 70, 10, 14, 200, 'client_reported'),
            ('r3', 'u1', '小林', 'party-full', 'Party Sector · 完整', 3, 60000, 65, 30, 55, 10, 29, 50, 'client_reported'),
        ]
        for item in values:
            db.execute('INSERT INTO rhythm_score(%s) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)' % fields, item)
        rows = [dict(zip(('run_id', 'user_id', 'display_name', 'song_id', 'song_title', 'chart_version', 'score', 'accuracy', 'max_combo', 'perfect', 'good', 'miss', 'played_at', 'score_basis'), item))
                for item in db.execute('SELECT %s FROM rhythm_score WHERE song_id=? AND chart_version=? ORDER BY score DESC LIMIT 100' % fields, ('party-full', 3))]
        self.assertEqual(len(rows), 3)
        out = json.loads(run(wrap, wrap_params('leaderboard.list', rows))['response_json'])
        self.assertEqual(out['data']['me'], {'position': 2, 'score': 65000})
        self.assertEqual(out['data']['entries'][0]['display_name'], '阿青')


class MergeTest(unittest.TestCase):
    def test_first_nonempty_branch_wins(self):
        self.assertEqual(run(merge, {'r0': '', 'r1': '{"ok":true}'}), {'response_json': '{"ok":true}'})
        out = json.loads(run(merge, {})['response_json'])
        self.assertEqual(out['error']['code'], 'NO_BRANCH')

    def test_adds_text_prefix_to_score_and_leaderboard_replies(self):
        board = run(wrap, wrap_params('leaderboard.list', []))['response_json']
        score = run(wrap, wrap_params('score.submit', [row('u1', 65000, 20)]))['response_json']
        self.assertEqual(run(merge, {'r1': board})['response_json'], 'RHYTHM_RESULT\n' + board)
        self.assertEqual(run(merge, {'r0': score, 'r1': board})['response_json'], 'RHYTHM_RESULT\n' + score)
        self.assertEqual(run(merge, {'r2': board})['response_json'], board)
        self.assertEqual(run(merge, {'r1': 'text'})['response_json'], 'text')


if __name__ == '__main__':
    unittest.main()
