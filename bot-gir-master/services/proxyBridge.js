const http = require('http');
const net = require('net');

function authHeader(proxy) {
  return `Basic ${Buffer.from(`${proxy.username}:${proxy.password}`).toString('base64')}`;
}

function startProxyBridge(proxy) {
  return new Promise((resolve, reject) => {
    const auth = authHeader(proxy);

    const server = http.createServer((clientReq, clientRes) => {
      const headers = {
        ...clientReq.headers,
        'proxy-authorization': auth,
        'proxy-connection': 'keep-alive'
      };

      const upstreamReq = http.request({
        host: proxy.host,
        port: Number(proxy.port),
        method: clientReq.method,
        path: clientReq.url,
        headers
      }, upstreamRes => {
        clientRes.writeHead(upstreamRes.statusCode || 502, upstreamRes.headers);
        upstreamRes.pipe(clientRes);
      });

      upstreamReq.on('error', error => {
        clientRes.writeHead(502);
        clientRes.end(error.message);
      });

      clientReq.pipe(upstreamReq);
    });

    server.on('connect', (clientReq, clientSocket, head) => {
      const upstreamSocket = net.connect(Number(proxy.port), proxy.host, () => {
        upstreamSocket.write(
          `CONNECT ${clientReq.url} HTTP/1.1\r\n` +
          `Host: ${clientReq.url}\r\n` +
          `Proxy-Authorization: ${auth}\r\n` +
          'Proxy-Connection: keep-alive\r\n' +
          '\r\n'
        );
      });

      let pending = Buffer.alloc(0);

      upstreamSocket.on('data', chunk => {
        pending = Buffer.concat([pending, chunk]);
        const headerEnd = pending.indexOf('\r\n\r\n');
        if (headerEnd === -1) return;

        const header = pending.slice(0, headerEnd).toString('latin1');
        const rest = pending.slice(headerEnd + 4);

        upstreamSocket.removeAllListeners('data');

        if (!/^HTTP\/1\.[01] 200/i.test(header)) {
          clientSocket.write(header + '\r\n\r\n');
          clientSocket.end();
          upstreamSocket.end();
          return;
        }

        clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');

        if (head && head.length) upstreamSocket.write(head);
        if (rest.length) upstreamSocket.unshift(rest);

        upstreamSocket.pipe(clientSocket);
        clientSocket.pipe(upstreamSocket);
      });

      upstreamSocket.on('error', () => clientSocket.end());
      clientSocket.on('error', () => upstreamSocket.end());
    });

    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      resolve({
        url: `http://127.0.0.1:${address.port}`,
        close: () => new Promise(done => server.close(done))
      });
    });
  });
}

module.exports = { startProxyBridge };
