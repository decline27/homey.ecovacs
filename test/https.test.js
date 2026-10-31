'use strict';

const test = require('node:test');
const assert = require('node:assert');
const http = require('http');
const Module = require('module');
const path = require('path');

// lib/https.js only uses request() of the https module, plain http behaves the same for these tests
function loadHttps() {
	const file = path.resolve(__dirname, '../lib/https.js');
	const originalLoad = Module._load;
	Module._load = function (request, parent, isMain) {
		if (request === 'https' && parent && parent.filename === file) {
			return http;
		}
		return originalLoad.call(this, request, parent, isMain);
	};
	delete require.cache[file];
	try {
		return require(file);
	}
	finally {
		Module._load = originalLoad;
	}
}

async function withServer(handler, run) {
	const server = http.createServer(handler);
	await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
	try {
		await run('http://127.0.0.1:' + server.address().port);
	}
	finally {
		server.closeAllConnections();
		await new Promise((resolve) => server.close(resolve));
	}
}

const settleWithin = (promise, ms) => Promise.race([
	promise,
	new Promise((_, reject) => setTimeout(() => reject(new Error('still not settled after ' + ms + 'ms')), ms).unref()),
]);

test('JSON response is parsed', async () => {
	const https = loadHttps();
	await withServer((req, res) => {
		res.setHeader('content-type', 'application/json');
		res.end('{"ret":"ok"}');
	}, async (url) => {
		assert.deepStrictEqual(await https.request('GET', url, { headers: {} }), { ret: 'ok' });
	});
});

test('a non-200 response rejects with the status, like axios', async () => {
	const https = loadHttps();
	await withServer((req, res) => {
		res.statusCode = 502;
		res.end('bad');
	}, async (url) => {
		await assert.rejects(https.request('GET', url, { headers: {} }), (error) => {
			assert.strictEqual(error.response.status, 502);
			return true;
		});
	});
});

test('a connection lost during the response rejects instead of hanging', async () => {
	const https = loadHttps();
	await withServer((req, res) => {
		res.setHeader('content-type', 'application/json');
		res.writeHead(200);
		res.write('{"ret":');
		setTimeout(() => res.destroy(), 50);
	}, async (url) => {
		await assert.rejects(settleWithin(https.request('GET', url, { headers: {} }), 3000), /ECONNRESET/);
	});
});

test('errors do not contain the query with the login data', async () => {
	const https = loadHttps();
	await assert.rejects(https.request('GET', 'http://127.0.0.1:1/login?account=me&password=secret', { headers: {} }), (error) => {
		assert.ok(!error.message.includes('secret'), error.message);
		assert.ok(!error.message.includes('account'), error.message);
		return true;
	});
});

test('a timer does not keep the process waiting after the request is done', async () => {
	const https = loadHttps();
	await withServer((req, res) => res.end('x'), async (url) => {
		const before = process.getActiveResourcesInfo().filter((r) => r === 'Timeout').length;
		await https.request('GET', url, { headers: {} });
		await new Promise((resolve) => setImmediate(resolve));
		const after = process.getActiveResourcesInfo().filter((r) => r === 'Timeout').length;
		assert.ok(after <= before, before + ' => ' + after);
	});
});
