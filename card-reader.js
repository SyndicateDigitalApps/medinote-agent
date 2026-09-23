'use strict';

// eCard.SDK wrapper (Anexa 102 PIAS)
// Citirea reala merge prin ecard-helper.ps1, care incarca Novensys.eCard.SDK.dll
// prin reflection. SDK-ul (4 fisiere de la CNAS/Novensys) se pune in SDK_DIR —
// agentul il detecteaza automat, fara reinstalare. Fara SDK -> eroare reala (fara mock).

const { execFile } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

const SDK_DIR = process.env.MEDINOTE_ECARD_SDK_DIR || 'C:\\ProgramData\\MediNoteAgent\\eCardSDK';
const HELPER_SRC = path.join(__dirname, 'ecard-helper.ps1');
const IS_PROD = process.env.MEDINOTE_AGENT_ENV !== 'test';
const UM_HOST = IS_PROD ? 'umceas.siui.ro' : 'testumceas.siui.ro';

// powershell.exe nu poate citi din app.asar — copiem helperul intr-un .ps1
// temporar la primul apel (fs-ul Electron citeste din asar fara probleme)
let helperTmp = null;
function helperPath() {
    if (helperTmp && fs.existsSync(helperTmp)) return helperTmp;
    const tmp = path.join(os.tmpdir(), 'mn_ecard_helper_' + process.pid + '.ps1');
    // BOM UTF-8, altfel PowerShell 5.1 citeste diacriticele gresit
    fs.writeFileSync(tmp, '\uFEFF' + fs.readFileSync(HELPER_SRC, 'utf8'), 'utf8');
    helperTmp = tmp;
    return tmp;
}

function isSdkAvailable() {
    try {
        return fs.existsSync(path.join(SDK_DIR, 'Novensys.eCard.SDK.dll'));
    } catch (e) {
        return false;
    }
}

function runHelper(command, extraArgs, timeoutSec) {
    const args = [
        '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', helperPath(),
        '-Command', command,
        '-SdkDir', SDK_DIR,
        '-UmHost', UM_HOST,
        '-TimeoutSec', String(timeoutSec),
    ].concat(extraArgs || []);
    return new Promise((resolve, reject) => {
        execFile('powershell.exe', args, { timeout: (timeoutSec + 30) * 1000, maxBuffer: 16 * 1024 * 1024, windowsHide: true }, (err, stdout) => {
            const lines = String(stdout || '').trim().split(/\r?\n/);
            const last = lines[lines.length - 1] || '';
            try {
                resolve(JSON.parse(last));
            } catch (e) {
                reject(new Error(err ? ('helper eCard: ' + err.message) : ('raspuns helper invalid: ' + last.slice(0, 200))));
            }
        });
    });
}

// Datele de contract (identificatorul de drepturi din Anexa 102) vin de la
// MediNote per apel — clinici diferite pe acelasi agent nu se amesteca.
function drepturiArgs(params) {
    const p = params || {};
    const missing = ['cui', 'contract', 'casa'].filter((k) => !p[k]);
    if (missing.length) {
        throw new Error('Lipsesc datele de contract pentru card: ' + missing.join(', '));
    }
    return [
        '-Cif', String(p.cif || p.cui),
        '-Cui', String(p.cui),
        '-Contract', String(p.contract),
        '-ContractDate', String(p.contract_date || ''),
        '-Casa', String(p.casa),
        '-TipFurnizor', String(p.tip_furnizor || 'CLIN'),
    ];
}

// Mapeaza dump-ul generic de campuri (nume proprietati Novensys, necunoscute
// exact pana la primul test) pe cheile stabile pe care le asteapta MediNote.
function pick(fields, patterns) {
    for (const key of Object.keys(fields || {})) {
        const flat = key.toLowerCase().replace(/[^a-z0-9]/g, '');
        if (patterns.some((rx) => rx.test(flat))) return fields[key];
    }
    return null;
}

function mapCardFields(fields) {
    const nume = pick(fields, [/^(.*\.)?nume$/, /numetitular/, /numeasigurat/]);
    const prenume = pick(fields, [/prenume/]);
    return {
        cid: pick(fields, [/numarasigurat/, /^cid$/]),
        card_no: pick(fields, [/numarcard/, /nrcard/]),
        cnp: pick(fields, [/^(.*\.)?cnp$/, /codnumericpersonal/]),
        patient_name: [nume, prenume].filter(Boolean).join(' ') || null,
        birth_date: pick(fields, [/datanasterii/, /datanastere/]),
    };
}

// Fara mock: daca biblioteca eCard nu e instalata, intoarcem EROARE REALA,
// nu date fictive. MediNote afiseaza eroarea ca atare.
const SDK_MISSING_MSG = 'Biblioteca eCard (SDK CNAS) nu este instalata pe acest calculator. '
    + 'Copiaza fisierele SDK (Novensys.eCard.SDK.dll etc.) in ' + SDK_DIR + ' si reincearca.';

async function readCard(params) {
    if (!isSdkAvailable()) {
        return { success: false, unavailable: true, error: SDK_MISSING_MSG };
    }
    const result = await runHelper('read', drepturiArgs(params), 90);
    if (!result.success) {
        return { success: false, error: result.error || 'Citire esuata', code: result.code };
    }
    const mapped = mapCardFields(result.fields);
    return Object.assign({ success: true, fields_raw: result.fields }, mapped);
}

async function signData(cid, cardNo, reportDate, serviceCode, params) {
    if (!isSdkAvailable()) {
        return { success: false, unavailable: true, error: SDK_MISSING_MSG };
    }
    // Sablonul semnaturii per serviciu (spec PIAS): cid|cardNo|reportDate|serviceCode
    const payload = `${cid}|${cardNo}|${reportDate}|${serviceCode}`;
    const args = drepturiArgs(params).concat(['-DataB64', Buffer.from(payload, 'utf8').toString('base64')]);
    const result = await runHelper('sign', args, 120);
    if (!result.success) {
        return { success: false, error: result.error || 'Semnare esuata' };
    }
    return { success: true, signature: result.signature };
}

async function getReaderStatus() {
    if (!isSdkAvailable()) {
        return { connected: false, sdk_present: false, reader_name: null, sdk_dir: SDK_DIR };
    }
    try {
        const result = await runHelper('status', [], 20);
        return {
            connected: !!result.success,
            sdk_present: true,
            sdk_version: result.sdk_version || null,
            supported_terminals: result.supported_terminals || [],
            error: result.success ? undefined : result.error,
        };
    } catch (e) {
        return { connected: false, sdk_present: true, error: e.message };
    }
}

module.exports = { readCard, signData, getReaderStatus, isSdkAvailable };
