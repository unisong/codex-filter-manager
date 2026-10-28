"""Exercise the installed Magpie engine with a disposable profile and fake upstream.

Only loopback model requests are made; no installed provider keys are read.
"""
import argparse
import json
import os
from pathlib import Path
import shutil
import socket
import subprocess
import tempfile
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import urllib.error
import urllib.request


def free_port():
    with socket.socket() as sock:
        sock.bind(('127.0.0.1', 0))
        return sock.getsockname()[1]


def functions(tools):
    for tool in tools:
        if tool.get('type') == 'namespace':
            yield from functions(tool.get('tools', []))
        elif tool.get('type') == 'function':
            yield tool.get('function', tool)


def schemas(body):
    yield from functions(body.get('tools', []))
    for item in body.get('input', []) if isinstance(body.get('input'), list) else []:
        if item.get('type') in ('additional_tools', 'tool_search_output'):
            yield from functions(item.get('tools', []))


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--binary', required=True)
    parser.add_argument('--middleware', required=True)
    parser.add_argument('--schema', help='Optional local tool schema, never sent off this computer')
    parser.add_argument('--expect-broken', action='store_true')
    args = parser.parse_args()
    scratch = Path(tempfile.mkdtemp(prefix='magpie-deferred-schema-')).resolve()
    print('Evidence directory:', scratch, flush=True)
    app = scratch / 'app'
    app.mkdir()
    binary = app / 'magpie.exe'
    shutil.copy2(Path(args.binary).resolve(), binary)
    (app / '.portable').write_text('')
    data = app / 'data'
    data.mkdir()
    profile = scratch / 'profile'
    profile.mkdir()
    plugin = scratch / 'schema.middleware.js'
    shutil.copy2(Path(args.middleware).resolve(), plugin)
    schema = json.loads(Path(args.schema).read_text(encoding='utf-8')) if args.schema else {
        'oneOf': [{'$ref': '#/$defs/read'}, {'$ref': '#/$defs/changes'}],
        '$defs': {
            'read': {'type': 'object', 'properties': {'mode': {'enum': ['view']}, 'id': {'type': 'string'}}, 'required': ['mode', 'id']},
            'changes': {'oneOf': [
                {'type': 'object', 'properties': {'mode': {'enum': ['create']}, 'prompt': {'type': 'string'}}, 'required': ['mode', 'prompt']},
                {'type': 'object', 'properties': {'mode': {'enum': ['update']}, 'id': {'type': 'string'}}, 'required': ['mode', 'id']}]}}}
    seen = []

    class Mock(BaseHTTPRequestHandler):
        def log_message(self, *_):
            pass

        def do_POST(self):
            body = json.loads(self.rfile.read(int(self.headers['Content-Length'])))
            offered = list(schemas(body))
            target = [tool for tool in offered if 'automation_update' in tool.get('name', '')]
            valid = bool(target) and all(tool.get('parameters', {}).get('type') == 'object' for tool in target)
            seen.append({'path': self.path, 'valid': valid, 'targets': len(target), 'bytes': len(json.dumps(body)),
                         'properties': [sorted(t.get('parameters', {}).get('properties', {})) for t in target]})
            if not valid:
                reply = json.dumps({'error': {'message': 'Invalid schema for function automation_update: root type must be object',
                                             'type': 'invalid_request_error'}}).encode()
                self.send_response(400)
                self.send_header('Content-Type', 'application/json')
            else:
                if self.path.endswith('/responses'):
                    response = {'id': 'resp_local', 'object': 'response', 'status': 'completed', 'model': body['model'],
                                'output': [{'id': 'msg_local', 'type': 'message', 'role': 'assistant', 'status': 'completed',
                                            'content': [{'type': 'output_text', 'text': 'LOCAL_SCHEMA_OK', 'annotations': []}]}],
                                'usage': {'input_tokens': 8, 'output_tokens': 4, 'total_tokens': 12}}
                    reply = ('event: response.completed\ndata: ' + json.dumps({'type': 'response.completed', 'response': response}) + '\n\n').encode()
                else:
                    chunk = {'id': 'chatcmpl_local', 'object': 'chat.completion.chunk', 'model': body['model'],
                             'choices': [{'index': 0, 'delta': {'role': 'assistant', 'content': 'LOCAL_SCHEMA_OK'}, 'finish_reason': None}]}
                    end = {**chunk, 'choices': [{'index': 0, 'delta': {}, 'finish_reason': 'stop'}],
                           'usage': {'prompt_tokens': 8, 'completion_tokens': 4, 'total_tokens': 12}}
                    reply = ('data: ' + json.dumps(chunk) + '\n\ndata: ' + json.dumps(end) + '\n\ndata: [DONE]\n\n').encode()
                self.send_response(200)
                self.send_header('Content-Type', 'text/event-stream')
            self.send_header('Content-Length', str(len(reply)))
            self.end_headers()
            self.wfile.write(reply)

    upstream = ThreadingHTTPServer(('127.0.0.1', 0), Mock)
    threading.Thread(target=upstream.serve_forever, daemon=True).start()
    port, web_port = free_port(), free_port()
    origin = f'http://127.0.0.1:{port}'
    settings = {'port': port, 'noUsageStats': True, 'autoRestart': False, 'updateEvery': 1440,
                'modelAPIs': {'schema-fixture/deepseek-v4.1-flash': 'responses'}}
    (data / 'settings.json').write_text(json.dumps(settings))
    (data / 'plugins.yml').write_text('preset: all\n')
    (data / 'providers.json').write_text(json.dumps({'providers': [{
        'id': 'schema-fixture', 'name': 'Local schema fixture', 'key': 'LOCAL_ONLY',
        'responses': f'http://127.0.0.1:{upstream.server_port}/v1',
        'chat': f'http://127.0.0.1:{upstream.server_port}/v1',
        'models': ['deepseek-v4.1-flash'], 'contexts': {'*': 1000000}}]}))
    (data / 'plugins.json').write_text(json.dumps({'plugins': [{'spec': str(plugin), 'options': {
        'providers': {'magpie:schema-fixture': {'historyFilter': False, 'deepSeekObjectRoot': True}},
        'aliases': {},
    }}]}))
    env = {k: v for k, v in os.environ.items() if k.upper() in
           ('SYSTEMROOT', 'WINDIR', 'PATH', 'TEMP', 'TMP', 'PATHEXT', 'COMSPEC')}
    env.update({'USERPROFILE': str(profile), 'HOME': str(profile), 'XDG_CONFIG_HOME': str(scratch / 'config'),
                'XDG_CACHE_HOME': str(scratch / 'cache'), 'MAGPIE_ADDR': f'127.0.0.1:{port}',
                'MAGPIE_WEB_KEY': 'local-schema-fixture', 'MAGPIE_PLUGIN_MARKET': 'off'})
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    log = (scratch / 'magpie.log').open('wb')
    proc = None
    results = []
    try:
        proc = subprocess.Popen([str(binary), 'serve', f'--web=127.0.0.1:{web_port}'], cwd=app, env=env,
                                stdout=log, stderr=log, creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0))
        for _ in range(100):
            try:
                with opener.open(origin, timeout=1) as r:
                    assert json.load(r)['pid'] == proc.pid
                break
            except Exception:
                if proc.poll() is not None:
                    raise RuntimeError('Isolated Magpie exited; see ' + str(scratch / 'magpie.log'))
                time.sleep(.1)
        else:
            raise RuntimeError('Isolated Magpie did not become ready')
        for protocol in ['responses', 'chat']:
            settings['modelAPIs']['schema-fixture/deepseek-v4.1-flash'] = protocol
            (data / 'settings.json').write_text(json.dumps(settings))
            time.sleep(1.1)
            for location, megabytes in [('top', 0), ('additional_tools', 0), ('tool_search_output', 0), ('tool_search_output', 4)]:
                tool = {'type': 'namespace', 'name': 'codex_app', 'tools': [{'type': 'function', 'name': 'automation_update',
                        'description': 'Local fixture; do not execute.', 'parameters': schema, 'strict': False}]}
                body = {'model': 'schema-fixture/deepseek-v4.1-flash', 'stream': True, 'max_output_tokens': 64,
                        'input': [{'role': 'user', 'content': 'Return LOCAL_SCHEMA_OK only.'}]}
                if location == 'top':
                    body['tools'] = [tool]
                elif location == 'additional_tools':
                    body['input'].insert(0, {'type': location, 'tools': [tool]})
                else:
                    body['tools'] = [{'type': 'tool_search', 'execution': 'client'}]
                    body['input'] = [{'type': 'tool_search_call', 'call_id': 'call_schema', 'arguments': {'query': 'local fixture'}},
                                     {'type': 'tool_search_output', 'call_id': 'call_schema', 'tools': [tool]}] + body['input']
                if megabytes:
                    body['input'].insert(0, {'role': 'user', 'content': 'Local history fixture. ' * (megabytes * 1024 * 1024 // 23)})
                request = urllib.request.Request(origin + '/v1/responses', data=json.dumps(body).encode(),
                          headers={'Content-Type': 'application/json', 'User-Agent': 'codex_cli_rs/local-schema-fixture'})
                count_before = len(seen)
                try:
                    response = opener.open(request, timeout=35)
                except urllib.error.HTTPError as error:
                    response = error
                with response:
                    text = response.read().decode()
                    status = response.status
                success = 'response.completed' in text and 'LOCAL_SCHEMA_OK' in text
                result = {'protocol': protocol, 'location': location, 'historyMB': megabytes, 'status': status,
                          'completed': success, 'upstream': seen[count_before:]}
                results.append(result)
                print(json.dumps(result), flush=True)
                if not args.expect_broken:
                    assert success and seen[count_before:] and all(x['valid'] for x in seen[count_before:]), result
        if args.expect_broken:
            assert any(not r['completed'] and r['location'] == 'tool_search_output' for r in results)
        (scratch / 'result.json').write_text(json.dumps({'passed': True, 'supplierRequests': 0, 'results': results}, indent=2))
        print('PASS: isolated native gateway schema checks; supplierRequests=0', flush=True)
    finally:
        if proc and proc.poll() is None:
            proc.terminate()
            proc.wait(timeout=10)
        log.close()
        upstream.shutdown()
        upstream.server_close()


if __name__ == '__main__':
    main()
