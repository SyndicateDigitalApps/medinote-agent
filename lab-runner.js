'use strict';

/**
 * MediNote Lab Runner
 * -------------------
 * Orchestratorul conectorului de laborator în agent:
 *  - citește config local (token clinică + URL server) din lab-config.json
 *  - cere config-ul aparatelor de la MediNote (/api/lab/analyzers)
 *  - pornește un listener MLLP pentru fiecare aparat (mod tcp_server)
 *  - reîmprospătează periodic config-ul
 *
 * Config local (lab-config.json, lângă executabil sau în userData):
 *   { "baseUrl": "https://medinote.ro", "token": "<lab_gateway_token>", "refreshMinutes": 10 }
 */

const fs   = require('fs');
const path = require('path');
const net  = require('net');
const { startAnalyzerListener, parseHL7, toIngestPayload, wrapMllp, postJson } = require('./lab-connector');

function loadConfig(configPath) {
    try {
        if (!fs.existsSync(configPath)) return null;
        const cfg = JSON.parse(fs.readFileSync(configPath, 'utf8'));
        if (!cfg.token || !cfg.baseUrl) return null;
        return cfg;
    } catch (e) {
        return null;
    }
}

function getJson(baseUrl, pathName, token) {
    const { URL } = require('url');
    const url = new URL(pathName, baseUrl);
    const lib = url.protocol === 'https:' ? require('https') : require('http');
    return new Promise((resolve, reject) => {
        const req = lib.request(url, {
            method: 'GET',
            headers: { 'Accept': 'application/json', 'X-Lab-Token': token },
            timeout: 15000,
        }, (res) => {
            let buf = '';
            res.on('data', c => buf += c);
            res.on('end', () => {
                let json = null; try { json = JSON.parse(buf); } catch (_) {}
                resolve({ status: res.statusCode, body: json });
            });
        });
        req.on('error', reject);
        req.on('timeout', () => req.destroy(new Error('timeout')));
        req.end();
    });
}

class LabRunner {
    constructor({ configPath, log } = {}) {
        this.configPath = configPath;
        this.log = log || console.log;
        this.servers = new Map();   // analyzerId → net.Server
        this.clients = new Map();   // analyzerId → reconnect timer
        this.refreshTimer = null;
        this.config = null;
    }

    async start() {
        this.config = loadConfig(this.configPath);
        if (!this.config) {
            this.log('[lab] niciun lab-config.json valid — conectorul de laborator e inactiv.');
            return false;
        }
        this.log(`[lab] conector pornit — server ${this.config.baseUrl}`);
        await this.sync();
        const mins = Math.max(2, this.config.refreshMinutes || 10);
        this.refreshTimer = setInterval(() => this.sync().catch(e => this.log('[lab] sync err: ' + e.message)), mins * 60000);
        return true;
    }

    async sync() {
        let resp;
        try {
            resp = await getJson(this.config.baseUrl, '/api/lab/analyzers', this.config.token);
        } catch (e) {
            this.log('[lab] nu pot lua config aparate: ' + e.message);
            return;
        }
        if (resp.status !== 200 || !resp.body || !Array.isArray(resp.body.analyzers)) {
            this.log('[lab] config aparate invalid (HTTP ' + resp.status + ')');
            return;
        }

        const analyzers = resp.body.analyzers;
        const wantedIds = new Set();

        for (const an of analyzers) {
            if (an.connection_mode === 'serial') {
                this.log(`[lab] ${an.name}: serial (${an.serial_path || 'COM?'}) — necesită adaptor + modul serial (în lucru)`);
                continue;
            }
            if (!an.port) { this.log(`[lab] ${an.name}: fără port configurat, sărit`); continue; }
            wantedIds.add(an.id);

            if (an.connection_mode === 'tcp_client') {
                if (!this.clients.has(an.id)) this.startClient(an);
            } else { // tcp_server (default)
                if (!this.servers.has(an.id)) {
                    const server = startAnalyzerListener(an, {
                        baseUrl: this.config.baseUrl,
                        token: this.config.token,
                        log: this.log,
                    });
                    this.servers.set(an.id, server);
                }
            }
        }

        // Oprește listenerele pentru aparate eliminate din config
        for (const [id, server] of this.servers) {
            if (!wantedIds.has(id)) { try { server.close(); } catch (_) {} this.servers.delete(id); this.log('[lab] listener oprit pt aparat ' + id); }
        }
    }

    /** Mod tcp_client: agentul se conectează la aparat și citește MLLP. */
    startClient(an) {
        const log = this.log;
        const connect = () => {
            const socket = net.connect({ host: an.host, port: an.port }, () => log(`[${an.name}] conectat (client) ${an.host}:${an.port}`));
            let buffer = Buffer.alloc(0);
            const VT = 0x0b, FS = 0x1c;
            socket.on('data', async (chunk) => {
                buffer = Buffer.concat([buffer, chunk]);
                let s, e;
                while ((s = buffer.indexOf(VT)) !== -1 && (e = buffer.indexOf(FS, s)) !== -1) {
                    const raw = buffer.slice(s + 1, e).toString('binary');
                    buffer = buffer.slice(e + 2);
                    const parsed = parseHL7(raw);
                    if (parsed && parsed.results.length && parsed.barcode) {
                        const payload = toIngestPayload(parsed);
                        payload.analyzer_code = an.device_code || an.name || payload.analyzer_code;
                        try { const r = await postJson(this.config.baseUrl, '/api/lab/ingest', this.config.token, payload); log(`[${an.name}] → ${r.status}`); }
                        catch (err) { log(`[${an.name}] forward err: ${err.message}`); }
                    }
                }
            });
            const retry = () => {
                if (this.clients.has(an.id)) clearTimeout(this.clients.get(an.id));
                this.clients.set(an.id, setTimeout(connect, 10000)); // reconectare la 10s
            };
            socket.on('error', (e) => { log(`[${an.name}] client err: ${e.message}`); });
            socket.on('close', () => { log(`[${an.name}] deconectat, reconectare în 10s`); retry(); });
        };
        this.clients.set(an.id, setTimeout(connect, 0));
    }

    stop() {
        if (this.refreshTimer) clearInterval(this.refreshTimer);
        for (const s of this.servers.values()) { try { s.close(); } catch (_) {} }
        for (const t of this.clients.values()) { try { clearTimeout(t); } catch (_) {} }
        this.servers.clear();
        this.clients.clear();
    }
}

module.exports = { LabRunner, loadConfig };
