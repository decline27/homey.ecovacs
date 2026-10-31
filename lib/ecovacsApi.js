'use strict';

const http			= require('http');
// const ecovacsDeebot	= require('./ecovacs-deebot');
const ecovacsDeebot	= require('ecovacs-deebot');
const EcoVacsAPI	= ecovacsDeebot.EcoVacsAPI;
let deviceAPI		= null;
exports.errorCodes 	= require('ecovacs-deebot/library/errorCodes.json');

// exports.getApi = async function(username, password){
// 	let json = await httpGetIpInfo('http://ipinfo.io/json');
// 	let device_id		= EcoVacsAPI.md5(between(10000000, 99999999));
// 	let password_hash	= EcoVacsAPI.md5(password);
// 	let country			= (json.country.toLowerCase() == 'gb') ? 'uk': json.country.toLowerCase();
// 	let continent		= ecovacsDeebot.countries[country.toUpperCase()].continent.toLowerCase();
// 	deviceAPI	        = new EcoVacsAPI(device_id, country, continent);

// 	try{
// 		await deviceAPI.connect(username, password_hash);
// 		console.log("Connected!");
// 	}catch(e){
// 		console.error("Failure in connecting!: ", e);
// 		throw e;
// 	}

// 	return deviceAPI;
// }

// country: optional, the country found at a previous connect. Avoids depending on ipinfo.io for every (re)connect.
exports.getApi = async function(deviceId, country){
	if (!country){
		let json = await httpGetIpInfo('http://ipinfo.io/json');
		if (!json.country){
			throw new Error('Could not determine country from ipinfo.io: ' + JSON.stringify(json));
		}
		country = json.country;
	}
	let device_id       = deviceId ?? this.getDeviceId(between(10000000, 99999999));
	country				= (country.toLowerCase() == 'gb') ? 'uk': country.toLowerCase();
	let continent		= ecovacsDeebot.countries[country.toUpperCase()].continent.toLowerCase();
	deviceAPI	        = new EcoVacsAPI(device_id, country, continent);

	return deviceAPI;
}

exports.getPasswordHash = function(password){
	return EcoVacsAPI.md5(password);;
}

exports.getConstant = function(constant){
    return EcoVacsAPI[constant];
}

exports.getDeviceId = function(deviceId){
    return EcoVacsAPI.getDeviceId(deviceId, 0);;
}

function httpGetIpInfo(url) {
	return new Promise((resolve, reject) => {
		const req = http.get(url, (res) => {
			res.setEncoding('utf8');
			let rawData = '';
			res.on('close', () => {
				if (!res.complete) {
					reject(new Error('ECONNRESET: ipinfo.io closed the connection during the response'));
				}
			});
			res.on('data', (chunk) => { rawData += chunk; });
			res.on('end', function () {
				try {
					const json = JSON.parse(rawData);
					resolve(json);
				} catch (e) {
					reject(e);
				}
			});
		});
		req.on('error', (e) => {
			reject(e);
		});
		// Not req.setTimeout(): while connecting that fires on the socket timeout of Node's default agent (5s)
		const timer = setTimeout(() => {
			req.destroy(new Error('ETIMEDOUT: ipinfo.io did not respond'));
		}, 15 * 1000);
		req.on('close', () => clearTimeout(timer));
	});
}

function between(min, max) {
	let num = Math.floor(
		Math.random() * (max - min) + min
	);
	return num.toString();
}

// function log() {
//     console.log.bind(this, new Date(new Date().getTime() + (new Date().getTimezoneOffset() * 60 * 1000)).toLocaleString('en-US', { day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', timeZone: this.homey.clock.getTimezone(), hour12: false }).replace(',', '') + " [log] [Driver]").apply(this, arguments);
// }

// function error() {
//     console.error.bind(this, new Date(new Date().getTime() + (new Date().getTimezoneOffset() * 60 * 1000)).toLocaleString('en-US', { day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', timeZone: this.homey.clock.getTimezone(), hour12: false }).replace(',', '') + " [err] [Driver]").apply(this, arguments);
// }