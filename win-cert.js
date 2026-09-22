'use strict';

/**
 * Criptografie prin Windows: certificate din magazinul de certificate (inclusiv
 * TOKENURI eToken/SafeNet — cheia ramane in cip, la semnare middleware-ul cere PIN)
 * si cereri HTTPS cu certificat client din store (curl.exe cu backend schannel,
 * livrat cu Windows 10+).
 *
 * Context: certificatele SIUI sunt calificate PE TOKEN prin lege (din 2011) — nu
 * exista fisier .pfx de incarcat, deci semnarea si mTLS-ul se fac obligatoriu aici,
 * pe calculatorul cu tokenul. Validat prin PoC 21.09.2026: SignedCms cu SHA-256
 * din store produce CMS acceptat de `openssl cms -verify`, payload byte-identic.
 */

const { execFile } = require('child_process');
const fs   = require('fs');
const os   = require('os');
const path = require('path');

const IS_WIN = process.platform === 'win32';

function tmpFile(sufix) {
    return path.join(os.tmpdir(), 'mn_siui_' + Date.now() + '_' + Math.random().toString(36).slice(2) + sufix);
}

function runPowerShell(script) {
    return new Promise((resolve, reject) => {
        if (!IS_WIN) return reject(new Error('Functiile de certificat din store merg doar pe Windows'));
        const ps1 = tmpFile('.ps1');
        // BOM UTF-8, altfel PowerShell 5.1 citeste diacriticele gresit
        fs.writeFileSync(ps1, '﻿' + script, 'utf8');
        execFile('powershell.exe',
            ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', ps1],
            { maxBuffer: 64 * 1024 * 1024, windowsHide: true },
            (err, stdout, stderr) => {
                try { fs.unlinkSync(ps1); } catch (e) {}
                if (err) return reject(new Error((stderr || err.message || '').trim().slice(0, 500)));
                resolve(stdout);
            });
    });
}

/** Certificatele cu cheie privata din CurrentUser\My — tokenul apare aici cand e in USB + SafeNet instalat. */
async function listCerts() {
    const out = await runPowerShell(`
        $certs = Get-ChildItem Cert:\\CurrentUser\\My | Where-Object { $_.HasPrivateKey } | ForEach-Object {
            @{ thumbprint = $_.Thumbprint
               subject    = $_.Subject
               issuer     = $_.Issuer
               not_after  = $_.NotAfter.ToString('yyyy-MM-dd')
               expired    = ($_.NotAfter -lt (Get-Date)) }
        }
        if ($certs -eq $null) { '[]' } else { ConvertTo-Json @($certs) -Compress }
    `);
    return JSON.parse(out.trim() || '[]');
}

/**
 * Semnatura CMS atasata, DER, SHA-256 (RFC 5652) — formatul cerut de SIUI sendReport.
 * certRef: { thumbprint } (store/token) SAU { pfxBase64, passphrase } (certificat-fisier, ex. cel de test).
 * Cu token, Windows/SafeNet deschide fereastra de PIN la ComputeSignature.
 */
async function signCms(dataBase64, certRef) {
    const inFile  = tmpFile('.bin');
    const outFile = tmpFile('.der');
    fs.writeFileSync(inFile, Buffer.from(dataBase64, 'base64'));

    let certLoad;
    if (certRef.thumbprint) {
        certLoad = `$cert = Get-Item ('Cert:\\CurrentUser\\My\\' + '${certRef.thumbprint.replace(/[^0-9A-Fa-f]/g, '')}')`;
    } else if (certRef.pfxBase64) {
        const pfxFile = tmpFile('.pfx');
        fs.writeFileSync(pfxFile, Buffer.from(certRef.pfxBase64, 'base64'));
        certLoad = `$cert = New-Object System.Security.Cryptography.X509Certificates.X509Certificate2('${pfxFile.replace(/\\/g, '\\\\')}', '${(certRef.passphrase || '').replace(/'/g, "''")}')`;
    } else {
        throw new Error('signCms: lipseste thumbprint sau pfxBase64');
    }

    try {
        await runPowerShell(`
            $ErrorActionPreference = 'Stop'
            Add-Type -AssemblyName System.Security
            ${certLoad}
            $data    = [IO.File]::ReadAllBytes('${inFile.replace(/\\/g, '\\\\')}')
            $content = New-Object System.Security.Cryptography.Pkcs.ContentInfo (,$data)
            $cms     = New-Object System.Security.Cryptography.Pkcs.SignedCms ($content, $false)
            $signer  = New-Object System.Security.Cryptography.Pkcs.CmsSigner ($cert)
            # .NET Framework semneaza implicit SHA-1 — refuzat de openssl 3 / SIUI modern. Fortam SHA-256.
            $signer.DigestAlgorithm = New-Object System.Security.Cryptography.Oid '2.16.840.1.101.3.4.2.1'
            $cms.ComputeSignature($signer)
            [IO.File]::WriteAllBytes('${outFile.replace(/\\/g, '\\\\')}', $cms.Encode())
        `);
        return fs.readFileSync(outFile).toString('base64');
    } finally {
        try { fs.unlinkSync(inFile); }  catch (e) {}
        try { fs.unlinkSync(outFile); } catch (e) {}
    }
}

/** ZIP cu un singur fisier inauntru (numele conteaza — SIUI identifica raportarea dupa el). */
async function zipSingleFile(fileName, dataBase64) {
    const dir = tmpFile('_zipdir');
    fs.mkdirSync(dir);
    const inner = path.join(dir, fileName);
    const zip   = tmpFile('.zip');
    fs.writeFileSync(inner, Buffer.from(dataBase64, 'base64'));
    try {
        await runPowerShell(`
            $ErrorActionPreference = 'Stop'
            Compress-Archive -Path '${inner.replace(/\\/g, '\\\\')}' -DestinationPath '${zip.replace(/\\/g, '\\\\')}' -Force
        `);
        return fs.readFileSync(zip).toString('base64');
    } finally {
        try { fs.unlinkSync(inner); } catch (e) {}
        try { fs.rmdirSync(dir); }    catch (e) {}
        try { fs.unlinkSync(zip); }   catch (e) {}
    }
}

/**
 * Cerere HTTPS cu certificat client din STORE (mTLS prin tokenul din USB).
 * Node https nu poate folosi chei din store → curl.exe cu backend schannel
 * (`--cert CurrentUser\\MY\\<thumbprint>` — validat in PoC ca accepta sintaxa).
 * Returneaza { status, headers (lowercase, multi-value ca array), body }.
 */
function curlStoreRequest({ url, method = 'GET', headers = {}, body = null, thumbprint, userpwd, timeoutSec = 60 }) {
    return new Promise((resolve, reject) => {
        if (!IS_WIN) return reject(new Error('curl schannel merge doar pe Windows'));

        const headerFile = tmpFile('.hdr');
        const args = ['-s', '-S', '--max-time', String(timeoutSec),
            '-X', method,
            '--cert', 'CurrentUser\\MY\\' + String(thumbprint).replace(/[^0-9A-Fa-f]/g, ''),
            '-D', headerFile,
            '-H', 'Expect:',
            '--http1.1', // spec cere 1.0; curl nu mai stie 1.0 peste TLS modern — Axis accepta 1.1 (nota istorica din agent)
        ];
        if (userpwd) args.push('-u', userpwd);

        // DOAR pentru serverele CNAS: nu validam certificatul serverului. Incident
        // 22.09.2026: dupa o mentenanta, www.siui.ro a ramas cu un certificat
        // EXPIRAT (09.04.2026) si REVOCAT — toate softurile de raportare din piata
        // merg pentru ca nu valideaza deloc; validarea stricta ne-a oprit doar pe
        // noi. Securitatea autentificarii ramane pe mTLS (certificat client din
        // token) + Basic + jetonul OCSP; -k e limitat strict la *.siui.ro.
        let siuiHost = false;
        try { siuiHost = /(^|\.)siui\.ro$/.test(new URL(url).hostname); } catch (e) {}
        if (siuiHost) args.push('-k');

        for (const [k, v] of Object.entries(headers)) args.push('-H', k + ': ' + v);

        let bodyFile = null;
        if (body !== null) {
            bodyFile = tmpFile('.body');
            fs.writeFileSync(bodyFile, body);
            args.push('--data-binary', '@' + bodyFile);
        }
        args.push(url);

        // encoding buffer: body-ul poate fi binar (ZIP-ul nomenclatoarelor) — utf8 l-ar corupe
        execFile('curl.exe', args, { maxBuffer: 128 * 1024 * 1024, windowsHide: true, encoding: 'buffer' }, (err, stdout, stderr) => {
            let rawHeaders = '';
            try { rawHeaders = fs.readFileSync(headerFile, 'utf8'); } catch (e) {}
            try { fs.unlinkSync(headerFile); } catch (e) {}
            if (bodyFile) { try { fs.unlinkSync(bodyFile); } catch (e) {} }

            if (err && !rawHeaders) {
                const errText = Buffer.isBuffer(stderr) ? stderr.toString('utf8') : String(stderr || err.message);
                return reject(new Error('curl: ' + errText.trim().slice(0, 300)));
            }

            // Ultimul bloc de headere (dupa eventuale redirecturi/100-continue)
            const blocks = rawHeaders.split(/\r?\n\r?\n/).filter(b => b.trim());
            const last   = blocks[blocks.length - 1] || '';
            const lines  = last.split(/\r?\n/);
            const status = parseInt((lines[0] || '').split(' ')[1], 10) || 0;
            const hdrs   = {};
            for (const line of lines.slice(1)) {
                const i = line.indexOf(':');
                if (i === -1) continue;
                const k = line.slice(0, i).trim().toLowerCase();
                const v = line.slice(i + 1).trim();
                (hdrs[k] = hdrs[k] || []).push(v);
            }
            // body: Buffer (binar-sigur); apelantii de text fac .toString('utf8')
            resolve({ status, headers: hdrs, body: stdout });
        });
    });
}

module.exports = { IS_WIN, listCerts, signCms, zipSingleFile, curlStoreRequest };
