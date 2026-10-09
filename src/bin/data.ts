// pm2 app "data": serves /api/* and the static data/*.json files (bind to localhost; front with a proxy).
import { startApi } from '../api.js';
import { loadConfig } from '../config.js';
import { makeLog } from '../log.js';

const cfg = loadConfig();
startApi(cfg);
makeLog('data')('listening', { host: cfg.ops.apiHost, port: cfg.ops.apiPort });
