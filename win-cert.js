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

const { execFile, spawn } = require('child_process');
const fs   = require('fs');
const os   = require('os');
const path = require('path');

const IS_WIN = process.platform === 'win32';

function tmpFile(sufix) {
    return path.join(os.tmpdir(), 'mn_siui_' + Date.now() + '_' + Math.random().toString(36).slice(2) + sufix);
}

function runPowerShell(script, opts = {}) {
    return new Promise((resolve, reject) => {
        if (!IS_WIN) return reject(new Error('Functiile de certificat din store merg doar pe Windows'));
        const ps1 = tmpFile('.ps1');
        // BOM UTF-8, altfel PowerShell 5.1 citeste diacriticele gresit
        fs.writeFileSync(ps1, '﻿' + script, 'utf8');
        // interactive: pentru operatiile cu tokenul (SIUI), fereastra de PIN a
        // middleware-ului SafeNet trebuie sa poata aparea pe ecran — deci FARA
        // -NonInteractive si FARA windowsHide (incident 23.09: tokenul cere PIN
        // per-operatie, iar dintr-un proces ascuns dialogul nu apare → LSA error).
        const psArgs = ['-NoProfile', '-ExecutionPolicy', 'Bypass'];
        if (!opts.interactive) psArgs.push('-NonInteractive');
        psArgs.push('-File', ps1);
        execFile('powershell.exe', psArgs,
            { maxBuffer: 64 * 1024 * 1024, windowsHide: !opts.interactive },
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

    if (certRef.thumbprint && TOKEN_WORKER_ON && (IS_WIN || workerSpawn)) {
        try {
            await workerCall({ op: 'sign', thumbprint: certRef.thumbprint.replace(/[^0-9A-Fa-f]/g, ''), inFile, outFile }, 300000);
            const sig = fs.readFileSync(outFile).toString('base64');
            try { fs.unlinkSync(inFile); }  catch (e) {}
            try { fs.unlinkSync(outFile); } catch (e) {}
            return sig;
        } catch (e) {
            stopWorker();
            console.warn('[token] semnatura prin procesul de token a esuat (' + e.message + ') — incerc calea veche');
        }
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
/**
 * Transport principal pentru SIUI: HttpWebRequest (.NET prin PowerShell).
 * Motiv (incident 22.09.2026): serverele CNAS ruleaza cu certificat EXPIRAT si
 * REVOCAT; curl+schannel cu `-k` + certificat de client din token a dat
 * SEC_E_INTERNAL_ERROR pe calculatorul clinicii. .NET suporta curat
 * combinatia: callback de validare permisiv + cheie pe token (CSP SafeNet).
 * Acelasi contract ca curlStoreRequest: { status, headers{k:[v]}, body:Buffer }.
 */
function psStoreRequest({ url, method = 'GET', headers = {}, body = null, thumbprint, userpwd, timeoutSec = 60 }) {
    return new Promise((resolve, reject) => {
        if (!IS_WIN) return reject(new Error('Cererile cu certificat din store merg doar pe Windows'));

        const tp = String(thumbprint).replace(/[^0-9A-Fa-f]/g, '');
        const outFile  = tmpFile('.resp');
        const hdrFile  = tmpFile('.rhdr');
        let bodyFile = null;
        if (body !== null) {
            bodyFile = tmpFile('.body');
            fs.writeFileSync(bodyFile, body);
        }
        const esc = (s) => String(s).replace(/'/g, "''");

        let setHeaders = '';
        for (const [k, v] of Object.entries(headers)) {
            if (k.toLowerCase() === 'content-type') {
                setHeaders += `$req.ContentType = '${esc(v)}'\n`;
            } else {
                setHeaders += `$req.Headers.Set('${esc(k)}', '${esc(v)}')\n`;
            }
        }

        const script = `
$ErrorActionPreference = 'Stop'
try {
    [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12 -bor [Net.SecurityProtocolType]::Tls11 -bor [Net.SecurityProtocolType]::Tls
    # serverele CNAS pot avea certificat expirat/revocat (incident 22.09.2026);
    # procesul e efemer si vorbeste doar cu URL-ul primit, deci acceptam serverul
    [Net.ServicePointManager]::ServerCertificateValidationCallback = { $true }

    $cert = Get-Item ('Cert:\\CurrentUser\\My\\' + '${tp}')

    # Incalzire PIN: o semnatura directa cu cheia de pe token INAINTE de handshake.
    # Deblocheaza tokenul in SafeNet (fereastra de PIN apare aici, controlat), ca
    # schannel sa foloseasca apoi cheia silentios in TLS (incident 23.09.2026:
    # token cu PIN per-operatie, schannel nu putea afisa dialogul in handshake).
    try {
        $rsaPrime = [Security.Cryptography.X509Certificates.RSACertificateExtensions]::GetRSAPrivateKey($cert)
        if ($rsaPrime) { [void]$rsaPrime.SignData([Text.Encoding]::UTF8.GetBytes('mn-prime'), [Security.Cryptography.HashAlgorithmName]::SHA256, [Security.Cryptography.RSASignaturePadding]::Pkcs1) }
    } catch {}

    $req  = [Net.HttpWebRequest]::Create('${esc(url)}')
    $req.Method = '${esc(method)}'
    $req.ProtocolVersion = [Version]'1.1'
    $req.KeepAlive = $false
    $req.AllowAutoRedirect = $false
    $req.Timeout = ${timeoutSec * 1000}
    $req.ReadWriteTimeout = ${timeoutSec * 1000}
    $req.ServicePoint.Expect100Continue = $false
    [void]$req.ClientCertificates.Add($cert)
${userpwd ? `    $req.Headers.Set('Authorization', 'Basic ' + [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes('${esc(userpwd)}')))` : ''}
${setHeaders}
${bodyFile ? `
    $bytes = [IO.File]::ReadAllBytes('${esc(bodyFile)}')
    $req.ContentLength = $bytes.Length
    $rs = $req.GetRequestStream(); $rs.Write($bytes, 0, $bytes.Length); $rs.Close()
` : `    if ('${esc(method)}' -ne 'GET') { $req.ContentLength = 0 }`}

    try {
        $resp = $req.GetResponse()
    } catch [Net.WebException] {
        if ($_.Exception.Response) { $resp = $_.Exception.Response } else { throw }
    }

    $status = [int]$resp.StatusCode
    $sb = New-Object Text.StringBuilder
    foreach ($k in $resp.Headers.AllKeys) {
        foreach ($v in $resp.Headers.GetValues($k)) { [void]$sb.AppendLine($k + ': ' + $v) }
    }
    [IO.File]::WriteAllText('${esc(hdrFile)}', $sb.ToString())
    $ms = New-Object IO.MemoryStream
    $resp.GetResponseStream().CopyTo($ms)
    $resp.Close()
    [IO.File]::WriteAllBytes('${esc(outFile)}', $ms.ToArray())
    Write-Output ('PSOK:' + $status)
} catch {
    Write-Output ('PSERR:' + $_.Exception.Message)
}
`;
        runPowerShell(script, { interactive: true }).then((stdout) => {
            const cleanup = () => {
                if (bodyFile) { try { fs.unlinkSync(bodyFile); } catch (e) {} }
                try { fs.unlinkSync(hdrFile); } catch (e) {}
                try { fs.unlinkSync(outFile); } catch (e) {}
            };
            const line = String(stdout || '').trim().split(/\r?\n/).pop() || '';
            if (!line.startsWith('PSOK:')) {
                cleanup();
                return reject(new Error('transport .NET: ' + (line.replace(/^PSERR:/, '').trim() || 'raspuns neasteptat').slice(0, 300)));
            }
            const status = parseInt(line.slice(5), 10) || 0;
            const hdrs = {};
            let rawHeaders = '';
            try { rawHeaders = fs.readFileSync(hdrFile, 'utf8'); } catch (e) {}
            for (const l of rawHeaders.split(/\r?\n/)) {
                const i = l.indexOf(':');
                if (i === -1) continue;
                const k = l.slice(0, i).trim().toLowerCase();
                const v = l.slice(i + 1).trim();
                (hdrs[k] = hdrs[k] || []).push(v);
            }
            let respBody = Buffer.alloc(0);
            try { respBody = fs.readFileSync(outFile); } catch (e) {}
            cleanup();
            resolve({ status, headers: hdrs, body: respBody });
        }).catch((e) => {
            if (bodyFile) { try { fs.unlinkSync(bodyFile); } catch (e2) {} }
            try { fs.unlinkSync(hdrFile); } catch (e2) {}
            try { fs.unlinkSync(outFile); } catch (e2) {}
            reject(e);
        });
    });
}


// ── Procesul de token: PIN o singura data pe sesiune (v1.10.0, 18.11.2026) ────────────────────
// Pana la 1.9.3 fiecare cerere catre SIUI pornea un powershell.exe nou, cu conexiune noua. Tokenul (SafeNet) tine
// minte PIN-ul doar cat traieste procesul care l-a cerut → PIN la fiecare operatie. Acum un singur proces ramane
// pornit cat ruleaza agentul: PIN-ul se cere la prima operatie, iar conexiunea cu SIUI ramane deschisa intre cereri.
// Daca procesul pica sau o cerere esueaza, se revine la calea veche (proces nou per cerere), deci nimic nu merge mai rau.
// MN_TOKEN_WORKER=0 il opreste; MN_TOKEN_IDLE_MIN = dupa cate minute fara cereri se inchide (implicit 240).
const TOKEN_WORKER_ON = process.env.MN_TOKEN_WORKER !== '0';
const TOKEN_IDLE_MS   = (parseInt(process.env.MN_TOKEN_IDLE_MIN, 10) || 240) * 60000;
const WORKER_PS = String.raw`# MediNote Agent - procesul care tine tokenul deschis (PIN o singura data pe sesiune).
# Primeste pe stdin cate o comanda pe linie (JSON in base64) si raspunde pe stdout cu MNRES:<id>:PSOK:<status> sau MNRES:<id>:PSERR:<mesaj>.
# Ramane pornit cat ruleaza agentul: tokenul tine minte PIN-ul cat traieste procesul, iar conexiunea cu SIUI ramane deschisa intre cereri.
$ErrorActionPreference = 'Stop'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12 -bor [Net.SecurityProtocolType]::Tls11 -bor [Net.SecurityProtocolType]::Tls
# serverele CNAS pot avea certificat expirat/revocat (incident 22.09.2026); procesul vorbeste doar cu adresele primite de la agent
[Net.ServicePointManager]::ServerCertificateValidationCallback = { $true }
[Net.ServicePointManager]::Expect100Continue = $false
Add-Type -AssemblyName System.Security
try { $Host.UI.RawUI.WindowTitle = 'MediNote Agent - token SIUI (nu inchide fereastra)' } catch {}
try {
    Add-Type -Namespace MN -Name Win -MemberDefinition '[DllImport("kernel32.dll")] public static extern IntPtr GetConsoleWindow(); [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int n);'
} catch {}

$certs = @{}
$primed = @{}
$minimized = $false

function Reply([string]$id, [string]$text) {
    [Console]::Out.WriteLine('MNRES:' + $id + ':' + $text)
    [Console]::Out.Flush()
}

function Get-Cert([string]$tp) {
    if (-not $tp) { return $null }
    if (-not $certs.ContainsKey($tp)) { $certs[$tp] = Get-Item ('Cert:\CurrentUser\My\' + $tp) }
    return $certs[$tp]
}

# O semnatura cu cheia de pe token inaintea primei conexiuni: fereastra de PIN apare aici, controlat (incident 23.09.2026).
# O singura data pe proces: dupa ea tokenul are PIN-ul in memorie.
function Prime([string]$tp, $cert) {
    if (-not $cert -or $primed[$tp]) { return }
    try {
        $rsa = [Security.Cryptography.X509Certificates.RSACertificateExtensions]::GetRSAPrivateKey($cert)
        if ($rsa) { [void]$rsa.SignData([Text.Encoding]::UTF8.GetBytes('mn-prime'), [Security.Cryptography.HashAlgorithmName]::SHA256, [Security.Cryptography.RSASignaturePadding]::Pkcs1) }
    } catch {}
    $primed[$tp] = $true
}

function Send-Once($j, $cert) {
    $req = [Net.HttpWebRequest]::Create([string]$j.url)
    $req.Method = [string]$j.method
    $req.ProtocolVersion = [Version]'1.1'
    $req.KeepAlive = $true
    $req.ConnectionGroupName = 'mn-' + [string]$j.thumbprint
    $req.AllowAutoRedirect = $false
    $req.Timeout = [int]$j.timeoutMs
    $req.ReadWriteTimeout = [int]$j.timeoutMs
    if ($cert) { [void]$req.ClientCertificates.Add($cert) }
    if ($j.userpwd) { $req.Headers.Set('Authorization', 'Basic ' + [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes([string]$j.userpwd))) }
    if ($j.headers) {
        foreach ($p in $j.headers.PSObject.Properties) {
            $n = $p.Name.ToLower()
            if ($n -eq 'content-type') { $req.ContentType = [string]$p.Value }
            elseif ($n -eq 'accept') { $req.Accept = [string]$p.Value }
            else { $req.Headers.Set($p.Name, [string]$p.Value) }
        }
    }
    if ($j.bodyFile) {
        $bytes = [IO.File]::ReadAllBytes([string]$j.bodyFile)
        $req.ContentLength = $bytes.Length
        $rs = $req.GetRequestStream(); $rs.Write($bytes, 0, $bytes.Length); $rs.Close()
    } elseif ($req.Method -ne 'GET') {
        $req.ContentLength = 0
    }

    $resp = $null
    try {
        $resp = $req.GetResponse()
    } catch [Net.WebException] {
        if ($_.Exception.Response) { $resp = $_.Exception.Response } else { throw }
    }

    $status = [int]$resp.StatusCode
    $sb = New-Object Text.StringBuilder
    foreach ($k in $resp.Headers.AllKeys) {
        foreach ($v in $resp.Headers.GetValues($k)) { [void]$sb.AppendLine($k + ': ' + $v) }
    }
    [IO.File]::WriteAllText([string]$j.hdrFile, $sb.ToString())
    $ms = New-Object IO.MemoryStream
    $resp.GetResponseStream().CopyTo($ms)
    $resp.Close()
    [IO.File]::WriteAllBytes([string]$j.outFile, $ms.ToArray())
    return $status
}

# Conexiunea pastrata deschisa a fost inchisa intre timp de server: cererea se repeta o data, pe o conexiune noua.
function Is-StaleConnection($err) {
    $e = $err.Exception
    while ($e -and -not ($e -is [Net.WebException])) { $e = $e.InnerException }
    if (-not $e) { return $false }
    return @('KeepAliveFailure', 'ConnectionClosed', 'SendFailure', 'ReceiveFailure', 'PipelineFailure') -contains [string]$e.Status
}

function Sign-Cms($j, $cert) {
    $data    = [IO.File]::ReadAllBytes([string]$j.inFile)
    $content = New-Object System.Security.Cryptography.Pkcs.ContentInfo (,$data)
    $cms     = New-Object System.Security.Cryptography.Pkcs.SignedCms ($content, $false)
    $signer  = New-Object System.Security.Cryptography.Pkcs.CmsSigner ($cert)
    # .NET Framework semneaza implicit SHA-1 - refuzat de SIUI. Fortam SHA-256.
    $signer.DigestAlgorithm = New-Object System.Security.Cryptography.Oid '2.16.840.1.101.3.4.2.1'
    $cms.ComputeSignature($signer)
    [IO.File]::WriteAllBytes([string]$j.outFile, $cms.Encode())
}

while ($true) {
    $line = [Console]::In.ReadLine()
    if ($line -eq $null) { break }
    if (-not $line.Trim()) { continue }
    $id = '0'
    try {
        $j = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($line.Trim())) | ConvertFrom-Json
        $id = [string]$j.id
        if ($j.op -eq 'ping') { Reply $id 'PSOK:0'; continue }
        $cert = Get-Cert ([string]$j.thumbprint)
        if ($j.op -eq 'sign') {
            Sign-Cms $j $cert
            Reply $id 'PSOK:0'
            continue
        }
        Prime ([string]$j.thumbprint) $cert
        $status = $null
        try {
            $status = Send-Once $j $cert
        } catch {
            if (Is-StaleConnection $_) { $status = Send-Once $j $cert } else { throw }
        }
        Reply $id ('PSOK:' + $status)
        # dupa prima cerere reusita fereastra se micsoreaza in bara de jos (nu se ascunde: tokenul poate cere iar PIN-ul)
        if (-not $minimized) { $minimized = $true; try { [void][MN.Win]::ShowWindow([MN.Win]::GetConsoleWindow(), 7) } catch {} }
    } catch {
        $m = [string]$_.Exception.Message
        Reply $id ('PSERR:' + ($m -replace '[\r\n]+', ' '))
    }
}
`;

let worker = null;
let workerSpawn = null;   // doar pentru teste: inlocuieste powershell.exe

function startWorker() {
    let proc, ps1 = null;
    if (workerSpawn) {
        proc = workerSpawn();
    } else {
        ps1 = tmpFile('_token.ps1');
        fs.writeFileSync(ps1, '﻿' + WORKER_PS, 'utf8');
        // FARA windowsHide si FARA -NonInteractive: fereastra de PIN a tokenului trebuie sa poata aparea (incident 23.09.2026)
        proc = spawn('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', ps1],
            { windowsHide: false, stdio: ['pipe', 'pipe', 'pipe'] });
    }
    const w = { proc, ps1, buf: '', pending: new Map(), seq: 0, idle: null, dead: false };
    w.die = (why) => {
        if (w.dead) return;
        w.dead = true;
        if (worker === w) worker = null;
        clearTimeout(w.idle);
        for (const p of w.pending.values()) { clearTimeout(p.timer); p.reject(new Error('procesul de token s-a oprit' + (why ? ' (' + why + ')' : ''))); }
        w.pending.clear();
        if (w.ps1) { try { fs.unlinkSync(w.ps1); } catch (e) {} }
    };
    proc.stdout.setEncoding('utf8');
    proc.stdout.on('data', (chunk) => {
        w.buf += chunk;
        let i;
        while ((i = w.buf.indexOf('\n')) !== -1) {
            const line = w.buf.slice(0, i).trim();
            w.buf = w.buf.slice(i + 1);
            const m = line.match(/^MNRES:(\d+):(PSOK|PSERR):(.*)$/);
            if (!m) continue;
            const p = w.pending.get(Number(m[1]));
            if (!p) continue;
            w.pending.delete(Number(m[1]));
            clearTimeout(p.timer);
            if (m[2] === 'PSOK') p.resolve(m[3]);
            else p.reject(new Error('transport .NET: ' + (m[3].trim() || 'raspuns neasteptat').slice(0, 300)));
        }
    });
    if (proc.stderr) proc.stderr.on('data', () => {});
    proc.stdin.on('error', () => {});
    proc.on('exit', (code) => w.die('cod ' + code));
    proc.on('error', (e) => w.die(e.message));
    return w;
}

function stopWorker() {
    const w = worker;
    if (!w) return;
    worker = null;
    try { w.proc.stdin.end(); } catch (e) {}
    try { w.proc.kill(); } catch (e) {}
    w.die('oprit');
}

function workerCall(msg, timeoutMs) {
    if (!worker) worker = startWorker();
    const w = worker;
    const id = ++w.seq;
    clearTimeout(w.idle);
    w.idle = setTimeout(() => { if (worker === w && w.pending.size === 0) stopWorker(); }, TOKEN_IDLE_MS);
    if (w.idle.unref) w.idle.unref();
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
            w.pending.delete(id);
            reject(new Error('procesul de token nu a raspuns in ' + Math.round(timeoutMs / 1000) + ' s'));
            if (worker === w) stopWorker();
        }, timeoutMs);
        w.pending.set(id, { resolve, reject, timer });
        try {
            w.proc.stdin.write(Buffer.from(JSON.stringify(Object.assign({ id }, msg)), 'utf8').toString('base64') + '\n');
        } catch (e) {
            clearTimeout(timer);
            w.pending.delete(id);
            reject(e);
        }
    });
}

/** Aceeasi cerere ca psStoreRequest, dar prin procesul care ramane pornit. Acelasi contract: { status, headers{k:[v]}, body:Buffer }. */
async function workerStoreRequest({ url, method = 'GET', headers = {}, body = null, thumbprint, userpwd, timeoutSec = 60 }) {
    if (!IS_WIN && !workerSpawn) throw new Error('Cererile cu certificat din store merg doar pe Windows');
    const outFile = tmpFile('.resp');
    const hdrFile = tmpFile('.rhdr');
    let bodyFile = null;
    if (body !== null) {
        bodyFile = tmpFile('.body');
        fs.writeFileSync(bodyFile, body);
    }
    try {
        // +120 s peste limita cererii: timpul in care omul tasteaza PIN-ul la prima operatie
        const st = await workerCall({
            op: 'http', url, method, headers, bodyFile, outFile, hdrFile,
            thumbprint: String(thumbprint || '').replace(/[^0-9A-Fa-f]/g, ''),
            userpwd: userpwd || '', timeoutMs: timeoutSec * 1000,
        }, timeoutSec * 1000 + 120000);
        const hdrs = {};
        let rawHeaders = '';
        try { rawHeaders = fs.readFileSync(hdrFile, 'utf8'); } catch (e) {}
        for (const l of rawHeaders.split(/\r?\n/)) {
            const i = l.indexOf(':');
            if (i === -1) continue;
            (hdrs[l.slice(0, i).trim().toLowerCase()] = hdrs[l.slice(0, i).trim().toLowerCase()] || []).push(l.slice(i + 1).trim());
        }
        let respBody = Buffer.alloc(0);
        try { respBody = fs.readFileSync(outFile); } catch (e) {}
        return { status: parseInt(st, 10) || 0, headers: hdrs, body: respBody };
    } finally {
        if (bodyFile) { try { fs.unlinkSync(bodyFile); } catch (e) {} }
        try { fs.unlinkSync(hdrFile); } catch (e) {}
        try { fs.unlinkSync(outFile); } catch (e) {}
    }
}

process.on('exit', stopWorker);

/** Dispatcher: procesul de token (PIN o data), apoi caile vechi — .NET intr-un proces nou, curl ca rezerva. */
async function storeRequest(opts) {
    let first = null;
    if (TOKEN_WORKER_ON) {
        try {
            return await workerStoreRequest(opts);
        } catch (e) {
            first = e;
            stopWorker();
            console.warn('[token] cererea prin procesul de token a esuat (' + e.message + ') — incerc calea veche');
        }
    }
    try {
        return await psStoreRequest(opts);
    } catch (e) {
        try {
            return await curlStoreRequest(opts);
        } catch (e2) {
            throw new Error((first ? first.message + ' | ' : '') + e.message + ' | fallback ' + e2.message);
        }
    }
}

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

module.exports = {
    IS_WIN, listCerts, signCms, zipSingleFile, curlStoreRequest, storeRequest, stopWorker,
    _test: { setWorkerSpawn(fn) { workerSpawn = fn; }, workerAlive() { return !!worker; }, workerStoreRequest },
};
