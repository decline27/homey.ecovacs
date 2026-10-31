const http = require('https');

const REQUEST_TIMEOUT = 30 * 1000;

// The query of Ecovacs login URLs holds the account and password hash. Errors end up in logs and on the device.
const urlWithoutQuery = (url) => String(url).split('?')[0];

const request = async function(method='GET', url, options={}, body) {
  return new Promise((resolve, reject) => {
    if (method == 'POST'){
      options.headers["Content-Length"] = Buffer.byteLength(body);
    }
    options.method = method;

    // Force IPv$ DNS resolution
    // options['family'] = 4;
    // options['timeout'] = 1000;

    let req = http.request(url, options, res => {
      // if (res.statusCode !== 200) {
      //     // console.log('Failed to POST to url:' + url +' status code: '+res.statusCode);
      //     reject( new Error(res.statusCode + ' '  + res.statusMessage));
      // }
      res.setEncoding('utf8');
      let data = [];
      let resHeaders = res.headers;

      res.on('data', chunk => data.push(chunk));
      res.on('end', () => {
        try{
          if (res.statusCode !== 200) {
            // console.log('Failed to POST to url:' + url +' status code: '+res.statusCode);
            // Axios-like error, the ecovacs-deebot lib checks error.response.status to retry on 502
            let error = new Error(res.statusCode + ' '  + res.statusMessage + ': ' + data);
            error.response = { status: res.statusCode, data: data.join('') };
            reject(error);
            return;
          }
          let result = data;
          if ((resHeaders["content-type"] || '').startsWith("application/json")){
            result = JSON.parse(data.join(''));
            if (result.response){
              result = result.response;
            }
          }
          resolve(result);
        }
        catch(error){
          reject( new Error('Failed to '+method+' to url:' + urlWithoutQuery(url) +' error: ' + error.message ));
        }
      });
    });

    req.on('error', (error) =>
      // reject(new Error('Failed to '+method+' to url:' + url +' with body:'+ JSON.stringify(body) +' '+ error))
      reject(new Error('Failed to '+method+' to url:' + urlWithoutQuery(url) +' error: ' + error.message ))
    );

    // Without a timeout a stalled connection never settles (login hangs forever, commands get lost)
    // Not req.setTimeout(): while connecting that fires on the socket timeout of Node's default agent (5s)
    const timer = setTimeout(() => {
      req.destroy(new Error('ETIMEDOUT: no response within ' + (REQUEST_TIMEOUT / 1000) + 's'));
    }, REQUEST_TIMEOUT);
    req.on('close', () => clearTimeout(timer));

    if (method == 'POST'){
      req.write(body);
    }
    req.end();
  });
}

const requestStream = async function(method='GET', url, options={}, body) {
  return new Promise((resolve, reject) => {
    if (method == 'POST'){
      options.headers["Content-Length"] = Buffer.byteLength(body);
    }
    options.method = method;

    // Force IPv$ DNS resolution
    // options['family'] = 4;
    // options['timeout'] = 1000;

    let req = http.request(url, options, res => {
      if (res.statusCode !== 200) {
          // console.log('Failed to POST to url:' + url +' status code: '+res.statusCode);
          reject( new Error(res.statusCode + ' '  + res.statusMessage));
      }
      res.setEncoding('utf8');
      let data = [];
      let resHeaders = res.headers;
      let result = res;

      res.on('data', chunk => data.push(chunk));
      res.on('end', async (res) => {
        try{
          // let result = data;
          // if (resHeaders["content-type"].startsWith("application/json")){
          //   result = JSON.parse(data.join('')); 
          //   if (result.response){
          //     result = result.response;
          //   }
          // }
          resolve(result);
        }
        catch(error){
          reject( new Error('Failed to '+method+' to url:' + urlWithoutQuery(url) +' error: ' + error.message ));
        }
      });
    });

  req.on('error', (error) => 
      // reject(new Error('Failed to '+method+' to url:' + url +' with body:'+ JSON.stringify(body) +' '+ error))
      reject(new Error('Failed to '+method+' to url:' + urlWithoutQuery(url) +' error: ' + error.message ))
    );

    if (method == 'POST'){
      req.write(body);
    }
    req.end();
  });
}


const getRedirectUrl = async function(url, options={}) {
  return new Promise((resolve, reject) => {
    options['method'] = 'GET';
    // options['timeout'] = 1000;
    options['headers'] = {
      maxRedirects: 1
    };
    // Force IPv$ DNS resolution
    // options['family'] = 4;

    let req = http.get(url, options, res => {
      if (res.statusCode == 302) {
          resolve(res.headers.location);
      }
      else{
        reject( new Error('No valid redirect URL found.'));
      }
    });

    req.on('error', (error) => 
      // reject(new Error('Failed to '+method+' to url:' + url +' with body:'+ JSON.stringify(body) +' '+ error))
      reject(new Error('Failed to '+options['method']+' to url:' + urlWithoutQuery(url) +' error: ' + error.message ))
    );
  });
}

exports.request = request;
exports.requestStream = requestStream;
exports.getRedirectUrl = getRedirectUrl;