FROM python:3.12-slim

ARG PIP_INDEX_URL=https://pypi.org/simple

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    REXHUB_PORT=3002 \
    REXHUB_DATA_DIR=/app/server/data

RUN apt-get update \
 && apt-get install -y --no-install-recommends openssh-client gosu \
 && rm -rf /var/lib/apt/lists/* \
 && pip install -i "$PIP_INDEX_URL" psutil==6.1.0

WORKDIR /app

COPY server/ /app/server/
COPY web/ /app/web/
COPY docker-entrypoint.sh /app/docker-entrypoint.sh

RUN useradd --system --uid 10001 --create-home --home-dir /home/studiolo studiolo \
 && chmod +x /app/docker-entrypoint.sh \
 && mkdir -p /app/server/data \
 && chown -R studiolo:studiolo /app

USER root
EXPOSE 3002
VOLUME ["/app/server/data"]

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD python -c "import os, urllib.request; urllib.request.urlopen('http://127.0.0.1:' + os.environ.get('REXHUB_PORT', '3002') + '/api/v1/health', timeout=4)" || exit 1

ENTRYPOINT ["/app/docker-entrypoint.sh"]
