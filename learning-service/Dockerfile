FROM python:3.12-alpine

WORKDIR /app
COPY learning-service/server.py ./
COPY learning-service/engine ./engine
COPY learning /app/learning
CMD ["python", "/app/server.py"]
