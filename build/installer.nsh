; MediNote Agent — NSIS custom hooks (electron-builder)
; Închide instanța care rulează ÎNAINTE de instalare/dezinstalare, ca să nu mai apară
; dialogul „MediNote Agent cannot be closed. Please close it manually and click Retry".
; Agentul stă în tray (fără fereastră vizibilă), deci NSIS nu-l poate închide "gracefully" —
; îl oprim direct cu taskkill (procesul nu are stare de salvat, e sigur).

!macro customInit
  nsExec::Exec 'taskkill /F /IM "MediNote Agent.exe" /T'
  Sleep 700
!macroend

!macro customUnInit
  nsExec::Exec 'taskkill /F /IM "MediNote Agent.exe" /T'
  Sleep 700
!macroend
