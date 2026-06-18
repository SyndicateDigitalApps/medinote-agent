'use strict';

/**
 * MediNote — Connector MINILITE (SeleoSrl miniLite v300)
 * ------------------------------------------------------
 * Schimb prin fișiere în folderul NETDIR al aplicației miniLite:
 *   - Accettazione.txt  → worklist-ul pe care îl SCRIEM noi (cereri către aparat)
 *   - REPORT.txt        → rezultatele pe care le CITIM (electroforeză proteine)
 *
 * Format linie (CSV, terminat CRLF):
 *   Accettazione: NUME,VARSTA,SEX,DATA,BARCODE, ,SECTIE,PROG,FLAG,FLAG
 *   REPORT:       <aceleași 10 câmpuri>,SIEROPROTEINE,TPlow,TPhigh,
 *                 n, [ref_low×n], [ref_high×n], n, [masurat×n], [nume×n],
 *                 n, [delimitatori], n_curba, [puncte_curba...]
 *
 * Testabil standalone:  node minilite-connector.js --selftest <REPORT.txt>
 */

const fs = require('fs');

// Coduri catalog pentru fracțiile electroforezei (mapate în MediNote)
const FRACTION_CODES = {
    'albumina': 'EFP_ALB',
    'alfa1':    'EFP_A1',
    'alfa2':    'EFP_A2',
    'beta':     'EFP_BETA',
    'gamma':    'EFP_GAMMA',
};
const FRACTION_LABELS = {
    'EFP_ALB':   'Albumină',
    'EFP_A1':    'Alfa 1 globuline',
    'EFP_A2':    'Alfa 2 globuline',
    'EFP_BETA':  'Beta globuline',
    'EFP_GAMMA': 'Gamma globuline',
};

function num(x) {
    const v = parseFloat(String(x).replace(',', '.'));
    return isNaN(v) ? null : v;
}

/**
 * Parsează o linie REPORT.txt → obiect structurat (sau null dacă nu e SIEROPROTEINE).
 */
function parseReportLine(line) {
    const f = String(line).replace(/[\r\n]+$/, '').split(',');
    if (f.length < 25) return null;

    const demo = {
        name:     (f[0] || '').trim(),
        age:      (f[1] || '').trim(),
        sex:      (f[2] || '').trim(),
        date:     (f[3] || '').trim(),
        barcode:  (f[4] || '').trim(),
        division: (f[6] || '').trim(),
    };

    const testType = (f[10] || '').trim();
    if (!/SIEROPROTEIN/i.test(testType)) return null; // momentan doar electroforeza

    const tpLow = num(f[11]);   // proteine totale - ref low (g/dL)
    const tpHigh = num(f[12]);  // proteine totale - ref high

    // Structura: <n>, [n ref_low], [n ref_high], <n>, [n masurat], [n nume],
    //            <n>, [n delimitatori], <n_curba>, [puncte curba...]
    let i = 13;
    const take = (cnt) => { const a = f.slice(i, i + cnt); i += cnt; return a; };

    const n1 = parseInt(f[i++], 10);                 // 5 fracții
    if (isNaN(n1) || n1 <= 0 || n1 > 50) return null;
    const refLow   = take(n1);                       // [52.0,1.5,6.5,8.0,10.5]
    const refHigh  = take(n1);                       // [68.0,4.5,13.5,15.0,20.5]

    const n2 = parseInt(f[i++], 10);                 // 5
    if (isNaN(n2) || n2 !== n1) return null;
    const measured = take(n2);                       // [59.4,2.4,11.6,11.4,15.2]
    const names    = take(n2);                       // [Albumina,Alfa1,Alfa2,Beta,Gamma]

    // delimitatori fracții pe curbă + curba propriu-zisă (pt grafic viitor)
    let delimiters = [], curve = [];
    if (!isNaN(parseInt(f[i], 10))) {
        const n3 = parseInt(f[i++], 10);
        delimiters = take(n3).map(x => parseInt(x, 10));
        const nCurve = parseInt(f[i++], 10);
        if (!isNaN(nCurve)) curve = take(nCurve).map(x => parseInt(x, 10)).filter(x => !isNaN(x));
    }

    // construiește fracțiile
    const fractions = names.map((nm, idx) => {
        const key = String(nm).toLowerCase().replace(/[^a-z0-9]/g, '');
        const code = FRACTION_CODES[key] || ('EFP_' + key.toUpperCase());
        return {
            code,
            name: FRACTION_LABELS[code] || nm,
            value: num(measured[idx]),
            unit: '%',
            ref_low: num(refLow[idx]),
            ref_high: num(refHigh[idx]),
        };
    });

    return {
        demo,
        testType,
        tpRef: { low: tpLow, high: tpHigh },
        fractions,
        delimiters,
        curve,
    };
}

/** Transformă rezultatul parsat în payload pentru /api/lab/ingest. */
function toIngestPayload(parsed, deviceCode) {
    return {
        analyzer_code: deviceCode || 'MINILITE',
        barcode: parsed.demo.barcode || null,
        barcode_candidates: parsed.demo.barcode ? [parsed.demo.barcode] : [],
        message_type: 'minilite_report',
        patient_name: parsed.demo.name,
        results: parsed.fractions.map(fr => ({
            code: fr.code,
            name: fr.name,
            value: fr.value,
            unit: fr.unit,
            ref_low: fr.ref_low,
            ref_high: fr.ref_high,
        })),
        // date suplimentare pentru buletin/grafic (MediNote poate stoca sau ignora)
        extra: {
            test: 'EFP',
            tp_ref_low: parsed.tpRef.low,
            tp_ref_high: parsed.tpRef.high,
            curve: parsed.curve,
        },
    };
}

/**
 * Construiește o linie Accettazione.txt dintr-o comandă de worklist.
 * order: { name, age, sex, date(DD/MM/YY), barcode, division }
 */
function buildAccettazioneLine(order) {
    const sex = (order.sex || '').toUpperCase().startsWith('M') ? 'M' : 'F';
    const fields = [
        order.name || '',
        order.age != null ? order.age : '',
        sex,
        order.date || '',
        order.barcode || '',
        ' ',
        order.division || ' ',
        order.prog != null ? order.prog : 1,
        'T',
        'F',
    ];
    return fields.join(',') + '\r\n';
}

// ── Selftest pe fișier real ─────────────────────────────────────
if (require.main === module && process.argv[2] === '--selftest') {
    const file = process.argv[3];
    const data = fs.readFileSync(file, 'latin1');
    const lines = data.split(/\r?\n/).filter(l => l.trim().length);
    console.log(`Linii REPORT: ${lines.length}`);
    let ok = 0;
    lines.forEach((line, idx) => {
        const p = parseReportLine(line);
        if (!p) { console.log(`  linia ${idx + 1}: ne-parsabilă/altă analiză`); return; }
        ok++;
        if (ok <= 2) {
            console.log(`\n=== Rezultat ${ok} — ${p.demo.name} (barcode ${p.demo.barcode}) ===`);
            console.log(`  Proteine totale ref: ${p.tpRef.low}–${p.tpRef.high} g/dL`);
            p.fractions.forEach(fr => {
                const flag = (fr.value < fr.ref_low) ? ' ↓' : (fr.value > fr.ref_high ? ' ↑' : '');
                console.log(`  ${fr.name.padEnd(20)} ${String(fr.value).padStart(6)} %   (ref ${fr.ref_low}–${fr.ref_high})${flag}`);
            });
            console.log(`  curbă: ${p.curve.length} puncte`);
            console.log('  payload ingest:', JSON.stringify(toIngestPayload(p, 'MINILITE').results));
        }
    });
    console.log(`\nParsate cu succes: ${ok}/${lines.length}`);
}

module.exports = { parseReportLine, toIngestPayload, buildAccettazioneLine, FRACTION_CODES, FRACTION_LABELS };
