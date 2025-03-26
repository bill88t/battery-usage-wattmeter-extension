import {
    Extension,
    gettext as _,
} from 'resource:///org/gnome/shell/extensions/extension.js';
import {panel} from 'resource:///org/gnome/shell/ui/main.js';
import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import GObject from 'gi://GObject';
import Shell from 'gi://Shell';
import St from 'gi://St';
import Clutter from 'gi://Clutter';

const BAT0 = '/sys/class/power_supply/BAT0/';
const BAT1 = '/sys/class/power_supply/BAT1/';
const BAT2 = '/sys/class/power_supply/BAT2/';
const SBS0 = '/sys/class/power_supply/sbs-5-000b/';

let retry_count = 0;
const max_retries = 5;
const retry_delay = 2;
let BatteryInfo = null;
let batteryIndicatorTimeoutId = null;

function getBatteryIndicator(callback) {
    let system = panel.statusArea?.quickSettings?._system;
    if (system?._systemItem?._powerToggle) {
        callback(system._systemItem._powerToggle._proxy, system);
    } else if (retry_count < max_retries) {
        retry_count++;
        if (batteryIndicatorTimeoutId)
            GLib.Source.remove(batteryIndicatorTimeoutId);
        batteryIndicatorTimeoutId = GLib.timeout_add_seconds(
            GLib.PRIORITY_LOW,
            retry_delay,
            () => {
                getBatteryIndicator(callback);
                return GLib.SOURCE_REMOVE;
            }
        );
    } else {
        console.error(
            `[wattmeter-extension] Failed to find power toggle indicator after ${max_retries} retries.`
        );
    }
}

// Function to get the appropriate battery path and its type
function getBatteryPath(battery) {
    // Array of possible battery paths
    const batteryPaths = [BAT0, BAT1, BAT2, SBS0];
    const invalidPath = -1;

    if (battery === 0) {
        // Automatic setting
        // Check each path and return the first one that contains a valid status file
        for (let path of batteryPaths) {
            if (readFileSafely(`${path}status`, 'none') !== 'none') {
                return {
                    path: path,
                    isTP: readFileSafely(`${path}power_now`, 'none') !== 'none',
                };
            }
        }
        console.error(
            '[wattmeter-extension] No valid battery path found for automatic setting.'
        );
        return {path: invalidPath, isTP: false};
    } else {
        // Manual setting
        let pathIndex = battery - 1;
        if (pathIndex >= 0 && pathIndex < batteryPaths.length) {
            let path = batteryPaths[pathIndex];
            if (readFileSafely(`${path}status`, 'none') !== 'none') {
                return {
                    path: path,
                    isTP: readFileSafely(`${path}power_now`, 'none') !== 'none',
                };
            }
        }
        // If the selected battery path is not valid, return an error
        console.error(
            `[wattmeter-extension] No valid battery path found for battery ${battery}.`
        );
        return {path: invalidPath, isTP: false};
    }
}

function readFileSafely(filePath, defaultValue) {
    try {
        let file = Gio.File.new_for_path(filePath);
        let [ok, contents] = file.load_contents(null);
        if (ok) {
            return String.fromCharCode.apply(null, contents);
        } else {
            return defaultValue;
        }
    } catch (e) {
        console.log(`Cannot read file ${filePath}: ${e}`);
        return defaultValue;
    }
}


// Indicator class
let BatLabelIndicator = GObject.registerClass(
    class BatLabelIndicator extends St.Label {
        constructor(settings) {
            super({
                text: _('Calculating…'),
                y_align: Clutter.ActorAlign.CENTER,
            });
            this._settings = settings;
            let battery = this._settings.get_int('battery');
            BatteryInfo = getBatteryPath(battery);
            this._spawn();
        }

        // Get power consumption in Watts
        _getPower() {
            if (this._settings.get_boolean('combine-batteries')) {
                let total = 0;
                const batteryPaths = [BAT0, BAT1, BAT2, SBS0];
                for (let path of batteryPaths) {
                    if (readFileSafely(`${path}status`, 'none') !== 'none') {
                        let reading;
                        if (readFileSafely(`${path}power_now`, 'none') !== 'none') {
                            reading = this._getValue(`${path}power_now`);
                        } else {
                            const current_now = this._getValue(`${path}current_now`);
                            const voltage_now = this._getValue(`${path}voltage_now`);
                            reading = current_now * voltage_now;
                        }
                        if (reading !== -1)
                            total += reading;
                    }
                }
                return total;
            } else {
                const path = BatteryInfo['path'];
                if (!BatteryInfo['isTP']) {
                    const current_now = this._getValue(`${path}current_now`);
                    const voltage_now = this._getValue(`${path}voltage_now`);
                    return current_now * voltage_now;
                }
                return this._getValue(`${path}power_now`);
            }
        }

        // Helper function to get the value from a sysfs file
        _getValue(path) {
            const value = parseFloat(readFileSafely(path, -1));
            return value === -1 ? value : value / 1000000;
        }

        // Determine battery status and power
       _getBatteryStatus() {
    const status = readFileSafely(
        BatteryInfo['path'] + 'status',
        'Unknown'
    );
    const hideNA = this._settings.get_boolean('hide-na');
    const showMinusSign = this._settings.get_boolean('show-minus-sign');

    if (status.includes('Full')) {
        return ''; // Don't display anything if battery is full
    }

    const powerDraw = this._meas();
    if (status.includes('Charging')) {
        return  _(' +%s W ').format(powerDraw);
    } else if (status.includes('Discharging')) {
        return showMinusSign ? _(' -%s W ').format(powerDraw) : _(' %s W ').format(powerDraw);
    } else if (status.includes('Unknown')) {
        return _(' ? ');
    } else {
        return hideNA ? '' : _(' N/A ');
    }
}


        // Convert power to string with appropriate formatting
 _meas() {
    const power = this._getPower();
    const padSingleDigit = this._settings.get_boolean('pad-single-digit');
    const powerValue = Math.round(power < 0 ? -power : power);
    return padSingleDigit ? String(powerValue).padStart(2, '0') : String(powerValue);
}


        // Update the indicator label
        _sync() {
            if (BatteryInfo['path'] !== -1) {
                this.text = this._getBatteryStatus();
            } else {
                console.log("[wattmeter-extension] can't find battery!!!");
                this.text = ' ⚠ ';
            }
            return GLib.SOURCE_CONTINUE;
        }

        // Start the update loop
        _spawn() {
            // Remove the existing timeout before creating a new one
            if (this._biForceSync) {
                GLib.Source.remove(this._biForceSync);
                this._biForceSync = null;
            }

            this._biForceSync = GLib.timeout_add_seconds(
                GLib.PRIORITY_LOW,
                this._settings.get_int('interval'),
                this._sync.bind(this)
            );
        }

        // Stop the update loop
        _stop() {
            if (this._biForceSync) {
                GLib.Source.remove(this._biForceSync);
                this._biForceSync = null;
            }
        }
    }
);

// Main extension class
export default class WattmeterExtension extends Extension {
    enable() {
        this._settings = this.getSettings(
            'org.gnome.shell.extensions.battery_usage_wattmeter'
        );

        this._batLabelIndicator = new BatLabelIndicator(this._settings);
        getBatteryIndicator((proxy, icon) => {
            icon.add_child(this._batLabelIndicator);
        });
        this._settings.connect('changed::battery', () => {
            let newBatteryValue = this._settings.get_int('battery');
            BatteryInfo = getBatteryPath(newBatteryValue);
            this._batLabelIndicator._sync();
        });
    }

    disable() {
        if (batteryIndicatorTimeoutId) {
            GLib.Source.remove(batteryIndicatorTimeoutId);
            batteryIndicatorTimeoutId = null;
        }
        if (this._batLabelIndicator) {
            this._batLabelIndicator._stop();
            this._batLabelIndicator.destroy();
            this._batLabelIndicator = null;
        }
        this._settings = null;
    }
}
