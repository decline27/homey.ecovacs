'use strict';

// Loads drivers/deebot/device.js with a fake Homey SDK, Ecovacs API and robot, so the connection logic can run
// without a Homey. Timers are not real: they are collected and fired with fireTimers().

const Module = require('module');
const path = require('path');
const { EventEmitter } = require('events');

class FakeDevice {
	constructor() {
		this.store = {};
		this.capabilities = {};
		this.logs = [];
		this.available = true;
		this.timers = [];
		this.flowTriggers = [];
		this.homey = {
			setTimeout: (fn, delay) => {
				const timer = { fn, delay };
				this.timers.push(timer);
				return timer;
			},
			clearTimeout: (timer) => {
				this.timers = this.timers.filter((t) => t !== timer);
			},
			flow: {
				getDeviceTriggerCard: (id) => ({
					trigger: async (device, tokens) => { this.flowTriggers.push({ id, tokens }); },
				}),
			},
		};
	}
	log(...args) { this.logs.push(args.join(' ')); }
	error(...args) { this.logs.push('ERR ' + args.join(' ')); }
	getName() { return 'Test robot'; }
	getStoreValue(key) { return this.store[key]; }
	async setStoreValue(key, value) { this.store[key] = value; }
	hasCapability() { return true; }
	getCapabilityValue(key) { return this.capabilities[key]; }
	async setCapabilityValue(key, value) { this.capabilities[key] = value; }
	async setAvailable() { this.available = true; }
	async setUnavailable(message) { this.available = false; this.unavailableMessage = message; }
	async fireTimers() {
		const timers = this.timers;
		this.timers = [];
		for (const timer of timers) {
			await timer.fn();
		}
	}
}

class FakeVacbot extends EventEmitter {
	constructor() {
		super();
		this.deviceClass = 'twunby';
		this.commands = [];
		this.results = [];
		this.disconnected = false;
	}
	connect() {}
	run(command, ...args) { this.commands.push({ command, args }); }
	async runAsync(command, ...args) {
		this.commands.push({ command, args });
		const next = this.results.shift();
		if (typeof next === 'function') {
			return next();
		}
		if (next instanceof Error) {
			throw next;
		}
		return next;
	}
	getMqttClient() { return null; }
	async disconnect() { this.disconnected = true; }
	updateUserAccessToken(token) { this.token = token; }
}

class FakeApi extends EventEmitter {
	constructor(owner) {
		super();
		this.owner = owner;
		this.country = 'SE';
		this.uid = 'uid';
		this.resource = 'resource';
		this.tokenExpiresAt = Date.now() + 7 * 24 * 60 * 60 * 1000;
	}
	getTokenExpiry() { return this.tokenExpiresAt; }
	getVersion() { return 'test'; }
	async connect() {
		this.owner.logins++;
		if (this.owner.connectError) {
			throw this.owner.connectError;
		}
		if (this.owner.loginFixesDevices) {
			this.owner.devicesError = null;
		}
		this.user_access_token = 'token' + this.owner.logins;
		this.emit('credentialsUpdated', { token: this.user_access_token });
	}
	async devices() {
		if (this.owner.devicesError) {
			throw this.owner.devicesError;
		}
		return [{ did: 'did', resource: 'resource', class: 'twunby' }];
	}
	getVacBot() {
		const vacbot = new FakeVacbot();
		this.owner.vacbots.push(vacbot);
		return vacbot;
	}
}

function loadDevice() {
	const fake = { logins: 0, vacbots: [], connectError: null, devicesError: null, getApi: null };
	fake.getApi = async () => new FakeApi(fake);
	const ecovacsApiStub = {
		getApi: (...args) => fake.getApi(...args),
		getPasswordHash: () => 'hash',
		getConstant: () => 'realm',
	};

	const devicePath = path.resolve(__dirname, '../drivers/deebot/device.js');
	const originalLoad = Module._load;
	Module._load = function (request, parent, isMain) {
		if (request === 'homey') {
			return { Device: FakeDevice };
		}
		if (request.endsWith('lib/ecovacsApi')) {
			return ecovacsApiStub;
		}
		return originalLoad.call(this, request, parent, isMain);
	};
	delete require.cache[devicePath];
	global.appdebug = false;
	let Device;
	try {
		Device = require(devicePath);
	}
	finally {
		Module._load = originalLoad;
	}

	const device = new Device();
	device.store = {
		deviceId: 'id',
		email: 'mail',
		password: 'password',
		geo: 'eu',
		vacuum: { did: 'did', resource: 'resource', class: 'twunby' },
	};
	return { device, fake };
}

module.exports = { loadDevice };
