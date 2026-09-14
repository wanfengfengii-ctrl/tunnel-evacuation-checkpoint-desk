FROM python:3.11-slim

WORKDIR /app

COPY requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt

COPY app ./app

# Location of the single SQLite file; compose mounts a volume here so the
# unique current drill survives API restarts/rebuilds.
ENV DRILL_DB_PATH=/data/drill.db
EXPOSE 8000

CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000"]
