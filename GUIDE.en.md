# Guide

> **Important for error reports:** switch on the **Diagnostic log** at the bottom of the page *before* you connect to the scooter. Only then is the full connection handshake captured - and those are exactly the lines we need in a [ticket](https://github.com/Laufbursche42/Laufbursche42/issues) to reproduce a problem.

## What you need
- An INOKIM e-scooter.
- A phone or computer with **Chrome**, **Edge**, or on iOS **Bluefy**. Safari and Firefox cannot do Web Bluetooth.

## Connecting
1. Turn on Bluetooth and wake the scooter.
2. Tap **Connect** and pick the scooter from the list.
3. If it is not listed, tick **Show all devices** and try again. The real check is the Bluetooth service found, not the advertised name.
4. Once connected, the live-values, lock, speed and settings cards appear.

## Reading live values
The scooter streams its status continuously. Each tile appears once its value has arrived; a dash just means that value has not come in yet. Below the tiles, **All received frames** lets you follow the raw data per opcode.

## Setting the speed
- **Unlock** writes the value from the **Open** field, **Lock** writes the **eKFV / legal** field. The button labels itself from the limit the scooter actually reports.
- **Set exact** writes any km/h value directly.
- Important: an echo in the log only means the scooter accepted the frame. Only when the speed limit changes in the live values is the value really active. Watch the scooter itself while testing.

## Lock and anti-theft
In the **Lock and anti-theft** card you lock or unlock the scooter (immobilizer) and toggle anti-theft. Note: a locked scooter can only be unlocked again over Bluetooth.

## More settings
Light, unit (km/mi), cruise control and wheel size. Only rows whose value the scooter reports are shown. Wheel size only changes the speedometer calculation, not the real speed.

## Advanced settings (engine level)
Straight at the protocol level. **Send a raw frame** sends your hex bytes unchanged. **Build a frame** takes an opcode and payload and adds the header and checksum for you.

## Shortcuts
Copy the link to your home screen, then one tap unlocks or locks directly. On iOS via Bluefy, and the scooter must have been connected normally once before.

## If something does not work
- Cannot connect? Check that the browser supports Web Bluetooth, Bluetooth is on and the scooter is awake. Retry with **Show all devices**.
- Nothing happens after a command? Check the log: if it says "sent" but no "confirmed", the firmware did not acknowledge the frame.
- **Diagnostics: list all devices** in the log area shows every Bluetooth service of a device without writing anything - useful for support.

## Contribute
Want to find out if and how tuning works on your scooter? Test this tool on your own vehicle and open a ticket on [GitHub](https://github.com/Laufbursche42/Laufbursche42/issues) - with your model and what worked (or did not). That way we figure out together what is possible on which model.
