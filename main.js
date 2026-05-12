'use strict';

const { app, Tray, Menu, nativeImage, dialog, shell } = require('electron');
const path   = require('path');
const { createServer, PORT } = require('./server');

const IS_DEV = process.argv.includes('--dev');

let tray   = null;
let server = null;

// Rulează ca singleton — un singur agent per mașină
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
    app.quit();
}

app.whenReady().then(() => {
    // Ascunde din taskbar — trăiește doar în tray
    app.setActivationPolicy && app.setActivationPolicy('accessory');

    startServer();
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
