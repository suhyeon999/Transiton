import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from http.server import BaseHTTPRequestHandler

from api_helpers import send_json
from transit_service import get_service


class handler(BaseHTTPRequestHandler):
    def do_GET(self):
        try:
            data = get_service().get_realtime()
            send_json(self, 200, data)
        except Exception as exc:
            send_json(self, 500, {"error": str(exc)})
