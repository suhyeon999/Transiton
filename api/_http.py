import json
import os
import sys
import traceback
from urllib.parse import parse_qs, urlparse

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if ROOT not in sys.path:
    sys.path.insert(0, ROOT)


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


def handle_errors(fn):
    def wrapper(handler):
        try:
            fn(handler)
        except Exception as exc:
            send_json(
                handler,
                500,
                {
                    "error": str(exc),
                    "trace": traceback.format_exc()[:500],
                },
            )

    return wrapper
