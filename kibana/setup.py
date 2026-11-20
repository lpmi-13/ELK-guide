"""Import the baseline saved objects into Kibana's default Space at startup."""

import json
import os
import time
import uuid
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen


kibana_url = os.getenv("KIBANA_INTERNAL_URL", "http://kibana:5601").rstrip("/")
saved_objects = Path(os.getenv("KIBANA_SAVED_OBJECTS", "/app/kibana/saved-objects.ndjson"))

while True:
    try:
        with urlopen(f"{kibana_url}/api/status", timeout=5) as response:
            if response.status == 200:
                break
    except (HTTPError, URLError, TimeoutError):
        pass
    time.sleep(2)

boundary = f"incident-lab-{uuid.uuid4().hex}"
body = (
    f'--{boundary}\r\nContent-Disposition: form-data; name="file"; filename="saved-objects.ndjson"\r\n'
    "Content-Type: application/ndjson\r\n\r\n"
).encode() + saved_objects.read_bytes() + f"\r\n--{boundary}--\r\n".encode()
request = Request(
    f"{kibana_url}/api/saved_objects/_import?overwrite=true",
    data=body,
    headers={"kbn-xsrf": "incident-lab-setup", "Content-Type": f"multipart/form-data; boundary={boundary}"},
)
try:
    with urlopen(request, timeout=30) as response:
        result = json.load(response)
except HTTPError as error:
    raise SystemExit(f"Kibana saved-object import failed ({error.code}): {error.read().decode(errors='replace')}") from error
if not result.get("success", False):
    raise SystemExit(f"Kibana saved-object import failed: {result.get('errors', result)}")
print("Kibana incident-lab saved objects imported")
