#!/bin/bash
# MTG Agent installer
# Usage: bash install-agent.sh [AGENT_TOKEN]

set -e

TOKEN="${1:-mtg-agent-secret}"
INSTALL_DIR="/opt/mtg-agent"

echo "📦 Installing MTG Agent..."

# Create dir
mkdir -p "$INSTALL_DIR"
cd "$INSTALL_DIR"

# Write docker-compose.yml
cat > docker-compose.yml << EOF
services:
  mtg-agent:
    image: python:3.12-alpine
    container_name: mtg-agent
    restart: unless-stopped
    ports:
      - "8081:8081"
    volumes:
      - /var/run/docker.sock:/var/run/docker.sock:ro
      - ./main.py:/app/main.py:ro
    working_dir: /app
    environment:
      - AGENT_TOKEN=${TOKEN}
    command: sh -c "pip install --quiet fastapi uvicorn docker && uvicorn main:app --host 0.0.0.0 --port 8081"
EOF

# Write main.py
cat > main.py << 'PYEOF'
import os
from fastapi import FastAPI, HTTPException, Header
from fastapi.responses import JSONResponse
import docker

app = FastAPI()
AGENT_TOKEN = os.environ.get("AGENT_TOKEN", "mtg-agent-secret")
client = docker.from_env()

def get_connections(container):
    try:
        result = container.exec_run("cat /proc/net/tcp", demux=False)
        if result.exit_code != 0:
            return 0
        output = result.output.decode("utf-8", errors="ignore")
        return sum(1 for line in output.strip().split("\n")[1:] if len(line.split()) >= 4 and line.split()[3] == "01")
    except:
        return 0

def get_traffic(container):
    try:
        stats = container.stats(stream=False)
        nets = stats.get("networks", {})
        rx = sum(v.get("rx_bytes", 0) for v in nets.values())
        tx = sum(v.get("tx_bytes", 0) for v in nets.values())
        def fmt(b):
            if b >= 1073741824: return f"{b/1073741824:.2f}GB"
            if b >= 1048576: return f"{b/1048576:.2f}MB"
            if b >= 1024: return f"{b/1024:.2f}KB"
            return f"{b}B"
        return {"rx": fmt(rx), "tx": fmt(tx), "rx_bytes": rx, "tx_bytes": tx}
    except:
        return {"rx": "—", "tx": "—", "rx_bytes": 0, "tx_bytes": 0}

@app.get("/health")
def health():
    return {"status": "ok"}

@app.get("/metrics")
def metrics(x_agent_token: str = Header(default="")):
    if x_agent_token != AGENT_TOKEN:
        raise HTTPException(status_code=401, detail="Unauthorized")
    containers = [c for c in client.containers.list(all=True) if c.name.startswith("mtg-")]
    result = []
    for c in containers:
        running = c.status == "running"
        conns = get_connections(c) if running else 0
        traf = get_traffic(c) if running else {"rx":"—","tx":"—","rx_bytes":0,"tx_bytes":0}
        result.append({"name": c.name, "running": running, "status": c.status, "connections": conns, "is_online": conns > 0, "traffic": traf})
    return JSONResponse({"containers": result})
PYEOF

# Write .env
echo "AGENT_TOKEN=${TOKEN}" > .env

echo "🚀 Starting MTG Agent..."
docker compose up -d

echo ""
echo "✅ MTG Agent installed at ${INSTALL_DIR}"
echo "🔑 Token: ${TOKEN}"
echo "🌐 Port: 8081"
echo ""
echo "Test: curl -s -H 'x-agent-token: ${TOKEN}' http://localhost:8081/metrics"
