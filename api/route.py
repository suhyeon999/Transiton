import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from http.server import BaseHTTPRequestHandler

from api_helpers import parse_query, qfloat, qstr, send_json
from transit_service import DEFAULT_LOCATION, HOME_DEFAULT, get_service


class handler(BaseHTTPRequestHandler):
    def do_GET(self):
        try:
            params = parse_query(self.path)
            dest_lat = qfloat(params, "dest_lat")
            dest_lng = qfloat(params, "dest_lng")
            if dest_lat is None or dest_lng is None:
                send_json(self, 400, {"error": "dest_lat and dest_lng required"})
                return

            data = get_service().plan_transit_route(
                qfloat(params, "origin_lat", DEFAULT_LOCATION["lat"]),
                qfloat(params, "origin_lng", DEFAULT_LOCATION["lon"]),
                dest_lat,
                dest_lng,
                qstr(params, "dest_name", HOME_DEFAULT),
                qstr(params, "origin_label", DEFAULT_LOCATION["label"]),
            )
            send_json(self, 200, data)
        except Exception as exc:
            send_json(self, 500, {"error": str(exc)})
