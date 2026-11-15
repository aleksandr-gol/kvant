FROM oven/bun:1.3.8-slim

WORKDIR /app
ENV NODE_ENV=production \
    PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 \
    HOST=0.0.0.0 \
    PORT=8787 \
    NODE_EXTRA_CA_CERTS=/app/certs/russian_trusted_root_ca.pem

COPY package.json bun.lock ./
# Web edition needs no headless browser and no native sqlite (bun:sqlite is built in).
RUN bun install --frozen-lockfile --production --ignore-scripts

COPY SOUL.md tsconfig.json ./
COPY certs ./certs
COPY src ./src
COPY web ./web

USER bun
EXPOSE 8787
HEALTHCHECK --interval=30s --timeout=5s --retries=3 CMD bun -e "fetch('http://127.0.0.1:8787/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["bun", "run", "src/web/server.ts"]
