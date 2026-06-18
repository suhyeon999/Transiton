from http.server import BaseHTTPRequestHandler

from _http import parse_query, qfloat, qstr, send_json
from transit_service import HOME_DEFAULT, get_service


class handler(BaseHTTPRequestHandler):
    def do_GET(self):
        try:
            params = parse_query(self.path)
            data = get_service().analyze(
                qstr(params, "destination", HOME_DEFAULT),
                qfloat(params, "origin_lat"),
                qfloat(params, "origin_lng"),
                qfloat(params, "dest_lat"),
                qfloat(params, "dest_lng"),
            )
            send_json(self, 200, data)
        except Exception as exc:
            send_json(self, 500, {"error": str(exc)})
