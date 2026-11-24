# Lingzhu code node A: validate the request and emit a compact payload.
# The output set is intentionally small: the database nodes only need the
# fields they write/query, and code B reads everything else from payload_json.
import json
import re
import time

VERSION = 'rhythm-jump/1'
MAX_BYTES = 24576
OPS = ('user.upsert', 'score.submit', 'leaderboard.list')

# Each chart version has its own note count and leaderboard.
SONGS = {
    'party-full': {
        'title': 'Party Sector',
        'duration_ms': 96000,
        'notes_by_version': {3: 94, 4: 69},
    },
    'beatucada': {
        'title': 'Beatucada',
        'duration_ms': 108475,
        'notes_by_version': {1: 32},
    },
    'into-my-dream': {
        'title': 'Into My Dream',
        'duration_ms': 146571,
        'notes_by_version': {1: 54},
    },
    'summer-overload': {
        'title': 'Summer Overload!',
        'duration_ms': 145424,
        'notes_by_version': {1: 55},
    },
}


def dump(value):
    return json.dumps(value, ensure_ascii=False, sort_keys=True,
                      separators=(',', ':'), allow_nan=False)


def no_dup(pairs):
    out = {}
    for key, value in pairs:
        if key in out:
            raise ValueError('duplicate key')
        out[key] = value
    return out


def text(value, limit=24):
    if (not isinstance(value, str) or not value.strip() or len(value) > limit
            or any(ord(char) < 32 for char in value)
            or '<' in value or '>' in value):
        raise ValueError('text field')
    return value.strip()


def ident(value):
    if not isinstance(value, str) or not re.fullmatch(r'[A-Za-z0-9_.:-]{1,100}', value):
        raise ValueError('identifier')
    return value


def integer(value, low, high):
    if type(value) is not int or not low <= value <= high:
        raise ValueError('integer range')
    return value


def song_of(song_id, chart_version):
    song = SONGS.get(song_id)
    if not song:
        raise ValueError('song')
    notes = song['notes_by_version'].get(chart_version)
    if notes is None:
        raise ValueError('chart version')
    return {**song, 'notes': notes}


async def main(args):
    out = {
        'op': '', 'payload_json': '', 'actor': '', 'user_name': '',
        'now_ms': int(time.time() * 1000), 'song_id': '', 'chart_version': 0,
        'run_id': '', 'score': 0, 'limit_n': 8,
    }
    request_id = None
    payload = {
        'v': VERSION, 'request_id': None, 'op': '', 'ok': False,
        'error': {'code': 'INVALID_REQUEST', 'message': 'request failed', 'retryable': False},
    }
    try:
        raw = args.params.get('input')
        if not isinstance(raw, str) or len(raw.encode('utf-8')) > MAX_BYTES:
            payload['error'] = {'code': 'INVALID_REQUEST', 'message': '输入必须是限定长度的 JSON 字符串', 'retryable': False}
            out['payload_json'] = dump(payload)
            return out
        try:
            request = json.loads(
                raw, object_pairs_hook=no_dup,
                parse_constant=lambda _: (_ for _ in ()).throw(ValueError('nan')))
        except (ValueError, RecursionError):
            payload['error'] = {'code': 'INVALID_REQUEST', 'message': 'JSON 解析失败', 'retryable': False}
            out['payload_json'] = dump(payload)
            return out
        if not isinstance(request, dict) or set(request) != {'v', 'request_id', 'actor', 'op', 'data'}:
            payload['error'] = {'code': 'INVALID_REQUEST', 'message': '请求字段缺失或包含未支持字段', 'retryable': False}
            out['payload_json'] = dump(payload)
            return out
        request_id = request['request_id']
        payload['request_id'] = request_id
        payload['op'] = request['op'] if isinstance(request['op'], str) else ''
        if request['v'] != VERSION:
            payload['error'] = {'code': 'UNSUPPORTED_VERSION', 'message': '协议版本不支持', 'retryable': False}
            out['payload_json'] = dump(payload)
            return out
        request_id = ident(request_id)
        payload['request_id'] = request_id
        actor = request['actor']
        if not isinstance(actor, dict) or set(actor) != {'id', 'name'}:
            payload['error'] = {'code': 'INVALID_REQUEST', 'message': 'actor 字段无效', 'retryable': False}
            out['payload_json'] = dump(payload)
            return out
        out['actor'] = ident(actor['id'])
        out['user_name'] = text(actor['name'], 24)
        payload['user_name'] = out['user_name']
        payload['actor'] = out['actor']
        payload['now_ms'] = out['now_ms']
        if request['op'] not in OPS:
            payload['error'] = {'code': 'UNKNOWN_OPERATION', 'message': '未知操作', 'retryable': False}
            out['payload_json'] = dump(payload)
            return out
        if not isinstance(request['data'], dict):
            payload['error'] = {'code': 'INVALID_REQUEST', 'message': 'data 必须是对象', 'retryable': False}
            out['payload_json'] = dump(payload)
            return out
        out['op'] = request['op']
        payload['op'] = out['op']
        data = request['data']

        if out['op'] == 'user.upsert':
            if set(data) - {'display_name'}:
                raise ValueError('user fields')
            if 'display_name' in data:
                out['user_name'] = text(data['display_name'], 24)
            payload['user_name'] = out['user_name']

        elif out['op'] == 'score.submit':
            need = {'song_id', 'chart_version', 'run_id', 'score',
                    'max_combo', 'perfect', 'good', 'miss'}
            if set(data) != need:
                raise ValueError('score fields')
            out['song_id'] = ident(data['song_id'])
            out['chart_version'] = integer(data['chart_version'], 1, 1000)
            song = song_of(out['song_id'], out['chart_version'])
            out['run_id'] = ident(data['run_id'])
            out['score'] = integer(data['score'], 0, 1000 * song['notes'])
            out['max_combo'] = integer(data['max_combo'], 0, song['notes'])
            out['perfect'] = integer(data['perfect'], 0, song['notes'])
            out['good'] = integer(data['good'], 0, song['notes'])
            out['miss'] = integer(data['miss'], 0, song['notes'])
            if out['perfect'] + out['good'] + out['miss'] != song['notes']:
                raise ValueError('note total')
            if out['max_combo'] > out['perfect'] + out['good']:
                raise ValueError('combo')
            if out['score'] > 1000 * out['perfect'] + 500 * out['good']:
                raise ValueError('score cap')
            payload.update({
                'song_id': out['song_id'], 'song_title': song['title'],
                'chart_version': out['chart_version'], 'run_id': out['run_id'],
                'score': out['score'],
                'accuracy': int(round((out['perfect'] + 0.6 * out['good']) / song['notes'] * 100)),
                'max_combo': out['max_combo'], 'perfect': out['perfect'],
                'good': out['good'], 'miss': out['miss'], 'limit': 8,
            })

        else:  # leaderboard.list
            if set(data) != {'song_id', 'chart_version', 'limit'}:
                raise ValueError('leaderboard fields')
            out['song_id'] = ident(data['song_id'])
            out['chart_version'] = integer(data['chart_version'], 1, 1000)
            song = song_of(out['song_id'], out['chart_version'])
            out['limit_n'] = integer(data['limit'], 1, 20)
            payload.update({
                'song_id': out['song_id'], 'song_title': song['title'],
                'chart_version': out['chart_version'], 'limit': out['limit_n'],
            })

        payload['ok'] = True
        payload['error'] = None
        out['payload_json'] = dump(payload)
        return out
    except ValueError:
        payload['ok'] = False
        payload['error'] = {'code': 'INVALID_REQUEST', 'message': '字段、类型或范围不合法', 'retryable': False}
        payload['op'] = payload.get('op') if payload.get('op') in OPS else ''
        out['op'] = ''
        out['payload_json'] = dump(payload)
        return out
    except Exception:
        payload['ok'] = False
        payload['error'] = {'code': 'INVALID_REQUEST', 'message': '请求处理失败', 'retryable': False}
        out['op'] = ''
        out['payload_json'] = dump(payload)
        return out
