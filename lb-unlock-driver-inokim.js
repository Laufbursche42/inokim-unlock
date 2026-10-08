'use strict';
/*
 * INOKIM unlock driver (M3). Declarative manifest + pure protocol core for the generic runtime.
 * Protocol proven from com.bugull.myway (code-verified): UUIDs (MAIN 0xFFB0, single char 0xFFB2
 * write+notify via CCCD 0x2902), the 0x4A framing + signed 16-bit additive checksum, TX opcodes
 * 0x40 (settings bits: lock/light/antiTheft/unit) and 0x41 (speed km/h raw byte + cruise/wheel bits),
 * RX 0x10/0x11/0x12/0x40/0x48/0x49. No auth. The pure functions below are relocated byte-identical
 * from the original inokim app.js - same logic, only moved into the driver.
 */
(function () {

  // =========================================================================================
  //  VERIFIED PROTOCOL CORE (code-proven from com.bugull.myway; self-test vectors below)
  // =========================================================================================
  // frame: [0]=0x4A | [1]=dir(0x03 TX) | [2]=op | [3]=len N | [4..]=payload | [N+4,N+5]=cksum LE | 0x0D 0x0A
  // checksum = Java signed 16-bit additive sum of bytes index 1..(3+N); lo=(byte)(sum%256), hi=(byte)(sum/256).
  // The sum sign-extends each byte (Constants.NETWORK_TYPE_UNCONNECTED == -1), so the high byte differs from a
  // naive unsigned sum - replicated exactly here (K.java:193-231).
  function checksum(core) {
    let sum = 0;
    for (const b of core) { let s = b & 0xff; if (s >= 0x80) s -= 0x100; sum += s; }
    return [sum & 0xff, (Math.trunc(sum / 256)) & 0xff];
  }
  function buildFrame(op, payload) {
    payload = (payload || []).map(b => b & 0xff);
    const core = [0x03, op & 0xff, payload.length & 0xff, ...payload];
    const [lo, hi] = checksum(core);
    return [0x4a, ...core, lo, hi, 0x0d, 0x0a];
  }
  // strict validator mirroring K.java:193-207
  function validFrame(f) {
    if (f.length < 8 || f[0] !== 0x4a) return false;
    if (f[1] !== 0 && f[1] !== 3) return false;
    const N = f[3];
    if (f.length !== N + 8) return false;
    const [lo, hi] = checksum(f.slice(1, 4 + N));
    return f[N + 4] === lo && f[N + 5] === hi && f[N + 6] === 0x0d && f[N + 7] === 0x0a;
  }
  const bitSet = (b, oneBasedBit, on) => on ? (b | (1 << (oneBasedBit - 1))) : (b & ~(1 << (oneBasedBit - 1)));
  function pick(o, k, dflt) { return (o && o[k] != null) ? o[k] : (dflt == null ? false : dflt); }
  // 0x40 settings: payload=[0x00, flags], base 0x08; bit5=unit(mi) 6=antiTheft 7=lock 8=light. The app always
  // rebuilds the whole byte from live state and overrides one field (c.java:77-103) - we do the same from S.
  function frame0x40(over, S) {
    let f = 0x08;
    f = bitSet(f, 5, pick(over, 'unitMi', S.unitMi));
    f = bitSet(f, 6, pick(over, 'antiTheft', S.antiTheft));
    f = bitSet(f, 7, pick(over, 'lock', S.lock));
    f = bitSet(f, 8, pick(over, 'light', S.light));
    return buildFrame(0x40, [0x00, f]);
  }
  // 0x41 tuning: payload=[bits, speed]; bit8=cruise 7=diameter(8.5") 6=clearTrip; speed = raw km/h byte
  // (unclamped app_side). Preserve cruise+diameter from live state (c.java:137-145).
  function frame0x41(over, S) {
    let b = 0x00;
    b = bitSet(b, 8, pick(over, 'cruise', S.cruise));
    b = bitSet(b, 7, pick(over, 'diam85', S.diam85));
    b = bitSet(b, 6, pick(over, 'clearTrip', false));
    const speed = pick(over, 'speedKmh', S.speedLimit != null ? S.speedLimit : 20);
    return buildFrame(0x41, [b, speed & 0xff]);
  }

  // RX parsers (exact offsets/endianness from the beans; big-endian throughout)
  const be16 = (b, i) => ((b[i] & 0xff) << 8) | (b[i + 1] & 0xff);
  const be24 = (b, i) => ((b[i] & 0xff) << 16) | ((b[i + 1] & 0xff) << 8) | (b[i + 2] & 0xff);
  const u32 = (b, i) => (((b[i] & 0xff) * 0x1000000) + ((b[i + 1] & 0xff) << 16) + ((b[i + 2] & 0xff) << 8) + (b[i + 3] & 0xff)) >>> 0;
  function parseFrame(f, S) {
    const op = f[2];
    if (op === 0x10) {                       // Data0x10Bean
      const fl = f[4];
      S.antiTheft = (fl & 2) === 2; S.light = (fl & 4) === 4; S.lock = (fl & 8) === 8; S.cruise = (fl & 16) === 16;
      S.current = f[5] & 0xff; S.period = be16(f, 6); S.fault = f[8]; S.residual = be16(f, 9); S.unitMi = (f[11] & 15) !== 0;
    } else if (op === 0x11) {                // Data0x11Bean
      S.diam85 = (f[4] & 64) === 64; S.speedLimit = f[5] & 0xff; S.fullCap = be16(f, 6);
    } else if (op === 0x12) {                // Data0x12Bean (24-bit)
      S.fw = be24(f, 4);
    } else if (op === 0x40) {                // Data0x40Bean (BE24/10)
      S.trip = be24(f, 4) / 10; S.odo = be24(f, 7) / 10; S.charging = (f[10] & 0xff) >= 0x80;
    } else if (op === 0x48) {                // device serial 32-bit
      S.serial = u32(f, 4);
    } else if (op === 0x49) {                // motor serial 32-bit
      S.motor = u32(f, 4);
    }
    // derived (c.java:40-66)
    if (S.residual != null && S.fullCap) { const r = S.residual / S.fullCap; S.battPct = Math.round(100 * r); S.rangeKm = +(r * 35.0).toFixed(1); }
    if (S.period != null) { const k = S.diam85 ? 67.8 : 72.0; S.speed = S.period ? Math.round((k * 36.0) / S.period) : 0; }
  }

  // hex helper (advanced raw/free builders): strip spaces/punctuation, parse pairs, drop a dangling nibble
  function hexToBytes(s) {
    const clean = String(s).replace(/[^0-9a-fA-F]/g, '');
    const out = []; for (let i = 0; i + 2 <= clean.length; i += 2) out.push(parseInt(clean.slice(i, i + 2), 16));
    return out;
  }

  // load-time self-test: builders must match known-good vectors, every built frame must re-validate
  function runSelfTest() {
    const Z = newState();
    const eq = (a, b) => a.length === b.length && a.every((v, i) => (v & 0xff) === (b[i] & 0xff));
    const t1 = eq(frame0x41({ speedKmh: 20, cruise: false, diam85: false }, Z), [0x4a, 0x03, 0x41, 0x02, 0x00, 0x14, 0x5a, 0x00, 0x0d, 0x0a]);
    const t2 = eq(frame0x40({ lock: true, light: false, antiTheft: false, unitMi: false }, Z), [0x4a, 0x03, 0x40, 0x02, 0x00, 0x48, 0x8d, 0x00, 0x0d, 0x0a]);
    const t3 = eq(frame0x41({ speedKmh: 128, cruise: true, diam85: true }, Z), [0x4a, 0x03, 0x41, 0x02, 0xc0, 0x80, 0x86, 0x00, 0x0d, 0x0a]);
    return t1 && t2 && t3 && validFrame(frame0x41({ speedKmh: 20 }, Z)) && validFrame(frame0x40({ lock: true }, Z));
  }

  // live device state, rebuilt from the push frames (the command builders read from this)
  function newState() {
    return {
      antiTheft: null, light: null, lock: null, cruise: null, unitMi: null, diam85: null,
      current: null, period: null, fault: null, residual: null, fullCap: null,
      speedLimit: null, trip: null, odo: null, charging: null, fw: null, serial: null, motor: null,
      battPct: null, rangeKm: null, speed: null
    };
  }

  // on/off value label from the manifest, language-aware (matches the original onOff())
  const ON = { de: 'an', en: 'on' }, OFF = { de: 'aus', en: 'off' };
  const onOff = (v, ctx) => v == null ? null : (v ? ON[ctx.lang] : OFF[ctx.lang]);

  // =========================================================================================
  //  DRIVER MANIFEST
  // =========================================================================================
  const DRIVER = {
    meta: {
      id: 'inokim', brand: 'INOKIM',
      models: [{ id: 'default', label: 'INOKIM' }],
      defaultModel: 'default'
    },

    connection: {
      services: ['0000ffb0-0000-1000-8000-00805f9b34fb'],   // primary service (also the 16-bit scan filter 0xFFB0)
      char: '0000ffb2-0000-1000-8000-00805f9b34fb',         // single characteristic: write WITH response + notify (CCCD 0x2902)
      filterServices: ['0000ffb0-0000-1000-8000-00805f9b34fb'],
      writeMode: 'response',                                 // writes WITH response (Session.java:149)
      needs: { model: false, pin: false, localKey: false, btsnoop: false },
      handshake: null
    },

    newState,

    // ---- pure protocol (no DOM, no globals) ----
    reassemble: { header: 0x4a, lenAt: 3, extra: 8, min: 8 },  // total = bytes[lenAt] + extra
    validate(bytes) { return validFrame(bytes); },
    decode(bytes, S) { parseFrame(bytes, S); },
    rxKey(frame) { return 'op:' + frame[2]; },                 // ack-resolution key from an RX frame

    build: {
      raw(hex) { return hexToBytes(hex); },                    // verbatim hex bytes, no header/checksum added
      free(opHex, payloadHex) {                                // proper 0x4A frame + checksum
        const op = parseInt(opHex, 16);
        if (isNaN(op)) return null;
        return buildFrame(op, hexToBytes(payloadHex || ''));
      }
    },

    selfTest() { return { ok: runSelfTest(), label: 'protocol self-test' }; },

    // ---- declarative telemetry (get -> display string or null; runtime shows a dash for null) ----
    telemetry: {
      live: [
        { key: 'speedlimit', label: { de: 'Tempolimit', en: 'Speed limit' }, get: S => S.speedLimit == null ? null : S.speedLimit + ' km/h' },
        { key: 'speed', label: { de: 'Tempo', en: 'Speed' }, get: S => S.speed == null ? null : S.speed + ' km/h' },
        { key: 'period', label: { de: 'Periode (roh)', en: 'Period (raw)' }, get: S => S.period == null ? null : String(S.period) },
        { key: 'current', label: { de: 'Strom (roh)', en: 'Current (raw)' }, get: S => S.current == null ? null : String(S.current) },
        { key: 'fault', label: { de: 'Fehler', en: 'Fault' }, get: (S, ctx) => S.fault == null ? null : (S.fault === 0 ? (ctx.lang === 'de' ? 'keiner' : 'none') : 'code ' + S.fault) },
        { key: 'unit', label: { de: 'Einheit', en: 'Unit' }, get: S => S.unitMi == null ? null : (S.unitMi ? 'mi' : 'km') },
        { key: 'wheel', label: { de: 'Rad', en: 'Wheel' }, get: S => S.diam85 == null ? null : (S.diam85 ? '8.5"' : '10"') },
        { key: 'trip', label: { de: 'Strecke', en: 'Trip' }, get: S => S.trip == null ? null : S.trip.toFixed(1) + ' km' },
        { key: 'odo', label: { de: 'Gesamt', en: 'Total' }, get: S => S.odo == null ? null : S.odo.toFixed(1) + ' km' },
        { key: 'fw', label: { de: 'Firmware', en: 'Firmware' }, get: S => S.fw == null ? null : String(S.fw) },
        { key: 'serial', label: { de: 'Seriennr.', en: 'Serial' }, get: S => S.serial == null ? null : String(S.serial) },
        { key: 'motor', label: { de: 'Motor-Nr.', en: 'Motor no.' }, get: S => S.motor == null ? null : String(S.motor) },
        { key: 'lock', label: { de: 'Sperre', en: 'Lock' }, get: (S, ctx) => S.lock == null ? null : (S.lock ? (ctx.lang === 'de' ? 'gesperrt' : 'locked') : (ctx.lang === 'de' ? 'offen' : 'open')) },
        { key: 'light', label: { de: 'Licht', en: 'Light' }, get: (S, ctx) => onOff(S.light, ctx) },
        { key: 'antitheft', label: { de: 'Diebstahlschutz', en: 'Anti-theft' }, get: (S, ctx) => onOff(S.antiTheft, ctx) },
        { key: 'cruise', label: { de: 'Tempomat', en: 'Cruise' }, get: (S, ctx) => onOff(S.cruise, ctx) }
      ],
      battery: [
        { key: 'batt', label: { de: 'Akku', en: 'Battery' }, get: S => S.battPct == null ? null : S.battPct + ' %' },
        { key: 'range', label: { de: 'Reichweite ca.', en: 'Range approx.' }, get: S => S.rangeKm == null ? null : S.rangeKm + ' km' },
        { key: 'residual', label: { de: 'Restkapazität (roh)', en: 'Residual cap. (raw)' }, get: S => S.residual == null ? null : String(S.residual) },
        { key: 'fullcap', label: { de: 'Kapazität (roh)', en: 'Full cap. (raw)' }, get: S => S.fullCap == null ? null : String(S.fullCap) },
        { key: 'charge', label: { de: 'Laden', en: 'Charging' }, get: (S, ctx) => onOff(S.charging, ctx) }
      ]
    },

    // ---- declarative settings (runtime renders by type, groups by `group`, refreshes from `read`) ----
    settings: [
      { key: 'speed', type: 'speed', group: { de: 'Tempo und Freischaltung', en: 'Speed and unlocking' },
        bounds: { min: 1, max: 99 }, defaults: { open: 30, ekfv: 20 },
        labels: {
          open: { de: 'Offen (km/h)', en: 'Open (km/h)' },
          ekfv: { de: 'eKFV / legal (km/h)', en: 'eKFV / legal (km/h)' },
          unlock: { de: 'Entsperren', en: 'Unlock' },
          lock: { de: 'Sperren (eKFV)', en: 'Lock (eKFV)' },
          curUnknown: { de: 'Aktuelles Limit: unbekannt (warte auf Telemetrie).', en: 'Current limit: unknown (waiting for telemetry).' },
          curPrefix: { de: 'Aktuelles Limit:', en: 'Current limit:' }
        },
        logLabel: { de: 'Tempolimit', en: 'Speed limit' },
        hint: { de: 'Entsperren schreibt den Wert "Offen", Sperren den eKFV-Wert ins Tempolimit. Der Knopf beschriftet sich aus dem gemeldeten Limit. Beide Werte merkt sich der Browser auf diesem Gerät.', en: 'Unlock writes the "Open" value, Lock the eKFV value into the speed limit. The button labels itself from the reported limit. Both values are remembered in this browser.' },
        read: S => S.speedLimit, ack: 'op:0x11',
        write: (kmh, S) => frame0x41({ speedKmh: kmh & 0xff }, S) },

      { key: 'lock', type: 'select', group: { de: 'Allgemein', en: 'General' },
        label: { de: 'Roller-Sperre', en: 'Scooter lock' },
        options: [{ val: 0, label: { de: 'offen', en: 'open' } }, { val: 1, label: { de: 'gesperrt', en: 'locked' } }],
        read: S => bNum(S.lock), write: (v, S) => frame0x40({ lock: !!v }, S), ack: 'op:0x10',
        risky: true, warn: { de: 'Das sperrt den Roller (Immobilizer). Entsperren geht nur wieder über Bluetooth.', en: 'This locks the scooter (immobilizer). It can only be unlocked again over Bluetooth.' } },

      { key: 'antitheft', type: 'select', group: { de: 'Allgemein', en: 'General' },
        label: { de: 'Diebstahlschutz', en: 'Anti-theft' },
        options: [{ val: 0, label: { de: 'aus', en: 'off' } }, { val: 1, label: { de: 'an', en: 'on' } }],
        read: S => bNum(S.antiTheft), write: (v, S) => frame0x40({ antiTheft: !!v }, S), ack: 'op:0x10' },

      { key: 'light', type: 'select', group: { de: 'Allgemein', en: 'General' },
        label: { de: 'Licht', en: 'Light' },
        options: [{ val: 0, label: { de: 'aus', en: 'off' } }, { val: 1, label: { de: 'an', en: 'on' } }],
        read: S => bNum(S.light), write: (v, S) => frame0x40({ light: !!v }, S), ack: 'op:0x10' },

      { key: 'unit', type: 'select', group: { de: 'Allgemein', en: 'General' },
        label: { de: 'Einheit', en: 'Unit' },
        options: [{ val: 0, label: { de: 'km', en: 'km' } }, { val: 1, label: { de: 'mi', en: 'mi' } }],
        read: S => bNum(S.unitMi), write: (v, S) => frame0x40({ unitMi: !!v }, S), ack: 'op:0x10' },

      { key: 'cruise', type: 'select', group: { de: 'Allgemein', en: 'General' },
        label: { de: 'Tempomat', en: 'Cruise control' },
        options: [{ val: 0, label: { de: 'aus', en: 'off' } }, { val: 1, label: { de: 'an', en: 'on' } }],
        read: S => bNum(S.cruise), write: (v, S) => frame0x41({ cruise: !!v }, S), ack: 'op:0x11' },

      { key: 'wheel', type: 'select', group: { de: 'Allgemein', en: 'General' },
        label: { de: 'Radgröße', en: 'Wheel size' },
        options: [{ val: 0, label: { de: '10 Zoll', en: '10 inch' } }, { val: 1, label: { de: '8,5 Zoll', en: '8.5 inch' } }],
        read: S => bNum(S.diam85), write: (v, S) => frame0x41({ diam85: !!v }, S), ack: 'op:0x11',
        risky: true, warn: { de: 'Die Radgröße ändert die Tacho-Berechnung, nicht die reale Geschwindigkeit. Falsch gesetzt zeigt der Tacho falsch an.', en: 'Wheel size changes the speedometer calculation, not the real speed. Set wrong, the speedo reads wrong.' } },

      { key: 'cleartrip', type: 'action', group: { de: 'Tageskilometer', en: 'Trip meter' },
        label: { de: 'Tageskilometer zurücksetzen', en: 'Reset trip meter' },
        hint: { de: 'Setzt nur die Tagesstrecke zurück, nicht den Gesamtkilometerstand.', en: 'Resets only the trip distance, not the total odometer.' },
        write: (_v, S) => frame0x41({ clearTrip: true }, S), ack: 'op:0x40',
        risky: true, warn: { de: 'Das setzt den Tageskilometerzähler auf null. Die Gesamtstrecke bleibt erhalten.', en: 'This resets the trip meter to zero. The total distance is kept.' } }
    ],

    // ---- advanced (engine level): verbatim raw frame + free opcode/payload builder ----
    advanced: [
      { key: 'raw', type: 'raw', label: { de: 'Rohes Frame (Hex)', en: 'Raw frame (hex)' },
        placeholder: '4A 03 41 02 00 14 5A 00 0D 0A', btn: { de: 'Senden', en: 'Send' },
        logLabel: { de: 'rohes Frame', en: 'raw frame' } },
      { key: 'free', type: 'free',
        opLabel: { de: 'Opcode (Hex)', en: 'Opcode (hex)' }, opPlaceholder: '41',
        payloadLabel: { de: 'Payload (Hex)', en: 'Payload (hex)' }, payloadPlaceholder: '00 14',
        btn: { de: 'Frame bauen und senden', en: 'Build and send frame' },
        logLabel: { de: 'gebautes Frame', en: 'built frame' } }
    ],

    // ---- log anonymization pipeline (mask = always at source; redact = when public-log is on) ----
    logAnonymize: {
      mask: [
        { re: /eyJ[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}/g, repl: '[redacted-jwt]' },
        { re: /\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, repl: 'Bearer ***' },
        { re: /\b(access[_-]?token|refresh[_-]?token|token|jwt|password|passwd|pwd|secret|code|otp)\b(\s*[:=]\s*)("?)([^\s",}]+)\3/gi, repl: (m, k, sep) => k + sep + '***' }
      ],
      redact: [
        { re: /\b(?:[0-9A-Fa-f]{2}[:-]){5}[0-9A-Fa-f]{2}\b/g, repl: '[redacted-mac]' },
        { re: /\b(secret|token|key|aes|pwd|password|pin|mac|serial|vin|uid|imei)\b(\s*[:=]\s*)("?)([^\s",]+)\3/gi, repl: (m, k, sep) => k + sep + '[redacted]' },
        { re: /\b[0-9A-Fa-f]{16,}\b/g, repl: '[redacted-hex]' }
      ]
    },

    docs: {
      disclaimer: {
        de: 'Dieses Werkzeug ist eine Machbarkeitsstudie, kein fertiges Produkt. Es gibt keine Gewährleistung und keine Zusicherung fehlerfreien Betriebs. Das Anheben der Geschwindigkeit hebt die Drossel auf: die ABE erlischt und der Betrieb auf öffentlichen Wegen ist dann nicht erlaubt. Nutze es nur am eigenen Fahrzeug und auf eigenes Risiko. Die Seite spricht nur lokal über Bluetooth mit dem Gerät, es werden keine Daten an einen Server gesendet. INOKIM ist eine Marke des jeweiligen Inhabers. Dieses Projekt ist unabhängig und steht in keiner Verbindung zu INOKIM oder Myway.',
        en: 'This tool is a feasibility study, not a finished product. There is no warranty and no guarantee of error-free operation. Raising the speed removes the throttle: the type approval becomes void and riding on public roads is then not allowed. Use it only on your own vehicle and at your own risk. The page talks to the device locally over Bluetooth only, no data is sent to any server. INOKIM is a trademark of its respective owner. This project is independent and not affiliated with INOKIM or Myway.'
      },
      trademarks: { de: 'INOKIM ist eine Marke des jeweiligen Inhabers.', en: 'INOKIM is a trademark of its respective owner.' },
      guide: { de: 'GUIDE.de.md', en: 'GUIDE.en.md' },
      readme: { de: 'README.md', en: 'README.md' }
    }
  };

  function bNum(v) { return v == null ? null : (v ? 1 : 0); }

  if (typeof window !== 'undefined') window.DRIVER = DRIVER;
  if (typeof module !== 'undefined' && module.exports) module.exports = DRIVER;

})();
