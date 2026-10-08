# Laufbursche INOKIM unlock

A static web page that talks to INOKIM e-scooters over Web Bluetooth. Connect, read the live values and - straight from the browser - set the maximum speed, lock and unlock the scooter, arm the anti-theft and change display settings. Nothing to install: no app store, no signing, no developer account. It runs in **Bluefy** on iOS and in **Chrome** or **Edge** on Android or desktop.

> **This is a feasibility study - the speed write is sent, its effect on hardware is unconfirmed.** It exists to show what INOKIM's Bluetooth protocol makes possible, not to be a finished product; the protocol was reconstructed from the official app (`com.bugull.myway`) and is documented byte for byte. One generic profile covers every INOKIM model and there is no authentication, so any client that knows the frame format can read and write. The max-speed write (opcode `0x41` on characteristic `FFB2`) is sent on request, but whether the firmware accepts a value above the 30 km/h the vendor app offers - or enforces any auth of its own - sits in the controller and cannot be proven from the app: it must be tested on the device. **Reading works:** live telemetry, battery, speed limit, mileage, fault and lock state are decoded and shown. Error-free operation is not promised and there is no warranty of any kind. Whatever you do with it, you do at your own risk - read the [Legal](#legal) section before you connect a scooter.

**Open the web app: [laufbursche42.github.io/inokim-unlock](https://laufbursche42.github.io/inokim-unlock/)**

Or run it yourself, no build step and no dependencies: clone the repo and serve the folder over a local HTTP server. Opening `index.html` directly as a `file://` URL will not work, the page fetches its own documents and browsers block that over `file://`.

```
git clone https://github.com/Laufbursche42/inokim-unlock.git
cd inokim-unlock
python -m http.server 8000
```

Any static server works. With Node installed, this does the same job:

```
npx serve .
```

Then open the printed address in a browser that supports Web Bluetooth.

**Guide: [Deutsch](GUIDE.de.md) | [English](GUIDE.en.md)** covers everything step by step, from connecting to the first send.

## What it does

- **Live values** - speed limit, speed, battery, estimated range, trip and total mileage, fault code, firmware, serial, and the lock / light / anti-theft / cruise state.
- **Speed** - an unlock/lock toggle (open value vs eKFV value) plus an exact km/h set. Writes the `0x41` limit register. The button labels itself from the limit the scooter actually reports.
- **Lock + anti-theft** - the immobilizer, via `0x40`.
- **More settings** - light, unit (km/mi), cruise control, wheel size.
- **Expert** - send a raw frame verbatim, or build one from an opcode plus payload (the header and checksum are added for you).
- **Shortcut** - a home-screen link that unlocks or locks in a single tap.

## Protocol (proven)

- Service `0xFFB0`, single characteristic `0xFFB2` (write with response + notify via CCCD `0x2902`). No pairing, no PIN.
- Frame: `4A | dir(03) | opcode | len | payload | checksum(2, little-endian signed-additive) | 0D 0A`.
- TX `0x40` settings bits (unit / anti-theft / lock / light), `0x41` tuning (speed km/h raw byte + cruise / wheel-diameter bits). RX `0x10` status, `0x11` config/limit, `0x12` firmware, `0x40` mileage, `0x48` serial, `0x49` motor serial.

## Honesty

Device-untested by design - you test on your own scooter, which is exactly the point of a public tool. An echo in the log means the scooter **accepted** the frame; only the new limit appearing in the live values proves it actually took effect.

## Legal

License: PolyForm Noncommercial, see [License](LICENSE.md). Privacy: nothing leaves your device, see [Privacy](PRIVACY.md). Trademarks: INOKIM is a trademark of its respective owner, this project is independent, see [Trademarks](TRADEMARKS.md).

Source: https://github.com/Laufbursche42/inokim-unlock
