/**
 *      RPI-Monitor Adapter
 *
 *      License: MIT
 */
'use strict';

const utils = require('@iobroker/adapter-core'); // Get common adapter utils
let gpio;
let errorsLogged = {};
const debounceTimers = [];

// Which button events will we capture and have states for?
// See https://www.npmjs.com/package/rpi-gpio-buttons
const buttonEvents = [ 'pressed', 'clicked', 'clicked_pressed', 'double_clicked', 'released' ];

const adapter = new utils.Adapter({
    name: 'rpi2',

    ready: function () {
        config = adapter.config;
        objects = {};

        if (adapter.config.forceinit) {
            adapter.getAdapterObjects((res) => {
                for (const id of Object.keys(res)) {
                    if (/^rpi2\.\d+$/.test(id)) {
                        adapter.log.debug('Skip root object ' + id);
                        continue;
                    }
                  
                    adapter.log.debug('Remove ' + id + ': ' + id);

                    adapter.delObject(id, (res, err) => {
                        if (res !== undefined && res !== null && res !== 'Not exists') adapter.log.error('res from delObject: ' + res);
                        if (err !== undefined) adapter.log.error('err from delObject: ' + err);
                    });
                    adapter.deleteState(id, (res, err) => {
                        if (res !== undefined && res !== null && res !== 'Not exists') adapter.log.error('res from deleteState: ' + res);
                        if (err !== undefined) adapter.log.error('err from deleteState: ' + err);
                    });
                }
                adapter.subscribeStates('*');
                main();
            });
        } else {
             adapter.getAdapterObjects((res) => {
                for (const id of Object.keys(res)) {
                    objects[id] = true; //object already exists.
                }

                adapter.log.debug('received all objects');
                adapter.subscribeStates('*');
                main();
             });
        }        
    },
    stateChange: function (id, state) {
        adapter.log.debug('stateChange for ' + id + ' found state = ' + JSON.stringify(state));
        if (state && !state.ack) {
            if (id.indexOf('gpio.') !== -1) {
                const parts = id.split('.');
                parts.pop(); // remove state
                writeGpio(parts.pop(), state.val);
            }
        }
    },
    unload: function (callback) {
        // Cancel any debounce timers
        debounceTimers.forEach((timer) => {
            if (timer != null) {
                clearTimeout(timer);
            }
        });
        // TODO: destroy rpi-gpio-buttons when this is fixed: https://github.com/bnielsen1965/rpi-gpio-buttons/issues/9
        if (gpio) {
            gpio.destroy(() => callback && callback());
        } else {
            callback && callback();
        }
    }
});

function writeGpio(port, value) {
    port = parseInt(port, 10);
    if (!adapter.config.gpios[port] || !adapter.config.gpios[port].enabled) {
        adapter.log.warn('Port ' + port + ' is not writable, because disabled.');
        return;
    } else if (adapter.config.gpios[port].input === 'in' || adapter.config.gpios[port].input === 'true' || adapter.config.gpios[port].input === true) {
        return adapter.log.warn('Port ' + port + ' is configured as input and not writable');
    }

    if (value === 'true')  value = true;
    if (value === 'false') value = false;
    if (value === '0')     value = false;
    value = !!value;

    try {
        if (gpio) {
            gpio.write(port, value, err => {
                if (err) {
                    adapter.log.error(err);
                } else {
                    adapter.log.debug('Written ' + value + ' into port ' + port);
                    adapter.setState('gpio.' + port + '.state', value, true);
                }
            });
        } else {
            adapter.log.error('GPIO is not initialized!');
        }
    } catch (error) {
        adapter.log.error('Cannot write port ' + port + ': ' + error);
    }
}

let objects;
let exec;
const rpi      = {};
const table    = {};
let config;
let oldstyle = false;

function main() {
    if (anyParserConfigEnabled()) {
        // TODO: Check which Objects we provide
        setInterval(parser, adapter.config.interval || 60000);

        const version = process.version;
        const va = version.split('.');
        if (va[0] === 'v0' && va[1] === '10') {
            adapter.log.debug('NODE Version = ' + version + ', we need new exec-sync');
            exec     = require('sync-exec');
            oldstyle = true;
        } else {
            adapter.log.debug('NODE Version = ' + version + ', we need new execSync');
            exec     = require('child_process').execSync;
        }
        parser();
    } else {
        adapter.log.info('No parser items enabled - skipping');
    }
    initPorts();
}

function anyParserConfigEnabled() {
    for (const configKey of Object.keys(adapter.config)) {
        if (configKey.indexOf('c_') >= 0) {
            adapter.log.debug(`${configKey} looks like a parser item`);
            if (adapter.config[configKey] === true) {
                adapter.log.debug(`${configKey} is enabled`);
                return true;
            }
        }
    }
    return false;
}

function parser() {

    adapter.log.debug('start parsing');

    // Workaround, WebStorm
    if (config === undefined) {
        config = adapter.config;
    }
    for (const c in config) {
        if (!config.hasOwnProperty(c)) continue;

        adapter.log.debug('PARSING: ' + c);

        if (c.indexOf('c_') !== 0 && config['c_' + c] === true) {
            table[c] = new Array(20);
            const o = config[c];
            for (const i in o) {
                if (!o.hasOwnProperty(i)) continue;
                adapter.log.debug('    PARSING: ' + i);
                const object = o[i];
                const command = object.command;
                let regexp;
                if (object.multiline !== undefined) {
                    regexp = new RegExp(object.regexp, 'm');
                } else {
                    regexp = new RegExp(object.regexp);
                }
                const post = object.post;

                adapter.log.debug('---> ' + command);

                let stdout;
                try {
                    if (oldstyle) {
                        stdout = exec(command).stdout;
                    } else {
                        stdout = exec(command).toString();
                    }
                    adapter.log.debug('------------- ' + stdout);
                } catch (er) {
                    adapter.log.debug(er.stack);
                    if (er.pid) console.log('%s (pid: %d) exited with status %d',
                        er.file, er.pid, er.status);
                    // do not process if exec fails
                    continue;
                }

                const match = regexp.exec(stdout);
                adapter.log.debug('---> REGEXP: ' + regexp);
                if (match !== undefined && match !== null && match.length !== undefined) {
                    adapter.log.debug('GROUPS: ' + match.length);
                }
                // TODO: if Group Match is bigger than 2
                // split groups and header into separate objects
                if (match !== undefined && match !== null && match.length > 2) {
                    const lname = i.split(',');
                    for (let m = 1; m < match.length; m++) {
                        const value = match[m];
                        const name = lname[m - 1];
                        adapter.log.debug('MATCHING: ' + value);
                        adapter.log.debug('NAME: ' + name + ', VALULE: ' + value);

                        rpi[name] = value;
                        table[c][i] = value;
                    }
                } else {
                    adapter.log.debug('---> POST:   ' + post);
                    let value;
                    if (match !== undefined && match !== null) {
                        value = match[1];
                    } else {
                        value = stdout;
                    }
                    rpi[i] = value;
                    table[c][i] = value;
                }
            }
        }
    }

    // TODO: Parse twice to get post data and evaluate
    for (const c in config) {
        if (!config.hasOwnProperty(c)) continue;
        adapter.log.debug('CURRENT = ' + c + ' ' + config['c_' + c]);
        adapter.log.debug(c.indexOf('c_'));
        if (c.indexOf('c_') !== 0 && config['c_' + c]) {
            if (objects[c] === undefined) {
                const stateObj = {
                    common: {
                        name:   c, // You can add here some description
                        role:   'sensor'
                    },
                    type:   'device',
                    _id:    c
                };

                adapter.extendObject(c, stateObj);
                objects[c] = true; //remember that we created the object.
            }
            const o = config[c];
            for (const i in o) {
                if (!o.hasOwnProperty(i)) {
                    continue;
                }
                const object = o[i];
                const command = object.command;
                const post = object.post;

                adapter.log.debug('---> POST:   ' + post + ' for ' + i + ' in ' + o);
                let value;

                const lname = i.split(',');
                if (lname !== undefined && lname.length > 1) {
                    for (let m = 0; m < lname.length; m++) {
                        const name = lname[m];
                        value = rpi[name];

                        // TODO: Check if value is number and format it 2 Digits
                        if (!isNaN(value)) {
                            value = parseFloat(value);
                            const re = new RegExp(/^\d+\.\d+$/);
                            if (re.exec(value)) {
                                value = value.toFixed(2);
                            }
                        }

                        adapter.log.debug('MATCHING: ' + value);
                        adapter.log.debug('NAME: ' + name + ' VALUE: ' + value);

                        const objectName = adapter.name + '.' + adapter.instance + '.' + c + '.' + name;
                        adapter.log.debug('SETSTATE FOR ' + objectName + ' VALUE = ' + value);
                        if (objects[objectName] === undefined) {
                            // TODO Create an Object tree
                            const stateObj = {
                                common: {
                                    name:  objectName, // You can add here some description
                                    read:  true,
                                    write: false,
                                    state: 'state',
                                    role:  'value',
                                    type:  'number'
                                },
                                type: 'state',
                                _id: objectName
                            };
                            adapter.extendObject(objectName, stateObj);
                            objects[objectName] = true; //remember that we created the object.
                        }
                        adapter.setState(objectName, {
                            val: value,
                            ack: true
                        });
                    }
                } else {
                    value = rpi[i];
                    if (value !== undefined && value !== '' && value !== null) {
                        if (post.indexOf('$1') !== -1) {
                            adapter.log.debug('VALUE: ' + value + ' POST: ' + post);
                            try {
                                value = eval(post.replace('$1', value));
                            } catch (e) {
                                adapter.log.error('Cannot evaluate: ' + post.replace('$1', value));
                                value = NaN;
                            }
                        }
                        // TODO: Check if value is number and format it 2 Digits
                        if (!isNaN(value)) {
                            value = parseFloat(value);
                            const r = new RegExp(/^\d+\.\d+$/);
                            if (r.exec(value)) {
                                value = value.toFixed(2);
                            }
                        }

                        const objectName = adapter.name + '.' + adapter.instance + '.' + c + '.' + i;
                        adapter.log.debug('SETSTATE FOR ' + objectName + ' VALUE = ' + value);
                        if (objects[objectName] === undefined) {
                            // TODO Create an Objecttree
                            const stateObj = {
                                common: {
                                    name:  objectName, // You can add here some description
                                    read:  true,
                                    write: false,
                                    state: 'state',
                                    role:  'value',
                                    type:  'mixed'
                                },
                                type: 'state',
                                _id: objectName
                            };
                            adapter.extendObject(objectName, stateObj);
                            objects[objectName] = true; //remember that we created the object.
                        }
                        adapter.setState(objectName, {
                            val: value,
                            ack: true
                        });
                    } else {
                        if (i === 'wifi_send' || i === 'wifi_received') {
                            adapter.log.debug('No Value found for ' + i);
                        } else if (! errorsLogged[i]) {
                            adapter.log.error('No Value found for ' + i);
                            errorsLogged[i] = true;
                        }
                    }
                }
            }
        }
    }
}

function inputPullUp(value) {
    return (adapter.config.inputPullUp ? !value : value);
}

function readValue(port) {
    if (!gpio) {
        return adapter.log.error('GPIO is not initialized!');
    }

    gpio.read(port, (err, value) => {
        if (err) {
            adapter.log.error('Cannot read port ' + port + ': ' + err);
        } else {
            adapter.setState('gpio.' + port + '.state', inputPullUp(value), true);
        }
    });
}

// syncPort waits for everything it calls, so upon return, when the GPIO
// handlers, etc. are setup their states are guaranteed to be in place.

// Our own deleteState that logs an error only if it's not, Not Exists
async function deleteState(stateName) {
    try {
        await adapter.delObjectAsync(stateName);
    } catch (err) {
        if (err != 'Error: Not exists') {
            throw new Error(`Failed to delete object ${stateName}: ${err}`);
        }
    }
    await deleteObject(stateName);
}

 async function deleteObject(objectName) {
    try {
        await adapter.delStateAsync(objectName);
    } catch (err) {
        if (err != 'Error: Not exists') {
            throw new Error(`Failed to delete object ${objectName}: ${err}`);
        }
    }
}

async function syncPort(port, data) {
    data.isButton = (data.input === 'button');
    data.isInput = (data.input === 'in' || data.input === 'true' || data.input === true || data.isButton);

    const channelName = 'gpio.' + port;
    if (data.enabled) {
        await adapter.extendObjectAsync(channelName, {
            type: 'channel',
            common: {
                name: !data.hasOwnProperty('label') || data.label == '' ? 'GPIO ' + port : data.label,
                // TODO: should we do more than just add this as 'info'?
                role: 'info'
            }
        });
    } else {
        await deleteObject(channelName);
    }
    
    const stateName = 'gpio.' + port + '.state';
    if (data.enabled && !data.isButton) {
        const obj = {
            common: {
                name:  'GPIO ' + port,
                type:  'boolean',
                role:  data.isInput ? 'indicator' : 'switch',
                read:  data.isInput,
                write: !data.isInput
            },
            native: {
            },
            type: 'state'
        };
        // extendObject creates one if it doesn't exist - same below
        await adapter.extendObjectAsync(stateName, obj);
    } else {
        await deleteState(stateName);
    }
    await syncPortDirection(port, data);
    await syncPortButton(port, data);
}

async function syncPortDirection(port, data) {
    const stateName = 'gpio.' + port + '.isInput';
    if (data.enabled) {
        adapter.log.debug(`Creating ${stateName}`);
        const obj = {
            common: {
                name:  'GPIO ' + port + ' direction',
                type:  'boolean',
                role:  'state',
                read:  true,
                write: false
            },
            native: {
            },
            type: 'state'
        };
        await adapter.extendObjectAsync(stateName, obj);
        await adapter.setStateAsync(stateName, data.isInput, true);
    } else {
        await deleteState(stateName);
    }
}

function buttonStateName(port, eventName) {
    return 'gpio.' + port + '.' + eventName;
}

async function syncPortButton(port, data) {
    for (const eventName of buttonEvents) {
        const stateName = buttonStateName(port, eventName);
        if (data.enabled && data.isButton) {
            const obj = {
                common: {
                    name:  'GPIO ' + port + ' ' + eventName,
                    type:  'boolean',
                    role:  'button',
                    read:  false,
                    write: true
                },
                native: {
                },
                type: 'state'
            };
            await adapter.extendObjectAsync(stateName, obj);
        } else {
            await deleteState(stateName);
        }
    };
}

async function initPorts() {
    adapter.log.debug('Inputs are pull ' + (adapter.config.inputPullUp ? 'up' : 'down') + '.');
    adapter.log.debug('Buttons are pull ' + (adapter.config.buttonPullUp ? 'up' : 'down') + '.');

    let anyGpioEnabled = false;
    let buttonPorts = [];

    if (adapter.config.gpios && adapter.config.gpios.length) {
        for (let pp = 0; pp < adapter.config.gpios.length; pp++) {
            // syncPort sets up object tree. Do it now so all ready when
            // physical GPIOs are enabled below.

            await syncPort(pp, adapter.config.gpios[pp] || {});

            if (!adapter.config.gpios[pp] || !adapter.config.gpios[pp].enabled) continue;
            if (adapter.config.gpios[pp].input == 'button') {
                // This is a button - add to array to initialise module
                buttonPorts.push(pp);
            } else {
                // Must just be regular GPIO
                anyGpioEnabled = true;
            }
        }
    }

    if (anyGpioEnabled) {
        try {
            gpio = require('rpi-gpio');
        } catch (e) {
            gpio = null;
            adapter.log.error('Cannot initialize GPIO: ' + e);
            console.error('Cannot initialize GPIO: ' + e);
        }
        try {
            gpio.setMode(gpio.MODE_BCM);
        } catch (e) {
            gpio = null;
            adapter.log.error('cannot use GPIO: ' + e);
        }
    }

    let gpioButtons;
    if (buttonPorts.length > 0) {
        try {
            const rpi_gpio_buttons = require('rpi-gpio-buttons');
            gpioButtons = rpi_gpio_buttons(buttonPorts, {
                mode: rpi_gpio_buttons.MODE_BCM,
                usePullUp: adapter.config.buttonPullUp,
                debounce: adapter.config.buttonDebounceMs,
                pressed: adapter.config.buttonPressMs,
                clicked: adapter.config.buttonDoubleMs
            });
        } catch (e) {
            gpioButtons = null;
            adapter.log.error('Cannot initialize GPIO Buttons: ' + e);
        }
    }

    if (adapter.config.gpios && adapter.config.gpios.length) {
        let haveInputs = false;
        for (let p = 0; p < adapter.config.gpios.length; p++) {
            if (!adapter.config.gpios[p]) continue;

            if (gpio && adapter.config.gpios[p].enabled) {
                /* Ensure backwards compatibility of property .input
                 * in older versions, it was true for "in" and false for "out" 
                 * in newer versions, it is "in", "out", "outlow" or "outhigh"
                 */
                if (adapter.config.gpios[p].input === 'true' || adapter.config.gpios[p].input === true) {
                    adapter.config.gpios[p].input = 'in';
                }
                else if (adapter.config.gpios[p].input === 'false' || adapter.config.gpios[p].input === false) {
                    adapter.config.gpios[p].input = 'out';
                }

                switch(adapter.config.gpios[p].input) {
                    case 'in':
                        (function (port) {
                            haveInputs = true;
                            gpio.setup(port, gpio.DIR_IN, gpio.EDGE_BOTH, (err) => {
                                if (err) {
                                    adapter.log.error('Cannot setup port ' + port + ' as input: ' + err);
                                } else {
                                    readValue(port);
                                }
                            });
                        })(p);
                        break;
                    case 'button':
                        // Do nothing - jus here to prevent error below.
                        break;
                    case 'out':
                        (function (port){
                            gpio.setup(port, gpio.DIR_OUT, err =>
                                err && adapter.log.error('Cannot setup port ' + port + ' as output: ' + err));
                        })(p);
                        break;
                    case 'outlow':
                        (function (port){
                            gpio.setup(port, gpio.DIR_LOW, err =>
                                err && adapter.log.error('Cannot setup port ' + port + ' as output with initial value "0": ' + err));
                        })(p);
                        break;
                    case 'outhigh':
                        (function (port){
                            gpio.setup(port, gpio.DIR_HIGH, err =>
                                err && adapter.log.error('Cannot setup port ' + port + ' as output with initial value "1": ' + err));
                        })(p);
                        break;
                    default:
                        adapter.log.error('Cannot setup port ' + port + ': invalid direction type.');
                }
            }
        }

        // Setup input change handler - only has to be done once no matter how many inputs we have
        if (haveInputs && gpio) {
            adapter.log.debug('Register onchange handler');
            gpio.on('change', (port, value) => {
                // Ignore buttons as they are handled below
                if (adapter.config.gpios[port].input == 'in') {
                    adapter.log.debug('GPIO change on port ' + port + ': ' + value);
                    if (debounceTimers[port] != null) {
                        // Timer is running but state changed (must be back) so just cancel timer.
                        clearTimeout(debounceTimers[port]);
                        debounceTimers[port] = null;
                    } else {
                        // Start a timer and report to state if doesn't revert within given period.
                        debounceTimers[port] = setTimeout((t_port, t_value) => {
                            debounceTimers[t_port] = null;
                            adapter.log.debug(`GPIO debounced on port ${t_port}: ${t_value}`);
                            adapter.setState('gpio.' + t_port + '.state', inputPullUp(t_value), true);
                        }, adapter.config.inputDebounceMs, port, value);
                    }
                }
            });
        }

        // Setup events for buttons - only has to be done once no matter how many buttons we have
        if (buttonPorts.length > 0 && gpioButtons /* to check init was good */) {
            buttonEvents.forEach((eventName) => {
                gpioButtons.on(eventName, (port) => {
                    adapter.log.debug(`${eventName} triggered for port ${port}`);
                    const stateName = buttonStateName(port, eventName);
                    adapter.setState(stateName, true, true);
                });
            });
        }
    } else {
        adapter.log.info('GPIO ports are not configured');
    }
}
