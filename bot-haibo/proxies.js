require('dotenv').config();

const DEFAULT_HAIBO_PROXY_HOST = '209.101.201.73';
const DEFAULT_HAIBO_PROXY_PORT = '59100';

module.exports = [
  {
    host: process.env.HAIBO_PROXY_HOST || DEFAULT_HAIBO_PROXY_HOST,
    port: process.env.HAIBO_PROXY_PORT || DEFAULT_HAIBO_PROXY_PORT,
    username: process.env.HAIBO_PROXY_USERNAME,
    password: process.env.HAIBO_PROXY_PASSWORD
  }
];
