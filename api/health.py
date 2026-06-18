from datetime import datetime
from http.server import BaseHTTPRequestHandler

from _http import send_json
from transit_service import get_service


class handler(BaseHTTPRequestHandler):
    def do_GET(self):
        try:
            send_json(
                self,
                200,
                {
                    "status": "ok",
                    "service": "TransitON",
                    "runtime": "vercel",
                    "time": datetime.now().isoformat(),
                },
            )
        except Exception as exc:
            send_json(self, 500, {"error": str(exc)})
