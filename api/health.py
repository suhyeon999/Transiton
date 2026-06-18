import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from datetime import datetime
from http.server import BaseHTTPRequestHandler

from api_helpers import send_json


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
