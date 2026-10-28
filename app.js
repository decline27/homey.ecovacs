'use strict';

const Homey			= require('homey');
const Logger		= require('./settings/captureLogs.js');
global.DeviceAPI	= null;

class Deebot extends Homey.App {

	async onInit() {
		if (process.env.DEBUG === '1') {

			// Start/connect debugger
			if (this.homey.platform == "local") {
				try {
				require('inspector').waitForDebugger();
				}
				catch (error) {
				require('inspector').open(9914, '0.0.0.0', true);
				}
			}
		}

		if (!this.logger) this.logger = new Logger({ homey: this.homey, length: 500 });

		global.appdebug		= this.homey.settings.get('appdebug')		|| false;
		global.libdebug		= this.homey.settings.get('libdebug')		|| false;
		global.verbose		= this.homey.settings.get('verbose')		|| false;
		global.wrap			= this.homey.settings.get('wrap')			|| false;
		global.autorefresh	= this.homey.settings.get('autorefresh')	|| false;

		process.on('unhandledRejection', (reason, promise, error) => {
			this.error('Unhandled Rejection at:', promise, ', reason:', reason, ', error:', error);
			// Application specific logging, throwing an error, or other logic here
		});

		process.on('uncaughtException', (error, origin) => {
			this.error('Uncaught Exception at: ', origin, ', error:', error);
		});		

		this.log(`${Homey.manifest.id} V${Homey.manifest.version} is running...`);
		this.log(`Ecovacs Deebot is started`)

		// Set debug mode for ecovacs-deebot.js:
		if (libdebug) { 
			process.env.NODE_ENV = 'development'
		} else {
			process.env.NODE_ENV = 'production'
		}
		console.log('NODE_ENV:', process.env.NODE_ENV);

		if (appdebug) { this.log('Settings:')}
		if (appdebug) { this.log('- appdebug: ' + appdebug) }
		if (appdebug) { this.log('- libdebug: ' + libdebug) }
		if (appdebug) { this.log('- verbose: ' + verbose) }
		if (appdebug) { this.log('- wrap: ' + wrap) }
		if (appdebug) { this.log('- autorefresh: ' + autorefresh) }

		this.homey.on('unload', () => {
			this.log(`${Homey.manifest.id} V${Homey.manifest.version} is stopping...`);
			this.log(`Ecovacs Deebot has stopped`)
			this.logger.saveLogs();
		})

		this.homey.settings.on('set', (function (dynamicVariableName) {
			eval(dynamicVariableName + " = this.homey.settings.get(dynamicVariableName)");
			if (appdebug) { this.log('Settings changed: ' + dynamicVariableName + ' set to ' + this.homey.settings.get(dynamicVariableName)) }
			if (dynamicVariableName === 'libdebug') {
				if (this.homey.settings.get('libdebug')) {
					process.env.NODE_ENV = 'development'
				} else {
					process.env.NODE_ENV = 'production'
				}
			}
		}).bind(this));


		await this._initFlowActions();
		await this._initFlowTriggers();
		await this._initFlowConditions();
	}

	// =======================================================================================================================================================================================
	// FLOW ACTIONS
	// =======================================================================================================================================================================================	
	async _initFlowActions() {
		this.homey.flow.getActionCard('clean').registerRunListener(async (args, state) => {
			return await args.device.flowActionClean();
		});

		this.homey.flow.getActionCard('stop').registerRunListener(async (args, state) => {
			return await args.device.flowActionStop();
		});

		this.homey.flow.getActionCard('charge').registerRunListener(async (args, state) => {
			return await args.device.flowActionCharge();
		});

		this.homey.flow.getActionCard('park').registerRunListener(async (args, state) => {
			return await args.device.flowActionPark();
		});

		this.homey.flow.getActionCard('pause_on').registerRunListener(async (args, state) => {
			return await args.device.flowActionPauseOn();
		});

		this.homey.flow.getActionCard('pause_off').registerRunListener(async (args, state) => {
			return await args.device.flowActionPauseOff();
		});

		this.homey.flow.getActionCard('empty_dustbin').registerRunListener(async (args, state) => {
			return await args.device.flowActionEmptyDustbin();
		});

		this.homey.flow.getActionCard('wash_mop_start').registerRunListener(async (args, state) => {
			return await args.device.flowActionWashMopStart();
		});

		this.homey.flow.getActionCard('wash_mop_stop').registerRunListener(async (args, state) => {
			return await args.device.flowActionWashMopStop();
		});

		this.homey.flow.getActionCard('dry_mop_start').registerRunListener(async (args, state) => {
			return await args.device.flowActionDryMopStart();
		});

		this.homey.flow.getActionCard('dry_mop_stop').registerRunListener(async (args, state) => {
			return await args.device.flowActionDryMopStop();
		});

		this.homey.flow.getActionCard('airdrying_on').registerRunListener(async (args, state) => {
			return await args.device.flowActionAirdryingOn();
		});

		this.homey.flow.getActionCard('airdrying_off').registerRunListener(async (args, state) => {
			return await args.device.flowActionAirdryingOff();
		});

		this.homey.flow.getActionCard('wash_mop_on').registerRunListener(async (args, state) => {
			return await args.device.flowActionWashMopOn();
		});

		this.homey.flow.getActionCard('wash_mop_off').registerRunListener(async (args, state) => {
			return await args.device.flowActionWashMopOff();
		});

		this.homey.flow.getActionCard('raw_command').registerRunListener(async (args, state) => {
			return await args.device.flowActionRawCommand( args.command );
		});

		this.homey.flow.getActionCard('clean_zone')
			.registerRunListener(async (args, state) => {
				return await args.device.flowActionCleanZone( args.zone );
			})
			.registerArgumentAutocompleteListener('zone', async (query, args) => {
				const zoneList = args.device.getAutocompleteZoneList(true);
				return zoneList.filter((result) => { 
					return result.name.toLowerCase().includes(query.toLowerCase());
				});
			});

		this.homey.flow.getActionCard('clean_zones')
			.registerRunListener(async (args, state) => {
				return await args.device.flowActionCleanZones( args );
			})
			.registerArgumentAutocompleteListener('zone01', async (query, args) => {
				const zoneList = args.device.getAutocompleteZoneList(true);
				return zoneList.filter((result) => { 
					return result.name.toLowerCase().includes(query.toLowerCase());
				});
			})
			.registerArgumentAutocompleteListener('zone02', async (query, args) => {
				const zoneList = args.device.getAutocompleteZoneList(true);
				return zoneList.filter((result) => { 
					return result.name.toLowerCase().includes(query.toLowerCase());
				});
			})
			.registerArgumentAutocompleteListener('zone03', async (query, args) => {
				const zoneList = args.device.getAutocompleteZoneList(true);
				return zoneList.filter((result) => { 
					return result.name.toLowerCase().includes(query.toLowerCase());
				});
			})
			.registerArgumentAutocompleteListener('zone04', async (query, args) => {
				const zoneList = args.device.getAutocompleteZoneList(true);
				return zoneList.filter((result) => { 
					return result.name.toLowerCase().includes(query.toLowerCase());
				});
			})
			.registerArgumentAutocompleteListener('zone05', async (query, args) => {
				const zoneList = args.device.getAutocompleteZoneList(true);
				return zoneList.filter((result) => { 
					return result.name.toLowerCase().includes(query.toLowerCase());
				});
			});

		this.homey.flow.getActionCard('set_map')
			.registerRunListener(async (args, state) => {
				return await args.device.flowActionSetMap( args.map );
			})
			.registerArgumentAutocompleteListener('map', async (query, args) => {
				const mapList = args.device.getAutocompleteMapList(true);
				return mapList.filter((result) => { 
					return result.name.toLowerCase().includes(query.toLowerCase());
				});
			});

		this.homey.flow.getActionCard('suction_power').registerRunListener(async (args, state) => {
			return await args.device.flowActionSetCleanSpeed( args.suction_power );
		});

		this.homey.flow.getActionCard('water_flow_value').registerRunListener(async (args, state) => {
			return await args.device.flowActionSetWaterFlowValue( args.value );
		});

		this.homey.flow.getActionCard('water_flow_level').registerRunListener(async (args, state) => {
			return await args.device.flowActionSetWaterFlowLevel( args.level );
		});

		this.homey.flow.getActionCard('work_mode').registerRunListener(async (args, state) => {
			return await args.device.flowActionSetWorkMode( args.mode );
		});

		this.homey.flow.getActionCard('sweep_mode').registerRunListener(async (args, state) => {
			return await args.device.flowActionSetSweepMode( args.mode );
		});

		this.homey.flow.getActionCard('clean_count_mode').registerRunListener(async (args, state) => {
			return await args.device.flowActionSetCleanCountpMode( args.mode );
		});

		try{
		this.homey.flow.getActionCard('get_map_image')
			.registerRunListener(async (args, state) => {
				return await args.device.flowActionGetMapImage( args.map );
			})
			.registerArgumentAutocompleteListener('map', async (query, args) => {
				const mapList = args.device.getAutocompleteMapList(true);
				return mapList.filter((result) => { 
					return result.name.toLowerCase().includes(query.toLowerCase());
				});
			});
		}catch(error){}
	}

	// =======================================================================================================================================================================================
	// FLOW TRIGGERS
	// =======================================================================================================================================================================================	
	async _initFlowTriggers() {
		
	}

	// =======================================================================================================================================================================================
	// FLOW CONDITIONS
	// =======================================================================================================================================================================================	
	async _initFlowConditions() {
		this.homey.flow.getConditionCard('map_active')
			.registerRunListener(async (args, state) => {
				return (args.device.isMapActive(args.map));
			})
			.registerArgumentAutocompleteListener('map', async (query, args) => {
				const mapList = args.device.getAutocompleteMapList();
				return mapList.filter((result) => { 
					return result.name.toLowerCase().includes(query.toLowerCase());
				});
			});

		this.homey.flow.getConditionCard('state_charge')
			.registerRunListener(async (args, state) => {
				return (args.device.getCapabilityValue('state_charge') == args.state);
			})

		this.homey.flow.getConditionCard('state_device')
			.registerRunListener(async (args, state) => {
				return (args.device.getCapabilityValue('state_device') == args.state);
			})

		this.homey.flow.getConditionCard('state_station')
			.registerRunListener(async (args, state) => {
				return (args.device.getCapabilityValue('state_station') == args.state);
			})

		this.homey.flow.getConditionCard('water_flow_level')
			.registerRunListener(async (args, state) => {
				return (args.device.getCapabilityValue('water_flow_level') == args.level);
			})

		this.homey.flow.getConditionCard('water_flow_value')
			.registerRunListener(async (args, state) => {
				return (args.device.getCapabilityValue('water_flow_value') == args.value);
			})

		this.homey.flow.getConditionCard('suction_power')
			.registerRunListener(async (args, state) => {
				return (args.device.getCapabilityValue('suction_power') == args.value);
			})

		this.homey.flow.getConditionCard('work_mode')
			.registerRunListener(async (args, state) => {
				return (args.device.getCapabilityValue('work_mode') == args.value);
			})

		this.homey.flow.getConditionCard('sweep_mode')
			.registerRunListener(async (args, state) => {
				return (args.device.getCapabilityValue('sweep_mode') == args.value);
			})

		this.homey.flow.getConditionCard('clean_count_mode')
			.registerRunListener(async (args, state) => {
				return (args.device.getCapabilityValue('clean_count_mode') == args.value);
			})

		this.homey.flow.getConditionCard('error_code')
			.registerRunListener(async (args, state) => {
				return (args.device.getCapabilityValue('error_code') == args.errorCode.id);
			})
			.registerArgumentAutocompleteListener('errorCode', async (query, args) => {
				const errorCodeList = args.device.getAutocompleteErrorCodeList();
				return errorCodeList.filter((result) => { 
					return result.name.toLowerCase().includes(query.toLowerCase());
				});
			});

	}

	// =======================================================================================================================================================================================
	// APP
	// =======================================================================================================================================================================================	
	deleteLogs() {
		return this.logger.deleteLogs();
	}

	getLogs() {
		return this.logger.logArray;
	}

	// log() {
	// 	console.log.bind(this, new Date(new Date().getTime() + (new Date().getTimezoneOffset() * 60 * 1000)).toLocaleString('en-US', { day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', timeZone: this.homey.clock.getTimezone(), hour12: false }).replace(',', '') + " [log] [App]").apply(this, arguments);
	// }

	// error() {
	// 	console.error.bind(this, new Date(new Date().getTime() + (new Date().getTimezoneOffset() * 60 * 1000)).toLocaleString('en-US', { day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', timeZone: this.homey.clock.getTimezone(), hour12: false }).replace(',', '') + " [err] [App]").apply(this, arguments);
	// }

}

module.exports = Deebot;