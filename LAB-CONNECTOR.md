# MediNote — Conector aparate de laborator

Conectează analizoarele (Mindray & compatibile HL7/ASTM) la MediNote. Citește rezultatele
de la aparate și le scrie automat pe buletinul corect, după codul de bare al probei.

## Componente
- `lab-connector.js` — parser HL7 v2.3.1 (MSH/PID/OBR/OBX), cadrare MLLP, ACK, forward.
- `lab-runner.js` — orchestratorul: citește config, ia aparatele de la server, pornește listenerele.
- Pornește automat din `main.js` dacă există `lab-config.json`.

## Instalare la clinică
1. În MediNote: **Laborator → Aparate → Conector aparate → Activează**. Copiază **tokenul**.
2. Pe PC-ul din laborator (cel care stă pornit), pune un fișier `lab-config.json` lângă
   executabilul agentului (sau în `%APPDATA%/MediNote Agent/`):
   ```json
   { "baseUrl": "https://medinote.ro", "token": "<TOKEN_DIN_MEDINOTE>", "refreshMinutes": 10 }
   ```
3. În MediNote, la fiecare aparat (Aparate → editează), completează **Conectivitate**:
   - **Cod aparat (MSH)** — ex. `BS-2000` (cum se identifică în mesaj)
   - **IP (LAN)** static + **Port**
   - **Mod**: `TCP — agent ascultă` (uzual la Mindray) / `agent se conectează` / `serial`
4. Repornește agentul. În log apare `ascultă MLLP pe 0.0.0.0:<port>` pentru fiecare aparat.
5. Pe aparat, setează LIS/Host = IP-ul PC-ului cu agent + portul configurat.

## Maparea codurilor (o singură dată, pe teren)
Aparatele trimit coduri proprii (OBX-3, ex. `5`=ALT). La primul rezultat, codurile apar
automat în **Aparate → [aparat] → Coduri aparat** (evidențiate galben = nemapate).
Alegi din dropdown analiza din catalog pentru fiecare. Gata — de atunci scrierea e automată.

## Cerințe rețea
- Aparatele TCP (chimie/imuno/urină/hematologie): IP static în aceeași rețea cu PC-ul agent.
- AF-300 (microbiologie, serial RS-232): adaptor USB-serial sau convertor serial→ethernet.

## Diagnostic
- `Laborator → Aparate → Ultimele mesaje primite` arată fiecare mesaj: ok / cod de bare
  negăsit / cod nemapat. Util la reglajul on-site.
- Test rapid token: `GET https://medinote.ro/api/lab/ping?token=<TOKEN>` → `{"ok":true}`.

## Protocol (rezumat)
- HL7 v2.3.1, encoding ASCII, transport MLLP (`<VT> mesaj <FS><CR>`).
- Rezultate: `ORU^R01` (OBX-3=cod, OBX-4=nume, OBX-5=valoare, OBX-6=U.M., OBX-7=ref, OBX-8=flag).
- Cod de bare probă: căutat în OBR-3 / OBR-2 / SPM-2 / SAC-3 (serverul potrivește pe oricare).
- Bidirectional (host query) pregătit: `GET /api/lab/worklist?barcode=...`.
