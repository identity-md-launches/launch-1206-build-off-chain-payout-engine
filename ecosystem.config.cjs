// pm2: `pm2 start ecosystem.config.cjs`. Environment comes from .env (loaded by node --env-file).
const common = {
  cwd: __dirname,
  interpreter: 'node',
  interpreter_args: '--env-file-if-exists=.env --import tsx',
  autorestart: true,
  max_restarts: 50,
  restart_delay: 5000,
  time: true,
};

module.exports = {
  apps: [
    // executor + in-process indexer; the only writer (data/state/writer.lock)
    { ...common, name: 'rounds', script: 'src/bin/rounds.ts', kill_timeout: 30000 },
    // rewrites data/*.json and prices every 60 s
    { ...common, name: 'snapshot', script: 'src/bin/snapshot.ts' },
    // serves /api/* and /data/*.json on API_HOST:API_PORT
    { ...common, name: 'data', script: 'src/bin/data.ts' },
  ],
};
