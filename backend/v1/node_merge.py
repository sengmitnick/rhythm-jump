# Lingzhu merge node: all branch wrap nodes point here, then the End node
# references response_json. Accepting several inputs avoids the platform error
# "引用变量不存在" when End has multiple incoming edges.
import json

VERSION = 'rhythm-jump/1'


async def main(args):
    p = args.params
    for index in range(8):
        value = p.get('r%d' % index)
        if isinstance(value, str) and value.strip():
            if index in (0, 1):
                # AIUI delivers score and leaderboard replies as prefixed text.
                try:
                    response = json.loads(value)
                except ValueError:
                    response = None
                if isinstance(response, dict) and response.get('v') == VERSION:
                    value = 'RHYTHM_RESULT\n' + value
            return {'response_json': value}
    return {'response_json': json.dumps({
        'v': VERSION, 'request_id': None, 'ok': False, 'data': None,
        'error': {'code': 'NO_BRANCH', 'message': '没有任何分支产出结果',
                  'retryable': False},
    }, ensure_ascii=False)}
