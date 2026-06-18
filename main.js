'use strict';

const { app, Tray, Menu, nativeImage, dialog, shell } = require('electron');
const path   = require('path');
const { createServer, PORT } = require('./server');
const { LabRunner } = require('./lab-runner');
const { MiniliteRunner } = require('./minilite-runner');

const IS_DEV = process.argv.includes('--dev');

let tray   = null;
let server = null;
let labRunner = null;
let miniliteRunner = null;

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

// Conectorul de laborator — pornește doar dacă există lab-config.json valid (token clinică).
// Caută config-ul lângă executabil, apoi în userData.
function startLabConnector() {
    try {
        const candidates = [
            path.join(path.dirname(app.getPath('exe')), 'lab-config.json'),
            path.join(app.getPath('userData'), 'lab-config.json'),
            path.join(__dirname, 'lab-config.json'),
        ];
        const fs = require('fs');
        const configPath = candidates.find(p => { try { return fs.existsSync(p); } catch (_) { return false; } });
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
        const fs = require('fs');
        const candidates = [
            path.join(path.dirname(app.getPath('exe')), 'minilite-config.json'),
            path.join(app.getPath('userData'), 'minilite-config.json'),
            path.join(__dirname, 'minilite-config.json'),
        ];
        const configPath = candidates.find(p => { try { return fs.existsSync(p); } catch (_) { return false; } });
        if (!configPath) { console.log('[minilite] minilite-config.json negăsit — connector inactiv.'); return; }
        miniliteRunner = new MiniliteRunner({ configPath, log: (m) => console.log(m) });
        miniliteRunner.start();
    } catch (e) {
        console.log('[minilite] eroare pornire: ' + e.message);
    }
}

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
