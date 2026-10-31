'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { loadDevice } = require('./helpers');

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

const validToken = (expiresIn = 6 * DAY) => ({ uid: 'uid', user_access_token: 'stored', tokenExpiresAt: Date.now() + expiresIn });

// --- Login ---

test('a valid stored token is used without a password login', async () => {
	const { device, fake } = loadDevice();
	device.store.api = validToken();
	await device._connectWithRetry();
	assert.strictEqual(fake.logins, 0);
	assert.strictEqual(fake.vacbots.length, 1);
	assert.strictEqual(device.available, true);
});

test('no password login until the token is about to expire', async () => {
	const { device, fake } = loadDevice();
	device.store.api = validToken(6 * DAY);
	await device._connectWithRetry();
	const refresh = device._refreshTimer;
	assert.ok(refresh.delay > 4.9 * DAY && refresh.delay <= 5 * DAY, 'delay ' + refresh.delay);
	assert.strictEqual(fake.logins, 0);
});

test('the refresh timer logs in when the token is close to expiry and hands the new token to the vacbot', async () => {
	const { device, fake } = loadDevice();
	device.store.api = validToken(6 * DAY);
	await device._connectWithRetry();
	device.api.tokenExpiresAt = Date.now() + HOUR;
	await device._refreshTimer.fn();
	assert.strictEqual(fake.logins, 1);
	assert.strictEqual(fake.vacbots[0].token, 'token1');
	assert.strictEqual(device.store.api.user_access_token, 'token1');
});

test('a refresh timer that fires early does not log in', async () => {
	const { device, fake } = loadDevice();
	device.store.api = validToken(20 * DAY);
	await device._connectWithRetry();
	assert.strictEqual(device._refreshTimer.delay, 7 * DAY);
	await device._refreshTimer.fn();
	assert.strictEqual(fake.logins, 0);
	assert.ok(device._refreshTimer, 'a new timer is set');
});

test('tokens that expire soon cannot cause a login loop', async () => {
	const { device } = loadDevice();
	device.store.api = validToken(2 * HOUR);
	await device._connectWithRetry();
	assert.strictEqual(device._refreshTimer.delay, 30 * 60 * 1000);
});

test('no answer on the stored token check does not cause a password login', async () => {
	const { device, fake } = loadDevice();
	device.store.api = validToken();
	fake.devicesError = new Error('Failed to POST to url:https://x error: ETIMEDOUT: no response within 30s');
	await device._connectWithRetry();
	assert.strictEqual(fake.logins, 0);
	assert.strictEqual(device.available, false);
	assert.ok(device._reconnectTimer, 'retries later');
});

test('a rejected stored token falls back to a password login', async () => {
	const { device, fake } = loadDevice();
	device.store.api = validToken();
	fake.devicesError = new Error('Failure code 3 (auth error)');
	fake.loginFixesDevices = true;
	await device._connectWithRetry();
	assert.strictEqual(fake.logins, 1);
	assert.strictEqual(device.available, true);
});

test('2FA required: no retry, the user has to repair', async () => {
	const { device, fake } = loadDevice();
	const error = new Error('verify');
	error.name = 'DeviceVerificationRequired';
	fake.connectError = error;
	await device._connectWithRetry();
	assert.strictEqual(device.available, false);
	assert.strictEqual(device._reconnectTimer, undefined);
});

// --- Reconnect ---

test('reconnect delay doubles while connecting keeps failing', async () => {
	const { device, fake } = loadDevice();
	fake.connectError = new Error('Failure code 1');
	const delays = [];
	await device._connectWithRetry();
	for (let i = 0; i < 7; i++) {
		delays.push(device._reconnectTimer.delay / 1000);
		await device._reconnectTimer.fn();
	}
	assert.deepStrictEqual(delays, [60, 120, 240, 480, 960, 1800, 1800]);
});

test('a login that works but a session that dies right away keeps backing off', async () => {
	const { device, fake } = loadDevice();
	const delays = [];
	await device._connectWithRetry();
	for (let i = 0; i < 4; i++) {
		fake.vacbots[fake.vacbots.length - 1].emit('disconnect');
		delays.push(device._reconnectTimer.delay / 1000);
		await device._reconnectTimer.fn();
	}
	assert.deepStrictEqual(delays, [60, 120, 240, 480]);
});

test('several disconnect events only schedule one reconnect', async () => {
	const { device, fake } = loadDevice();
	await device._connectWithRetry();
	for (let i = 0; i < 5; i++) {
		fake.vacbots[0].emit('disconnect');
	}
	assert.strictEqual(device._reconnectTimer.delay, 60 * 1000);
	assert.strictEqual(device.timers.filter((t) => t === device._reconnectTimer).length, 1);
});

test('a session that lasted a while starts the backoff over', async () => {
	const { device, fake } = loadDevice();
	device._reconnectDelay = 30 * 60 * 1000;
	await device._connectWithRetry();
	device._connectedAt = Date.now() - 11 * 60 * 1000;
	fake.vacbots[0].emit('disconnect');
	assert.strictEqual(device._reconnectTimer.delay, 60 * 1000);
});

test('long outage after a stable session keeps backing off', async () => {
	const { device, fake } = loadDevice();
	await device._connectWithRetry();
	device._connectedAt = Date.now() - 11 * 60 * 1000;
	fake.connectError = new Error('Failure code 1');
	fake.vacbots[0].emit('disconnect');
	assert.strictEqual(device._reconnectTimer.delay, 60 * 1000);
	await device._reconnectTimer.fn();
	assert.strictEqual(device._reconnectTimer.delay, 120 * 1000);
});

test('a device deleted during login creates no session', async () => {
	const { device, fake } = loadDevice();
	let finishGetApi;
	const original = fake.getApi;
	fake.getApi = () => new Promise((resolve) => { finishGetApi = () => resolve(original()); });
	const connecting = device._connectWithRetry();
	await device.onDeleted();
	finishGetApi();
	await connecting;
	assert.strictEqual(fake.vacbots.length, 0);
	assert.strictEqual(device.vacbot == null, true);
});

test('a failure after deleting the device does not schedule a retry', async () => {
	const { device, fake } = loadDevice();
	let failGetApi;
	fake.getApi = () => new Promise((_, reject) => { failGetApi = () => reject(new Error('Failure code 1')); });
	const connecting = device._connectWithRetry();
	await device.onDeleted();
	failGetApi();
	await connecting;
	assert.strictEqual(device.timers.length, 0);
});

test('a newer connect wins over one that is still logging in', async () => {
	const { device, fake } = loadDevice();
	const original = fake.getApi;
	let finishFirst;
	fake.getApi = () => new Promise((resolve) => { finishFirst = () => resolve(original()); });
	const first = device._connectWithRetry();
	fake.getApi = original;
	await device._connectWithRetry();
	finishFirst();
	await first;
	assert.strictEqual(fake.vacbots.length, 1);
	assert.strictEqual(device.vacbot, fake.vacbots[0]);
});

// --- Commands and errors ---

async function connected() {
	const loaded = loadDevice();
	loaded.device.store.api = validToken();
	await loaded.device._connectWithRetry();
	return { ...loaded, vacbot: loaded.fake.vacbots[0] };
}

// Runs a command and fires the retry waits until it settles
async function runWithRetries(device, command, ...args) {
	let settled = false;
	const result = device._runCommand(command, ...args).then(
		(value) => { settled = true; return { value }; },
		(error) => { settled = true; return { error }; },
	);
	for (let i = 0; i < 20 && !settled; i++) {
		await new Promise((resolve) => setImmediate(resolve));
		const waits = device.timers.filter((t) => t.delay < 60 * 1000);
		device.timers = device.timers.filter((t) => t.delay >= 60 * 1000);
		waits.forEach((t) => t.fn());
	}
	return result;
}

const timeout500 = (device) => () => {
	device.onLastError({ code: '500', error: "Request Timeout (command 'clean')" });
	throw new Error('Failure code 500 (Request Timeout)');
};

test('a command that works on a retry raises no alarm', async () => {
	const { device, vacbot } = await connected();
	vacbot.results = [timeout500(device), 'ok'];
	const { value, error } = await runWithRetries(device, 'Clean');
	assert.strictEqual(error, undefined);
	assert.strictEqual(value, 'ok');
	assert.strictEqual(device.capabilities.alarm_error, undefined);
	assert.deepStrictEqual(device.flowTriggers, []);
});

test('a command that keeps failing raises one alarm and one flow trigger', async () => {
	const { device, vacbot } = await connected();
	vacbot.results = [timeout500(device), timeout500(device), timeout500(device)];
	const { error } = await runWithRetries(device, 'Clean');
	assert.match(error.message, /Failure code 500/);
	assert.strictEqual(vacbot.commands.filter((c) => c.command === 'Clean').length, 3);
	assert.strictEqual(device.capabilities.alarm_error, true);
	assert.strictEqual(device.capabilities.error_code, 500);
	assert.strictEqual(device.flowTriggers.length, 1);
});

test('a status read that keeps failing raises no alarm', async () => {
	const { device, vacbot } = await connected();
	const fail = () => { throw new Error('Failure code 500 (Request Timeout)'); };
	vacbot.results = [fail, fail, fail];
	const { error } = await runWithRetries(device, 'GetBatteryState');
	assert.ok(error);
	assert.strictEqual(device.capabilities.alarm_error, undefined);
});

test('an error that is not retried is not retried and is reported by the library event', async () => {
	const { device, vacbot } = await connected();
	vacbot.results = [() => {
		device.onLastError({ code: '3', error: 'auth' });
		throw new Error('Failure code 3 (auth)');
	}];
	const { error } = await runWithRetries(device, 'Clean');
	assert.ok(error);
	assert.strictEqual(vacbot.commands.filter((c) => c.command === 'Clean').length, 1);
	assert.strictEqual(device.flowTriggers.length, 1);
});

test('a robot error outside a command raises the alarm, error 0 clears it', async () => {
	const { device } = await connected();
	await device.onLastError({ code: '102', error: 'HostHang' });
	assert.strictEqual(device.capabilities.alarm_error, true);
	await device.onLastError({ code: '0', error: 'NoError' });
	assert.strictEqual(device.capabilities.alarm_error, false);
});

test('a timed out status read outside a command raises no alarm', async () => {
	const { device } = await connected();
	await device.onLastError({ code: '500', error: "Request Timeout (command 'getBattery')" });
	assert.strictEqual(device.capabilities.alarm_error, undefined);
});

// --- Rooms ---

const MAP_A = '1356878604';
const zone = (mapid, zoneid) => ({ id: { id: mapid + '-' + zoneid, mapid, zoneid } });

function withRooms(device) {
	device.store.maps = [
		{ mapid: MAP_A, name: 'Nedervåningen', mapIsCurrentMap: true },
		{ mapid: '577384709', name: 'Uterummet', mapIsCurrentMap: false },
	];
	device.store.areas = [
		{ mapid: MAP_A, name: 'Hallen', zoneid: '2' },
		{ mapid: MAP_A, name: 'Köket', zoneid: '6' },
		{ mapid: MAP_A, name: '', zoneid: '5' },
		{ mapid: '577384709', name: '', zoneid: '1' },
	];
}

test('one room on the T90 is sent as freeClean', async () => {
	const { device, vacbot } = await connected();
	withRooms(device);
	await device.flowActionCleanZone(zone(MAP_A, '2'));
	assert.strictEqual(vacbot.commands.at(-1).command, 'FreeClean');
	assert.strictEqual(vacbot.commands.at(-1).args[0], '1,2');
});

test('several rooms on the T90 are sent as freeClean', async () => {
	const { device, vacbot } = await connected();
	withRooms(device);
	await device.flowActionCleanZones({ zone01: zone(MAP_A, '2'), zone03: zone(MAP_A, '6') });
	assert.strictEqual(vacbot.commands.at(-1).args[0], '1,2;1,6');
});

test('other models keep SpotArea', async () => {
	const { device, vacbot } = await connected();
	withRooms(device);
	vacbot.deviceClass = 'other';
	await device.flowActionCleanZones({ zone01: zone(MAP_A, '2'), zone02: zone(MAP_A, '6') });
	assert.strictEqual(vacbot.commands.at(-1).command, 'SpotArea');
	assert.strictEqual(vacbot.commands.at(-1).args[0], '2,6');
});

test('a room on another map fails instead of cleaning the same id on the active map', async () => {
	const { device, vacbot } = await connected();
	withRooms(device);
	const before = vacbot.commands.length;
	await assert.rejects(device.flowActionCleanZone(zone('577384709', '1')), /another map/);
	assert.strictEqual(vacbot.commands.length, before);
});

test('a room that no longer exists fails', async () => {
	const { device, vacbot } = await connected();
	withRooms(device);
	const before = vacbot.commands.length;
	await assert.rejects(device.flowActionCleanZone(zone(MAP_A, '0')), /no longer exists/);
	assert.strictEqual(vacbot.commands.length, before);
});

test('a room can still be cleaned while the rooms are not loaded', async () => {
	const { device, vacbot } = await connected();
	await device.flowActionCleanZone(zone(MAP_A, '2'));
	assert.strictEqual(vacbot.commands.at(-1).args[0], '1,2');
});

test('only room sets are stored, carpets and dock data are ignored', async () => {
	const { device } = await connected();
	withRooms(device);
	const rooms = device.store.areas;
	device.onMapSet({ mid: MAP_A, subsets: [{ mssid: '0', name: '1', type: 'ct' }] });
	device.onMapSet({ mid: MAP_A, subsets: [{ mssid: '0', name: '1', type: 'ds' }] });
	device.onMapSet({ mid: MAP_A, subsets: [] });
	assert.deepStrictEqual(device.store.areas, rooms);
	device.onMapSet({ mid: MAP_A, subsets: [{ mssid: '9', name: 'New', type: 'ar', spotPosition: '1,1' }] });
	assert.deepStrictEqual(device.store.areas.filter((a) => a.mapid === MAP_A).map((a) => a.zoneid), ['9']);
	assert.strictEqual(device.store.areas.filter((a) => a.mapid !== MAP_A).length, 1);
});

test('reconnecting keeps the known rooms', async () => {
	const { device, fake } = await connected();
	withRooms(device);
	fake.vacbots[0].emit('disconnect');
	await device._reconnectTimer.fn();
	assert.strictEqual(device.store.areas.length, 4);
});

test('pickers work before any map is known', async () => {
	const { device } = await connected();
	assert.deepStrictEqual(device.getAutocompleteZoneList(true), []);
	assert.deepStrictEqual(device.getAutocompleteMapList(), []);
	assert.strictEqual(device.isMapActive({ id: MAP_A }), false);
});

test('the room picker shows names, a fallback for unnamed rooms, and only the active map', async () => {
	const { device } = await connected();
	withRooms(device);
	const names = device.getAutocompleteZoneList(true).map((z) => z.name);
	assert.deepStrictEqual(names, ['Nedervåningen - Hallen', 'Nedervåningen - Köket', 'Nedervåningen - Room 5']);
});

test('opening the room picker reads the rooms again, at most once a minute', async () => {
	const { device, vacbot } = await connected();
	withRooms(device);
	const reads = () => vacbot.commands.filter((c) => c.command === 'GetMaps').length;
	device.getAutocompleteZoneList(true);
	device.getAutocompleteZoneList(true);
	assert.strictEqual(reads(), 1);
});

// --- Status ---

test('startup reads wake the robot first and send each read once', async () => {
	const { device, vacbot } = await connected();
	await device._refreshStates(true);
	const names = vacbot.commands.map((c) => c.command);
	assert.strictEqual(names[0], 'GetBatteryState');
	assert.strictEqual(names.filter((n) => n === 'GetBatteryState').length, 1);
	assert.strictEqual(names.filter((n) => n === 'GetWaterInfo').length, 1);
	assert.ok(!names.includes('GetWaterLevel') && !names.includes('GetWaterBoxInfo'));
	assert.ok(names.includes('GetMaps'));
});

test('a sleeping robot gets no burst of status reads', async () => {
	const { device, vacbot } = await connected();
	const fail = () => { throw new Error('Failure code 400'); };
	vacbot.results = [fail];
	await device._refreshStates(true);
	assert.deepStrictEqual(vacbot.commands.map((c) => c.command), ['GetBatteryState']);
});

test('reconnect reads maps only when none are known', async () => {
	const { device, vacbot } = await connected();
	await device._refreshStates(false);
	assert.ok(vacbot.commands.some((c) => c.command === 'GetMaps'));
	vacbot.commands = [];
	withRooms(device);
	await device._refreshStates(false);
	assert.ok(!vacbot.commands.some((c) => c.command === 'GetMaps'));
});

test('water level is stored as text for number and text input', async () => {
	const { device } = await connected();
	device.onWaterLevel(2);
	assert.strictEqual(device.capabilities.water_flow_level, '2');
	assert.strictEqual(device.capabilities['water_flow_level.display'], '2');
	assert.strictEqual(device.capabilities.water_flow_value, 30);
	device.onWaterLevel('3');
	assert.strictEqual(device.capabilities.water_flow_level, '3');
});

test('cleaning complete only fires after real work', async () => {
	const { device } = await connected();
	let complete = 0;
	device.onCleaningComplete = () => { complete++; };
	device.onWorkState({ robot: 'idle', station: 'idle', paused: false });
	assert.strictEqual(complete, 0, 'unknown to idle is no finished run');
	await device.setCapabilityValue('state_device', 'cleaning');
	device.onWorkState({ robot: 'idle', station: 'idle', paused: false });
	assert.strictEqual(complete, 1);
});
