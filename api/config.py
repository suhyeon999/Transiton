import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from http.server import BaseHTTPRequestHandler

from api_helpers import send_json


class handler(BaseHTTPRequestHandler):
    def do_GET(self):
        try:
            send_json(
                self,
                200,
                {
                    "supabaseUrl": os.environ.get("SUPABASE_URL", ""),
                    "supabaseAnonKey": os.environ.get("SUPABASE_ANON_KEY", ""),
                },
            )
        except Exception as exc:
            send_json(self, 500, {"error": str(exc)})
