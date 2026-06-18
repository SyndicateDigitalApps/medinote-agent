'use strict';

/**
 * MediNote — Runner MINILITE (file-watcher)
 * -----------------------------------------
 * Urmărește folderul NETDIR al aplicației miniLite:
 *  - citește REPORT.txt când se modifică → parsează liniile NOI → POST /api/lab/ingest
 *  - scrie Accettazione.txt periodic din worklist-ul cerut de la MediNote
 *
 * Config local (minilite-config.json, lângă executabil):
 *   {
 *     "baseUrl": "https://medinote.ro",
 *     "token": "<lab_gateway_token>",
 *     "deviceCode": "MINILITE",
 *     "netdir": "C:\\Program Files (x86)\\SeleoSrl\\miniLite_v300\\NETDIR",
 *     "pollSeconds": 5
 *   }
 *
 * Liniile deja trimise sunt reținute (hash) într-un state file, ca să nu se
 * retrimită la fiecare modificare (REPORT.txt e cumulativ).
 */

const fs   = require('fs');
const path = require('path');
const crypto = require('crypto');
const { parseReportLine, toIngestPayload, buildAccettazioneLine } = require('./minilite-connector');

function postJson(baseUrl, pathName, token, payload) {
    const { URL } = require('url');
    const url = new URL(pathName, baseUrl);
    const lib = url.protocol === 'https:' ? require('https') : require('http');
    const body = Buffer.from(JSON.stringify(payload));
    return new Promise((resolve, reject) => {
        const req = lib.request(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Content-Length': body.length, 'X-Lab-Token': token },
            timeout: 15000,
        }, (res) => {
            let buf = ''; res.on('data', c => buf += c);
            res.on('end', () => { let j = null; try { j = JSON.parse(buf); } catch (_) {} resolve({ status: res.statusCode, body: j }); });
        });
        req.on('error', reject);
        req.on('timeout', () => req.destroy(new Error('timeout')));
        req.write(body); req.end();
    });
}

function getJson(baseUrl, pathName, token) {
    const { URL } = require('url');
    const url = new URL(pathName, baseUrl);
    const lib = url.protocol === 'https:' ? require('https') : require('http');
    return new Promise((resolve, reject) => {
        const req = lib.request(url, { method: 'GET', headers: { 'Accept': 'application/json', 'X-Lab-Token': token }, timeout: 15000 }, (res) => {
            let buf = ''; res.on('data', c => buf += c);
            res.on('end', () => { let j = null; try { j = JSON.parse(buf); } catch (_) {} resolve({ status: res.statusCode, body: j }); });
        });
        req.on('error', reject);
        req.on('timeout', () => req.destroy(new Error('timeout')));
        req.end();
    });
}

const lineHash = (line) => crypto.createHash('sha1').update(line.trim()).digest('hex').slice(0, 16);

class MiniliteRunner {
    constructor({ configPath, statePath, log } = {}) {
        this.configPath = configPath;
        this.statePath  = statePath || (configPath ? configPath.replace(/[^\\/]+$/, 'minilite-state.json') : null);
        this.log = log || console.log;
        this.cfg = null;
        this.sent = new Set();          // hash-uri linii deja trimise
        this.pollTimer = null;
        this.worklistTimer = null;
        this.lastSize = 0;
    }

    loadState() {
        try { const s = JSON.parse(fs.readFileSync(this.statePath, 'utf8')); (s.sent || []).forEach(h => this.sent.add(h)); } catch (_) {}
    }
    saveState() {
        try { fs.writeFileSync(this.statePath, JSON.stringify({ sent: [...this.sent].slice(-5000) })); } catch (_) {}
    }

    start() {
        try { this.cfg = JSON.parse(fs.readFileSync(this.configPath, 'utf8')); } catch (_) { this.cfg = null; }
        if (!this.cfg || !this.cfg.token || !this.cfg.baseUrl || !this.cfg.netdir) {
            this.log('[minilite] config lipsă/incomplet — connectorul MINILITE e inactiv.');
            return false;
        }
        this.loadState();
        this.reportPath = path.join(this.cfg.netdir, 'REPORT.txt');
        this.acceptPath = path.join(this.cfg.netdir, 'Accettazione.txt');
        this.log(`[minilite] pornit — urmăresc ${this.reportPath}`);

        const poll = Math.max(2, this.cfg.pollSeconds || 5) * 1000;
        this.pollTimer = setInterval(() => this.checkReport().catch(e => this.log('[minilite] ' + e.message)), poll);
        this.checkReport().catch(e => this.log('[minilite] ' + e.message));

        // worklist → Accettazione.txt (la 60s)
        this.worklistTimer = setInterval(() => this.writeWorklist().catch(e => this.log('[minilite] wl ' + e.message)), 60000);
        return true;
    }

    async checkReport() {
        if (!fs.existsSync(this.reportPath)) return;
        const stat = fs.statSync(this.reportPath);
        if (stat.size === this.lastSize) return;   // nimic nou
        this.lastSize = stat.size;

        const data = fs.readFileSync(this.reportPath, 'latin1');
        const lines = data.split(/\r?\n/).filter(l => l.trim().length);
        let sent = 0;
        for (const line of lines) {
            const h = lineHash(line);
            if (this.sent.has(h)) continue;
            const parsed = parseReportLine(line);
            if (!parsed || !parsed.demo.barcode) { this.sent.add(h); continue; }
            try {
                const r = await postJson(this.cfg.baseUrl, '/api/lab/ingest', this.cfg.token, toIngestPayload(parsed, this.cfg.deviceCode));
                if (r.status >= 200 && r.status < 300) { this.sent.add(h); sent++; this.log(`[minilite] ${parsed.demo.barcode} → ${r.status}`); }
                else this.log(`[minilite] ${parsed.demo.barcode} ingest HTTP ${r.status}`);
            } catch (e) { this.log(`[minilite] forward err: ${e.message}`); }
        }
        if (sent) this.saveState();
    }

    async writeWorklist() {
        let resp;
        try { resp = await getJson(this.cfg.baseUrl, '/api/lab/worklist?device=' + encodeURIComponent(this.cfg.deviceCode || 'MINILITE'), this.cfg.token); }
        catch (_) { return; }
        if (resp.status !== 200 || !resp.body || !Array.isArray(resp.body.orders)) return;
        if (!resp.body.orders.length) return;
        const lines = resp.body.orders.map(buildAccettazioneLine).join('');
        try { fs.writeFileSync(this.acceptPath, lines, 'latin1'); this.log(`[minilite] Accettazione.txt scris (${resp.body.orders.length} cereri)`); }
        catch (e) { this.log('[minilite] scriere Accettazione err: ' + e.message); }
    }

    stop() {
        if (this.pollTimer) clearInterval(this.pollTimer);
        if (this.worklistTimer) clearInterval(this.worklistTimer);
        this.saveState();
    }
}

module.exports = { MiniliteRunner };
