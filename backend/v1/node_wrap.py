# Lingzhu code node B: wrap database rows into the response envelope.
# Inputs: payload_json (from code A), rows (query outputList), inserted
# (optional insert rowNum). Duplicate this node per selector branch; bind
# `rows` to that branch's query output.
import json

VERSION = 'rhythm-jump/1'


def dump(value):
    return json.dumps(value, ensure_ascii=False, sort_keys=True,
                      separators=(',', ':'), allow_nan=False)


def fail(request_id, code, message, retryable=False):
    return dump({
        'v': VERSION, 'request_id': request_id, 'ok': False, 'data': None,
        'error': {'code': code, 'message': message, 'retryable': retryable},
    })


def load_payload(value):
    if isinstance(value, dict):
        return value
    if not isinstance(value, str) or not value.strip():
        return None
    try:
        parsed = json.loads(value)
    except ValueError:
        return None
    return parsed if isinstance(parsed, dict) else None


def rows_of(value):
    if value is None or value == '':
        return []
    if isinstance(value, str):
        try:
            value = json.loads(value)
        except ValueError:
            return []
    if isinstance(value, dict) and isinstance(value.get('outputList'), list):
        value = value['outputList']
    if isinstance(value, list):
        return [row for row in value if isinstance(row, dict)]
    if isinstance(value, dict):
        return [value]
    return []


def as_int(value, default=0):
    if type(value) is int:
        return value
    if isinstance(value, float) and value.is_integer():
        return int(value)
    if isinstance(value, str) and value.strip():
        try:
            return int(value)
        except ValueError:
            return default
    return default


def board(payload, rows):
    best = {}
    for row in rows:
        user_id = row.get('user_id')
        if not isinstance(user_id, str) or not user_id:
            continue
        score = as_int(row.get('score'), -1)
        if score < 0:
            continue
        played_at = as_int(row.get('played_at'), 0)
        previous = best.get(user_id)
        if previous is None or score > previous['score'] or (
                score == previous['score'] and played_at < previous['achieved_at_ms']):
            best[user_id] = {
                'user_id': user_id,
                'score': score,
                'achieved_at_ms': played_at,
                'display_name': str(row.get('display_name') or '').strip(),
            }
    ordered = sorted(best.values(), key=lambda item: (
        -item['score'], item['achieved_at_ms'], item['user_id']))
    actor = payload.get('actor') or ''
    limit = as_int(payload.get('limit'), 8) or 8
    entries = [{
        'position': index + 1,
        'is_me': 1 if item['user_id'] == actor else 0,
        'display_name': item['display_name'],
        'score': item['score'],
        'achieved_at_ms': item['achieved_at_ms'],
    } for index, item in enumerate(ordered[:limit])]
    me = None
    for index, item in enumerate(ordered):
        if item['user_id'] == actor:
            me = {'position': index + 1, 'score': item['score']}
            break
    data = {
        'song_id': payload.get('song_id') or '',
        'song_title': str(payload.get('song_title') or '').strip(),
        'chart_version': as_int(payload.get('chart_version'), 0),
        'score_basis': 'client_reported',
        'entries': entries,
        'me': me,
        'total_players': len(ordered),
    }
    if payload.get('op') == 'score.submit':
        submitted = as_int(payload.get('score'), 0)
        data['submitted'] = {
            'score': submitted,
            'position': me['position'] if me else None,
            'is_best': 1 if me and me['score'] == submitted else 0,
        }
    return data


async def main(args):
    p = args.params
    payload = load_payload(p.get('payload_json'))
    if payload is None:
        return {'response_json': fail(None, 'BAD_PAYLOAD', '请求载荷缺失')}
    if payload.get('ok') is not True:
        return {'response_json': dump(payload)}

    request_id = payload.get('request_id')
    op = payload.get('op')
    rows = rows_of(p.get('rows'))
    if op == 'leaderboard.list' or op == 'score.submit':
        inserted = p.get('inserted')
        if op == 'score.submit' and inserted is not None and as_int(inserted, 1) == 0:
            return {'response_json': fail(request_id, 'DB_ERROR', '成绩写入失败', True)}
        return {'response_json': dump({
            'v': VERSION, 'request_id': request_id, 'ok': True,
            'data': board(payload, rows), 'error': None,
        })}

    if op == 'user.upsert':
        user = rows[0] if rows else None
        if user is None:
            now = as_int(payload.get('now_ms'), 0)
            user = {
                'user_id': payload.get('actor') or '',
                'display_name': (payload.get('user_name') or '').strip(),
                'created_at': now,
                'updated_at': now,
            }
        return {'response_json': dump({
            'v': VERSION, 'request_id': request_id, 'ok': True,
            'data': {'user': user}, 'error': None,
        })}

    return {'response_json': fail(request_id, 'UNKNOWN_OPERATION', '未知操作')}
