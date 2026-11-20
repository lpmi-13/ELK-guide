FROM python:3.12-alpine

WORKDIR /app
COPY scenario-controller/controller.py ./
COPY scenario-controller/scenarios ./scenarios
COPY learning ./learning
COPY kibana/saved-objects.ndjson ./kibana/saved-objects.ndjson
COPY kibana/setup.py ./kibana/setup.py
CMD ["python", "/app/controller.py"]
