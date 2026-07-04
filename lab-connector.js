'use strict';

/**
 * MediNote Lab Connector
 * ----------------------
 * Conectează analizoarele de laborator (Mindray & compatibile) la MediNote.
 *
 * - Parser HL7 v2.3.1 (MSH/PID/OBR/OBX) — dialectul Mindray.
 * - Transport MLLP peste TCP (cadrare VT ... FS CR).
 * - Mod tcp_server: agentul ascultă, aparatul se conectează (config uzual Mindray).
 *   Mod tcp_client: agentul se conectează la IP:port-ul aparatului.
 * - Răspunde cu ACK (MSA|AA) și forwardează rezultatele la MediNote /api/lab/ingest.
 *
 * Testabil standalone:  node lab-connector.js --selftest
 */

const net  = require('net');
const https = require('https');
const http  = require('http');
const { URL } = require('url');

// ── MLLP framing ────────────────────────────────────────────────
const VT = 0x0b; // <SB> start block
const FS = 0x1c; // <EB> end block
const CR = 0x0d; // carriage return

function wrapMllp(message) {
    return Buffer.concat([Buffer.from([VT]), Buffer.from(message, 'binary'), Buffer.from([FS, CR])]);
}

// ── HL7 parsing ─────────────────────────────────────────────────

/**
 * Parsează un mesaj HL7 v2.x (dialect Mindray) într-un obiect structurat.
 * Tolerant la separatoare: citește encoding chars din MSH-2.
 */
function parseHL7(raw) {
    if (!raw || typeof raw !== 'string') return null;

    // Normalizează terminatorii de segment (\r, \n, \r\n) la \r
    const clean = raw.replace(/\r\n|\n/g, '\r').replace(/\r+/g, '\r').trim();
    const segments = clean.split('\r').filter(s => s.length > 0);
    if (segments.length === 0) return null;

    const msh = segments.find(s => s.startsWith('MSH'));
    if (!msh) return null;

    // MSH: separatorul de câmp e caracterul 4 (index 3); encoding chars urmează
    const fieldSep = msh[3] || '|';
    const enc      = msh.substring(4, msh.indexOf(fieldSep, 4) === -1 ? 8 : msh.indexOf(fieldSep, 4));
    const compSep  = enc[0] || '^';
    const repSep   = enc[1] || '~';
    const escChar  = enc[2] || '\\';
    const subSep   = enc[3] || '&';

    const splitFields = (seg) => {
        // pentru MSH, câmpul 1 e separatorul însuși; normalizăm așa încât index-urile HL7 să se potrivească
        if (seg.startsWith('MSH')) {
            const rest = seg.substring(4).split(fieldSep);
            return ['MSH', enc, ...rest];
        }
        return seg.split(fieldSep);
    };
    const comp = (field, idx) => (field || '').split(compSep)[idx] || '';

    const mshF = splitFields(msh);
    // MSH-9 = tip mesaj (ORU^R01); MSH-3/4 = aplicație/aparat emitent
    const messageType = (mshF[9] || '').replace(compSep, '^');
    const sendingApp   = mshF[3] || '';
    const sendingFac   = mshF[4] || '';

    let analyzerCode = comp(mshF[4], 0) || comp(mshF[3], 0) || sendingFac || sendingApp || '';

    // Barcode probă: candidați din OBR (filler/placer) + SPM + PID
    const barcodeCandidates = [];
    const results = [];
    let patientName = '', patientSex = '';
    // Host query (QRY^Q02): QRD-8 = barcode-ul întrebat; păstrăm QRD/QRF brute pt. echo în DSR
    let queryBarcode = '', qrdRaw = '', qrfRaw = '';

    for (const seg of segments) {
        const f = splitFields(seg);
        const type = f[0];

        if (type === 'PID') {
            patientName = (f[5] || '').replace(new RegExp('\\' + compSep, 'g'), ' ').trim();
            patientSex  = f[8] || '';
            if (f[3]) barcodeCandidates.push(comp(f[3], 0)); // PID-3 ca ultim resort
        }

        if (type === 'QRD') {
            // QRD-8 (Who Subject Filter) = ID-ul probei întrebate (dialect Mindray)
            queryBarcode = comp(f[8], 0) || (f[8] || '');
            qrdRaw = seg;
        }
        if (type === 'QRF') { qrfRaw = seg; }

        if (type === 'OBR') {
            // OBR-3 (Filler Order Number) = de obicei ID-ul probei la Mindray; OBR-2 (Placer) = ce a trimis LIS-ul
            const obr3 = comp(f[3], 0) || (f[3] || '');
            const obr2 = comp(f[2], 0) || (f[2] || '');
            if (obr3) barcodeCandidates.unshift(obr3);
            if (obr2) barcodeCandidates.push(obr2);
        }

        if (type === 'SPM') {
            // SPM-2 = Specimen ID (HL7 mai nou)
            const spm2 = comp(f[2], 0) || (f[2] || '');
            if (spm2) barcodeCandidates.unshift(spm2);
        }

        if (type === 'SAC') {
            // SAC-3 = Container/Carrier ID (unele aparate)
            const sac3 = comp(f[3], 0) || (f[3] || '');
            if (sac3) barcodeCandidates.unshift(sac3);
        }

        if (type === 'OBX') {
            // OBX-3 = identificator (cod^denumire^sistem); OBX-4 = denumire (Mindray)
            const obx3 = f[3] || '';
            const code = comp(obx3, 0) || obx3;
            const nameFromCode = comp(obx3, 1);
            const name = (f[4] || nameFromCode || '').trim();
            const valueType = f[2] || '';
            let value = (f[5] || '').trim();
            const unit  = (f[6] || '').trim();
            const refRaw = (f[7] || '').trim();
            const flag   = (f[8] || '').trim();
            const status = (f[11] || '').trim();

            // ref range „min-max" sau „min-" sau „<max"
            let refLow = null, refHigh = null, refText = null;
            if (refRaw) {
                const m = refRaw.match(/^\s*(-?\d+(?:[.,]\d+)?)?\s*-\s*(-?\d+(?:[.,]\d+)?)?\s*$/);
                if (m) {
                    refLow  = m[1] !== undefined && m[1] !== '' ? m[1].replace(',', '.') : null;
                    refHigh = m[2] !== undefined && m[2] !== '' ? m[2].replace(',', '.') : null;
                } else {
                    refText = refRaw;
                }
            }

            if (code) {
                results.push({ code, name, valueType, value, unit, refLow, refHigh, refText, flag, status });
            }
        }
    }

    // candidați unici, non-goi (serverul potrivește pe oricare — robust la variații între aparate)
    const uniqCandidates = [...new Set(barcodeCandidates.map(b => (b || '').trim()).filter(b => b && b !== '^'))];
    const barcode = uniqCandidates[0] || '';

    return {
        messageType,
        analyzerCode: analyzerCode.trim(),
        controlId: mshF[10] || '1',
        barcode: barcode.trim(),
        barcodeCandidates: uniqCandidates,
        patientName,
        patientSex,
        results,
        queryBarcode: (queryBarcode || '').trim(),
        qrdRaw,
        qrfRaw,
        raw,
    };
}

/** Construiește un ACK HL7 (MSA|AA|controlId). */
function buildAck(parsed, ackCode = 'AA') {
    const now = new Date();
    const ts = now.getFullYear().toString()
        + String(now.getMonth() + 1).padStart(2, '0')
        + String(now.getDate()).padStart(2, '0')
        + String(now.getHours()).padStart(2, '0')
        + String(now.getMinutes()).padStart(2, '0')
        + String(now.getSeconds()).padStart(2, '0');
    const ctrl = parsed?.controlId || '1';
    const msh = `MSH|^~\\&|MediNote|AGENT|||${ts}||ACK|${ctrl}|P|2.3.1`;
    const msa = `MSA|${ackCode}|${ctrl}`;
    return msh + '\r' + msa + '\r';
}

/**
 * Construiește răspunsul DSR^Q03 la un host query (QRY^Q02) — dialect Mindray BS (chimie).
 *
 * Layout (manual Mindray Host Interface, BS-200/BS-2000):
 *  MSH / MSA / ERR / QAK / QRD (echo) / QRF (echo) / DSP 1..22 (demografice) / DSP 23+ (câte un canal per DSP) / DSC
 *  - DSP-2  = nume pacient, DSP-4 = sex, DSP-13 = barcode probă, DSP-19 = tip probă (serum)
 *  - Testele comandate: din DSP-23 în sus, valoarea = numărul de canal (device_code din mapare).
 * NOTĂ teren: indecșii DSP pot varia ușor între modele/firmware — de verificat la prima probă
 * reală; constantele sunt grupate aici ca să fie ușor de ajustat.
 *
 * @param {Object} parsed    mesajul QRY parsat (controlId, qrdRaw, qrfRaw, queryBarcode)
 * @param {?Object} worklist răspunsul /api/lab/worklist ({ok, patient, patient_sex, barcode, tests:[{device_code,...}]})
 */
function buildDsr(parsed, worklist) {
    const now = new Date();
    const ts = now.getFullYear().toString()
        + String(now.getMonth() + 1).padStart(2, '0')
        + String(now.getDate()).padStart(2, '0')
        + String(now.getHours()).padStart(2, '0')
        + String(now.getMinutes()).padStart(2, '0')
        + String(now.getSeconds()).padStart(2, '0');
    const ctrl  = parsed?.controlId || '1';
    const found = !!(worklist && worklist.ok && Array.isArray(worklist.tests) && worklist.tests.length > 0);
    const codes = found ? worklist.tests.map(t => (t.device_code || '').toString().trim()).filter(c => c !== '') : [];

    const seg = [];
    seg.push(`MSH|^~\\&|MediNote|LIS|||${ts}||DSR^Q03|${ctrl}|P|2.3.1`);
    seg.push(`MSA|AA|${ctrl}`);
    seg.push('ERR|0');
    seg.push(`QAK|SR|${found && codes.length ? 'OK' : 'NF'}`);
    seg.push(parsed?.qrdRaw || `QRD|${ts}|R|D|1|||RD|${parsed?.queryBarcode || ''}|OTH|||T`);
    if (parsed?.qrfRaw) seg.push(parsed.qrfRaw);

    // DSP 1..22 — demografice (completăm ce știm, restul goale)
    const dsp = new Array(23).fill('');           // index 1..22 folosite
    dsp[2]  = (worklist?.patient || '').toString();
    dsp[4]  = (worklist?.patient_sex || '').toString();
    dsp[13] = (worklist?.barcode || parsed?.queryBarcode || '').toString();
    dsp[19] = 'serum';
    let n = 0;
    for (let i = 1; i <= 22; i++) seg.push(`DSP|${++n}||${dsp[i]}||`);

    // DSP 23+ — câte un canal (device_code) per segment
    for (const code of codes) seg.push(`DSP|${++n}||${code}^^^||`);

    seg.push('DSC||');
    return seg.join('\r') + '\r';
}

/** GET JSON cu X-Lab-Token (pt. /api/lab/worklist). */
function getJson(baseUrl, pathName, token) {
    return new Promise((resolve, reject) => {
        const url = new URL(pathName, baseUrl);
        const lib = url.protocol === 'https:' ? https : http;
        const req = lib.request(url, {
            method: 'GET',
            headers: { 'Accept': 'application/json', 'X-Lab-Token': token },
            timeout: 10000,
        }, (res) => {
            let buf = '';
            res.on('data', c => buf += c);
            res.on('end', () => {
                let json = null; try { json = JSON.parse(buf); } catch (_) {}
                resolve({ status: res.statusCode, body: json });
            });
        });
        req.on('error', reject);
        req.on('timeout', () => { req.destroy(new Error('timeout')); });
        req.end();
    });
}

/** Transformă mesajul parsat în payload-ul pe care îl așteaptă /api/lab/ingest. */
function toIngestPayload(parsed) {
    return {
        analyzer_code: parsed.analyzerCode,
        barcode: parsed.barcode,
        barcode_candidates: parsed.barcodeCandidates,
        message_type: parsed.messageType,
        raw: parsed.raw,
        results: parsed.results.map(r => ({
            code: r.code,
            name: r.name,
            value: r.value,
            unit: r.unit,
            ref_low: r.refLow,
            ref_high: r.refHigh,
            ref_text: r.refText,
            flag: r.flag,
        })),
    };
}

// ── Forward către MediNote ──────────────────────────────────────
function postJson(baseUrl, path, token, body) {
    return new Promise((resolve, reject) => {
        const url = new URL(path, baseUrl);
        const data = JSON.stringify(body);
        const lib = url.protocol === 'https:' ? https : http;
        const req = lib.request(url, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Accept': 'application/json',
                'X-Lab-Token': token,
                'Content-Length': Buffer.byteLength(data),
            },
            timeout: 15000,
        }, (res) => {
            let buf = '';
            res.on('data', c => buf += c);
            res.on('end', () => {
                let json = null; try { json = JSON.parse(buf); } catch (_) {}
                resolve({ status: res.statusCode, body: json ?? buf });
            });
        });
        req.on('error', reject);
        req.on('timeout', () => { req.destroy(new Error('timeout')); });
        req.write(data);
        req.end();
    });
}

// ── Listener per aparat ─────────────────────────────────────────

/**
 * Pornește un listener MLLP pentru un aparat.
 * @param {Object} analyzer  {name, device_code, port, connection_mode, host}
 * @param {Object} opts      {baseUrl, token, log}
 * @returns {net.Server}
 */
function startAnalyzerListener(analyzer, opts) {
    const log = opts.log || console.log;
    const port = analyzer.port || 5000;

    const server = net.createServer((socket) => {
        log(`[${analyzer.name}] conectat ${socket.remoteAddress}:${socket.remotePort}`);
        let buffer = Buffer.alloc(0);

        socket.on('data', async (chunk) => {
            buffer = Buffer.concat([buffer, chunk]);

            // extrage mesaje complete între VT și FS+CR
            let start, end;
            while ((start = buffer.indexOf(VT)) !== -1 && (end = buffer.indexOf(FS, start)) !== -1) {
                const raw = buffer.slice(start + 1, end).toString('binary');
                buffer = buffer.slice(end + 2); // sare peste FS + CR

                try {
                    const parsed = parseHL7(raw);
                    if (!parsed) { socket.write(wrapMllp(buildAck(null, 'AR'))); continue; }

                    log(`[${analyzer.name}] mesaj ${parsed.messageType} barcode=${parsed.barcode} rezultate=${parsed.results.length}`);

                    // Host query (QRY^Q02): aparatul întreabă ce teste are proba →
                    // răspundem cu DSR^Q03 (conține MSA — fără ACK separat).
                    if ((parsed.messageType || '').startsWith('QRY')) {
                        const qb = parsed.queryBarcode || parsed.barcode || '';
                        let wl = null;
                        if (qb) {
                            try {
                                const dev  = analyzer.device_code || analyzer.name || '';
                                const resp = await getJson(opts.baseUrl,
                                    '/api/lab/worklist?barcode=' + encodeURIComponent(qb)
                                    + '&analyzer_code=' + encodeURIComponent(dev), opts.token);
                                wl = resp.body;
                            } catch (e) {
                                log(`[${analyzer.name}] EROARE worklist: ${e.message}`);
                            }
                        }
                        const nTests = (wl && wl.ok && wl.tests) ? wl.tests.filter(t => t.device_code).length : 0;
                        socket.write(wrapMllp(buildDsr(parsed, wl)));
                        log(`[${analyzer.name}] QRY barcode=${qb} → DSR ${nTests ? 'OK (' + nTests + ' canale)' : 'NF (fara comanda/mapare)'}`);
                        continue;
                    }

                    // ACK imediat către aparat (nu blocăm pe rețea)
                    socket.write(wrapMllp(buildAck(parsed, 'AA')));

                    // forward la MediNote dacă are rezultate
                    if (parsed.results.length > 0 && parsed.barcode) {
                        const payload = toIngestPayload(parsed);
                        // Identitatea aparatului = config-ul listener-ului (port 1:1 cu aparatul),
                        // nu MSH-4 din mesaj — altfel un nume diferit trimis de aparat lasă
                        // rezultatele nemapate pe server.
                        payload.analyzer_code = analyzer.device_code || analyzer.name || payload.analyzer_code;
                        try {
                            const resp = await postJson(opts.baseUrl, '/api/lab/ingest', opts.token, payload);
                            log(`[${analyzer.name}] → MediNote ${resp.status}: ${JSON.stringify(resp.body)}`);
                        } catch (e) {
                            log(`[${analyzer.name}] EROARE forward: ${e.message}`);
                        }
                    }
                } catch (e) {
                    log(`[${analyzer.name}] EROARE parse: ${e.message}`);
                    socket.write(wrapMllp(buildAck(null, 'AE')));
                }
            }
        });

        socket.on('error', (e) => log(`[${analyzer.name}] socket error: ${e.message}`));
        socket.on('close', () => log(`[${analyzer.name}] deconectat`));
    });

    server.on('error', (e) => log(`[${analyzer.name}] server error: ${e.message}`));
    server.listen(port, '0.0.0.0', () => log(`[${analyzer.name}] ascultă MLLP pe 0.0.0.0:${port}`));
    return server;
}

module.exports = { parseHL7, buildAck, buildDsr, toIngestPayload, startAnalyzerListener, wrapMllp, postJson, getJson };

// ── Self-test cu mesaje reale din manualele Mindray ─────────────
if (require.main === module && process.argv.includes('--selftest')) {
    const samples = [
        // Chimie (Chemistry Analyzer Host Interface Manual)
        'MSH|^~\\&|Mindray|BS-2000|||20120405193926||ORU^R01|1|P|2.3.1\r' +
        'PID|1|1001||| Mike ||19851001095133|M\r' +
        'OBR|1|000000000014|10|^|||20120405193926\r' +
        'OBX|1|NM|5|ALT|98.2|U/L|0-41|H|||F\r' +
        'OBX|2|NM|6|AST|26.4|U/L|0-40|N|||F\r' +
        'OBX|3|NM|99|GGT|45|U/L|0-55|N|||F',
        // Imunologie (cu ref „min-")
        'MSH|^~\\&|Mindray(Manufacturer)|CL-2600i|||20100217120412||ORU^R01|1410|P|2.3.1\r' +
        'PID|1410||1952-05-18||Pietrusza Tadeusz\r' +
        'OBR|1|256122-55|32|Mindray^|N||20100217120412\r' +
        'OBX|1|NM|25|HDL C|57.0|mg/dL|40.000000-|Normale|||F',
    ];
    for (const s of samples) {
        const p = parseHL7(s);
        console.log('\n=== ' + p.messageType + ' / ' + p.analyzerCode + ' / barcode=' + p.barcode + ' ===');
        console.log('candidați barcode:', p.barcodeCandidates);
        for (const r of p.results) {
            console.log(`  cod=${r.code} nume=${r.name} val=${r.value}${r.unit} ref=${r.refLow ?? ''}-${r.refHigh ?? ''} flag=${r.flag}`);
        }
        console.log('ACK:', JSON.stringify(buildAck(p)));
    }

    // Host query (QRY^Q02) din manualul Mindray → DSR^Q03
    const qry = 'MSH|^~\\&|Mindray|BS-2000|||20120405194245||QRY^Q02|9|P|2.3.1\r' +
        'QRD|20120405194245|R|D|1|||RD|10|OTH|||T\r' +
        'QRF|BS-2000||||';
    const pq = parseHL7(qry);
    console.log('\n=== ' + pq.messageType + ' / queryBarcode=' + pq.queryBarcode + ' ===');
    const fakeWorklist = { ok: true, barcode: '10', patient: 'Mike', patient_sex: 'M',
        tests: [{ device_code: '5' }, { device_code: '6' }, { device_code: '3' }] };
    console.log('DSR (cu comanda gasita):\n' + buildDsr(pq, fakeWorklist).replace(/\r/g, '\n'));
    console.log('DSR (fara comanda):\n' + buildDsr(pq, { ok: false, tests: [] }).split('\r').slice(0, 4).join('\n'));
}
