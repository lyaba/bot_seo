module.exports = [
  {
    host: process.env.PROXY_HOST || "res.geonix.com",
    port: process.env.PROXY_PORT || "10000",
    username: process.env.PROXY_USERNAME || "",
    password: process.env.PROXY_PASSWORD || ""
  }
];
