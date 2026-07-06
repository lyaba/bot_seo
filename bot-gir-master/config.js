module.exports = {
  targetDomain: 'gir-master.ru',
  keywords: [
    'расчитска участак казань',
    'сплить дерево цена',
    'удалить пень без корчевания быстро в казани',
    'услуги валки деревьев',
    'вырубка и вывоз деревьев'
  ],
  google: {
    provider: 'browser',
    headless: process.env.HEADLESS !== 'false',
    keepBrowserOpen: process.env.KEEP_BROWSER_OPEN === 'true',
    waitForManualVerification: process.env.WAIT_FOR_MANUAL_GOOGLE === 'true',
    manualVerificationTimeoutMinutes: Number(process.env.MANUAL_GOOGLE_TIMEOUT_MINUTES || 20),
    intervalMinutes: Number(process.env.CHECK_INTERVAL_MINUTES || 20),
    maxPages: 10,
    resultsPerPage: 10,
    language: 'ru',
    country: 'ru'
  },
  proxy: {
    enabled: true,
    index: 0
  }
};
