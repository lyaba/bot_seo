/**
 * Local HTTP proxy tunnel.
 * Forwards requests to the remote authenticated proxy.
 * Usage: node proxy-tunnel.js <host> <port> <username> <password> <localPort>
 */
const http = require('http');
const https = require('https');
const net = require('net');
const { URL } = require('url');

const [remoteHost, remotePort, username, password, localPortStr] = process.argv.slice(2);
const localPort = parseInt(localPortStr || '8899', 10);
const auth = Buffer.from(`${username}:${password}`).toString('base64');

const server = http.createServer((req, res) => {
  const isHttps = req.headers['x-forwarded-proto'] === 'https' || req.headers.host;
  
  // For CONNECT (HTTPS) requests, handle tunneling
  // For plain HTTP, forward with auth
  const targetHost = req.headers['x-target-host'] || req.headers.host;
  const targetPort = req.headers['x-target-port'] || (isHttps ? 443 : 80);

  const proxyReq = http.request({
    host: remoteHost,
    port: parseInt(remotePort, 10),
    method: req.method,
    path: req.url,
    headers: {
      ...req.headers,
      'proxy-authorization': `Basic ${auth}`,
      host: targetHost
    }
  });

  proxyReq.on('error', (err) => {
    res.writeHead(502);
    res.end('Proxy error: ' + err.message);
  });

  proxyReq.on('response', (proxyRes) => {
    res.writeHead(proxyRes.statusCode, proxyRes.headers);
    proxyRes.pipe(res);
  });

  req.pipe(proxyReq);
});

// Handle CONNECT for HTTPS
server.on('connect', (req, clientSocket, head) => {
  const [host, port] = req.url.split(':');
  const socket = net.connect(parseInt(port || 443, 10), remoteHost, () => {
    // Send CONNECT with proxy auth
    const connectReq = `CONNECT ${host}:${port || 443} HTTP/1.1\r\n` +
      `Host: ${host}:${port || 443}\r\n` +
      `Proxy-Authorization: Basic ${auth}\r\n` +
      `Connection: keep-alive\r\n\r\n`;
    socket.write(connectReq);
  });

  socket.on('connect', () => {
    // Wait for 200 response from proxy
    let buf = '';
    const onData = (data) => {
      buf += data.toString();
      if (buf.includes('\r\n\r\n')) {
        const statusLine = buf.split('\r\n')[0];
        if (statusLine.includes('200')) {
          clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
          socket.removeListener('data', onData);
          socket.removeAllListeners('data');
          socket.pipe(clientSocket);
          clientSocket.pipe(socket);
        } else {
          clientSocket.write('HTTP/1.1 502 Bad Gateway\r\n\r\n');
          clientSocket.end();
          socket.end();
        }
      }
    };
    socket.on('data', onData);
  });

  socket.on('error', (err) => {
    clientSocket.write('HTTP/1.1 502 Bad Gateway\r\n\r\n');
    clientSocket.end();
  });

  clientSocket.on('error', () => socket.destroy());
});

server.listen(localPort, '127.0.0.1', () => {
  console.log(`Proxy tunnel: localhost:${localPort} -> ${remoteHost}:${remotePort}`);
});
