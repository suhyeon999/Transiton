import json
from urllib.parse import parse_qs, urlparse


def parse_query(path):
    return parse_qs(urlparse(path).query)


def qfloat(params, key, default=None):
    raw = params.get(key, [None])[0]
    if raw is None or raw == "":
        return default
    return float(raw)


def qstr(params, key, default=""):
    raw = params.get(key, [None])[0]
    return raw if raw not in (None, "") else default


def send_json(handler, status, payload):
    body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
    handler.send_response(status)
    handler.send_header("Content-Type", "application/json; charset=utf-8")
    handler.send_header("Access-Control-Allow-Origin", "*")
    handler.end_headers()
    handler.wfile.write(body)
