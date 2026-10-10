# EarthOS: one container that serves the API and the built website from the same URL.

# ---- 1. build the frontend ----
FROM node:22-slim AS web
WORKDIR /app/frontend
COPY frontend/package.json frontend/package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY frontend/ ./
RUN npm run build \n && find dist -type f \( -name '*.js' -o -name '*.css' -o -name '*.json' -o -name '*.svg' \) -size +1k -exec gzip -9 -k {} +

# ---- 2. Python runtime ----
FROM python:3.11-slim
ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    FRONTEND_DIST=/app/frontend/dist \
    CACHE_DIR=/tmp/earthos-cache \
    ALLOWED_ORIGINS=
WORKDIR /app/backend
COPY backend/requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt
COPY backend/app ./app
COPY --from=web /app/frontend/dist /app/frontend/dist
RUN useradd --create-home earthos
USER earthos
EXPOSE 8000
# Hosts like Render, Railway and Fly set $PORT; default to 8000 elsewhere.
CMD ["sh", "-c", "uvicorn app.main:app --host 0.0.0.0 --port ${PORT:-8000} --proxy-headers --forwarded-allow-ips='*'"]
