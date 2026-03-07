const { Client } = require('ssh2');

function sshExec(node, command) {
  return new Promise((resolve, reject) => {
    const conn = new Client();
    let output = '';
    let errOutput = '';

    const config = {
      host: node.host,
      port: node.ssh_port || 22,
      username: node.ssh_user || 'root',
      readyTimeout: 8000,
    };

    if (node.ssh_key) {
      config.privateKey = node.ssh_key;
    } else if (node.ssh_password) {
      config.password = node.ssh_password;
    }

    const wrappedCommand = command;

    conn.on('ready', () => {
      conn.exec(wrappedCommand, (err, stream) => {
        if (err) { conn.end(); return reject(err); }
        stream.on('data', d => { output += d.toString(); });
        stream.stderr.on('data', d => { errOutput += d.toString(); });
        stream.on('close', (code) => {
          conn.end();
          resolve({ output: output.trim(), error: errOutput.trim(), code });
        });
      });
    });

    conn.on('error', err => reject(err));
    conn.connect(config);
  });
}

async function checkNode(node) {
  try {
    const r = await sshExec(node, 'echo ok');
    return r.output === 'ok';
  } catch {
    return false;
  }
}

async function getNodeStatus(node) {
  try {
    const r = await sshExec(node, "COUNT=$(docker ps --filter 'name=mtg-' --format '{{.Names}}' 2>/dev/null | wc -l); echo \"ONLINE|$COUNT\"");
    if (r.output.startsWith('ONLINE|')) {
      const count = parseInt(r.output.split('|')[1]) || 0;
      return { online: true, containers: count };
    }
    return { online: false, containers: 0 };
  } catch {
    return { online: false, containers: 0 };
  }
}

async function getRemoteUsers(node) {
  try {
    const cmd = [
      'BASE=' + node.base_dir,
      'for DIR in $BASE/*/; do',
      '  [ -d "$DIR" ] || continue',
      '  NAME=$(basename "$DIR")',
      "  SECRET=$(grep secret \"$DIR/config.toml\" 2>/dev/null | awk -F'\"' '{print $2}')",
      "  PORT=$(grep -o '[0-9]*:3128' \"$DIR/docker-compose.yml\" 2>/dev/null | cut -d: -f1)",
      "  STATUS=$(docker ps --filter \"name=mtg-$NAME\" --format '{{.Status}}' 2>/dev/null)",
      '  CONNS=$(docker exec mtg-$NAME cat /proc/net/tcp 2>/dev/null | grep -v local | wc -l || echo 0)',
      '  echo "USER|$NAME|$PORT|$SECRET|${STATUS:-stopped}|$CONNS"',
      'done'
    ].join('\n');

    const r = await sshExec(node, cmd);
    const users = [];
    for (const line of r.output.split('\n')) {
      if (!line.startsWith('USER|')) continue;
      const [, name, port, secret, status, conns] = line.split('|');
      if (!name) continue;
      users.push({ name, port: parseInt(port), secret, status, connections: parseInt(conns) || 0 });
    }
    return users;
  } catch {
    return [];
  }
}

async function getTraffic(node) {
  try {
    const r = await sshExec(node,
      "docker stats --no-stream --format '{{.Name}}|{{.NetIO}}' 2>/dev/null | grep '^mtg-'"
    );
    const result = {};
    for (const line of r.output.split('\n')) {
      if (!line.includes('|')) continue;
      const [name, netio] = line.split('|');
      const userName = name.replace('mtg-', '').trim();
      // NetIO format: "1.23MB / 4.56GB"
      const parts = netio.trim().split(' / ');
      result[userName] = {
        rx: parts[0] || '0B',
        tx: parts[1] || '0B'
      };
    }
    return result;
  } catch {
    return {};
  }
}

async function createRemoteUser(node, name) {
  const baseDir = node.base_dir;
  const startPort = node.start_port || 4433;

  const cmd = [
    'BASE=' + baseDir,
    'NAME=' + name,
    'START_PORT=' + startPort,
    'USER_DIR="$BASE/$NAME"',
    'if [ -d "$USER_DIR" ]; then echo EXISTS; exit 1; fi',
    'PORT=$(ls $BASE 2>/dev/null | wc -l)',
    'PORT=$((START_PORT + PORT))',
    "SECRET=\"ee$(openssl rand -hex 16)$(echo -n 'google.com' | xxd -p)\"",
    'mkdir -p "$USER_DIR"',
    'printf \'secret = "%s"\\nbind-to = "0.0.0.0:3128"\\n\' "$SECRET" > "$USER_DIR/config.toml"',
    'printf \'services:\\n  mtg-%s:\\n    image: nineseconds/mtg:2\\n    container_name: mtg-%s\\n    restart: unless-stopped\\n    ports:\\n      - "%s:3128"\\n    volumes:\\n      - %s/config.toml:/config.toml:ro\\n    command: run /config.toml\\n\' "$NAME" "$NAME" "$PORT" "$USER_DIR" > "$USER_DIR/docker-compose.yml"',
    'cd "$USER_DIR" && docker compose up -d 2>&1',
    'echo "OK|$NAME|$PORT|$SECRET"'
  ].join('\n');

  const r = await sshExec(node, cmd);

  if (r.output.includes('EXISTS')) throw new Error('User already exists on node');
  const okLine = r.output.split('\n').find(l => l.startsWith('OK|'));
  if (!okLine) throw new Error('Failed to create user: ' + r.output);

  const parts = okLine.split('|');
  return { port: parseInt(parts[2]), secret: parts[3] };
}

async function removeRemoteUser(node, name) {
  const cmd = [
    'BASE=' + node.base_dir,
    'NAME=' + name,
    'USER_DIR="$BASE/$NAME"',
    'if [ -d "$USER_DIR" ]; then',
    '  cd "$USER_DIR" && docker compose down 2>/dev/null',
    '  rm -rf "$USER_DIR"',
    'fi',
    'echo DONE'
  ].join('\n');
  await sshExec(node, cmd);
}

async function stopRemoteUser(node, name) {
  await sshExec(node, 'cd ' + node.base_dir + '/' + name + ' && docker compose stop 2>/dev/null');
}

async function startRemoteUser(node, name) {
  await sshExec(node, 'cd ' + node.base_dir + '/' + name + ' && docker compose start 2>/dev/null');
}

module.exports = {
  sshExec,
  checkNode,
  getNodeStatus,
  getRemoteUsers,
  getTraffic,
  createRemoteUser,
  removeRemoteUser,
  stopRemoteUser,
  startRemoteUser,
};
