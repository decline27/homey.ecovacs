'use strict';

const ecovacsApi = require('../../lib/ecovacsApi');
const CONSTANTS = require('../../lib/constants.js');
const { Device } = require('homey');

const https = require('https');
const crypto = require('crypto');

// const tools = require('../../lib/tools');
// const { PassThrough } = require('stream');
// const crypto = require("crypto");
// const SYNC_INTERVAL = 1000 * 30;  // 5 seconds

class VacuumDevice extends Device {

	async onInit() {

		this.log('Device ' + this.getName() + ' has been initialized');

		await this._updateCapabilities();
		await this.setAvailable();	

		this.registerCapabilityListener('clean', this.onCapabilityClean.bind(this));
		this.registerCapabilityListener('pause', this.onCapabilityPause.bind(this));
		this.registerCapabilityListener('stop', this.onCapabilityStop.bind(this));
		this.registerCapabilityListener('charge', this.onCapabilityCharge.bind(this));
		this.registerCapabilityListener('wash_mop', this.onCapabilityWashMop.bind(this));
		this.registerCapabilityListener('dry_mop', this.onCapabilityDryMop.bind(this));
		this.registerCapabilityListener('empty_dustbin', this.onCapabilityEmptyDustbin.bind(this));
		this.registerCapabilityListener('park', this.onCapabilityPark.bind(this));
		this.registerCapabilityListener('park_position', this.onCapabilityParkPosition.bind(this));
		this.registerCapabilityListener('suction_power', this.onCapabilitySuctionPower.bind(this));
		this.registerCapabilityListener('water_flow_level', this.onCapabilityWaterFlowLevel.bind(this));
		this.registerCapabilityListener('water_flow_value', this.onCapabilityWaterFlowValue.bind(this));
		this.registerCapabilityListener('work_mode', this.onCapabilityWorkMode.bind(this));
		this.registerCapabilityListener('sweep_mode', this.onCapabilitySweepMode.bind(this));
		this.registerCapabilityListener('clean_count_mode', this.onCapabilityCleanCountMode.bind(this));

		// Init API and connect
		await this._connectWithRetry();
	}

	// Connect, and on failure (no internet after a power cut, Ecovacs cloud down, ...) retry with backoff
	// instead of leaving the device unavailable until the app is restarted.
	async _connectWithRetry() {
		if (this._reconnectTimer){
			this.homey.clearTimeout(this._reconnectTimer);
			this._reconnectTimer = null;
		}
		if (this._stopped){
			return;
		}
		try{
			await this.initApi();
			this._reconnectDelay = 0;
			await this.setAvailable().catch(this.error);
		}
		catch(error){
			this.error('Error: error.message ', error);
			await this.setUnavailable(error.message).catch(this.error);
			// 2FA verification needs the user to repair the device, retrying won't help
			if (!error.verificationRequired){
				this._scheduleReconnect();
			}
		}
	}

	_scheduleReconnect() {
		if (this._reconnectTimer){
			this.homey.clearTimeout(this._reconnectTimer);
		}
		const MAX_RECONNECT_DELAY = 30 * 60 * 1000; // 30min
		this._reconnectDelay = Math.min((this._reconnectDelay || 30 * 1000) * 2, MAX_RECONNECT_DELAY);
		this.log('Reconnecting in ' + Math.round(this._reconnectDelay / 1000) + 's');
		this._reconnectTimer = this.homey.setTimeout(() => this._connectWithRetry(), this._reconnectDelay);
	}

	// Read the current device data from the account. The stored data from pairing can be outdated (e.g. a new
	// 'resource' after a firmware update), then commands time out and the MQTT subscription gets no status updates.
	async _getVacuum() {
		const stored = this.getStoreValue('vacuum');
		const devices = await this.api.devices();
		const vacuum = devices.find((device) => device.did === stored.did);
		if (!vacuum){
			this.log('Device ' + stored.did + ' not found in account device list, using stored device data');
			return stored;
		}
		if (vacuum.resource !== stored.resource || vacuum.class !== stored.class){
			this.log('Device data changed (resource ' + stored.resource + ' => ' + vacuum.resource + '), updating store');
		}
		await this.setStoreValue('vacuum', vacuum).catch(this.error);
		return vacuum;
	}

	_scheduleTokenRefresh() {
		let tokenExpiresAt = this.api.getTokenExpiry();
		this.log('tokenExpiresAt: ' + tokenExpiresAt);

		const MAX_DELAY = 23 * 60 * 60 * 1000; // 23h
		const delay = Math.max(Math.min(tokenExpiresAt - Date.now(), MAX_DELAY), 0);

		if (this._refreshTimer){
			this.homey.clearTimeout(this._refreshTimer);
		}
		this._refreshTimer = this.homey.setTimeout(async () => {
			this.log('Token refresh timer expired, Refreshing token...');
			try{
				await this.api.connect( this.getStoreValue('email'), ecovacsApi.getPasswordHash(this.getStoreValue('password')) );
			}
			catch(error){
				// A failed refresh doesn't fire credentialsUpdated, so no new timer would be set. Start over.
				this.error('Token refresh failed: ', error);
				this._scheduleReconnect();
			}
		}, delay);
	}

	// Close the current session completely, so a stale MQTT client does not keep reconnecting with an old token
	_teardownApi() {
		if (this._refreshTimer){
			this.homey.clearTimeout(this._refreshTimer);
			this._refreshTimer = null;
		}
		if (this.api){
			this.api.removeAllListeners('credentialsUpdated');
		}
		const vacbot = this.vacbot;
		this.vacbot = null;
		if (vacbot){
			const client = vacbot.getMqttClient();
			vacbot.disconnect().catch(this.error);
			if (client){
				try{ client.end(true); } catch(error){}
			}
		}
	}

	// =======================================================================================================================================================================================
	// DEVICE
	// =======================================================================================================================================================================================	
	async _updateCapabilities(){
		let capabilities = [];
		try{
		capabilities = this.homey.app.manifest.drivers.filter((e) => {return (e.id == this.driver.id);})[0].capabilities;
		// remove capabilities
		let deviceCapabilities = this.getCapabilities();
		for (let i=0; i<deviceCapabilities.length; i++){
			let filter = capabilities.filter((e) => {return (e == deviceCapabilities[i]);});
			if (filter.length == 0 ){
			try{
				await this.removeCapability(deviceCapabilities[i]);
			}
			catch(error){}
			}
		}
		// add missing capabilities
		for (let i=0; i<capabilities.length; i++){
			if (!this.hasCapability(capabilities[i])){
			try{
				await this.addCapability(capabilities[i]);
			}
			catch(error){}
			}
		}
		}
		catch (error){
		this.error(error.message);
		}
	}

  	async ready() {
		this.log('Device ' + this.getName() + ' :ready');
	}

	async onSettings({ oldSettings, newSettings, changedKeys }) {
		this.log('Device ' + this.getName() + ' settings changed', oldSettings, newSettings, changedKeys);
	}

	async onRenamed(name) {
		this.log('Device was renamed to' + this.getName());
	}

	async onDeleted() {
		this.log('Device ' + this.getName() + 'has been deleted');
		this._stopped = true;
		if (this._reconnectTimer){
			this.homey.clearTimeout(this._reconnectTimer);
		}
		this._teardownApi();
	}

	async onUninit() {
		this._stopped = true;
		if (this._reconnectTimer){
			this.homey.clearTimeout(this._reconnectTimer);
		}
		this._teardownApi();
	}

	// =======================================================================================================================================================================================
	// API
	// =======================================================================================================================================================================================	

	async initApi() {
		this.log('Vacuum has been added');

		// let data = this.getData();
		this.log('Device ID: ' + this.getStoreValue('deviceId') + ' email: ' + this.getStoreValue('email'));

		// Drop a previous session (reconnect after an error)
		this._teardownApi();

		let vacuum = null;
		try{
			this.api = await ecovacsApi.getApi(this.getStoreValue('deviceId'), this.getStoreValue('country'));
			await this.setStoreValue('country', this.api.country).catch(this.error);

			// Variant using the auth token to login
			// store auth token if changed
			this.api.on('credentialsUpdated', (data) => {
				this.log('credentialsUpdated');
				this.setStoreValue('api', {
					uid: this.api.uid,
					user_access_token: this.api.user_access_token,
					tokenExpiresAt: this.api.getTokenExpiry()
				}).catch(this.error);

				// Hand the new token to the vacbot. Commands are sent via REST with this token and MQTT uses it as password,
				// without this the vacbot keeps the old token and stops working when it expires (after ~7 days).
				if (this.vacbot){
					this.vacbot.updateUserAccessToken(data.token);
				}

				this._scheduleTokenRefresh();
			});
			// try to use auth token. A password login on every start/reconnect can make Ecovacs ask for 2FA device verification again.
			// The device list request checks the token and returns the current device data (resource) at the same time.
			const api = this.getStoreValue('api');
			const MIN_VALIDITY = 60 * 60 * 1000; // 1h
			if (api && api.uid && api.user_access_token && api.tokenExpiresAt > Date.now() + MIN_VALIDITY){
				this.api.uid = api.uid;
				this.api.user_access_token = api.user_access_token;
				this.api.tokenExpiresAt = api.tokenExpiresAt;
				try{
					vacuum = await this._getVacuum();
					this.log('Using stored token');
					this._scheduleTokenRefresh();
				}
				catch(error){
					this.log('Stored token not valid (' + error.message + ')');
				}
			}
			if (!vacuum){
				this.log('connect with user/password');
				await this.api.connect( this.getStoreValue('email'), ecovacsApi.getPasswordHash(this.getStoreValue('password')) );
				vacuum = await this._getVacuum();
			}

			// Variant using the user/password
			// await this.api.connect( this.getStoreValue('email'), ecovacsApi.getPasswordHash(this.getStoreValue('password')) );
			
			// Enable auto refrsh for both variante
			// this.api.enableAutoTokenRefresh(this.getStoreValue('email'),  ecovacsApi.getPasswordHash(this.getStoreValue('password')));
		}
		catch(error){
			if (error.name === 'DeviceVerificationRequired') {
				const verificationError = new Error('Device verification required. Repair device and log in again including 2FA verification code.');
				verificationError.verificationRequired = true;
				throw verificationError;
			}
			else{
				throw error;
			}
		}

		await this.setStoreValue('areas', []).catch((error) => { this.error('Error: ' + error); });
		await this.setStoreValue('mapnames', []).catch((error) => { this.error('Error: ' + error); });

		this.log('Deebot ApiVersion : ', this.api.getVersion());
		const vacbot = this.api.getVacBot(this.api.uid, ecovacsApi.getConstant('REALM'), this.api.resource, this.api.user_access_token, vacuum, this.getStoreValue('geo'));
		this.vacbot = vacbot;
		let eventsRegistered = false;

		// The library ends the session on an auth error (code 3). Log in again instead of staying disconnected.
		vacbot.on('disconnect', () => {
			if (vacbot !== this.vacbot){
				return;
			}
			this.log('vacbot disconnected, reconnecting...');
			// The token was rejected, don't reuse it
			this.setStoreValue('api', null).catch(this.error);
			this._scheduleReconnect();
		});

		// 'ready' fires again on every MQTT reconnect. Register the event handlers only once,
		// otherwise every reconnect adds another copy of each handler (duplicate flow triggers, memory leak).
		this.vacbot.on('ready', async (event) => {
			if (eventsRegistered){
				this.log('vacbot reconnected');
				this._refreshStates(false);
				return;
			}
			eventsRegistered = true;

			this.log('Model information');
			this.log('- Name: ' + this.vacbot.getName());
			this.log('- Model: ' + this.vacbot.deviceModel);
			this.log('- DeviceClass: ' + this.vacbot.deviceClass);
			this.log('- Image url: ' + this.vacbot.deviceImageURL);
			this.log('- Is fully supported model: ' + this.vacbot.isSupportedDevice());
			this.log('- Is a at least partly supported model: ' + this.vacbot.isKnownDevice());
			this.log('- Is legacy model: ' + this.vacbot.isLegacyModel());
			this.log('- Is 950 type model: ' + this.vacbot.is950type());
			this.log('- V2 commands are implemented: ' + this.vacbot.is950type_V2());
			this.log('- Communication protocol: ' + this.vacbot.getProtocol());
			this.log('- Main brush: ' + this.vacbot.hasMainBrush());
			this.log('- Mapping capabilities: ' + this.vacbot.hasMappingCapabilities());
			this.log('- Edge cleaning mode: ' + this.vacbot.hasEdgeCleaningMode());
			this.log('- Spot cleaning mode: ' + this.vacbot.hasSpotCleaningMode());
			this.log('- Spot area cleaning mode: ' + this.vacbot.hasSpotAreaCleaningMode());
			this.log('- Custom area cleaning mode: ' + this.vacbot.hasCustomAreaCleaningMode());
			this.log('- Mopping system: ' + this.vacbot.hasMoppingSystem());
			this.log('- Voice reports: ' + this.vacbot.hasVoiceReports());
			this.log('- Auto empty station: ' + this.vacbot.hasAutoEmptyStation());
			this.log('- Canvas module available: ' + this.api.getCanvasModuleIsAvailable());
			this.log('- Using country: ' + this.api.getCountryName());
			this.log('- Using continent code: ' + this.api.getContinent());
			this.log('ApiVersion : ' + this.api.getVersion());
			this.log('Device is ready');

			this.vacbot.on('WorkMode', (workMode) =>  this.onWorkMode(workMode));
			this.vacbot.on('SweepMode', (mode) => this.onSweepMode(mode));
			this.vacbot.on('WorkState', (workState) => this.onWorkState(workState));
			this.vacbot.on('CleanCount', (cleanCount) => this.onCleanCount(cleanCount));
			// this.vacbot.on('BatteryLevel', (batteryLevel) => {
			// 	if (appdebug) { this.log('vacbot.on(BatteryLevel, ' + JSON.stringify(batteryLevel) + ')'); }
			// });
			this.vacbot.on('BatteryInfo', (battery) => this.onBatteryInfo(battery));
			this.vacbot.on('ChargeState', (state) => this.onChargeState(state));
			this.vacbot.on('DeebotPosition', (values) => this.onDebotPosition(position));
			this.vacbot.on('CleanSpeed', (level) => this.onCleanSpeed(level));
			this.vacbot.on('WaterLevel', (level) => this.onWaterLevel(level));
			this.vacbot.on('WaterInfo', (level) => this.onWaterInfo(level));

			this.vacbot.on('Maps', async (maps) => await this.onMaps(maps));
			this.vacbot.on('MapSpotAreas', async (areas) => await this.onMapSpotAreas(areas));
			this.vacbot.on('MapSpotAreaInfo', async (area) => await this.onMapSpotAreaInfo(area));
			this.vacbot.on('MapSet_V2', async (mapset) => await this.onMapSet(mapset));
			this.vacbot.on('Error', async (error) => await this.onError(error));
			this.vacbot.on('ErrorCode', async (error) => await this.onErrorCode(error));
			this.vacbot.on('LastError', async (error) => await this.onLastError(error));

			this.vacbot.on('WaterBoxScrubbingType', async (mode) => { this.log('WaterBoxScrubbingType: ' + mode); });
			this.vacbot.on('MoppingSystemInfo ', async (state) => this.log('MoppingSystemInfo: ' + state));

			if (!this.vacbot.is950type_V2()) {
				this.vacbot.on('CleanReport', (cleanReport) => this.onCleanReport(cleanReport));
			}
			// this.vacbot.on('CleanLog', (cleanLog) => this.onCleanLog(cleanLog));
			// this.vacbot.on('LastCleanLogs', (lastCleanLogs) => this.onLastCleanLogs(lastCleanLogs));
			this.vacbot.on('CurrentStats', (currentStats) => this.onCurrentStats(currentStats));
			// this.vacbot.on('onWorkProgressReport ', async (state) => this.log('onWorkProgressReport: ' + state)); // currently not supported, example: { clean: 24, dry: 0, wash: 0 }
			this.vacbot.on('TaskStarted', async (data) =>  { 
				this.log('TaskStarted: ' + data); });

			

			this.vacbot.on('MapImage ', async (mapImage) => 
				this.onMapImage(mapImage));
			this.vacbot.on('MapImageData', async (mapImage) =>  { 
				this.log('MapImageData: ' + JSON.stringify(mapImage)); });
			this.vacbot.on('MapDataReady', async (mapImage) =>  { 
				this.log('MapDataReady: ' + mapImage); });
			this.vacbot.on('MapDataObject', async (mapImage) =>  { 
				this.log('MapDataObject: ' + mapImage); });
			this.vacbot.on('MapInfo', async (mapInfo) =>  { 
				this.log('MapInfo: ' + mapInfo); });
			this.vacbot.on('MinorMap', async (mapInfo) =>  { 
				this.log('MinorMap: ' + mapInfo); });

			this._refreshStates(true);
			
			// if (appdebug) { this.log('vacbot.run(GetCleanReport)'); } this.vacbot.run('GetCleanReport');

			// this.vacbot.run("GetMapImage", 1132941211, "outline");

			// this.vacbot.on('CleanLog', async (object) => {
			// 	if (appdebug) { this.log('vacbot.on(CleanLog, ' + object + ')'); }
			// 	if (object.length === 0) { return; }
			// 	var stopReason = -1;
			// 	try {
			// 		switch ((object[0].stopReason - 1).toString()) {
			// 			case '0': stopReason = 'CLEAN_SUCCESSFUL'; break;
			// 			case '1': stopReason = 'STOPPED_BY_APP'; break;
			// 			case '2': stopReason = 'BATTERY_LOW'; break;
			// 			case '3': stopReason = 'STOPPED_BY_IR'; break;
			// 			case '4': stopReason = 'STOPPED_BY_BUTTON'; break;
			// 			case '5': stopReason = 'STOPPED_BY_WARNING'; break;
			// 			case '6': stopReason = 'STOPPED_BY_NO_DISTURB'; break;
			// 			case '7': stopReason = 'STOPPED_BY_CLEARMAP'; break;
			// 			case '8': stopReason = 'STOPPED_BY_NO_PATH'; break;
			// 			case '9': stopReason = 'STOPPED_BY_NOT_IN_MAP'; break;
			// 			case '10': stopReason = 'STOPPED_BY_VIRTUAL_WALL'; break;
			// 			case '11': stopReason = 'WIRE_CHARGING'; break;
			// 			case '12': stopReason = 'STOPPED_BY_AIR_SPOT'; break;
			// 			case '13': stopReason = 'STOPPED_BY_AIR_AUTO'; break;
			// 			default: stopReason = 'UNKNOWN (' + object[0].stopReason + ')';
			// 		}
			// 	}



		});

		this.vacbot.connect();
	}

	// Read all states from the vacbot (after connect and reconnect). Maps only after connect, they cause a lot of requests (map set + map info per map).
	_refreshStates(withMaps) {
		if (!this.vacbot){
			return;
		}
		if (appdebug) { this.log('vacbot.run(GetWaterBoxInfo)'); } this.vacbot.run('GetWaterBoxInfo');
		if (appdebug) { this.log('vacbot.run(GetCleanCount)'); } this.vacbot.run('GetCleanCount');
		if (appdebug) { this.log('vacbot.run(GetCleanSpeed)'); } this.vacbot.run('GetCleanSpeed');
		if (appdebug) { this.log('vacbot.run(GetWaterLevel)'); } this.vacbot.run('GetWaterLevel');
		if (appdebug) { this.log('vacbot.run(GetWaterInfo)'); } this.vacbot.run('GetWaterInfo');
		if (appdebug) { this.log('vacbot.run(GetAutoEmpty)'); } this.vacbot.run('GetAutoEmpty');
		if (appdebug) { this.log('vacbot.run(GetBatteryState)'); } this.vacbot.run('GetBatteryState');
		if (appdebug) { this.log('vacbot.run(GetCleanState)'); } this.vacbot.run('GetCleanState');
		if (appdebug) { this.log('vacbot.run(GetPosition)'); } this.vacbot.run('GetPosition');
		if (appdebug) { this.log('vacbot.run(GetStats)'); } this.vacbot.run('GetStats');
		if (appdebug) { this.log('vacbot.run(GetWorkState)'); } this.vacbot.run('GetWorkState');
		if (appdebug) { this.log('vacbot.run(GetChargeState)'); } this.vacbot.run('GetChargeState');
		if (appdebug) { this.log('vacbot.run(GetWorkMode)'); } this.vacbot.run('GetWorkMode');
		if (appdebug) { this.log('vacbot.run(GetSweepMode)'); } this.vacbot.run('GetSweepMode');
		if (appdebug) { this.log('vacbot.run(GetError)'); } this.vacbot.run('GetError');
		if (withMaps) {
			if (appdebug) { this.log('vacbot.run(GetMaps)'); } this._getMaps();
		}
	}

	// =======================================================================================================================================================================================
	// EVENTS
	// =======================================================================================================================================================================================	

	onWorkMode(workMode){
		if (appdebug) { this.log('vacbot.on(WorkMode, ' + JSON.stringify(workMode) + ')'); }
		// 'vacuumAndMop': 0,  // Vacuum and mop
		// 'vacuum': 1,        // Vacuum only
		// 'mop': 2,           // Mop only
		// 'mopAfterVacuum': 3 // Mop after vacuum
		this.setCapabilityValue('work_mode', workMode.toString()).catch((error) => { this.log('Error: ' + error); });
		this.setCapabilityValue('work_mode.display', workMode.toString()).catch((error) => { this.log('Error: ' + error); });
	}

	onWorkState(workState){
		if (appdebug) { this.log('vacbot.on(WorkState, ' + JSON.stringify(workState) + ')'); }

		let lastRobotState = this.getCapabilityValue('state_device');

		switch (workState.robot) {
			case CONSTANTS.WORKMODE_ROBOT_CLEANING: 
				this.setCapabilityValue('clean', true).catch((error) => { this.log('Error: ' + error); }); 
				break;
			case CONSTANTS.WORKMODE_ROBOT_IDLE:
				this.setCapabilityValue('clean', false).catch((error) => { this.log('Error: ' + error); }); 
				break;

		}
		if (workState.paused != undefined) {
			this.setCapabilityValue('pause', workState.paused).catch((error) => { this.log('Error: ' + error); }); 
		}
		this.setCapabilityValue('state_device', workState.robot).catch((error) => { this.log('Error: ' + error); });
		this.setCapabilityValue('state_station', workState.station).catch((error) => { this.log('Error: ' + error); });

		// set buttons state
		if (workState.station == CONSTANTS.WORKMODE_STATION_GOWASHING || workState.station == CONSTANTS.WORKMODE_STATION_WASHING) {
			this.setCapabilityValue('wash_mop', true).catch((error) => { this.log('Error: ' + error); });
		}
		else{
			this.setCapabilityValue('wash_mop', false).catch((error) => { this.log('Error: ' + error); });
		}
		if (workState.station == CONSTANTS.WORKMODE_STATION_DRYING) {
			this.setCapabilityValue('dry_mop', true).catch((error) => { this.log('Error: ' + error); });
		}
		else{
			this.setCapabilityValue('dry_mop', false).catch((error) => { this.log('Error: ' + error); });
		}

		// cleaning finished?
		if (lastRobotState != CONSTANTS.WORKMODE_ROBOT_IDLE &&
			workState.robot == CONSTANTS.WORKMODE_ROBOT_IDLE ) {
			this.onCleaningComplete();
		}

	}

	// Not emitted for V2
	onCleanReport(cleanReport){
		if (appdebug) { this.log('vacbot.on(CleanReport, ' + JSON.stringify(cleanReport) + ')'); }

		let lastRobotState = this.getCapabilityValue('state_device');

		switch (cleanReport) {
			case 'parking':
				break;
			case 'pause':
				this.setCapabilityValue('pause', true).catch((error) => { this.log('Error: ' + error); }); 
				break;
			case 'idle':
				this.setCapabilityValue('state_device', CONSTANTS.WORKMODE_ROBOT_IDLE).catch((error) => { this.log('Error: ' + error); });
				break;
			case 'auto':
				this.setCapabilityValue('state_device', CONSTANTS.WORKMODE_ROBOT_CLEANING).catch((error) => { this.log('Error: ' + error); });
				this.setCapabilityValue('pause', false).catch((error) => { this.log('Error: ' + error); }); 
				this.setCapabilityValue('clean', true).catch((error) => { this.log('Error: ' + error); }); 
				break;
			case 'returning':
				break;
			case 'alert':
				break;
			default:
				this.setCapabilityValue('state_device', CONSTANTS.WORKMODE_ROBOT_IDLE).catch((error) => { this.log('Error: ' + error); });
				this.setCapabilityValue('pause', false).catch((error) => { this.log('Error: ' + error); }); 
				this.setCapabilityValue('clean', false).catch((error) => { this.log('Error: ' + error); }); 
		}

		// cleaning finished?
		if (lastRobotState != CONSTANTS.WORKMODE_ROBOT_IDLE &&
			cleanReport == CONSTANTS.WORKMODE_ROBOT_IDLE ) {
			this.onCleaningComplete();
		}

	}

	onCleanCount(cleanCount){
		if (appdebug) { this.log('vacbot.on(CleanCount, ' + JSON.stringify(cleanCount) + ')'); }
		this.setCapabilityValue('clean_count_mode', cleanCount.toString()).catch((error) => { this.error('Error: ' + error); });
		this.setCapabilityValue('clean_count_mode.display', cleanCount.toString()).catch((error) => { this.error('Error: ' + error); });
	}

	onDebotPosition(position){
		if (appdebug) { this.log('vacbot.on(DeebotPosition, ' + JSON.stringify(position) + ')'); }
		this.setStoreValue('currentPosition', position).catch((error) => { this.log('Error: ' + error); });
	}

	onBatteryInfo(battery){
		if (appdebug) { this.log('vacbot.on(BatteryInfo, ' + JSON.stringify(battery) + ')'); }
		this.setCapabilityValue('measure_battery', Math.round(battery)).catch((error) => { this.log('Error: ' + error); });
	}

	onChargeState(state){
		if (appdebug) { this.log('vacbot.on(ChargeState, ' + JSON.stringify(state) + ')'); }

		// let lastChargeState = this.getCapabilityValue('state_charge');

		this.setCapabilityValue('state_charge', state).catch((error) => { this.log('Error: ' + error); });

		// clean log request now done for robot state (WorkState)
		// // work done (charge state idle => charging)
		// if (lastChargeState == CONSTANTS.CHARGE_STATE_IDLE &&
		// 	state == CONSTANTS.CHARGE_STATE_CHARGING ) {
		// 	this.vacbot.run('GetCleanLogs');
		// }
	}

	onCleanSpeed(level){
		if (appdebug) { this.log('vacbot.on(CleanSpeed, ' + level.toString() + ')'); }
		this.setCapabilityValue('suction_power', level.toString()).catch((error) => { this.error('Error: ' + error); });
		this.setCapabilityValue('suction_power.display', level.toString()).catch((error) => { this.error('Error: ' + error); });
	}

	onWaterLevel(level){
		if (level == undefined) {
			return;
		}
		if (appdebug) { this.log('vacbot.on(WaterLevel, ' + level.toString() + ')'); }

		let levelValue;
		if (typeof level === 'string') {
			levelValue = parseInt(level);
		}
		if (typeof level === 'number') {
			levelValue = level.toString();
		}	
		this.setCapabilityValue('water_flow_level', levelValue).catch((error) => { this.error('Error: ' + error); });
		this.setCapabilityValue('water_flow_level.display', level).catch((error) => { this.error('Error: ' + error); });
		// map to int value
		switch (level) {
			case 1:
			case '1':
				this.setCapabilityValue('water_flow_value', 20).catch((error) => { this.error('Error: ' + error); });
				break;
			case 2:
			case '2':
				this.setCapabilityValue('water_flow_value', 30).catch((error) => { this.error('Error: ' + error); });
				break;
			case 3:
			case '3':
				this.setCapabilityValue('water_flow_value', 40).catch((error) => { this.error('Error: ' + error); });
				break;
			case 4:
			case '4':
				this.setCapabilityValue('water_flow_value', 50).catch((error) => { this.error('Error: ' + error); });
				break;
		}
	}

	onWaterInfo(level){
		if (appdebug) { this.log('vacbot.on(WaterInfo, ' + JSON.stringify(level) +  ')'); }
		if (level == undefined) {
			return;
		}

		if (level.customAmount == undefined) {
			return;
		}
		this.setCapabilityValue('water_flow_value', level.customAmount).catch((error) => { this.error('Error: ' + error); });
		// map to enum value
		if (level.customAmount <= 20) {
			this.setCapabilityValue('water_flow_level', '1' ).catch((error) => { this.error('Error: ' + error); });
			this.setCapabilityValue('water_flow_level.display', '1' ).catch((error) => { this.error('Error: ' + error); });
		}
		else if (level.customAmount <= 30) {
			this.setCapabilityValue('water_flow_level', '2' ).catch((error) => { this.error('Error: ' + error); });
			this.setCapabilityValue('water_flow_level.display', '2' ).catch((error) => { this.error('Error: ' + error); });
		}
		else if (level.customAmount <= 40) {
			this.setCapabilityValue('water_flow_level', '3' ).catch((error) => { this.error('Error: ' + error); });
			this.setCapabilityValue('water_flow_level.display', '3' ).catch((error) => { this.error('Error: ' + error); });
		}
		else {
			this.setCapabilityValue('water_flow_level', '4' ).catch((error) => { this.error('Error: ' + error); });
			this.setCapabilityValue('water_flow_level.display', '4' ).catch((error) => { this.error('Error: ' + error); });
		}
	}

	onSweepMode(mode){
		if (appdebug) { this.log('vacbot.on(SweepMode, ' + JSON.stringify(mode) + ')'); }
		this.setCapabilityValue('sweep_mode', mode.toString()).catch((error) => { this.error('Error: ' + error); });
		this.setCapabilityValue('sweep_mode.display', mode.toString()).catch((error) => { this.error('Error: ' + error); });
		// 0=Standard, 1=Tief, 2=Effizient
	}

	onCleanLog(cleanLog){
		// if (appdebug) { this.log('vacbot.on(CleanLog, ' + JSON.stringify(cleanLog) + ')'); }
		if (appdebug) { this.log('vacbot.on(CleanLog Newest CleanLog: ' + JSON.stringify(cleanLog[0]) + ')'); }
		if (cleanLog == undefined || cleanLog[0] == undefined) {
			return;
		}

		let tz  = this.homey.clock.getTimezone();
		let cleanTimestamp = cleanLog[0].timestamp == undefined? new Date() : new Date(cleanLog[0].timestamp*1000);
		let time = cleanTimestamp.toLocaleString(this.homey.i18n.getLanguage(), 
            { 
                hour12: false, 
                timeZone: tz,
                hour: "2-digit",
                minute: "2-digit",
                day: "2-digit",
                month: "2-digit",
                year: "numeric"
            });
        let timestamp = time.replace(',', '');

		const cleanLogTrigger = this.homey.flow.getDeviceTriggerCard('clean_log');
      	cleanLogTrigger.trigger(this, {
			timestamp: timestamp,
			square_meters: cleanLog[0].squareMeters,
			totel_time: cleanLog[0].totalTimeFormatted
		}, null).catch((error) => { this.log('Error: ' + error)});
	}

	async onLastCleanLogs(lastCleanLogs){
		if (appdebug) { this.log('vacbot.on(LastCleanLogs, ' + JSON.stringify(lastCleanLogs) + ')'); }
	}
	
	onCurrentStats(currentStats){
		if (appdebug) { this.log('vacbot.on(CurrentStats, ' + JSON.stringify(currentStats) + ')'); }
	}

	onMaps(maps){
		if (appdebug) { this.log('vacbot.on(Maps, ' + JSON.stringify(maps) + ')'); }

		let mapnames = [];
		for (const map of maps['maps']) {
			const mapID = map['mapID'];
			const mapIndex = map['mapIndex'];
			mapnames.push(
				{
					'mapid': mapID,
					'mapIndex': map['mapIndex'],
					'name': map['mapName'],
					'mapStatus': map['mapStatus'],
					'mapIsCurrentMap': map['mapIsCurrentMap']
				}
			);
			if (map['mapIsCurrentMap']) {
				this.setStoreValue('currentMap', { 'mapID': mapID, 'MapIndex': mapIndex }).catch((error) => { this.error('Error: ' + error); });
			}

			this.setStoreValue('maps', mapnames).catch((error) => { this.error('Error: ' + error); });
			if (appdebug) { this.log('Maps: ', JSON.stringify(mapnames)); }

			this.log('-Updating Floor ' + map['mapName']);

			// // Only V1
			// this.vacbot.run('GetSpotAreas', mapID);
			// V2 alternative (GetMapSet => GetMapSet_V2)
			this.vacbot.run('GetMapSet', mapID, 'ar')

		}

	}

	// Only V1
	onMapSpotAreas(areas){
		try{
			if (appdebug) { this.log('vacbot.on(MapSpotAreas, ' + JSON.stringify(areas) + ')'); }

			for (const spotArea of areas?.mapSpotAreas ?? []) {
				const spotAreaID = spotArea['mapSpotAreaID'];
				this.vacbot.run('GetSpotAreaInfo', areas['mapID'], spotAreaID);
			}			
		}
		catch (error) {
			this.log('Error: ' + error.message);
			throw new Error(error.message + ' (onMapSpotAreas): ' + JSON.stringify(areas));
		}
	}

	// Only V1
	onMapSpotAreaInfo(area){
		try {
			if (appdebug) { this.log('vacbot.on(MapSpotAreaInfo, ' + JSON.stringify(area) + ')'); }

			if (!area) {
				return;
			}
			let tableAreas = this.getStoreValue('areas') ?? [];
			tableAreas = tableAreas.filter(
				item =>
					item.mapid !== area.mapID ||
					item.zoneid !== area.mapSpotAreaID
			);

			tableAreas.push({
				mapid: area.mapID,
				name: area.mapSpotAreaName,
				zoneid: area.mapSpotAreaID,
				// toto: area.mapSpotAreaBoundaries,
				// boundaries: this.convertBoundaries(area.mapSpotAreaBoundaries),
			});

			this.setStoreValue('areas', tableAreas).catch((error) => { this.error('Error: ' + error); });
			// await this.createToken(area.mapID, area.mapSpotAreaID, area.mapSpotAreaName).then(() => { this.log('--Updated Zone ' + area.mapSpotAreaName); });
			
			if (appdebug) { this.log(JSON.stringify(tableAreas)); }
		}
		catch (error) {
			this.log('Error: ' + error.message);
			throw new Error(error.message + ' (onMapSpotAreaInfo): ' + JSON.stringify(mapSpotAreaInfo));
		}
	}

	onMapSet(mapset){
		if (appdebug) { this.log('vacbot.on(MapSet_V2, ' + JSON.stringify(mapset) + ')'); }

		if (mapset == undefined || mapset['subsets'] == undefined) {
			return;
		}

		let areas = this.getStoreValue('areas');
		areas = areas.filter(item => item.mapid !== mapset.mid);

		for (const subset of mapset['subsets']) {
			areas.push(
				{
					mapid: mapset.mid,
					name: subset.name,
					zoneid: subset.mssid,
					id: mapset.mid + subset.mssid,
					spotPosition: subset.spotPosition // Format "-3425,975"
					// toto: area.mapSpotAreaBoundaries,
					// boundaries: this.convertBoundaries(area.mapSpotAreaBoundaries),
				}
			);
			this.setStoreValue('areas', areas).catch((error) => { this.error('Error: ' + error); });
		}
		if (appdebug) { this.log(JSON.stringify(areas)); }
		// var areasPrint = areas;
		// areasPrint.forEach(area => delete area.toto);
		// areasPrint.forEach(area => delete area.boundaries);
		// if (appdebug) { this.log(JSON.stringify(areasPrint)); }

		this.vacbot.run('GetMapInfo', mapset.mid);
	}

	onMapImage(mapImage){
		if (appdebug) { this.log('vacbot.on(MapImage, ' + JSON.stringify(mapImage) + ')'); }

	}

	async onErrorCode(error) {
		if (appdebug) { this.log('vacbot.on(ErrorCode, ' + JSON.stringify(error) + ')'); }
		if (parseInt(error) !== 0 && parseInt(error) !== 100) {
			var errorMsg = JSON.stringify(this.homey.__("Deebot.Error" + error));
			// this.homey.flow.getDeviceTriggerCard('error').trigger(this, { error: errorMsg, errorcode: parseInt(error) });

			// await errorReportTrigger.trigger(this, { error: error, errorcode: parseInt(errorcode) });
		}		
	}

	async onError(error) {
		if (appdebug) { this.log('vacbot.on(Error, ' + JSON.stringify(error) + ')'); }

	}

	async onLastError(error) {
		if (appdebug) { this.log('vacbot.on(LastError, ' + JSON.stringify(error) + ')'); }
		if (error == undefined || error.code == undefined) return;

		let code = Number(error.code);
		if (code > 0 && code != 100){
			// Error codes for real error, 1-99: Auth or request error, >100: Device error
			if (this.hasCapability('error_message')) {
				this.setCapabilityValue('error_message', error.error).catch((error) => { this.error('Error: ' + error); });
			}
			if (this.hasCapability('error_code')) {
				this.setCapabilityValue('error_code', code).catch((error) => { this.error('Error: ' + error); });
			}
			if (this.hasCapability('alarm_error')) {
				this.setCapabilityValue('alarm_error', true).catch((error) => { this.error('Error: ' + error); });
			}
			const flowTriggerError = this.homey.flow.getDeviceTriggerCard('error');
			flowTriggerError.trigger(this, {
				error_id: code,
				error_message: error.error,
			}, null).catch((error) => { this.log('Error: ' + error)});		
		}
		else if (code === 0 || code === 100) {
			// No error: 0 and 100 = "NoError: Robot is operational"
			if (this.hasCapability('alarm_error')) {
				this.setCapabilityValue('alarm_error', false).catch((error) => { this.error('Error: ' + error); });
			}
			if (this.hasCapability('error_message')) {
				this.setCapabilityValue('error_message', null).catch((error) => { this.error('Error: ' + error); });
			}
			if (this.hasCapability('error_code')) {
				this.setCapabilityValue('error_code', 0).catch((error) => { this.error('Error: ' + error); });
			}
		}
		else{
			// other internal errors: <0 
		}
	}


	// =======================================================================================================================================================================================
	// INTERNAL EVENTS/FUNCTIONS
	// =======================================================================================================================================================================================	
	onCleaningComplete() {
		let tz  = this.homey.clock.getTimezone();
		let cleanTimestamp = new Date();
		let time = cleanTimestamp.toLocaleString(this.homey.i18n.getLanguage(), 
            { 
                hour12: false, 
                timeZone: tz,
                hour: "2-digit",
                minute: "2-digit",
                day: "2-digit",
                month: "2-digit",
                year: "numeric"
            });
        let timestamp = time.replace(',', '');

		const flowTriggerCleanLog = this.homey.flow.getDeviceTriggerCard('cleaning_complete');
      	flowTriggerCleanLog.trigger(this, {
			timestamp: timestamp,
			square_meters: 0,
			totel_time: 0
		}, null).catch((error) => { this.log('Error: ' + error)});		
	}

	// =======================================================================================================================================================================================
	// CAPABILITIES
	// =======================================================================================================================================================================================	

	async onCapabilityClean(value, opts) {
		if (appdebug) { this.log('onCapabilityClean(' + value + ')'); }
		if (value) {
			this.setCapabilityValue('pause', false).catch((error) => { this.log('Error: ' + error); });
			// this.setCapabilityValue('clean', true).catch((error) => { this.log('Error: ' + error); });
			await this._runCommand('Clean');
		}
		else{
			this.setCapabilityValue('pause', false).catch((error) => { this.log('Error: ' + error); });
			await this._runCommand('Stop');
		}
	}

	async onCapabilityPause(value, opts) {
		if (appdebug) { this.log('onCapabilityPause(' + value + ')'); }
		if (value) {
			this.setCapabilityValue('pause', true).catch((error) => { this.log('Error: ' + error); });
			await this._runCommand('Pause');
		} else {
			this.setCapabilityValue('pause', false).catch((error) => { this.log('Error: ' + error); });
			await this._runCommand('Resume');
		}
	}

	async onCapabilityStop(value, opts) {
		if (appdebug) { this.log('onCapabilityStop(' + value + ')'); }
		if (value) {
			this.setCapabilityValue('clean', false).catch((error) => { this.log('Error: ' + error); });
			this.setCapabilityValue('pause', false).catch((error) => { this.log('Error: ' + error); });
			await this._runCommand('Stop');
		}
	}

	async onCapabilityCharge(value, opts) {
		if (appdebug) { this.log('onCapabilityCharge(' + value + ')'); }
		if (value) {
			this.setCapabilityValue('clean', false).catch((error) => { this.log('Error: ' + error); });
			this.setCapabilityValue('pause', false).catch((error) => { this.log('Error: ' + error); });
			await this._runCommand('Charge');
		}
	}

	async onCapabilityWashMop(value, opts) {
		if (appdebug) { this.log('onCapabilityWashMop(' + value + ')'); }
		if (value) {
			await this._runCommand('WashingStart');
		}
		else{
			await this._runCommand('WashingStop');
		}
	}

	async onCapabilityDryMop(value, opts) {
		if (appdebug) { this.log('onCapabilityDryMop(' + value + ')'); }
		if (value) {
			await this._runCommand('AirDryingStart');
		}
		else{
			await this._runCommand('AirDryingStop');
		}
	}

	async onCapabilityEmptyDustbin(value, opts) {
		if (appdebug) { this.log('onCapabilityEmptyDustbin(' + value + ')'); }
		if (value) {
			await this._runCommand('EmptyDustbin');
		}
	}

	async onCapabilityPark(value, opts) {
		if (appdebug) { this.log('onCapabilityPark(' + value + ')'); }
		await this._park();
	}

	async onCapabilityParkPosition(value, opts) {
		if (appdebug) { this.log('onCapabilityParkPosition(' + value + ')'); }
		try {
			let position = await this.vacbot.runAsync('GetPosition');
			if (position != undefined) {
				await this.setStoreValue('parkPosition', position.deebotPos);				
			}
		}
		catch (error) {
			if (appdebug) { this.log('onCapabilityParkPosition error (' + error + ')'); }
			throw error;
		}
	}

	async onCapabilitySuctionPower(value, opts) {
		if (appdebug) { this.log('onCapabilitySuctionPower(' + value + ')'); }
		await this._runCommand('SetCleanSpeed', value);
	}

	async onCapabilityWaterFlowLevel(value, opts) {
		if (appdebug) { this.log('onCapabilityWaterFlow(' + value + ')'); }
		await this._runCommand('SetWaterLevel', value);		

		switch (value){
			case 1:
			case '1':
				await this._runCommand('SetWaterInfo', null, 20, null);
				break;
			case 2:
			case '2':
				await this._runCommand('SetWaterInfo', null, 30, null);
				break;
			case 3:
			case '3':
				await this._runCommand('SetWaterInfo', null, 40, null);
				break;
			case 4:
			case '4':
				await this._runCommand('SetWaterInfo', null, 50, null);
				break;
		}
	}

	async onCapabilityWaterFlowValue(value, opts) {
		if (appdebug) { this.log('onCapabilityWaterFlow(' + value + ')'); }
		await this._runCommand('SetWaterInfo', null, value, null);

		if (value <= 20) {
			await this._runCommand('SetWaterLevel', 1);					
		}
		else if (value <= 30) {
			await this._runCommand('SetWaterLevel', 2);					
		}
		else if (value <= 40) {
			await this._runCommand('SetWaterLevel', 3);					
		}
		else  {
			await this._runCommand('SetWaterLevel', 4);					
		}
	}

	async onCapabilityWorkMode(value, opts) {
		if (appdebug) { this.log('onCapabilityWorkMode(' + value + ')'); }
		await this._runCommand('SetWorkMode', Number(value));
	}

	async onCapabilitySweepMode(value, opts) {
		if (appdebug) { this.log('onCapabilitySweepMode(' + value + ')'); }
		await this._runCommand('SetSweepMode', Number(value));
	}

	async onCapabilityCleanCountMode(value, opts) {
		if (appdebug) { this.log('onCapabilityCleanCountMode(' + value + ')'); }
		await this._runCommand('SetCleanCount', Number(value));
	}

	// =======================================================================================================================================================================================
	// FLOW ACTIONS
	// =======================================================================================================================================================================================	

	async flowActionClean() {
		if (appdebug) { this.log('flowActionClean'); }
		await this._runCommand('Clean');
	}

	async flowActionStop() {
		if (appdebug) { this.log('flowActionStop'); }
		await this._runCommand('Stop');
	}

	async flowActionCharge() {
		if (appdebug) { this.log('flowActionCharge'); }
		await this._runCommand('Charge');
	}

	async flowActionPark() {
		if (appdebug) { this.log('flowActionPark'); }
		await this._park();
	}

	async flowActionPauseOn() {
		if (appdebug) { this.log('flowActionPauseOn'); }
		await this._runCommand('Pause');
	}

	async flowActionPauseOff() {
		if (appdebug) { this.log('flowActionPauseOff'); }
		await this._runCommand('Resume');
	}

	async flowActionEmptyDustbin() {
		if (appdebug) { this.log('flowActionEmptyDustbin'); }
		await this._runCommand('EmptyDustbin');
	}

	async flowActionWashMopStart() {
		if (appdebug) { this.log('flowActionWashMopStart'); }
		await this._runCommand('WashingStart');
	}

	async flowActionWashMopStop() {
		if (appdebug) { this.log('flowActionWashMopStop'); }
		await this._runCommand('WashingStop');
	}

	async flowActionDryMopStart() {
		if (appdebug) { this.log('flowActionDryMopStart'); }
		await this._runCommand('AirDryingStart');
	}

	async flowActionDryMopStop() {
		if (appdebug) { this.log('flowActionDryMopStop'); }
		await this._runCommand('AirDryingStop');
	}

	async flowActionAirdryingOn() {
		if (appdebug) { this.log('flowActionAirdryingOn'); }
		await this._runCommand('AirDryingStart');
	}

	async flowActionAirdryingOff() {
		if (appdebug) { this.log('flowActionAirdryingOff'); }
		await this._runCommand('AirDryingStop');		
	}

	async flowActionWashMopOn() {
		if (appdebug) { this.log('flowActionWashMopOn'); }
		await this._runCommand('WashingStart');
	}

	async flowActionWashMopOff() {
		if (appdebug) { this.log('flowActionWashMopOff'); }
		await this._runCommand('WashingStop');		
	}

	async flowActionRawCommand(command) {
		if (appdebug) { this.log('flowActionRawCommand(' + command + ')'); }
		await this._runCommand(command);
	}

	async flowActionCleanZone(zone) {
		if (appdebug) { this.log('flowActionCleanZone(' + zone + ')'); }
		await this._runCommand('SpotArea', zone.id.zoneid, 1);
		// await this.vacbot.run('FreeCLean', '1,' + zone.id.zoneid, 1);
	}

	async flowActionCleanZones(args) {
		if (appdebug) { this.log('flowActionCleanZonea(' + args + ')'); }
		const zones = [
			args.zone01?.id.zoneid,
			args.zone02?.id.zoneid,
			args.zone03?.id.zoneid,
			args.zone04?.id.zoneid,
			args.zone05?.id.zoneid
		]
		.filter(id => id != null)
		.join(',');
		await this._runCommand('SpotArea', zones, 1);
		// await this.vacbot.run('FreeCLean', '1,' + zone.id.zoneid, 1);
	}

	async flowActionSetCleanSpeed(value) {
		if (appdebug) { this.log('flowActionSetFanSpeed(' + value + ')'); }
		await this._runCommand('SetCleanSpeed', value);		
	}

	async flowActionSetWaterFlowValue(value) {
		if (appdebug) { this.log('flowActionSetWaterFlow(' + value + ')'); }
		await this._runCommand('SetWaterInfo', null, value, null );		

		if (value <= 20) {
			await this._runCommand('SetWaterLevel', 1);					
		}
		else if (value <= 30) {
			await this._runCommand('SetWaterLevel', 2);					
		}
		else if (value <= 40) {
			await this._runCommand('SetWaterLevel', 3);					
		}
		else  {
			await this._runCommand('SetWaterLevel', 4);					
		}
	}

	async flowActionSetWaterFlowLevel(level) {
		if (appdebug) { this.log('flowActionSetWaterFlow(' + level + ')'); }
		await this._runCommand('SetWaterLevel', level);		

		switch (level){
			case 1:
			case '1':
				await this._runCommand('SetWaterInfo', null, 20, null);
				break;
			case 2:
			case '2':
				await this._runCommand('SetWaterInfo', null, 30, null);
				break;
			case 3:
			case '3':
				await this._runCommand('SetWaterInfo', null, 40, null);
				break;
			case 4:
			case '4':
				await this._runCommand('SetWaterInfo', null, 50, null);
				break;
		}
	}

	async flowActionSetWorkMode(mode) {
		if (appdebug) { this.log('flowActionWorkMode(' + mode + ')'); }
		await this._runCommand('SetWorkMode', Number(mode));		
	}

	async flowActionSetSweepMode(mode) {
		if (appdebug) { this.log('flowActionSweepMode(' + mode + ')'); }
		await this._runCommand('SetSweepMode', Number(mode));		
	}

	async flowActionSetCleanCountpMode(mode) {
		if (appdebug) { this.log('flowActionSetCleanCountpMode(' + mode + ')'); }
		await this._runCommand('SetCleanCount', Number(mode));		
	}

	async flowActionSetMap(map) {
		if (appdebug) { this.log('flowActionSetMap(' + map + ')'); }
		await this._runCommand('SetMajorMap', map.id);		
	}

	async flowActionGetMapImage(map) {
		if (appdebug) { this.log('flowActionGetMapImage(' + map.id + ' , ' + map.name + ')'); }
		if (this.vacbot.isMapImageSupported() == false) { return; }
		this.vacbot.run('GetMapImage', map.id, "outline");		
		this.vacbot.run('GetMapInfo', map.id);		
		this.vacbot.run("GetMinorMap", map.id, 0);

		this.vacbot.mapManager.liveMapImage.getBase64PNG(
                this.vacbot.deebotPosition, this.vacbot.chargePosition, map.id, this.vacbot.mapManager
            ).then((base64) => { this.emit('mapImage', base64); });
	}


	// =======================================================================================================================================================================================
	// FLOW CONDITIONS
	// =======================================================================================================================================================================================	
	isMapActive(map) {
		this.maps = this.getStoreValue('maps');
		for (const m of this.maps) {
			if (m.mapid == map.id) {
				return m.mapIsCurrentMap;
			}
		}
		return false;
	}

	

	// =======================================================================================================================================================================================
	// FLOW AUTOCOMPLETE
	// =======================================================================================================================================================================================	
	getAutocompleteZoneList(onlyCurrentMap=false){
		let areas = this.getStoreValue('areas');
		let maps = this.getStoreValue('maps');

		let list = [];
		for (const map of maps) {
			for (const area of areas) {
				if (map.mapid == area.mapid) {
					if (onlyCurrentMap && !map.mapIsCurrentMap) { continue; }
					list.push(
						{
							"name": map.name + ' - ' + area.name,
							"id": {
								"id": area.mapid + '-' + area.zoneid,
								"mapid": area.mapid,
								"zoneid": area.zoneid 
							}
						}
					);
				}
			}
		}
		return list;
	}

	getAutocompleteMapList(){
		let maps = this.getStoreValue('maps');
		let list = [];
		for (const map of maps) {
			list.push(
				{
					"name": map.name,
					"id": map.mapid
				}
			);
		}
		return list;
	}

	getAutocompleteErrorCodeList(){
		const { errorCodes } = require('ecovacs-deebot/library/errorCodes.json');

		const list = Object.entries(errorCodes)
			.filter(([id]) => Number(id) >= 0)
			.map(([id, name]) => ({
				id,
				name: id.toString() + ': ' + name
			}));
		return list;
	}

	// =======================================================================================================================================================================================
	// DEEBOT API
	// =======================================================================================================================================================================================

	// Send a command and wait for the cloud response. Errors are returned to the flow card / UI instead of being
	// lost, and transient errors are retried. Error 500 'Request Timeout' (robot didn't answer the cloud in time)
	// happens regularly, e.g. when the robot is docked and its WiFi is sleeping.
	async _runCommand(command, ...args) {
		const MAX_ATTEMPTS = 3;
		for (let attempt = 1; ; attempt++){
			if (!this.vacbot){
				throw new Error('Not connected to the Ecovacs cloud, reconnecting...');
			}
			try{
				return await this.vacbot.runAsync(command, ...args);
			}
			catch(error){
				if (attempt >= MAX_ATTEMPTS || !this._isTransientError(error)){
					this.error('Command ' + command + ' failed: ' + error.message);
					throw error;
				}
				this.log('Command ' + command + ' failed (' + error.message + '), retry ' + attempt + '/' + (MAX_ATTEMPTS - 1));
				await new Promise((resolve) => this.homey.setTimeout(resolve, attempt * 3000));
			}
		}
	}

	_isTransientError(error) {
		const message = (error && error.message) || '';
		return /Failure code 50[0234]\b/.test(message) ||
			/^50[234] /.test(message) ||
			/ETIMEDOUT|ECONNRESET|ECONNREFUSED|EAI_AGAIN|ENOTFOUND|socket hang up/.test(message);
	}

	async _park(){
		let position = this.getStoreValue('parkPosition');
		if (position == undefined){
			throw new Error('No Park Position defined');
		} 
		position = position.x+','+position.y;
		await this._runCommand('GoToPosition', position);
	}

	_getMaps(){
		if (appdebug) { this.log('_getMaps()'); } 
		this.vacbot.run('GetMaps', true);
	}

	//////////////////////////////////////////// Utilities ///////////////////////////////////////


	// log() {
	// 	console.log.bind(this, new Date(new Date().getTime() + (new Date().getTimezoneOffset() * 60 * 1000)).toLocaleString('en-US', { day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', timeZone: this.homey.clock.getTimezone(), hour12: false }).replace(',', '') + " [log] [Device]").apply(this, arguments);
	// }

	// error() {
	// 	console.error.bind(this, new Date(new Date().getTime() + (new Date().getTimezoneOffset() * 60 * 1000)).toLocaleString('en-US', { day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', timeZone: this.homey.clock.getTimezone(), hour12: false }).replace(',', '') + " [err] [Device]").apply(this, arguments);
	// }

	// async getCleaningImage(vacbot, imageUrl) {

	// 	const sign = crypto
	// 		.createHash('sha256')
	// 		.update(vacbot.getCryptoHashStringForSecuredContent())
	// 		.digest('hex');

	// 	const headers = {
	// 		'Authorization': `Bearer ${vacbot.user_access_token}`,
	// 		'token': vacbot.user_access_token,
	// 		'appid': 'ecovacs',
	// 		'plat': 'android',
	// 		'userid': vacbot.uid,
	// 		'user-agent': 'EcovacsHome/2.3.7 (Linux; U; Android 5.1.1; A5010 Build/LMY48Z)',
	// 		'v': '2.3.7',
	// 		'country': vacbot.country,
	// 		'sign': sign,
	// 		'signType': 'sha256'
	// 	};

	// 	return new Promise((resolve, reject) => {
	// 		https.get(imageUrl, { headers }, res => {

	// 			const chunks = [];

	// 			res.on('data', chunk => chunks.push(chunk));

	// 			res.on('end', () => {
	// 				const data = Buffer.concat(chunks);

	// 				if (res.statusCode !== 200) {
	// 					return reject(
	// 						new Error(
	// 							`HTTP ${res.statusCode}: ${data.toString()}`
	// 						)
	// 					);
	// 				}

	// 				resolve(data);
	// 			});

	// 		}).on('error', reject);
	// 	});
	// }
}

module.exports = VacuumDevice