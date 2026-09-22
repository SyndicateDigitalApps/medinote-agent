'use strict';

const https = require('https');
const fs    = require('fs');

// PRODUCTIA e default: agentul ruleaza la clinici, cu chei si certificate reale.
// (v1.3.0 avea testul ca default — prins la primul test live, Nicomed 22.09.)
const IS_PROD = process.env.SIUI_ENV !== 'test';

// WSDL endpoints conform PIAS v3.7.31
const ENDPOINTS = {
    main:     IS_PROD
        ? 'https://www.siui.ro/svapntws/services/SiuiWS'
        : 'https://siui.cnas.ro/siuiTest/services/WSSIUI',
    insured:  IS_PROD
        ? 'https://www.siui.ro/svapntws/services/SiuiInsuredWS'
        : 'https://siui.cnas.ro/siuiTest/services/SiuiInsuredWS',
    validate: IS_PROD
        ? 'https://www.siui.ro/svapntws/services/SiuiValidateWS'
        : 'https://siui.cnas.ro/siuiTest/services/SiuiValidateWS',
    einvoice: IS_PROD
        ? 'https://www.siui.ro/svapntws/services/SiuiEInvoiceWS'
        : 'https://siui.cnas.ro/siuiTest/services/SiuiEInvoiceWS',
};

// OCSP validator endpoint — Step 1 din autentificare (PIAS cap. 5, pag. 47-49)
const OCSP_URL = IS_PROD
    ? 'https://www.siui.ro/OCSP/validator'
    : 'https://siui.cnas.ro/OCSP/validator';

// Refresh token la fiecare 20 minute (token are validitate limitată)
const TOKEN_TTL_MS = 20 * 60 * 1000;

const winCert = require('./win-cert');

// certConfig:
//   mod fisier: { mode: 'pfx',   pfx: Buffer, passphrase, username, activationKey }
//   mod TOKEN:  { mode: 'store', thumbprint,              username, activationKey }
// username      = utilizatorul SIUI in format CUI_CODCAS (ex. 13478334_CAS-B)
// activationKey = cheia de activare din convenția de utilizare cu CAS județean
// NOTA (21.09.2026): certificatele SIUI sunt calificate PE TOKEN prin lege — modul
// 'store' e calea reala pentru clinici; 'pfx' ramane pentru certificate de test.
let certConfig  = null;
let httpsAgent  = null;
let ocspToken   = null; // token din header OSCP_RESPONSE
let tokenExpiry = 0;

function buildAgent() {
    const opts = { keepAlive: true };
    if (certConfig && certConfig.mode === 'pfx') {
        opts.pfx        = certConfig.pfx;
        opts.passphrase = certConfig.passphrase;
    }
    return new https.Agent(opts);
}

function getAgent() {
    if (!httpsAgent) httpsAgent = buildAgent();
    return httpsAgent;
}

/**
 * Autentificarea conform spec PIAS v3.7.32 (NU Bearer — premisa veche era gresita):
 * Basic Auth cu user={CUI_CODCAS} si parola=cheia de activare, plus username in query
 * la OCSP. Corectat 21.09.2026 dupa citirea integrala a specificatiei.
 */
function basicAuthHeader() {
    const { username, activationKey } = certConfig;
    return 'Basic ' + Buffer.from(`${username || ''}:${activationKey || ''}`).toString('base64');
}

function resetSession() {
    httpsAgent  = null;
    ocspToken   = null;
    tokenExpiry = 0;
}

function loadCertFromFile(pfxPath, passphrase, activationKey, username) {
    try {
        const pfx = fs.readFileSync(pfxPath);
        certConfig = { mode: 'pfx', pfx, passphrase: passphrase || '', activationKey: activationKey || '', username: username || '' };
        resetSession();
        return { ok: true };
    } catch (e) {
        return { ok: false, error: e.message };
    }
}

function loadCertFromBase64(pfxBase64, passphrase, activationKey, username) {
    try {
        const pfx = Buffer.from(pfxBase64, 'base64');
        certConfig = { mode: 'pfx', pfx, passphrase: passphrase || '', activationKey: activationKey || '', username: username || '' };
        resetSession();
        return { ok: true };
    } catch (e) {
        return { ok: false, error: e.message };
    }
}

/** Modul TOKEN: certificatul din magazinul Windows (eToken/SafeNet in USB). */
function loadCertFromStore(thumbprint, activationKey, username) {
    if (!winCert.IS_WIN) return { ok: false, error: 'Modul token e disponibil doar pe Windows' };
    if (!thumbprint)     return { ok: false, error: 'Lipseste amprenta certificatului (thumbprint)' };
    certConfig = { mode: 'store', thumbprint: String(thumbprint), activationKey: activationKey || '', username: username || '' };
    resetSession();
    return { ok: true };
}

function clearCert() {
    certConfig = null;
    resetSession();
}

/**
 * Step 1 autentificare PIAS:
 * GET {OCSP_URL}?username={CUI_CODCAS} cu certificat client (mTLS) + Basic Auth.
 * Returnează token din header OSCP_RESPONSE.
 */
async function fetchOcspToken() {
    if (!certConfig) throw new Error('Certificat SIUI neîncărcat');

    const urlCuUser = OCSP_URL + '?username=' + encodeURIComponent(certConfig.username || '');

    if (certConfig.mode === 'store') {
        const res = await winCert.storeRequest({
            url: urlCuUser, method: 'GET',
            thumbprint: certConfig.thumbprint,
            userpwd: `${certConfig.username || ''}:${certConfig.activationKey || ''}`,
            timeoutSec: 30,
        });
        const token = (res.headers['oscp_response'] || res.headers['ocsp_response'] || [])[0];
        if (!token) throw new Error(`OCSP token lipsă (HTTP ${res.status}) — header OSCP_RESPONSE neprimit`);
        return token;
    }

    const url = new URL(urlCuUser);
    return new Promise((resolve, reject) => {
        const req = https.request({
            hostname:           url.hostname,
            port:               url.port || 443,
            path:               url.pathname + url.search,
            method:             'GET',
            agent:              getAgent(),
            headers:            { 'Authorization': basicAuthHeader() },
            // certificatele serverelor CNAS pot fi expirate/revocate (incident 22.09.2026) — vezi nota din win-cert.js
            rejectUnauthorized: false,
        }, (res) => {
            // Header-ul poate fi lowercase sau uppercase în funcție de implementare
            const token = res.headers['oscp_response'] || res.headers['OSCP_RESPONSE'];
            res.resume(); // consumă body-ul (nu ne interesează)
            if (!token) {
                return reject(new Error('OCSP token lipsă — header OSCP_RESPONSE neprimit'));
            }
            resolve(token);
        });

        req.setTimeout(10000, () => { req.destroy(); reject(new Error('Timeout OCSP (10s)')); });
        req.on('error', reject);
        req.end();
    });
}

async function ensureOcspToken() {
    if (ocspToken && Date.now() < tokenExpiry) return ocspToken;
    ocspToken   = await fetchOcspToken();
    tokenExpiry = Date.now() + TOKEN_TTL_MS;
    return ocspToken;
}

/**
 * Step 2 autentificare PIAS:
 * POST SOAP cu mTLS + Basic Auth + OSCP_RESPONSE header
 *
 * Notă: documentația PIAS cere HTTP/1.0 (Apache AXIS legacy).
 * Node.js https nu suportă forțarea HTTP/1.0 nativ; HTTP/1.1 funcționează
 * în practică cu serverele SIUI (AXIS acceptă ambele versiuni).
 *
 * endpointType: 'main' | 'insured' | 'validate' | 'einvoice'
 * soapAction: ex. 'getInsured', 'validateReport'
 * soapBody: SOAP envelope complet ca string XML
 */
async function call(endpointType, soapAction, soapBody) {
    const baseUrl = ENDPOINTS[endpointType];
    if (!baseUrl) throw new Error('Endpoint necunoscut: ' + endpointType);
    if (!certConfig) throw new Error('Certificat SIUI neîncărcat');

    const token       = await ensureOcspToken();
    const url         = new URL(baseUrl);
    const bodyBuf     = Buffer.from(soapBody, 'utf-8');

    if (certConfig.mode === 'store') {
        const res = await winCert.storeRequest({
            url: baseUrl, method: 'POST',
            headers: {
                'Content-Type':  'text/xml; charset=utf-8',
                'SOAPAction':    `"${soapAction}"`,
                'OSCP_RESPONSE': token,
            },
            body: bodyBuf,
            thumbprint: certConfig.thumbprint,
            userpwd: `${certConfig.username || ''}:${certConfig.activationKey || ''}`,
            timeoutSec: 120,
        });
        const newToken = (res.headers['oscp_response'] || res.headers['ocsp_response'] || [])[0];
        if (newToken) { ocspToken = newToken; tokenExpiry = Date.now() + TOKEN_TTL_MS; }
        return { status: res.status, body: res.body.toString('utf8') };
    }

    return new Promise((resolve, reject) => {
        const req = https.request({
            hostname:           url.hostname,
            port:               url.port || 443,
            path:               url.pathname,
            method:             'POST',
            agent:              getAgent(),
            headers: {
                'Content-Type':   'text/xml; charset=utf-8',
                'SOAPAction':     `"${soapAction}"`,
                'Content-Length': bodyBuf.length,
                'Authorization':  basicAuthHeader(),
                'OSCP_RESPONSE':  token,
            },
            // certificatele serverelor CNAS pot fi expirate/revocate (incident 22.09.2026) — vezi nota din win-cert.js
            rejectUnauthorized: false,
        }, (res) => {
            // SIUI poate returna un token reînnoit
            const newToken = res.headers['oscp_response'] || res.headers['OSCP_RESPONSE'];
            if (newToken) {
                ocspToken   = newToken;
                tokenExpiry = Date.now() + TOKEN_TTL_MS;
            }

            let body = '';
            res.on('data',  chunk => { body += chunk; });
            res.on('end',   ()    => resolve({ status: res.statusCode, body }));
            res.on('error', reject);
        });

        req.setTimeout(15000, () => { req.destroy(); reject(new Error('Timeout SIUI (15s)')); });
        req.on('error', reject);
        req.write(bodyBuf);
        req.end();
    });
}

/**
 * Descarcă un fișier de la URL-ul primit de la SIUI (autentificat mTLS + Basic Auth).
 * SIUI returnează URL-uri temporare cu durată de viață limitată.
 */
async function downloadFromUrl(fileUrl) {
    if (!certConfig) throw new Error('Certificat SIUI neîncărcat');

    if (certConfig.mode === 'store') {
        const res = await winCert.storeRequest({
            url: fileUrl, method: 'GET',
            thumbprint: certConfig.thumbprint,
            userpwd: `${certConfig.username || ''}:${certConfig.activationKey || ''}`,
            timeoutSec: 60,
        });
        if (res.status !== 200) throw new Error('Download HTTP ' + res.status);
        return res.body; // Buffer
    }

    const url = new URL(fileUrl);

    return new Promise((resolve, reject) => {
        const req = https.request({
            hostname:           url.hostname,
            port:               url.port || 443,
            path:               url.pathname + url.search,
            method:             'GET',
            agent:              getAgent(),
            headers:            { 'Authorization': basicAuthHeader() },
            // certificatele serverelor CNAS pot fi expirate/revocate (incident 22.09.2026) — vezi nota din win-cert.js
            rejectUnauthorized: false,
        }, (res) => {
            const chunks = [];
            res.on('data',  chunk => chunks.push(chunk));
            res.on('end',   ()    => resolve(Buffer.concat(chunks)));
            res.on('error', reject);
        });

        req.setTimeout(30000, () => { req.destroy(); reject(new Error('Timeout download nomenclatoare (30s)')); });
        req.on('error', reject);
        req.end();
    });
}

/**
 * Apelează getCatalogues pe SiuiWS, obține URL-ul arhivei ZIP cu nomenclatoare,
 * descarcă arhiva și o returnează ca Buffer base64.
 *
 * partnerCategory: 'CLIN' | 'PARA' | 'STOM' | 'MF' | 'FARMD' | etc. (PIAS §5.1)
 */
async function getCatalogues(partnerCategory) {
    if (!certConfig) throw new Error('Certificat SIUI neîncărcat');

    const soapBody = `<?xml version="1.0" encoding="UTF-8"?>
<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/"
                  xmlns:ws="http://ws.cnas.ro/siui">
    <soapenv:Header/>
    <soapenv:Body>
        <ws:getCatalogues>
            <ws:partnerCategory>${partnerCategory}</ws:partnerCategory>
        </ws:getCatalogues>
    </soapenv:Body>
</soapenv:Envelope>`;

    const result = await call('main', 'getCatalogues', soapBody);

    if (result.status !== 200) {
        throw new Error(`SIUI getCatalogues HTTP ${result.status}`);
    }

    // Parsare răspuns SOAP — returnează String[] cu [url, fileSize] sau null
    const body = result.body;
    const matches = [...body.matchAll(/<[^>]*return[^>]*>([^<]+)<\/[^>]*return>/g)];

    if (!matches || matches.length < 2) {
        // null înseamnă că nu există versiune mai nouă
        return { up_to_date: true, zip_base64: null, file_size: 0 };
    }

    const fileUrl  = matches[0][1].trim();
    const fileSize = parseInt(matches[1][1].trim(), 10) || 0;

    const zipBuffer = await downloadFromUrl(fileUrl);

    return {
        up_to_date: false,
        zip_base64: zipBuffer.toString('base64'),
        file_size:  fileSize,
    };
}

/**
 * Raportarea lunara: semneaza CMS (SHA-256, atasat, DER) XML-ul primit de la MediNote,
 * il arhiveaza ZIP (numele fisierului identifica raportarea la SIUI), il codifica Base64
 * si il trimite prin SiuiWS::sendReport(reportType, reportXML). Semnatura si formatul
 * validate prin PoC cu `openssl cms -verify` (payload byte-identic).
 *
 * Cu token, la semnare middleware-ul SafeNet deschide fereastra de PIN — de anuntat
 * utilizatorul in UI ca fereastra poate aparea in spatele browserului.
 */
async function sendReport({ reportType, fileName, xmlBase64 }) {
    if (!certConfig) throw new Error('Certificat SIUI neîncărcat');
    if (!reportType || !fileName || !xmlBase64) throw new Error('sendReport: reportType, fileName și xmlBase64 sunt obligatorii');

    const certRef = certConfig.mode === 'store'
        ? { thumbprint: certConfig.thumbprint }
        : { pfxBase64: certConfig.pfx.toString('base64'), passphrase: certConfig.passphrase };

    const signedBase64 = await winCert.signCms(xmlBase64, certRef);
    const zipBase64    = await winCert.zipSingleFile(fileName, signedBase64);

    const soapBody = `<?xml version="1.0" encoding="UTF-8"?>`
        + `<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/" xmlns:web="http://webservices.utils.svapnt.siveco.ro">`
        + `<soapenv:Body><web:sendReport>`
        + `<web:reportType>${reportType}</web:reportType>`
        + `<web:reportXML>${zipBase64}</web:reportXML>`
        + `</web:sendReport></soapenv:Body></soapenv:Envelope>`;

    const result = await call('main', 'sendReport', soapBody);

    const m = result.body.match(/<[^>]*sendReportReturn[^>]*>\s*(-?\d+)\s*</);
    const fault = result.body.match(/<faultstring[^>]*>([\s\S]*?)<\/faultstring>/);

    return {
        ok:          !!m && parseInt(m[1], 10) >= 0,
        return_code: m ? parseInt(m[1], 10) : null,
        fault:       fault ? fault[1].replace(/<[^>]+>/g, '').trim() : null,
        http_status: result.status,
        file_name:   fileName,
    };
}

/** Feedback-ul asincron al unei raportari trimise (dupa numele fisierului). */
async function getReportFeedback(fileName) {
    if (!certConfig) throw new Error('Certificat SIUI neîncărcat');

    const soapBody = `<?xml version="1.0" encoding="UTF-8"?>`
        + `<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/" xmlns:web="http://webservices.utils.svapnt.siveco.ro">`
        + `<soapenv:Body><web:getReportFeedback>`
        + `<web:fileName>${fileName}</web:fileName>`
        + `</web:getReportFeedback></soapenv:Body></soapenv:Envelope>`;

    const result = await call('main', 'getReportFeedback', soapBody);

    const lines = [...result.body.matchAll(/<[^>]*getReportFeedbackReturn[^>]*>([\s\S]*?)<\/[^>]*getReportFeedbackReturn>/g)]
        .map(m => m[1].replace(/<[^>]+>/g, '').trim())
        .filter(x => x !== '');

    return { ok: result.status === 200, http_status: result.status, lines };
}

function getStatus() {
    return {
        cert_loaded:    certConfig !== null,
        cert_mode:      certConfig ? certConfig.mode : null,
        username_set:   !!(certConfig && certConfig.username),
        session_active: ocspToken !== null && Date.now() < tokenExpiry,
        token_expires:  tokenExpiry > 0 ? new Date(tokenExpiry).toISOString() : null,
        env:            IS_PROD ? 'production' : 'test',
        endpoints:      ENDPOINTS,
    };
}

module.exports = {
    call, loadCertFromFile, loadCertFromBase64, loadCertFromStore, clearCert,
    getStatus, getCatalogues, sendReport, getReportFeedback, ENDPOINTS,
};
