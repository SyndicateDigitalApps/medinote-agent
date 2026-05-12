'use strict';

// eCard.SDK wrapper
// În producție: înlocuiește mock-urile cu apeluri reale la SDK-ul CNAS
// SDK-ul folosește TCP tcp://umceas.siui.ro:443 + biblioteca eCard.SDK (.NET/Java)
//
// Integrare reală (după primirea SDK-ului de la CNAS):
//   const { execSync } = require('child_process');
//   sau ffi-napi pentru DLL nativ Windows

const MOCK_MODE = true; // setat automat false când SDK-ul e prezent

function isSdkAvailable() {
    // TODO: verifică dacă eCardSDK.dll / ecard-sdk.jar există în același folder
    return false;
}

async function readCard() {
    if (!MOCK_MODE && isSdkAvailable()) {
        return readCardReal();
    }
    return readCardMock();
}

async function signData(cid, cardNo, reportDate, serviceCode) {
    if (!MOCK_MODE && isSdkAvailable()) {
        return signDataReal(cid, cardNo, reportDate, serviceCode);
    }
    return signDataMock(cid, cardNo, reportDate, serviceCode);
}

async function getReaderStatus() {
    if (!MOCK_MODE && isSdkAvailable()) {
        return getReaderStatusReal();
    }
    return { connected: false, mock: true, reader_name: null };
}

// --- Mock responses (pentru demo și dev) ---

function readCardMock() {
    return Promise.resolve({
        success: true,
        mock: true,
        cid: '40609705521205115895',
        card_no: '4417173678200944',
        patient_name: 'DEMO PACIENT',
        cnp: '1900101123456',
        valid_from: '2023-01-01',
        valid_to: '2027-12-31',
    });
}

function signDataMock(cid, cardNo, reportDate, serviceCode) {
    // Semnătura reală = "cid|cardNo|reportDate|serviceCode" semnat cu certificatul cardului
    const payload = `${cid}|${cardNo}|${reportDate}|${serviceCode}`;
    return Promise.resolve({
        success: true,
        mock: true,
        signature: Buffer.from('MOCK_SIGNATURE:' + payload).toString('base64'),
    });
}

// --- Real implementations (TODO după primirea SDK-ului) ---

function readCardReal() {
    // TODO: apel eCard.SDK
    // const sdk = require('./sdk/ecardSDK');
    // return sdk.readCard();
    throw new Error('eCard.SDK not implemented yet');
}

function signDataReal(cid, cardNo, reportDate, serviceCode) {
    // TODO: apel eCard.SDK
    throw new Error('eCard.SDK not implemented yet');
}

function getReaderStatusReal() {
    // TODO: verifică cititor conectat via SDK
    throw new Error('eCard.SDK not implemented yet');
}

module.exports = { readCard, signData, getReaderStatus, isSdkAvailable };
