"""The launch handoff relay (telemetry/service.py) and the pages that use it.

Start opens /preparing#<launch id> in a new tab. When the launcher can't reach that tab (on iximiuz it runs
in a pane inside a Cross-Origin-Opener-Policy: same-origin page, so the tab opens as noopener), the tab
learns the outcome by polling the relay. These tests drive the telemetry service's real HTTP handler.
"""

import importlib.util
import json
import os
import tempfile
import threading
import unittest
from http.server import ThreadingHTTPServer
from pathlib import Path
from urllib.error import HTTPError
from urllib.request import Request, urlopen

ROOT = Path(__file__).resolve().parents[1]
os.environ.setdefault("LOG_DIR", tempfile.mkdtemp(prefix="telemetry-test-"))
spec = importlib.util.spec_from_file_location("launch_handoff_service", ROOT / "telemetry/service.py")
service = importlib.util.module_from_spec(spec)
spec.loader.exec_module(service)

LAUNCH_ID = "0f8e2c1a-5b7d-4e3f-9a6b-1c2d3e4f5a6b"


class HandoffRelayTests(unittest.TestCase):
    def setUp(self):
        service.handoffs.clear()
        self.server = ThreadingHTTPServer(("127.0.0.1", 0), service.Handler)
        threading.Thread(target=self.server.serve_forever, daemon=True).start()
        self.base = f"http://127.0.0.1:{self.server.server_address[1]}"

    def tearDown(self):
        self.server.shutdown()
        self.server.server_close()

    def get(self, path):
        with urlopen(f"{self.base}{path}") as response:
            return response.status, json.loads(response.read())

    def post(self, path, body):
        data = body if isinstance(body, bytes) else json.dumps(body).encode()
        request = Request(f"{self.base}{path}", data=data, method="POST", headers={"Content-Type": "application/json"})
        try:
            with urlopen(request) as response:
                return response.status
        except HTTPError as error:
            return error.code

    def test_an_outcome_not_yet_posted_reads_as_pending(self):
        self.assertEqual(self.get(f"/preparing/handoff/{LAUNCH_ID}"), (200, {"pending": True}))

    def test_the_tab_reads_the_url_the_launcher_posted(self):
        url = "https://lab.example/app/discover#/view/incident-investigation?incident_coach_session=s1"
        self.assertEqual(self.post(f"/preparing/handoff/{LAUNCH_ID}", {"url": url}), 204)
        self.assertEqual(self.get(f"/preparing/handoff/{LAUNCH_ID}"), (200, {"url": url}))
        # Reading doesn't consume it, so a refreshed tab can still find it.
        self.assertEqual(self.get(f"/preparing/handoff/{LAUNCH_ID}"), (200, {"url": url}))

    def test_the_tab_reads_why_preparation_stopped(self):
        halt = {"heading": "Preparation did not complete", "message": "Start it again.", "link": ""}
        self.assertEqual(self.post(f"/preparing/handoff/{LAUNCH_ID}", {"halt": halt}), 204)
        self.assertEqual(self.get(f"/preparing/handoff/{LAUNCH_ID}"), (200, {"halt": halt}))

    def test_only_web_urls_and_text_halts_are_kept(self):
        for body in ({"url": "javascript:alert(1)"}, {"url": 7}, {"halt": {"heading": 1}}, {"halt": "stop"}, [], b"not json"):
            self.assertEqual(self.post(f"/preparing/handoff/{LAUNCH_ID}", body), 400, body)
        self.assertEqual(self.post(f"/preparing/handoff/{LAUNCH_ID}", {"url": "https://x/" + "a" * 9000}), 413)
        self.assertEqual(self.get(f"/preparing/handoff/{LAUNCH_ID}"), (200, {"pending": True}))

    def test_launch_ids_must_look_like_ids(self):
        for path in ("/preparing/handoff/short", "/preparing/handoff/../../etc", f"/preparing/handoff/{LAUNCH_ID}/x"):
            with self.assertRaises(HTTPError) as raised:
                urlopen(f"{self.base}{path}")
            self.assertEqual(raised.exception.code, 404, path)
            self.assertEqual(self.post(path, {"url": "https://x/"}), 404, path)

    def test_old_and_excess_outcomes_are_dropped(self):
        service.store_handoff("a" * 20, b'{"url":"https://old/"}')
        service.handoffs["a" * 20] = (service.handoffs["a" * 20][0] - service.HANDOFF_TTL_SECONDS - 1, service.handoffs["a" * 20][1])
        self.assertEqual(service.read_handoff("a" * 20), b'{"pending":true}')
        for index in range(service.HANDOFF_LIMIT + 5):
            service.store_handoff(f"{index:020d}", b'{"url":"https://x/"}')
        self.assertLessEqual(len(service.handoffs), service.HANDOFF_LIMIT)
        self.assertNotIn(f"{0:020d}", service.handoffs)
        self.assertIn(f"{service.HANDOFF_LIMIT + 4:020d}", service.handoffs)


class HandoffWiringTests(unittest.TestCase):
    def test_the_launcher_relays_every_outcome_under_the_tab_launch_id(self):
        launcher = (ROOT / "telemetry/index.html").read_text(encoding="utf-8")
        self.assertIn("launchId = crypto.randomUUID();\n      investigationTab = openPrepTab();", launcher)
        self.assertIn("return window.open(`/preparing#${launchId}`, '_blank')", launcher)
        self.assertIn("fetch(`/preparing/handoff/${launchId}`, {method: 'POST'", launcher)
        # Success, and every halt (they all go through tabMessage), reach a tab the launcher can't see.
        self.assertIn("relayToTab({url: investigationUrl})", launcher)
        self.assertIn("relayToTab({halt: {heading:", launcher)

    def test_the_preparation_page_polls_for_its_launch_outcome(self):
        page = (ROOT / "telemetry/preparing.html").read_text(encoding="utf-8")
        self.assertIn("fetch(`/preparing/handoff/${launchId}`", page)
        self.assertIn("/^#([A-Za-z0-9-]{16,64})$/.exec(location.hash)", page)
        self.assertIn("const url = webUrl(outcome?.url)", page)

    def test_the_gateway_routes_the_relay_to_the_telemetry_service(self):
        gateway = (ROOT / "kibana-gateway/nginx.conf").read_text(encoding="utf-8")
        route = gateway.index("location /preparing/handoff/ {")
        self.assertLess(route, gateway.index("location / {"))
        self.assertIn("proxy_pass http://browser-telemetry:8090;", gateway[route:route + 200])


if __name__ == "__main__":
    unittest.main()
