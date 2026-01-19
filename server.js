import express from 'express';
import pg from 'pg';
import cors from 'cors';
import dns from 'dns';
import { promisify } from 'util';
import { createServer } from 'http';
import { Server } from 'socket.io';
import 'dotenv/config';

const { Pool } = pg;
const dnsLookup = promisify(dns.lookup);
const dnsResolve4 = promisify(dns.resolve4);
const dnsResolve6 = promisify(dns.resolve6);

const app = express();
const httpServer = createServer(app);
const io = new Server(httpServer, {
    cors: {
        origin: "*",
        methods: ["GET", "POST"]
    }
});
const port = process.env.PORT || 3000;

let connectedUsers = 0;

const rateLimitMap = new Map();
const RATE_LIMIT_WINDOW = 5000;
const RATE_LIMIT_CLEANUP_INTERVAL = 60000;

const leaderboardCache = new Map();
const CACHE_TTL = 300000;

function cleanupRateLimits() {
    const now = Date.now();
    for (const [key, timestamp] of rateLimitMap.entries()) {
        if (now - timestamp > RATE_LIMIT_WINDOW) {
            rateLimitMap.delete(key);
        }
    }
}

function cleanupLeaderboardCache() {
    const now = Date.now();
    for (const [key, entry] of leaderboardCache.entries()) {
        if (now - entry.timestamp > CACHE_TTL) {
            leaderboardCache.delete(key);
        }
    }
}

function invalidateLeaderboardCache() {
    leaderboardCache.clear();
}

setInterval(cleanupRateLimits, RATE_LIMIT_CLEANUP_INTERVAL);
setInterval(cleanupLeaderboardCache, CACHE_TTL);

app.use(cors());
app.use(express.json());

const dbConfig = {
    host: process.env.DB_HOST || 'aws-0-us-west-2.pooler.supabase.com',
    port: process.env.DB_PORT ? parseInt(process.env.DB_PORT) : 6543,
    database: process.env.DB_NAME || 'postgres',
    user: process.env.DB_USER || 'postgres.znfamffcymyvsihpnfpk',
    password: process.env.DB_PASS,
    connectionTimeoutMillis: 10000,
    idleTimeoutMillis: 30000,
    max: 10,
    ssl: {
        rejectUnauthorized: false
    }
};

function logTimestamp() {
    return `[${new Date().toISOString()}]`;
}

async function logDnsResolution(hostname) {
    try {
        let hasIPv4 = false;
        let hasIPv6 = false;
        
        try {
            await dnsResolve4(hostname);
            hasIPv4 = true;
        } catch (err) {
        }
        
        try {
            await dnsResolve6(hostname);
            hasIPv6 = true;
        } catch (err) {
        }
        
        if (!hasIPv4 && hasIPv6) {
            console.warn(`${logTimestamp()} WARNING: Only IPv6 available. Connection may fail if IPv6 is unsupported.`);
        }
    } catch (error) {
        console.error(`${logTimestamp()} DNS resolution error:`, error.message);
    }
}

const pool = new Pool(dbConfig);

pool.on('error', (err) => {
    console.error(`${logTimestamp()} Database pool error:`, err.message);
    process.exit(-1);
});


async function initDatabase() {
    try {
        await pool.query('SELECT NOW()');
        
        await pool.query(`
            CREATE TABLE IF NOT EXISTS runs (
                id SERIAL PRIMARY KEY,
                user_id TEXT,
                run_id TEXT UNIQUE,
                timestamp BIGINT,
                heat REAL,
                power REAL,
                money REAL,
                time_played INTEGER,
                layout TEXT,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );
        `);

        await pool.query(`
            CREATE TABLE IF NOT EXISTS game_saves (
                id SERIAL PRIMARY KEY,
                user_id TEXT NOT NULL,
                slot_id INTEGER NOT NULL CHECK (slot_id BETWEEN 1 AND 3),
                save_data TEXT NOT NULL,
                timestamp BIGINT NOT NULL,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                UNIQUE(user_id, slot_id)
            );
        `);

        await pool.query(`
            CREATE INDEX IF NOT EXISTS idx_runs_power ON runs(power DESC);
            CREATE INDEX IF NOT EXISTS idx_runs_heat ON runs(heat DESC);
            CREATE INDEX IF NOT EXISTS idx_runs_money ON runs(money DESC);
            CREATE INDEX IF NOT EXISTS idx_runs_timestamp ON runs(timestamp DESC);
        `);
    } catch (error) {
        console.error(`${logTimestamp()} Database initialization failed:`, error.message);
        if (error.code === 'ENETUNREACH' || error.code === 'ETIMEDOUT' || error.code === 'ECONNREFUSED') {
            console.error(`${logTimestamp()} Connection error (${error.code}). Check DB_HOST and network configuration.`);
        }
        throw error;
    }
}

app.post('/api/leaderboard/save', async (req, res) => {
    try {
        const { user_id, run_id, heat, power, money, time, layout } = req.body;

        if (!user_id || !run_id) {
            return res.status(400).json({ error: 'user_id and run_id are required' });
        }

        const rateLimitKey = `${user_id}:${run_id}`;
        const now = Date.now();
        const lastRequestTime = rateLimitMap.get(rateLimitKey);

        if (lastRequestTime && (now - lastRequestTime) < RATE_LIMIT_WINDOW) {
            const remainingTime = Math.ceil((RATE_LIMIT_WINDOW - (now - lastRequestTime)) / 1000);
            console.log(`${logTimestamp()} Rate limit exceeded: ${rateLimitKey}`);
            return res.status(429).json({ 
                error: 'Too Many Requests', 
                message: `Same user_id:run_id can only be saved once every ${RATE_LIMIT_WINDOW / 1000} seconds`,
                retryAfter: remainingTime
            });
        }

        const result = await pool.query(`
            INSERT INTO runs (user_id, run_id, timestamp, heat, power, money, time_played, layout)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
            ON CONFLICT(run_id) DO UPDATE SET
                timestamp = CASE
                    WHEN $4 > runs.heat OR $5 > runs.power OR $6 > runs.money OR $7 > runs.time_played
                    THEN $3
                    ELSE runs.timestamp
                END,
                heat = CASE WHEN $4 > runs.heat THEN $4 ELSE runs.heat END,
                power = CASE WHEN $5 > runs.power THEN $5 ELSE runs.power END,
                money = CASE WHEN $6 > runs.money THEN $6 ELSE runs.money END,
                time_played = CASE WHEN $7 > runs.time_played THEN $7 ELSE runs.time_played END,
                layout = CASE
                    WHEN $8 IS NOT NULL AND ($4 > runs.heat OR $5 > runs.power OR $6 > runs.money OR $7 > runs.time_played)
                    THEN $8
                    ELSE runs.layout
                END
            RETURNING *
        `, [user_id, run_id, Date.now(), heat || 0, power || 0, money || 0, time || 0, layout || null]);

        rateLimitMap.set(rateLimitKey, now);
        invalidateLeaderboardCache();

        res.json({ success: true, data: result.rows[0] });
    } catch (error) {
        console.error(`${logTimestamp()} POST /api/leaderboard/save error:`, error.message);
        res.status(500).json({ error: 'Failed to save run', message: error.message });
    }
});

app.post('/api/saves', async (req, res) => {
    try {
        const { user_id, slot_id, save_data, timestamp } = req.body;
        
        if (!user_id || !slot_id || !save_data) {
            return res.status(400).json({ error: 'Missing required fields' });
        }
        
        if (slot_id < 1 || slot_id > 3) {
            return res.status(400).json({ error: 'Invalid slot_id (1-3)' });
        }

        const result = await pool.query(`
            INSERT INTO game_saves (user_id, slot_id, save_data, timestamp)
            VALUES ($1, $2, $3, $4)
            ON CONFLICT(user_id, slot_id) DO UPDATE SET
                save_data = $3,
                timestamp = $4
            RETURNING *
        `, [user_id, slot_id, save_data, timestamp || Date.now()]);
        
        res.json({ success: true, data: result.rows[0] });
    } catch (error) {
        console.error(`${logTimestamp()} POST /api/saves error:`, error.message);
        res.status(500).json({ error: 'Failed to save game', message: error.message });
    }
});

app.get('/api/saves/:userId', async (req, res) => {
    try {
        const { userId } = req.params;
        const result = await pool.query(`
            SELECT slot_id, timestamp, save_data 
            FROM game_saves 
            WHERE user_id = $1 
            ORDER BY slot_id ASC
        `, [userId]);
        
        res.json({ success: true, data: result.rows });
    } catch (error) {
        console.error(`${logTimestamp()} GET /api/saves/${req.params.userId} error:`, error.message);
        res.status(500).json({ error: 'Failed to fetch saves', message: error.message });
    }
});

app.get('/api/leaderboard/top', async (req, res) => {
    try {
        const sortBy = req.query.sortBy || 'power';
        const limit = parseInt(req.query.limit || '10', 10);

        const validSorts = ['heat', 'power', 'money', 'timestamp'];
        const sortColumn = validSorts.includes(sortBy) ? sortBy : 'power';

        const cacheKey = `${sortColumn}:${limit}`;
        const cached = leaderboardCache.get(cacheKey);
        const now = Date.now();

        if (cached && (now - cached.timestamp) < CACHE_TTL) {
            return res.json({ success: true, data: cached.data });
        }

        const result = await pool.query(`
            SELECT * FROM runs 
            ORDER BY ${sortColumn} DESC 
            LIMIT $1
        `, [limit]);

        leaderboardCache.set(cacheKey, {
            data: result.rows,
            timestamp: now
        });

        res.json({ success: true, data: result.rows });
    } catch (error) {
        console.error(`${logTimestamp()} GET /api/leaderboard/top error:`, error.message);
        res.status(500).json({ error: 'Failed to get top runs', message: error.message });
    }
});

app.get('/health', async (req, res) => {
    try {
        const healthCheck = await pool.query('SELECT 1 as health, NOW() as db_time');
        res.json({ 
            status: 'ok', 
            database: 'connected',
            poolStats: {
                total: pool.totalCount,
                idle: pool.idleCount,
                waiting: pool.waitingCount
            },
            dbTime: healthCheck.rows[0].db_time
        });
    } catch (error) {
        res.status(500).json({ 
            status: 'error', 
            database: 'disconnected', 
            error: error.message
        });
    }
});

async function startServer() {
    await logDnsResolution(dbConfig.host);
    
    try {
        await initDatabase();
        
        io.on('connection', (socket) => {
            connectedUsers++;
            io.emit('userCount', connectedUsers);
            
            socket.on('disconnect', () => {
                connectedUsers = Math.max(0, connectedUsers - 1);
                io.emit('userCount', connectedUsers);
            });
        });
        
        httpServer.listen(port, () => {
            console.log(`${logTimestamp()} Server started on port ${port}`);
        });
        
        httpServer.on('error', (error) => {
            console.error(`${logTimestamp()} HTTP server error:`, error.message);
        });
    } catch (error) {
        console.error(`${logTimestamp()} Server startup failed:`, error.message);
        process.exit(1);
    }
}

startServer();

