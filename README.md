# 🖥️ Homeserver-Manager

Selbstgehostetes Browser-Dashboard zur zentralen Verwaltung mehrerer Homeserver — Monitoring, Links, SSH-Terminal und Serversteuerung in einer Oberfläche.

## Features

- **Server-Verwaltung** — Server mit Bezeichnung und Hostname anlegen; IPv4/IPv6 werden automatisch per DNS ermittelt (inkl. Reverse-DNS).
- **Verfügbarkeits-Monitoring** — regelmäßige ICMP-Pings mit farbigen Status-Indikatoren, 24-h-Uptime-Streifen pro Server und Gesamt-Verfügbarkeitsdiagramm über alle Server.
- **Öffentliche IP** — aktuelle öffentliche IPv4 & IPv6 in der Kopfzeile; beim Hovern wird der letzte Änderungszeitpunkt angezeigt.
- **Services & Links** — pro Server beliebige Subservices mit Links (Alias + URL) oder reinen Ports. Links, die mit `/` oder `:` beginnen, bekommen automatisch den Server-Hostname vorangestellt. Links sind als `local`/`online` markierbar; die Erreichbarkeit wird per HTTP-Check geprüft und visualisiert. Bei Ports ist das Prüfprotokoll wählbar (TCP-Connect, HTTP oder HTTPS).
- **Globale Links** — Schnellzugriffe (Cloudflare, Strato, IONOS, …) ohne Verfügbarkeitsprüfung.
- **SSH-Integration** — Zugangsdaten (Passwort oder Private Key) pro Server, AES-256-GCM-verschlüsselt gespeichert:
  - **Web-Terminal** (xterm.js) direkt im Browser
  - **Live-Statistiken**: OS, Kernel, Uptime, Load, CPU, RAM, Festplatten, Temperatur
  - **Steuerung**: Neustart & Herunterfahren
  - **Host-Key-Pinning (Trust-on-first-use)**: Der SSH-Host-Key wird beim ersten Verbindungsaufbau gespeichert; weicht er später ab (z. B. Man-in-the-Middle), wird die Verbindung verweigert. Nach einer bewussten Neuinstallation des Zielservers lässt sich der gespeicherte Key im Server-Bearbeiten-Dialog über "SSH-Host-Key vergessen" zurücksetzen.
- **DNS-Abfragen** — alle gängigen Record-Typen (A, AAAA, CNAME, MX, NS, TXT, SOA, SRV, CAA) für beliebige Domains.
- **Hinweistexte** für jeden Server und jeden Service.
- **Passwortschutz** — wird bei der ersten Einrichtung festgelegt (scrypt-gehasht, Session-Cookies).
- **Export/Import** der gesamten Konfiguration als JSON (wahlweise mit oder ohne SSH-Secrets).
- **Dark Mode** — folgt standardmäßig dem System, umschaltbar (System/Hell/Dunkel).
- **Einstellungen** — Dashboard-Port und alle Prüfintervalle zur Laufzeit anpassbar.

## Installation

Voraussetzungen: Node.js ≥ 18, `ping` verfügbar (Standard auf Linux).

```bash
git clone <repo>
cd Homeserver-Manager
npm install
npm start
```

Dashboard öffnen: `http://<host>:4680` — beim ersten Aufruf wird das Passwort festgelegt.

### Als systemd-Dienst

```ini
[Unit]
Description=Homeserver-Manager
After=network-online.target

[Service]
WorkingDirectory=/opt/Homeserver-Manager
ExecStart=/usr/bin/node server/index.js
Restart=always

[Install]
WantedBy=multi-user.target
```

## Daten & Sicherheit

- Alle Daten liegen in `data/` (`config.json`, `state.json`, `secret.key`) — von Git ausgeschlossen.
- SSH-Secrets werden mit AES-256-GCM verschlüsselt; der Schlüssel (`data/secret.key`) verlässt den Server nie und Secrets werden nie an den Browser ausgeliefert.
- Der Export *inkl. Secrets* enthält Passwörter/Keys im Klartext — nur für Backups/Migration verwenden und sicher aufbewahren.
- Das Dashboard spricht HTTP. Für Zugriff außerhalb des LANs einen Reverse-Proxy mit TLS (z. B. Caddy, nginx) oder VPN (WireGuard, Tailscale) vorschalten.

## Lizenz

MIT

## Entwickler

Maximilian Golda
