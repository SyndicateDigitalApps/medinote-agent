# MediNote Agent - eCard.SDK helper (citire card CEAS + semnatura)
# Incarca Novensys.eCard.SDK.dll prin reflection (Anexa 102 PIAS) - nu are
# nevoie de DLL la compilare, doar la runtime, in $SdkDir.
# Output: UN SINGUR obiect JSON pe stdout (ultima linie).
param(
    [Parameter(Mandatory=$true)][ValidateSet('status','read','sign')][string]$Command,
    [string]$SdkDir = 'C:\ProgramData\MediNoteAgent\eCardSDK',
    [string]$UmHost = 'umceas.siui.ro',
    [int]$UmPort = 443,
    [string]$Cif = '',
    [string]$Cui = '',
    [string]$Contract = '',
    [string]$ContractDate = '',
    [string]$Casa = '',
    [string]$TipFurnizor = 'CLIN',
    [string]$DataB64 = '',
    [int]$TimeoutSec = 90,
    # campurile de citit (CoduriCampuriCard); la „identitate” se cer si cele de pe CEI (grupul I)
    [string]$Fields = 'A1,A3,B1,B2,B3,B4,C1',
    # daca SDK-ul refuza lista (card fara grupul I), se reia citirea doar cu acestea
    [string]$FallbackFields = ''
)

$ErrorActionPreference = 'Stop'

function Out-Json($obj) {
    Add-Type -AssemblyName System.Web.Extensions
    $ser = New-Object System.Web.Script.Serialization.JavaScriptSerializer
    $ser.MaxJsonLength = 10485760
    Write-Output $ser.Serialize($obj)
}

# Kitul CNAS: 2.x = un singur Ceas.eCard.SDK.dll (.NET 4.8, include si cartea de identitate);
# 1.x = Novensys.eCard.SDK.dll + BouncyCastle + OpenNETCF. Folosim 2.x daca exista.
# Sursa oficiala, publica: portal.cnas.ro/cnas/pias/ecard.sdk (06.11.2026)
$SdkUrl = 'https://portal.cnas.ro/cnas/pias/libs/ceas/eCard.SDK.2.0.0.4.zip'

function Find-SdkDll($dir) {
    foreach ($n in @('Ceas.eCard.SDK.dll', 'Novensys.eCard.SDK.dll')) {
        $p = Join-Path $dir $n
        if (Test-Path $p) { return $p }
    }
    return $null
}

$dllPath = Find-SdkDll $SdkDir
if (-not $dllPath) {
    # Prima folosire: descarcam kitul oficial CNAS in $SdkDir (fara reinstalarea agentului)
    try {
        [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
        New-Item -ItemType Directory -Force -Path $SdkDir | Out-Null
        $zip = Join-Path $env:TEMP ('ecard-sdk-' + [Guid]::NewGuid().ToString('N') + '.zip')
        Invoke-WebRequest -Uri $SdkUrl -OutFile $zip -UseBasicParsing -TimeoutSec 120
        Expand-Archive -Path $zip -DestinationPath $SdkDir -Force
        Remove-Item $zip -Force -ErrorAction SilentlyContinue
    } catch {}
    $dllPath = Find-SdkDll $SdkDir
}
if (-not $dllPath) {
    Out-Json @{ success = $false; sdk_present = $false; error = "SDK-ul eCard nu este instalat si nu s-a putut descarca automat. Descarca eCard.SDK.2.0.0.4.zip de pe portal.cnas.ro/cnas/pias/ecard.sdk si dezarhiveaza-l in $SdkDir" }
    exit 0
}

$src = @'
using System;
using System.Collections;
using System.Collections.Generic;
using System.IO;
using System.Reflection;
using System.Threading;

namespace MediNote {
public static class ECard {

    static Assembly _asm;

    static Type[] _types;
    static Type FindType(string name) {
        if (_types == null) {
            // kitul 2.x e un assembly mare: daca o dependinta optionala lipseste, GetTypes()
            // arunca ReflectionTypeLoadException — folosim tipurile care s-au putut incarca
            try { _types = _asm.GetTypes(); }
            catch (ReflectionTypeLoadException rtle) {
                List<Type> ok = new List<Type>();
                foreach (Type t in rtle.Types) if (t != null) ok.Add(t);
                _types = ok.ToArray();
            }
        }
        foreach (Type t in _types) if (t.Name == name) return t;
        throw new Exception("Tipul '" + name + "' nu exista in SDK (" + _asm.GetName().Name + " " + _asm.GetName().Version + ")");
    }

    static void SetProp(object o, string name, object value) {
        PropertyInfo p = o.GetType().GetProperty(name);
        if (p == null) throw new Exception("Proprietatea '" + name + "' nu exista pe " + o.GetType().Name);
        object v = value;
        Type pt = Nullable.GetUnderlyingType(p.PropertyType) ?? p.PropertyType;
        if (v != null && !pt.IsInstanceOfType(v)) {
            if (pt.IsEnum) v = Enum.Parse(pt, v.ToString(), true);
            else v = Convert.ChangeType(v, pt);
        }
        p.SetValue(o, v, null);
    }

    // CardData e un graf de grupuri -> campuri, fiecare camp are proprietatea "Valoare".
    // Extragem generic, ca sa nu depindem de numele exacte ale proprietatilor.
    static void Dump(object o, string prefix, Dictionary<string, object> into, int depth) {
        if (o == null || depth > 3) return;
        foreach (PropertyInfo p in o.GetType().GetProperties(BindingFlags.Public | BindingFlags.Instance)) {
            if (p.GetIndexParameters().Length > 0) continue;
            object v;
            try { v = p.GetValue(o, null); } catch { continue; }
            if (v == null) continue;
            Type vt = v.GetType();
            PropertyInfo valProp = vt.GetProperty("Valoare");
            if (valProp != null) {
                object inner;
                try { inner = valProp.GetValue(v, null); } catch { continue; }
                if (inner == null) continue;
                if (p.Name == "Poza") continue; // fotografia de pe CEI nu ne trebuie
                if (inner is string || inner.GetType().IsValueType) {
                    into[prefix + p.Name] = (inner is DateTime) ? ((DateTime)inner).ToString("yyyy-MM-dd") : inner.ToString();
                } else if (inner.GetType().Assembly == _asm && !(inner is IEnumerable)) {
                    // valoare compusa (ex. adresa de pe CEI): textul ei + componentele simple
                    into[prefix + p.Name] = inner.ToString();
                    DumpPlain(inner, prefix + p.Name + ".", into);
                } else if (inner is IEnumerable) {
                    List<string> items = new List<string>();
                    foreach (object it in (IEnumerable)inner) if (it != null) items.Add(it.ToString());
                    into[prefix + p.Name] = items;
                }
            } else if (!vt.IsValueType && !(v is string) && vt.Assembly == _asm) {
                Dump(v, p.Name + ".", into, depth + 1);
            }
        }
    }

    static void DumpPlain(object o, string prefix, Dictionary<string, object> into) {
        foreach (PropertyInfo p in o.GetType().GetProperties(BindingFlags.Public | BindingFlags.Instance)) {
            if (p.GetIndexParameters().Length > 0) continue;
            object v;
            try { v = p.GetValue(o, null); } catch { continue; }
            if (v == null) continue;
            if (v is string || v.GetType().IsValueType)
                into[prefix + p.Name] = (v is DateTime) ? ((DateTime)v).ToString("yyyy-MM-dd") : v.ToString();
        }
    }

    // Lista de campuri din „A1,B4,I10”; codurile pe care SDK-ul nu le are se sar.
    static object BuildFields(Type tCamp, string csv) {
        object fields = Activator.CreateInstance(typeof(List<>).MakeGenericType(tCamp));
        MethodInfo add = fields.GetType().GetMethod("Add");
        foreach (string raw in csv.Split(',')) {
            string f = raw.Trim();
            if (f == "") continue;
            try { add.Invoke(fields, new object[] { Enum.Parse(tCamp, f) }); } catch {}
        }
        return fields;
    }

    static object _session;

    static string MesajCod(int cod) {
        try {
            Type tMsg = FindType("MesajeRaspunsCard");
            IDictionary d = (IDictionary)Activator.CreateInstance(tMsg);
            Type tCod = FindType("CoduriRaspunsOperatieCard");
            object key = Enum.ToObject(tCod, cod);
            if (d.Contains(key)) return key.ToString() + ": " + d[key];
        } catch {}
        return "cod raspuns " + cod;
    }

    public static Dictionary<string, object> Run(
        string command, string dllPath, string umHost, int umPort,
        string cif, string cui, string contract, string contractDate,
        string casa, string tipFurnizor, string dataB64, int timeoutSec,
        string fieldsCsv, string fallbackCsv)
    {
        Dictionary<string, object> outp = new Dictionary<string, object>();
        Exception fail = null;

        Thread th = new Thread(delegate() {
            try {
                _asm = Assembly.LoadFrom(dllPath);
                Type mgr = FindType("ManagerSesiuniCard");

                if (command == "status") {
                    outp["success"] = true;
                    outp["sdk_present"] = true;
                    outp["sdk_version"] = _asm.GetName().Version.ToString();
                    outp["sdk_file"] = Path.GetFileName(dllPath);
                    MethodInfo mTerm = mgr.GetMethod("GetSupportedTerminalNames", BindingFlags.Public | BindingFlags.Static);
                    if (mTerm != null) outp["supported_terminals"] = (string[])mTerm.Invoke(null, null);
                    return;
                }

                mgr.GetMethod("SetAdresaUnitateManagement", BindingFlags.Public | BindingFlags.Static)
                   .Invoke(null, new object[] { umHost, umPort });
                _session = mgr.GetMethod("StartSesiuneNoua", BindingFlags.Public | BindingFlags.Static, null, Type.EmptyTypes, null)
                              .Invoke(null, null);

                // Identificator drepturi -> token (profil Specialist; UM face inrolarea
                // terminalului automat la primul token, apoi merge si offline).
                // Fara date de contract (clinica fara CAS, citire de buletin): fara token —
                // pentru cartea de identitate (RO_EID) SDK-ul nu cere token de la UM.
                string token = "";
                if (contract != "" && cui != "" && casa != "") {
                    Type tDr = FindType("IdentificatorDrepturi");
                    object dr = Activator.CreateInstance(tDr);
                    SetProp(dr, "NumarContract", contract);
                    SetProp(dr, "CasaAsigurare", casa);
                    SetProp(dr, "TipFurnizor", tipFurnizor);
                    SetProp(dr, "CUI", cui);
                    if (contractDate != "") SetProp(dr, "DataContract", DateTime.Parse(contractDate));
                    token = (string)_session.GetType().GetMethod("ObtineToken").Invoke(_session, new object[] { cif, dr });
                    if (token == null && command == "sign") throw new Exception("Token invalid — verifica datele de contract (CUI, contract, casa) si conexiunea la UM");
                    if (token == null) token = "";
                } else if (command == "sign") {
                    throw new Exception("Lipsesc datele de contract CAS (CUI, contract, casa) pentru semnare");
                }

                if (command == "read") {
                    // A1 nr card, A3 versiune, B1 nume, B2 prenume, B3 data nasterii, B4 CNP, C1 nr asigurat (CID);
                    // la „identitate” si grupul I (date personale de pe CEI: sex, serie CI, adresa...)
                    Type tCamp = FindType("CoduriCampuriCard");
                    Type tRasp = FindType("CoduriRaspunsOperatieCamp");
                    MethodInfo mRead = _session.GetType().GetMethod("CitesteDate");
                    object[] args = null;
                    int r = -1;
                    Exception readErr = null;
                    foreach (string csv in new string[] { fieldsCsv, fallbackCsv }) {
                        if (csv == null || csv == "" || (args != null && csv == fieldsCsv)) continue;
                        args = new object[] { token, BuildFields(tCamp, csv), Activator.CreateInstance(FindType("CardData")),
                                              Activator.CreateInstance(typeof(Dictionary<,>).MakeGenericType(tCamp, tRasp)) };
                        try {
                            r = (int)mRead.Invoke(_session, args);
                            readErr = null;
                        } catch (TargetInvocationException tie) { readErr = tie.InnerException ?? tie; r = -1; }
                        if (r == 0) break;
                        if (fallbackCsv == "" || fallbackCsv == fieldsCsv) break;
                    }
                    if (readErr != null) throw readErr;
                    outp["code"] = r;
                    if (r != 0) throw new Exception(MesajCod(r));

                    Dictionary<string, object> data = new Dictionary<string, object>();
                    Dump(args[2], "", data, 0);
                    outp["success"] = true;
                    outp["fields"] = data;
                    bool health = false, ident = false;
                    foreach (string k in data.Keys) {
                        if (k.StartsWith("DateAdministrative.")) health = true;
                        if (k.StartsWith("DatePersonale.")) ident = true;
                    }
                    outp["card_kind"] = health ? "health" : (ident ? "identity" : null);
                    IDictionary rd = args[3] as IDictionary;
                    if (rd != null) {
                        Dictionary<string, string> per = new Dictionary<string, string>();
                        foreach (DictionaryEntry e in rd) per[e.Key.ToString()] = e.Value.ToString();
                        outp["field_results"] = per;
                    }
                } else if (command == "sign") {
                    byte[] buf = Convert.FromBase64String(dataB64);
                    MethodInfo mHash = _session.GetType().GetMethod("ComputeHash", new Type[] { typeof(byte[]) });
                    byte[] sig = (byte[])mHash.Invoke(_session, new object[] { buf });
                    outp["success"] = true;
                    outp["signature"] = Convert.ToBase64String(sig);
                } else {
                    throw new Exception("Comanda necunoscuta: " + command);
                }
            } catch (TargetInvocationException tie) {
                fail = tie.InnerException ?? tie;
            } catch (Exception ex) {
                fail = ex;
            } finally {
                try {
                    if (_session != null) {
                        MethodInfo stop = _session.GetType().GetMethod("Stop", Type.EmptyTypes);
                        if (stop != null) stop.Invoke(_session, null);
                    }
                } catch {}
            }
        });
        th.IsBackground = true;
        th.Start();
        if (!th.Join(timeoutSec * 1000)) {
            return new Dictionary<string, object> {
                { "success", false }, { "sdk_present", true },
                { "error", "Timeout dupa " + timeoutSec + "s — verifica daca e card in cititor si daca s-a introdus PIN-ul pe terminal" }
            };
        }
        if (fail != null) {
            outp["success"] = false;
            outp["sdk_present"] = true;
            outp["error"] = fail.Message;
        }
        return outp;
    }
}
}
'@

try {
    Add-Type -TypeDefinition $src -Language CSharp
} catch {
    Out-Json @{ success = $false; error = "Eroare compilare helper: $($_.Exception.Message)" }
    exit 0
}

try {
    $result = [MediNote.ECard]::Run($Command, $dllPath, $UmHost, $UmPort, $Cif, $Cui, $Contract, $ContractDate, $Casa, $TipFurnizor, $DataB64, $TimeoutSec, $Fields, $FallbackFields)
    Out-Json $result
} catch {
    Out-Json @{ success = $false; error = $_.Exception.Message }
}
exit 0
