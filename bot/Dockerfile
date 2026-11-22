FROM python:3.12-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
        fonts-dejavu-core \
    && rm -rf /var/lib/apt/lists/*

RUN pip install --no-cache-dir pillow

WORKDIR /app
COPY board_render.py bot.py ./

ENV PYTHONUNBUFFERED=1
CMD ["python3", "/app/bot.py"]
