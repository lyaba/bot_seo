const devices = require('./devices');

function getRandomDevice() {
  return devices[Math.floor(Math.random() * devices.length)];
}

function buildFingerprint(proxy) {
  const device = getRandomDevice();

  return {
    ...device,
    proxy
  };
}

module.exports = { buildFingerprint };
