'use strict';

// eCard.SDK wrapper (Anexa 102 PIAS)
// Citirea reala merge prin ecard-helper.ps1, care incarca SDK-ul CNAS prin reflection:
// kitul 2.x = Ceas.eCard.SDK.dll (citeste si cartea de identitate electronica, CEI),
// kitul 1.x = Novensys.eCard.SDK.dll. Daca lipsesc, helperul descarca singur kitul oficial
// de pe portal.cnas.ro in SDK_DIR. Fara SDK -> eroare reala (fara mock).

const { execFile } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

const SDK_DIR = process.env.MEDINOTE_ECARD_SDK_DIR || 'C:\\ProgramData\\MediNoteAgent\\eCardSDK';
const SDK_FILES = ['Ceas.eCard.SDK.dll', 'Novensys.eCard.SDK.dll'];
const HELPER_SRC = path.join(__dirname, 'ecard-helper.ps1');
const IS_PROD = process.env.MEDINOTE_AGENT_ENV !== 'test';
const UM_HOST = IS_PROD ? 'umceas.siui.ro' : 'testumceas.siui.ro';

// Campurile cerute: cardul de sanatate (A1 nr card, A3 versiune, B1 nume, B2 prenume,
// B3 data nasterii, B4 CNP, C1 nr asigurat) + datele personale de pe cartea de identitate
// (grupul I: sex, parinti, cetatenie, serie/nr CI, emitere, valabilitate, autoritate, poza,
// adresa, resedinta). La „identitate” se cer toate; daca SDK-ul refuza lista, helperul revine
// la citirea de baza.
const FIELDS_HEALTH = ['A1', 'A3', 'B1', 'B2', 'B3', 'B4', 'C1'];
const FIELDS_IDENTITY = FIELDS_HEALTH.concat(['I1', 'I2', 'I3', 'I4', 'I5', 'I6', 'I7', 'I8', 'I10', 'I11']);

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

// Doar informativ (status): citirea merge si fara, pentru ca helperul descarca singur kitul.
// Pana la 1.9.0 se verifica doar Novensys.eCard.SDK.dll, asa ca pe calculatoarele noi
// (kitul 2.x) citirea se oprea cu „SDK neinstalat” inainte de descarcarea automata.
function isSdkAvailable() {
    try {
        return SDK_FILES.some((f) => fs.existsSync(path.join(SDK_DIR, f)));
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
        // +150s: prima citire poate descarca kitul SDK (~4 MB) de pe portal.cnas.ro
        execFile('powershell.exe', args, { timeout: (timeoutSec + 150) * 1000, maxBuffer: 16 * 1024 * 1024, windowsHide: true }, (err, stdout) => {
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
// $optional: la citirea de identitate (buletin) clinicile fara contract CAS trimit gol;
// pentru CEI SDK-ul nu cere token de la UM.
function drepturiArgs(params, optional) {
    const p = params || {};
    const missing = ['cui', 'contract', 'casa'].filter((k) => !p[k]);
    if (missing.length && !optional) {
        throw new Error('Lipsesc datele de contract pentru card: ' + missing.join(', '));
    }
    return [
        '-Cif', String(p.cif || p.cui || ''),
        '-Cui', String(p.cui || ''),
        '-Contract', String(p.contract || ''),
        '-ContractDate', String(p.contract_date || ''),
        '-Casa', String(p.casa || ''),
        '-TipFurnizor', String(p.tip_furnizor || 'CLIN'),
    ];
}

// Mapeaza dump-ul generic de campuri (nume proprietati Novensys) pe cheile stabile
// pe care le asteapta MediNote. Cheile vin ca „DateIdentificare.CNP”, „DatePersonale.Adresa” etc.
function pick(fields, patterns) {
    for (const key of Object.keys(fields || {})) {
        const flat = key.toLowerCase().replace(/[^a-z0-9]/g, '');
        if (patterns.some((rx) => rx.test(flat))) {
            const v = fields[key];
            if (v !== null && v !== undefined && String(v).trim() !== '') return v;
        }
    }
    return null;
}

function normSex(v) {
    if (v === null || v === undefined) return null;
    const s = String(v).trim().toUpperCase();
    if (/^(M|MASCULIN|MALE|1)$/.test(s)) return 'M';
    if (/^(F|FEMININ|FEMALE|2)$/.test(s)) return 'F';
    return null;
}

function mapCardFields(fields) {
    const nume = pick(fields, [/^(dateidentificare)?nume$/, /numetitular/, /numeasigurat/]);
    const prenume = pick(fields, [/^(dateidentificare)?prenume$/]);
    return {
        cid: pick(fields, [/numarasigurat/, /^cid$/]),
        card_no: pick(fields, [/numarcard/, /nrcard/]),
        cnp: pick(fields, [/cnp$/, /codnumericpersonal/]),
        patient_name: [nume, prenume].filter(Boolean).join(' ') || null,
        last_name: nume,
        first_name: prenume,
        birth_date: pick(fields, [/datanasterii/, /datanastere/]),
        sex: normSex(pick(fields, [/datepersonalesex$/, /^sex$/])),
        // adresa de domiciliu (CEI); componentele, daca SDK-ul le expune separat
        address: pick(fields, [/datepersonaleadresa$/, /^adresa$/]),
        county: pick(fields, [/adresa(judet|county)/]),
        city: pick(fields, [/adresa(localitate|oras|city)/]),
        residence: pick(fields, [/datepersonaleresedinta$/]),
        id_series: pick(fields, [/serienumarci/]),
    };
}

const SDK_MISSING_MSG = 'Biblioteca eCard (SDK CNAS) nu este instalata pe acest calculator si nu s-a putut descarca automat. '
    + 'Descarca eCard.SDK.2.0.0.4.zip de pe portal.cnas.ro/cnas/pias/ecard.sdk si dezarhiveaza-l in ' + SDK_DIR + '.';

// params.mode: 'health' (implicit, tabul CAS din fisa) sau 'identity' (card de sanatate SAU
// carte de identitate electronica, pentru datele pacientului la „Pacient nou” / „Consultatie noua”).
async function readCard(params) {
    const p = params || {};
    const identity = p.mode === 'identity';
    const args = drepturiArgs(p, identity).concat([
        '-Fields', (identity ? FIELDS_IDENTITY : FIELDS_HEALTH).join(','),
        '-FallbackFields', FIELDS_HEALTH.join(','),
    ]);
    const result = await runHelper('read', args, 90);
    if (!result.success) {
        if (result.sdk_present === false) return { success: false, unavailable: true, error: result.error || SDK_MISSING_MSG };
        return { success: false, error: result.error || 'Citire esuata', code: result.code };
    }
    const mapped = mapCardFields(result.fields);
    return Object.assign({ success: true, card_kind: result.card_kind || null, fields_raw: result.fields }, mapped);
}

async function signData(cid, cardNo, reportDate, serviceCode, params) {
    // Sablonul semnaturii per serviciu (spec PIAS): cid|cardNo|reportDate|serviceCode
    const payload = `${cid}|${cardNo}|${reportDate}|${serviceCode}`;
    const args = drepturiArgs(params).concat(['-DataB64', Buffer.from(payload, 'utf8').toString('base64')]);
    const result = await runHelper('sign', args, 120);
    if (!result.success) {
        if (result.sdk_present === false) return { success: false, unavailable: true, error: result.error || SDK_MISSING_MSG };
        return { success: false, error: result.error || 'Semnare esuata' };
    }
    return { success: true, signature: result.signature };
}

async function getReaderStatus() {
    // statusul nu descarca kitul (se cere des); descarcarea o face prima citire de card
    if (!isSdkAvailable()) {
        return { connected: false, sdk_present: false, reader_name: null, sdk_dir: SDK_DIR };
    }
    try {
        const result = await runHelper('status', [], 20);
        return {
            connected: !!result.success,
            sdk_present: result.sdk_present !== false,
            sdk_version: result.sdk_version || null,
            sdk_file: result.sdk_file || null,
            supported_terminals: result.supported_terminals || [],
            sdk_dir: SDK_DIR,
            error: result.success ? undefined : result.error,
        };
    } catch (e) {
        return { connected: false, sdk_present: isSdkAvailable(), sdk_dir: SDK_DIR, error: e.message };
    }
}

module.exports = { readCard, signData, getReaderStatus, isSdkAvailable };
