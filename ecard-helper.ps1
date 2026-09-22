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
    [int]$TimeoutSec = 90
)

$ErrorActionPreference = 'Stop'

function Out-Json($obj) {
    Add-Type -AssemblyName System.Web.Extensions
    $ser = New-Object System.Web.Script.Serialization.JavaScriptSerializer
    $ser.MaxJsonLength = 10485760
    Write-Output $ser.Serialize($obj)
}

$dllPath = Join-Path $SdkDir 'Novensys.eCard.SDK.dll'
if (-not (Test-Path $dllPath)) {
    Out-Json @{ success = $false; sdk_present = $false; error = "SDK-ul eCard nu este instalat (lipseste $dllPath)" }
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

    static Type FindType(string name) {
        foreach (Type t in _asm.GetTypes()) if (t.Name == name) return t;
        throw new Exception("Tipul '" + name + "' nu exista in SDK");
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
                if (inner is string || inner.GetType().IsValueType) {
                    into[prefix + p.Name] = (inner is DateTime) ? ((DateTime)inner).ToString("yyyy-MM-dd") : inner.ToString();
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
        string command, string sdkDir, string umHost, int umPort,
        string cif, string cui, string contract, string contractDate,
        string casa, string tipFurnizor, string dataB64, int timeoutSec)
    {
        Dictionary<string, object> outp = new Dictionary<string, object>();
        Exception fail = null;

        Thread th = new Thread(delegate() {
            try {
                _asm = Assembly.LoadFrom(Path.Combine(sdkDir, "Novensys.eCard.SDK.dll"));
                Type mgr = FindType("ManagerSesiuniCard");

                if (command == "status") {
                    outp["success"] = true;
                    outp["sdk_present"] = true;
                    outp["sdk_version"] = _asm.GetName().Version.ToString();
                    MethodInfo mTerm = mgr.GetMethod("GetSupportedTerminalNames", BindingFlags.Public | BindingFlags.Static);
                    if (mTerm != null) outp["supported_terminals"] = (string[])mTerm.Invoke(null, null);
                    return;
                }

                mgr.GetMethod("SetAdresaUnitateManagement", BindingFlags.Public | BindingFlags.Static)
                   .Invoke(null, new object[] { umHost, umPort });
                _session = mgr.GetMethod("StartSesiuneNoua", BindingFlags.Public | BindingFlags.Static, null, Type.EmptyTypes, null)
                              .Invoke(null, null);

                // Identificator drepturi -> token (profil Specialist; UM face inrolarea
                // terminalului automat la primul token, apoi merge si offline)
                Type tDr = FindType("IdentificatorDrepturi");
                object dr = Activator.CreateInstance(tDr);
                SetProp(dr, "NumarContract", contract);
                SetProp(dr, "CasaAsigurare", casa);
                SetProp(dr, "TipFurnizor", tipFurnizor);
                SetProp(dr, "CUI", cui);
                if (contractDate != "") SetProp(dr, "DataContract", DateTime.Parse(contractDate));
                string token = (string)_session.GetType().GetMethod("ObtineToken").Invoke(_session, new object[] { cif, dr });
                if (token == null) throw new Exception("Token invalid — verifica datele de contract (CUI, contract, casa) si conexiunea la UM");

                if (command == "read") {
                    Type tCamp = FindType("CoduriCampuriCard");
                    object fields = Activator.CreateInstance(typeof(List<>).MakeGenericType(tCamp));
                    MethodInfo add = fields.GetType().GetMethod("Add");
                    // A1 nr card, A3 versiune, B1 nume, B2 prenume, B3 data nasterii, B4 CNP, C1 nr asigurat (CID)
                    foreach (string f in new string[] { "A1", "A3", "B1", "B2", "B3", "B4", "C1" })
                        add.Invoke(fields, new object[] { Enum.Parse(tCamp, f) });

                    object cardData = Activator.CreateInstance(FindType("CardData"));
                    Type tRasp = FindType("CoduriRaspunsOperatieCamp");
                    object rez = Activator.CreateInstance(typeof(Dictionary<,>).MakeGenericType(tCamp, tRasp));

                    MethodInfo mRead = _session.GetType().GetMethod("CitesteDate");
                    object[] args = new object[] { token, fields, cardData, rez };
                    int r = (int)mRead.Invoke(_session, args);
                    outp["code"] = r;
                    if (r != 0) throw new Exception(MesajCod(r));

                    Dictionary<string, object> data = new Dictionary<string, object>();
                    Dump(args[2], "", data, 0);
                    outp["success"] = true;
                    outp["fields"] = data;
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
    $result = [MediNote.ECard]::Run($Command, $SdkDir, $UmHost, $UmPort, $Cif, $Cui, $Contract, $ContractDate, $Casa, $TipFurnizor, $DataB64, $TimeoutSec)
    Out-Json $result
} catch {
    Out-Json @{ success = $false; error = $_.Exception.Message }
}
exit 0
