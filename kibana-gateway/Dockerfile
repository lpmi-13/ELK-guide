FROM nginx:1.27.3-alpine

COPY kibana-gateway/nginx.conf /etc/nginx/nginx.conf
COPY kibana-gateway/runtime.json /usr/share/nginx/html/incident-coach/runtime.json
COPY kibana-coach /usr/share/nginx/html/incident-coach/assets
COPY telemetry/favicon.svg telemetry/favicon.png telemetry/favicon.ico telemetry/apple-touch-icon.png /usr/share/nginx/html/incident-coach/assets/
