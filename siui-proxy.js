'use strict';

const https = require('https');
const fs    = require('fs');

const IS_PROD = process.env.SIUI_ENV === 'production';

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

// certConfig: { pfx: Buffer, passphrase: string, activationKey: string }
// activationKey = cheia de activare din convenția de utilizare cu CAS județean
let certConfig  = null;
let httpsAgent  = null;
let ocspToken   = null; // token din header OSCP_RESPONSE
let tokenExpiry = 0;

function buildAgent() {
    const opts = { keepAlive: true };
    if (certConfig) {
        opts.pfx        = certConfig.pfx;
        opts.passphrase = certConfig.passphrase;
    }
    return new https.Agent(opts);
}

function getAgent() {
    if (!httpsAgent) httpsAgent = buildAgent();
    return httpsAgent;
}

function loadCertFromFile(pfxPath, passphrase, activationKey) {
    try {
        const pfx = fs.readFileSync(pfxPath);
        certConfig  = { pfx, passphrase: passphrase || '', activationKey: activationKey || '' };
        httpsAgent  = null;
        ocspToken   = null;
        tokenExpiry = 0;
        return { ok: true };
    } catch (e) {
        return { ok: false, error: e.message };
    }
}

function loadCertFromBase64(pfxBase64, passphrase, activationKey) {
    try {
        const pfx = Buffer.from(pfxBase64, 'base64');
        certConfig  = { pfx, passphrase: passphrase || '', activationKey: activationKey || '' };
        httpsAgent  = null;
        ocspToken   = null;
        tokenExpiry = 0;
        return { ok: true };
    } catch (e) {
        return { ok: false, error: e.message };
    }
}

function clearCert() {
    certConfig  = null;
    httpsAgent  = null;
    ocspToken   = null;
    tokenExpiry = 0;
}

/**
 * Step 1 autentificare PIAS:
 * GET {OCSP_URL} cu certificat client (mTLS) + cheia de activare ca Bearer
 * Returnează token din header OSCP_RESPONSE.
 */
function fetchOcspToken() {
    if (!certConfig) throw new Error('Certificat SIUI neîncărcat');

    const { activationKey } = certConfig;
    const url = new URL(OCSP_URL);

    return new Promise((resolve, reject) => {
        const req = https.request({
            hostname:           url.hostname,
            port:               url.port || 443,
            path:               url.pathname,
            method:             'GET',
            agent:              getAgent(),
            headers:            activationKey ? { 'Authorization': `Bearer ${activationKey}` } : {},
            rejectUnauthorized: true,
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
    const { activationKey } = certConfig;
    const url         = new URL(baseUrl);
    const bodyBuf     = Buffer.from(soapBody, 'utf-8');

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
                ...(activationKey ? { 'Authorization': `Bearer ${activationKey}` } : {}),
                'OSCP_RESPONSE':  token,
            },
            rejectUnauthorized: true,
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
function downloadFromUrl(fileUrl) {
    if (!certConfig) throw new Error('Certificat SIUI neîncărcat');

    const { activationKey } = certConfig;
    const url = new URL(fileUrl);

    return new Promise((resolve, reject) => {
        const req = https.request({
            hostname:           url.hostname,
            port:               url.port || 443,
            path:               url.pathname + url.search,
            method:             'GET',
            agent:              getAgent(),
            headers:            activationKey ? { 'Authorization': `Bearer ${activationKey}` } : {},
            rejectUnauthorized: true,
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

function getStatus() {
    return {
        cert_loaded:    certConfig !== null,
        session_active: ocspToken !== null && Date.now() < tokenExpiry,
        token_expires:  tokenExpiry > 0 ? new Date(tokenExpiry).toISOString() : null,
        env:            IS_PROD ? 'production' : 'test',
        endpoints:      ENDPOINTS,
    };
}

module.exports = { call, loadCertFromFile, loadCertFromBase64, clearCert, getStatus, getCatalogues, ENDPOINTS };
