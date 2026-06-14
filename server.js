'use strict';

const express = require('express');
const cors    = require('cors');
const http    = require('http');
const https   = require('https');
const net     = require('net');
const { URL } = require('url');
const { readCard, signData, getReaderStatus, isSdkAvailable } = require('./card-reader');
const siui    = require('./siui-proxy');

// Doar adrese locale (LAN/localhost) sunt permise ca țintă pt casa de marcat (anti-SSRF)
function isPrivateHost(host) {
    if (host === 'localhost' || host === '127.0.0.1' || host === '::1') return true;
    return /^10\./.test(host)
        || /^192\.168\./.test(host)
        || /^172\.(1[6-9]|2\d|3[01])\./.test(host);
}

// Execută un POST către casa de marcat locală și întoarce răspunsul
function relayPost(targetUrl, body, timeoutMs = 15000) {
    return new Promise((resolve, reject) => {
        const u = new URL(targetUrl);
        const lib = u.protocol === 'https:' ? https : http;
        const data = typeof body === 'string' ? body : JSON.stringify(body ?? {});
        const r = lib.request(u, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) },
            timeout: timeoutMs,
        }, (resp) => {
            let buf = '';
            resp.on('data', c => buf += c);
            resp.on('end', () => { let j = null; try { j = JSON.parse(buf); } catch (_) {} resolve({ status: resp.statusCode, json: j, text: buf }); });
        });
        r.on('error', reject);
        r.on('timeout', () => r.destroy(new Error('timeout')));
        r.write(data);
        r.end();
    });
}

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

    // ── SIUI proxy ──────────────────────────────────────────────────────────

    // GET /siui/status — stare certificat + sesiune SIUI
    app.get('/siui/status', (req, res) => {
        res.json(siui.getStatus());
    });

    // POST /siui/cert — încarcă certificat PFX + cheie de activare SIUI
    // Body: { pfx_path|pfx_base64: string, passphrase?: string, activation_key?: string }
    // activation_key = cheia din convenția de utilizare cu CAS județean
    app.post('/siui/cert', (req, res) => {
        const { pfx_path, pfx_base64, passphrase, activation_key } = req.body || {};
        if (!pfx_path && !pfx_base64) {
            return res.status(422).json({ ok: false, error: 'pfx_path sau pfx_base64 obligatoriu' });
        }
        if (pfx_base64) {
            return res.json(siui.loadCertFromBase64(pfx_base64, passphrase, activation_key));
        }
        res.json(siui.loadCertFromFile(pfx_path, passphrase, activation_key));
    });

    // POST /siui/cert/clear — șterge certificatul din memorie
    app.post('/siui/cert/clear', (req, res) => {
        siui.clearCert();
        res.json({ ok: true });
    });

    // POST /siui/call — proxy SOAP generic către SIUI
    // Body: { endpoint_type: 'main'|'insured'|'validate', soap_action: string, body: string }
    app.post('/siui/call', async (req, res) => {
        const { endpoint_type, soap_action, body } = req.body || {};
        if (!endpoint_type || !soap_action || !body) {
            return res.status(422).json({
                ok: false,
                error: 'endpoint_type, soap_action, body sunt obligatorii',
            });
        }
        try {
            const result = await siui.call(endpoint_type, soap_action, body);
            res.json({ ok: true, status: result.status, body: result.body });
        } catch (err) {
            res.status(500).json({ ok: false, error: err.message });
        }
    });

    // POST /siui/nomenclators — descarcă arhiva nomenclatoarelor pentru o categorie de furnizor
    // Body: { partner_category: 'CLIN' | 'PARA' | 'STOM' | 'MF' | ... }
    app.post('/siui/nomenclators', async (req, res) => {
        const { partner_category } = req.body || {};
        if (!partner_category) {
            return res.status(422).json({ ok: false, error: 'partner_category obligatoriu' });
        }
        try {
            const result = await siui.getCatalogues(partner_category);
            res.json({ ok: true, ...result });
        } catch (err) {
            res.status(500).json({ ok: false, error: err.message });
        }
    });

    // POST /fiscal/print — releu către casa de marcat din rețeaua locală
    // Body: { provider, base: "http://192.168.1.50:4444", requests: [ {path, body, timeout, stopOnError}, ... ] }
    // Logica per-marcă (Datecs/Tremol) e construită în MediNote (PHP); agentul doar execută local.
    app.post('/fiscal/print', async (req, res) => {
        const { base, requests } = req.body || {};
        if (!base || !Array.isArray(requests) || requests.length === 0) {
            return res.status(422).json({ ok: false, error: 'base + requests sunt obligatorii' });
        }
        let host;
        try { host = new URL(base).hostname; } catch (_) { return res.status(422).json({ ok: false, error: 'base invalid' }); }
        if (!isPrivateHost(host)) {
            return res.status(403).json({ ok: false, error: 'Doar adrese locale (LAN) sunt permise: ' + host });
        }

        const responses = [];
        try {
            for (const r of requests) {
                const url = base.replace(/\/+$/, '') + (r.path || '');
                const resp = await relayPost(url, r.body ?? {}, r.timeout || 15000);
                responses.push(resp);
                if (r.stopOnError && (resp.status < 200 || resp.status >= 300)) break;
            }
            if (onStatusChange) onStatusChange('fiscal_print');
            res.json({ ok: true, responses });
        } catch (err) {
            res.status(502).json({ ok: false, error: err.message, responses });
        }
    });

    // POST /probe — test conexiune (TCP connect) la un aparat/casă din rețeaua locală
    // Body: { host, port } → { reachable, ms }
    app.post('/probe', (req, res) => {
        const { host, port } = req.body || {};
        if (!host || !port) return res.status(422).json({ ok: false, error: 'host + port obligatorii' });
        if (!isPrivateHost(host)) return res.status(403).json({ ok: false, error: 'Doar adrese locale (LAN): ' + host });

        const start = Date.now();
        const sock = new net.Socket();
        let done = false;
        const finish = (reachable, err) => {
            if (done) return; done = true;
            try { sock.destroy(); } catch (_) {}
            res.json({ ok: true, reachable, ms: Date.now() - start, error: err || null });
        };
        sock.setTimeout(3000);
        sock.once('connect', () => finish(true));
        sock.once('timeout', () => finish(false, 'timeout'));
        sock.once('error', (e) => finish(false, e.code || e.message));
        sock.connect(Number(port), String(host));
    });

    // ────────────────────────────────────────────────────────────────────────

    return app.listen(PORT, '127.0.0.1', () => {
        console.log(`MediNote Agent REST API pornit pe localhost:${PORT}`);
    });
}

module.exports = { createServer, PORT };
