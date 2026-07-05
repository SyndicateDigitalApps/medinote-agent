'use strict';

const { app, Tray, Menu, nativeImage, dialog, shell, BrowserWindow, ipcMain } = require('electron');
const path   = require('path');
const fs     = require('fs');
const { createServer, PORT } = require('./server');
const { LabRunner } = require('./lab-runner');
const { MiniliteRunner } = require('./minilite-runner');

const IS_DEV = process.argv.includes('--dev');

let tray   = null;
let server = null;
let labRunner = null;
let miniliteRunner = null;
let settingsWin = null;

// Rulează ca singleton — un singur agent per mașină
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
    app.quit();
}

app.whenReady().then(() => {
    // Ascunde din taskbar — trăiește doar în tray
    app.setActivationPolicy && app.setActivationPolicy('accessory');

    startServer();
    startLabConnector();
    startMinilite();
    createTray();

    // Autostart la login Windows
    if (!IS_DEV) {
        app.setLoginItemSettings({
            openAtLogin: true,
            name: 'MediNote Agent',
        });
    }
});

app.on('window-all-closed', () => {
    // Nu ieși când se închid ferestrele — agentul rămâne în tray
});

function startServer() {
    server = createServer((event) => {
        if (event === 'card_read') updateTrayTooltip('Card citit cu succes');
    });
}

/** Găsește config-ul existent (lângă exe → userData → dir sursă), sau null. */
function findConfig(name) {
    const candidates = [
        path.join(path.dirname(app.getPath('exe')), name),
        path.join(app.getPath('userData'), name),
        path.join(__dirname, name),
    ];
    return candidates.find(p => { try { return fs.existsSync(p); } catch (_) { return false; } }) || null;
}

/** Calea unde SCRIEM config-ul: cea existentă (ca să rămână o singură sursă), altfel userData. */
function configWritePath(name) {
    return findConfig(name) || path.join(app.getPath('userData'), name);
}

// Conectorul de laborator — pornește doar dacă există lab-config.json valid (token clinică).
function startLabConnector() {
    try {
        const configPath = findConfig('lab-config.json');
        if (!configPath) {
            console.log('[lab] lab-config.json negăsit — conector inactiv.');
            return;
        }
        labRunner = new LabRunner({ configPath, log: (m) => console.log(m) });
        labRunner.start().then(ok => { if (ok) updateTrayTooltip('Conector laborator activ'); });
    } catch (e) {
        console.log('[lab] eroare pornire conector: ' + e.message);
    }
}

// Conectorul MINILITE — pornește doar dacă există minilite-config.json (token + netdir).
function startMinilite() {
    try {
        const configPath = findConfig('minilite-config.json');
        if (!configPath) { console.log('[minilite] minilite-config.json negăsit — connector inactiv.'); return; }
        miniliteRunner = new MiniliteRunner({ configPath, log: (m) => console.log(m) });
        miniliteRunner.start();
    } catch (e) {
        console.log('[minilite] eroare pornire: ' + e.message);
    }
}

// ── Fereastra de Setări (config laborator fără Notepad) ─────────
function openSettings() {
    if (settingsWin && !settingsWin.isDestroyed()) { settingsWin.focus(); return; }
    settingsWin = new BrowserWindow({
        width: 520, height: 640, resizable: false,
        title: 'Setări MediNote Agent',
        autoHideMenuBar: true,
        webPreferences: {
            preload: path.join(__dirname, 'settings-preload.js'),
            contextIsolation: true,
            nodeIntegration: false,
        },
    });
    settingsWin.loadFile(path.join(__dirname, 'settings.html'));
    settingsWin.on('closed', () => { settingsWin = null; });
}

function readJsonSafe(p) {
    try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch (_) { return null; }
}

/** Oprește și repornește conectorii cu config-urile de pe disc. */
function restartConnectors() {
    try { if (labRunner) { labRunner.stop(); labRunner = null; } } catch (_) {}
    try { if (miniliteRunner) { miniliteRunner.stop(); miniliteRunner = null; } } catch (_) {}
    startLabConnector();
    startMinilite();
}

ipcMain.handle('settings:get', () => {
    const labPath = findConfig('lab-config.json');
    const mlPath  = findConfig('minilite-config.json');
    const lab = labPath ? readJsonSafe(labPath) : null;
    const ml  = mlPath  ? readJsonSafe(mlPath)  : null;
    return {
        baseUrl: (lab && lab.baseUrl) || (ml && ml.baseUrl) || 'https://medinote.ro',
        token:   (lab && lab.token)   || (ml && ml.token)   || '',
        labEnabled: !!(lab && lab.token),
        refreshMinutes: (lab && lab.refreshMinutes) || 10,
        mlEnabled: !!(ml && ml.token && ml.netdir),
        netdir: (ml && ml.netdir) || '',
        deviceCode: (ml && ml.deviceCode) || 'MINILITE',
        pollSeconds: (ml && ml.pollSeconds) || 5,
        configDir: app.getPath('userData'),
    };
});

ipcMain.handle('settings:save', (_e, data) => {
    try {
        const labPath = configWritePath('lab-config.json');
        const mlPath  = configWritePath('minilite-config.json');

        if (data.labEnabled) {
            fs.writeFileSync(labPath, JSON.stringify({
                baseUrl: data.baseUrl, token: data.token, refreshMinutes: data.refreshMinutes,
            }, null, 2));
        } else if (fs.existsSync(labPath)) {
            fs.renameSync(labPath, labPath + '.disabled'); // dezactivat, dar păstrat
        }

        if (data.mlEnabled) {
            fs.writeFileSync(mlPath, JSON.stringify({
                baseUrl: data.baseUrl, token: data.token, deviceCode: data.deviceCode,
                netdir: data.netdir, pollSeconds: data.pollSeconds,
            }, null, 2));
        } else if (fs.existsSync(mlPath)) {
            fs.renameSync(mlPath, mlPath + '.disabled');
        }

        restartConnectors();
        return { ok: true };
    } catch (e) {
        return { ok: false, error: e.message };
    }
});

ipcMain.handle('settings:pick-folder', async () => {
    const r = await dialog.showOpenDialog(settingsWin, { properties: ['openDirectory'] });
    return (r.canceled || !r.filePaths.length) ? null : r.filePaths[0];
});

ipcMain.handle('settings:test', async (_e, baseUrl, token) => {
    return new Promise((resolve) => {
        try {
            const { URL } = require('url');
            const url = new URL('/api/lab/ping', baseUrl);
            const lib = url.protocol === 'https:' ? require('https') : require('http');
            const req = lib.request(url, {
                method: 'GET', timeout: 10000,
                headers: { 'Accept': 'application/json', 'X-Lab-Token': token },
            }, (res) => {
                let buf = '';
                res.on('data', c => buf += c);
                res.on('end', () => {
                    let j = null; try { j = JSON.parse(buf); } catch (_) {}
                    if (res.statusCode === 200 && j && j.ok) resolve({ ok: true, clinic: j.clinic });
                    else if (res.statusCode === 401) resolve({ ok: false, error: 'Token invalid sau gateway-ul de laborator nu e activat pe clinică.' });
                    else resolve({ ok: false, error: 'Răspuns neașteptat (' + res.statusCode + ').' });
                });
            });
            req.on('error', (err) => resolve({ ok: false, error: 'Nu mă pot conecta: ' + err.message }));
            req.on('timeout', () => { req.destroy(); resolve({ ok: false, error: 'Timeout la conectare.' }); });
            req.end();
        } catch (e) {
            resolve({ ok: false, error: e.message });
        }
    });
});

function createTray() {
    const iconPath = path.join(__dirname, 'assets', 'icon.png');
    const icon = nativeImage.createFromPath(iconPath);
    tray = new Tray(icon.isEmpty() ? nativeImage.createEmpty() : icon);

    updateTrayTooltip('Activ');
    tray.setContextMenu(buildMenu());

    tray.on('double-click', () => {
        shell.openExternal('https://medinote.ro');
    });
}

function buildMenu() {
    return Menu.buildFromTemplate([
        {
            label: `MediNote Agent v${require('./package.json').version}`,
            enabled: false,
        },
        { type: 'separator' },
        {
            label: `REST API: localhost:${PORT}`,
            enabled: false,
        },
        {
            label: 'Citește card sănătate',
            click: async () => {
                const { readCard } = require('./card-reader');
                try {
                    const result = await readCard();
                    dialog.showMessageBox({
                        type: 'info',
                        title: 'Card citit',
                        message: result.mock
                            ? `DEMO — CID: ${result.cid}\nPacient: ${result.patient_name}`
                            : `CID: ${result.cid}\nPacient: ${result.patient_name}\nCard nr: ${result.card_no}`,
                    });
                } catch (err) {
                    dialog.showErrorBox('Eroare citire card', err.message);
                }
            },
        },
        { type: 'separator' },
        {
            label: 'Setări laborator…',
            click: () => openSettings(),
        },
        {
            label: 'Deschide MediNote',
            click: () => shell.openExternal('https://medinote.ro'),
        },
        {
            label: 'Despre',
            click: () => dialog.showMessageBox({
                type: 'info',
                title: 'MediNote Agent',
                message: `MediNote Agent v${require('./package.json').version}\n\nCititor card sănătate CEAS\nREST API: localhost:${PORT}\n\n© 2026 Syndicate Digital SRL`,
            }),
        },
        { type: 'separator' },
        {
            label: 'Ieșire',
            click: () => {
                if (server) server.close();
                if (labRunner) labRunner.stop();
                if (miniliteRunner) miniliteRunner.stop();
                app.quit();
            },
        },
    ]);
}

function updateTrayTooltip(status) {
    if (!tray) return;
    tray.setToolTip(`MediNote Agent — ${status}`);
    tray.setContextMenu(buildMenu());
}
