'use strict';

const express = require('express');
const cors    = require('cors');
const { readCard, signData, getReaderStatus, isSdkAvailable } = require('./card-reader');

const PORT    = 7421;
const VERSION = '1.0.0';

const ALLOWED_ORIGINS = [
    'https://medinote.ro',
    'https://www.medinote.ro',
    'http://localhost:8000',  // dev local
    'http://127.0.0.1:8000',
];

function createServer(onStatusChange) {
    const app = express();

    app.use(cors({
        origin: (origin, cb) => {
            if (!origin || ALLOWED_ORIGINS.includes(origin)) return cb(null, true);
            cb(new Error('Origin not allowed: ' + origin));
        },
        methods: ['GET', 'POST'],
        allowedHeaders: ['Content-Type', 'X-MediNote-Token'],
    }));

    app.use(express.json());

    // GET /ping — health check simplu (browser îl apelează la fiecare pagină CAS)
    app.get('/ping', (req, res) => {
        res.json({ pong: true, version: VERSION });
    });

    // GET /status — stare completă: agent + cititor card
    app.get('/status', async (req, res) => {
        const reader = await getReaderStatus().catch(() => ({ connected: false }));
        res.json({
            running: true,
            version: VERSION,
            sdk_available: isSdkAvailable(),
            mock_mode: !isSdkAvailable(),
            card_reader: reader,
        });
    });

    // POST /card/read — citește cardul inserat în cititor
    app.post('/card/read', async (req, res) => {
        try {
            const result = await readCard();
            if (onStatusChange) onStatusChange('card_read');
            res.json(result);
        } catch (err) {
            res.status(500).json({ success: false, error: err.message });
        }
    });

    // POST /card/sign — semnează serviciul cu certificatul cardului
    // Body: { cid, card_no, report_date, service_code }
    app.post('/card/sign', async (req, res) => {
        const { cid, card_no, report_date, service_code } = req.body || {};
        if (!cid || !card_no || !report_date || !service_code) {
            return res.status(422).json({ success: false, error: 'cid, card_no, report_date, service_code obligatorii' });
        }
        try {
            const result = await signData(cid, card_no, report_date, service_code);
            res.json(result);
        } catch (err) {
            res.status(500).json({ success: false, error: err.message });
        }
    });

    return app.listen(PORT, '127.0.0.1', () => {
        console.log(`MediNote Agent REST API pornit pe localhost:${PORT}`);
    });
}

module.exports = { createServer, PORT };
