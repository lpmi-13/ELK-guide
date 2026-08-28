FROM mcr.microsoft.com/playwright:v1.62.1-noble

WORKDIR /app
COPY scenario-recorder/package.json scenario-recorder/package-lock.json ./
RUN npm ci --omit=dev
COPY scenario-recorder/recorder.mjs ./
COPY learning/selectors/kibana-8.15.json ./selectors.json
CMD ["npm", "run", "record"]
