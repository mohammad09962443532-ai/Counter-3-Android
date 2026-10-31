import express from 'express';
import { handleRealtimeRequest } from './lib/realtime.js';
import { db, migrate } from './lib/db.js';

migrate(`
  CREATE TABLE IF NOT EXISTS match_records (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    room_code TEXT NOT NULL,
    player_name TEXT NOT NULL,
    eliminations INTEGER NOT NULL DEFAULT 0,
    played_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
`);

const app = express();
app.use(async (req, res, next) => {
  try {
    if (await handleRealtimeRequest(req, res)) return;
    next();
  } catch (error) {
    console.error('Realtime request failed:', req.method, req.path, error);
    if (!res.headersSent) res.status(500).json({error:'room_unavailable'});
  }
});
app.use(express.json());
app.get('/api/health', (_req, res) => {
  try {
    db.prepare('SELECT 1').get();
    res.json({ok:true});
  } catch (error) {
    console.error('Health request failed:',error);
    res.status(500).json({ok:false});
  }
});
app.listen(Number(process.env.PORT), () => console.log('Game server ready'));
