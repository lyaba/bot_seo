const { randomInt, randomFloat } = require('./generator');

/**
 * Собирает весь JavaScript-код антидетект-патчей в одну строку.
 */
function buildPatchScript(fp) {
  return `
    // ============================================
    // 1. WEBDRIVER PATCH
    // ============================================
    try { (function() {
      // Удаляем webdriver property
      if (navigator.webdriver) {
        Object.defineProperty(navigator, 'webdriver', {
          get: () => undefined,
          configurable: true
        });
      }

      // Перезаписываем getter для всех источников
      const defineProp = (obj, prop, value) => {
        try {
          Object.defineProperty(obj, prop, {
            value: value,
            writable: false,
            configurable: true
          });
        } catch(e) {}
      };

      // Добавляем фиктивный ключ для обнаружения automation
      const randomKey = '_EE4Ee432e';
      defineProp(navigator, randomKey, { connection: 'downlink', rtt: 50 });

      // Patch Object.getOwnPropertyDescriptor
      const originalGetOwnPropertyDescriptor = Object.getOwnPropertyDescriptor;
      Object.getOwnPropertyDescriptor = function(obj, prop) {
        if (prop === 'webdriver' && obj === navigator) {
          return undefined;
        }
        return originalGetOwnPropertyDescriptor.call(this, obj, prop);
      };

      // Patch Object.getOwnPropertyNames
      const originalGetOwnPropertyNames = Object.getOwnPropertyNames;
      Object.getOwnPropertyNames = function(obj) {
        const names = originalGetOwnPropertyNames.call(this, obj);
        if (obj === navigator) {
          return names.filter(n => n !== 'webdriver');
        }
        return names;
      };

      // Patch for-in enumeration
      const originalKeys = Object.keys;
      Object.keys = function(obj) {
        const keys = originalKeys.call(this, obj);
        if (obj === navigator) {
          return keys.filter(k => k !== 'webdriver');
        }
        return keys;
      };

      // Patch JSON.stringify
      const originalStringify = JSON.stringify;
      JSON.stringify = function(obj) {
        if (obj === navigator || (typeof obj === 'object' && obj !== null && obj.webdriver !== undefined)) {
          const cloned = {};
          for (const key of Object.getOwnPropertyNames(obj)) {
            if (key !== 'webdriver') {
              cloned[key] = obj[key];
            }
          }
          return originalStringify(cloned);
        }
        return originalStringify.apply(this, arguments);
      };

      // Patch toString for webdriver-related functions
      const patchToString = (obj, prop) => {
        try {
          Object.defineProperty(obj, prop, {
            get: function() {
              return Function.prototype.toString.call(function() {});
            },
            configurable: true
          });
        } catch(e) {}
      };

      // Remove webdriver from window
      if ('webdriver' in window) {
        delete window.webdriver;
      }
    })(); } catch(e) { /* Section 1 (WEBDRIVER): */ }


    // ============================================
    // 2. WINDOW.CHROME PATCH
    // ============================================
    try { (function() {
      const chrome = {};

      // loadTimes API
      chrome.loadTimes = function() {
        return {
          connectionInfo: 'https',
          fps: 60,
          firstPaintAfterLoadTime: 0,
          renderBlockingTasks: [],
          resourceLoadTimes: {}
        };
      };

      // app API
      chrome.app = {
        getDetails: function() { return null; },
        getId: function() { return null; },
        IsInstalled: false
      };

      // runtime API
      chrome.runtime = {
        Id: null,
        getURL: function(path) { return 'chrome-extension://' + (chrome.runtime.Id || '') + '/' + path; },
        onMessage: { addListener: function() {}, removeListener: function() {} }
      };

      // webview API
      chrome.webview = {};

      // pdfViewer API
      chrome.pdfViewer = {
        isPdfViewerEnabled: true
      };

      // mediaCaptureDevices API
      chrome.mediaDevices = {
        mediaDevices: {}
      };

      // storage API
      chrome.storage = {
        local: {
          get: function() { return Promise.resolve({}); },
          set: function() { return Promise.resolve(); }
        },
        sync: {
          get: function() { return Promise.resolve({}); },
          set: function() { return Promise.resolve(); }
        }
      };

      // sendNativeMessage / connectNative stubs
      chrome.sendNativeMessage = function() { return Promise.resolve(); };
      chrome.connectNative = function() { return -1; };

      // Patch window.chrome
      try {
        Object.defineProperty(window, 'chrome', {
          get: function() { return chrome; },
          configurable: true,
          writable: true
        });
      } catch(e) {
        if (!window.chrome) window.chrome = chrome;
      }
    })(); } catch(e) { /* Section 2 (CHROME): */ }


    // ============================================
    // 3. NAVIGATOR.PLUGINS / mimeTypes PATCH
    // ============================================
    try { (function() {
      const plugins = [
        { name: 'Chrome PDF Viewer', filename: 'internal-pdf-viewer', description: 'Portable Document Format' },
        { name: 'PDF Viewer', filename: 'pdf.dll', description: '' },
        { name: 'Chromium PDF Viewer', filename: 'internal-pdf-viewer', description: '' },
        { name: 'Native Client', filename: 'internal-nacl-plugin', description: 'Native Executable Loader' },
        { name: 'PDFium', filename: 'pdfium.dll', description: '' }
      ];

      const mimeTypes = [
        { type: 'application/pdf', suffixes: 'pdf', description: 'Portable Document Format' },
        { type: 'application/x-chromium-pdf', suffixes: 'pdf', description: '' },
        { type: 'text/plain', suffixes: 'txt', description: '' }
      ];

      const Plugin = function(name, filename, description) {
        this.name = name;
        this.filename = filename;
        this.description = description;
        this.length = 0;
      };

      const MimeType = function(type, suffixes, description) {
        this.type = type;
        this.suffixes = suffixes;
        this.description = description;
        this.enabledPlugin = null;
      };

      try { Object.defineProperty(navigator, 'plugins', { get: function() { const a=[]; for(let i=0;i<plugins.length;i++){const p=new Plugin(plugins[i].name,plugins[i].filename,plugins[i].description);a.push(p)}Object.defineProperty(a,'item',{value:function(idx){return this[idx]||null},writable:true});Object.defineProperty(a,'refresh',{value:function(){},writable:true});Object.setPrototypeOf(a,Plugin.prototype);return a }, configurable:true }); } catch(e) {}
      try { Object.defineProperty(navigator, 'mimeTypes', { get: function() { const a=[]; for(let i=0;i<mimeTypes.length;i++){const m=new MimeType(mimeTypes[i].type,mimeTypes[i].suffixes,mimeTypes[i].description);a.push(m)}Object.defineProperty(a,'item',{value:function(idx){return this[idx]||null},writable:true});Object.setPrototypeOf(a,MimeType.prototype);return a }, configurable:true }); } catch(e) {}
      try { navigator.hasPlugin = function(name) { return false; }; } catch(e) {}
    })(); } catch(e) { /* Section 3 (PLUGINS): */ }


    // ============================================
    // 4. SCREEN METADATA PATCH
    // ============================================
    try { (function() {
      const sw = ${fp.screen?.width || fp.viewport.width};
      const sh = ${fp.screen?.height || fp.viewport.height};
      const availW = sw - 80;
      const availH = sh - 40;
      const dpr = ${fp.viewport.dpr || 3};
      const colorDepth = 24;
      const pixelDepth = 24;

      // Patch screen.width/height — stealth plugin may lock Screen.prototype
      try { Object.defineProperty(Screen.prototype, 'width', { get: function() { return sw; }, configurable: true }); } catch(e) {}
      try { Object.defineProperty(Screen.prototype, 'height', { get: function() { return sh; }, configurable: true }); } catch(e) {}
      try { Object.defineProperty(Screen.prototype, 'availWidth', { get: function() { return availW; }, configurable: true }); } catch(e) {}
      try { Object.defineProperty(Screen.prototype, 'availHeight', { get: function() { return availH; }, configurable: true }); } catch(e) {}
      try { Object.defineProperty(Screen.prototype, 'colorDepth', { get: function() { return colorDepth; }, configurable: true }); } catch(e) {}
      try { Object.defineProperty(Screen.prototype, 'pixelDepth', { get: function() { return pixelDepth; }, configurable: true }); } catch(e) {}

      // Patch orientation
      try {
        if (screen.orientation) {
          Object.defineProperty(screen.orientation, 'angle', { get: function() { return 0; }, configurable: true });
          Object.defineProperty(screen.orientation, 'type', { get: function() { return 'landscape-primary'; }, configurable: true });
        }
      } catch(e) {}

      // devicePixelRatio / window dimensions
      try { Object.defineProperty(window, 'devicePixelRatio', { get: function() { return dpr; }, configurable: true }); } catch(e) {}
      try { Object.defineProperty(window, 'innerWidth', { get: function() { return sw; }, configurable: true }); } catch(e) {}
      try { Object.defineProperty(window, 'innerHeight', { get: function() { return sh; }, configurable: true }); } catch(e) {}
      try { Object.defineProperty(window, 'outerWidth', { get: function() { return sw + 20; }, configurable: true }); } catch(e) {}
      try { Object.defineProperty(window, 'outerHeight', { get: function() { return sh + 60; }, configurable: true }); } catch(e) {}
    })(); } catch(e) { /* Section 4 (SCREEN): */ }


    // ============================================
    // 5. FONT ENUMERATION PATCH (FontsAPI)
    // ============================================
    try { (function() {
      const baseFonts = ['monospace', 'sans-serif', 'serif'];

      const fontList = [
        'Arial',
        'Arial Black',
        'Arial Narrow',
        'Calibri',
        'Cambria',
        'Cambria Math',
        'Comic Sans MS',
        'Consolas',
        'Courier',
        'Courier New',
        'Georgia',
        'Helvetica',
        'Impact',
        'Lucida Console',
        'Lucida Sans',
        'Microsoft Sans Serif',
        'MS Gothic',
        'MS PGothic',
        'MS Sans Serif',
        'MS Serif',
        'Palatino Linotype',
        'Segoe UI',
        'Tahoma',
        'Times',
        'Times New Roman',
        'Trebuchet MS',
        'Verdana',
        'Wingdings'
      ];

      // Patch FontFaceObserver
      if (typeof FontFaceObserver !== 'undefined') {
        const OriginalFontFaceObserver = FontFaceObserver;
        window.FontFaceObserver = function(name, weights) {
          return new OriginalFontFaceObserver(name, weights);
        };
        window.FontFaceObserver.prototype = OriginalFontFaceObserver.prototype;
      }

      // Patch matchFont API
      if (window.matchFont) {
        delete window.matchFont;
      }

      // Patch font enumeration detection libraries
      const originalGetComputedStyle = document.defaultView.getComputedStyle;
      document.defaultView.getComputedStyle = function(el, pseudo) {
        const style = originalGetComputedStyle.call(this, el, pseudo);
        if (style && typeof style.fontFamily === 'string') {
          Object.defineProperty(style, 'fontFamily', {
            get: function() {
              return 'Arial, sans-serif';
            },
            configurable: true
          });
        }
        return style;
      };

      // Patch document.fonts if available (modern browsers)
      if (document.fonts && document.fonts.query) {
        const originalQuery = document.fonts.query.bind(document.fonts);
        document.fonts.query = function(fontSize, fontString) {
          return originalQuery(fontSize, 'Arial' + fontString.slice(4));
        };
      }

      // Patch toFonData - canvas font fingerprinting
      if (HTMLCanvasElement.prototype.toFontData) {
        delete HTMLCanvasElement.prototype.toFontData;
      }
    })(); } catch(e) { /* Section 5 (FONTS): */ }


    // ============================================
    // 6. WEBGL / CANVAS / AUDIO FINGERPRINTS
    // ============================================
    try { (function() {
      // --- WebGL Renderer Patch ---
      const getParameterProxy = new Proxy(
        WebGLRenderingContext.prototype.getParameter,
        {
          apply: function(target, ctx, args) {
            if (args[0] === 7937) { // UNMASKED_VENDOR_WEBGL
              return 'Google Inc. (Intel)';
            }
            if (args[0] === 7938) { // UNMASKED_RENDERER_WEBGL
              return 'ANGLE (Intel, Intel(R) HD Graphics Direct3D11_17)' ;
            }
            return Reflect.apply(target, ctx, args);
          }
        }
      );
      WebGLRenderingContext.prototype.getParameter = getParameterProxy;

      if (WebGL2RenderingContext && WebGL2RenderingContext.prototype.getParameter) {
        WebGL2RenderingContext.prototype.getParameter = getParameterProxy;
      }

      // --- Canvas Fingerprint Patch ---
      const originalToDataURL = HTMLCanvasElement.prototype.toDataURL;
      HTMLCanvasElement.prototype.toDataURL = function() {
        return originalToDataURL.apply(this, arguments).replace(/\\d/g, function(match) {
          return String.fromCharCode(match.charCodeAt(0) + (Math.random() > 0.5 ? 1 : -1));
        });
      };

      // --- Audio Context Fingerprint Patch ---
      const createAnalyserProxy = new Proxy(
        AudioContext.prototype.createAnalyser,
        {
          apply: function(target, ctx, args) {
            const analyser = Reflect.apply(target, ctx, args);
            const originalGetFloatFrequencyData = analyser.getFloatFrequencyData;
            Object.defineProperty(analyser, 'getFloatFrequencyData', {
              value: function(arr) {
                if (arr && arr.length > 0) {
                  for (let i = 0; i < arr.length; i++) {
                    arr[i] += (Math.random() - 0.5) * 1e-6;
                  }
                }
                return originalGetFloatFrequencyData.call(this, arr);
              },
              writable: true
            });
            return analyser;
          }
        }
      );
      AudioContext.prototype.createAnalyser = createAnalyserProxy;
    })(); } catch(e) { /* Section 6 (WEBGL/AUDIO): */ }


    // ============================================
    // 7. WEBRTC IP LEAK PREVENTION
    // ============================================
    try { (function() {
      // Patch RTCPeerConnection
      const OriginalRTCPeerConnection = window.RTCPeerConnection;

      if (OriginalRTCPeerConnection) {
        window.RTCPeerConnection = function(config) {
          const pc = new OriginalRTCPeerConnection(config);

          // Override createOffer
          const originalCreateOffer = pc.createOffer;
          pc.createOffer = function() {
            return originalCreateOffer.call(this).then(function(offer) {
              if (offer.sdp) {
                offer.sdp = offer.sdp
                  .replace(/a=candidate:\\d+ \\d+ tcp \\d+ ([\\d.]+) \\d+ typ host/g, '')
                  .replace(/a=candidate:\\d+ \\d+ udp \\d+ ([\\d.]+) \\d+ typ host/g, '')
                  .replace(/a=candidate:(\\S+) .*typ host/g, 'a:candidate:$1 host 0 TCP 20 1 type host')
                  .replace(/([\\d.]+):\\d+(?:\\r\\n|\\n)/g, function(match, ip) {
                    if (/^\\d+\\.\\d+\\.\\d+\\.\\d+$/.test(ip)) {
                      return '0.0.0.0:9\\r\\n';
                    }
                    return match;
                  })
                  .replace(/a=local-ip([\\s=])([\\d.]+)/g, 'a=local-ip$10.0.0.0')
                  .replace(/a=remote-ip([\\s=])([\\d.]+)/g, 'a=remote-ip$10.0.0.1');
              }
              return offer;
            });
          };

          // Override createAnswer
          const originalCreateAnswer = pc.createAnswer;
          pc.createAnswer = function() {
            return originalCreateAnswer.call(this).then(function(answer) {
              if (answer.sdp) {
                answer.sdp = answer.sdp
                  .replace(/([\\d.]+):\\d+(?:\\r\\n|\\n)/g, function(match, ip) {
                    if (/^\\d+\\.\\d+\\.\\d+\\.\\d+$/.test(ip)) {
                      return '0.0.0.0:9\\r\\n';
                    }
                    return match;
                  })
                  .replace(/a=local-ip([\\s=])([\\d.]+)/g, 'a=local-ip$10.0.0.0')
                  .replace(/a=remote-ip([\\s=])([\\d.]+)/g, 'a=remote-ip$10.0.0.1');
              }
              return answer;
            });
          };

          // Override addIceCandidate - block real ICE candidates
          const originalAddIceCandidate = pc.addIceCandidate;
          pc.addIceCandidate = function(candidate) {
            return Promise.resolve();
          };

          // Patch onicecandidate to prevent IP leakage
          Object.defineProperty(pc, 'onicecandidate', {
            get: function() { return null; },
            set: function(handler) {
              // Swallow ICE candidates
              const originalHandler = handler;
              this._iceHandler = function(event) {
                if (event && event.candidate) {
                  event.candidate.candidate = '';
                }
                if (originalHandler) originalHandler(event);
              };
            },
            configurable: true
          });

          return pc;
        };

        // Copy static properties
        for (const key of Object.keys(OriginalRTCPeerConnection)) {
          window.RTCPeerConnection[key] = OriginalRTCPeerConnection[key];
        }
        window.RTCPeerConnection.prototype = OriginalRTCPeerConnection.prototype;
      }

      // Patch webrtcutil / detectRTC style checks
      if (window.webkitRTCPeerConnection) {
        window.webkitRTCPeerConnection = window.RTCPeerConnection;
      }
    })(); } catch(e) { /* Section 7 (WEBRTC): */ }


    // ============================================
    // 8. PERMISSIONS API PATCH
    // ============================================
    try { (function() {
      const OriginalNavigator = window.Navigator;
      const originalQuery = OriginalNavigator && OriginalNavigator.prototype && OriginalNavigator.prototype.permissions ?
        OriginalNavigator.prototype.permissions.bind({}) : null;

      if (navigator.permissions && navigator.permissions.query) {
        const originalPermissionsQuery = navigator.permissions.query;
        navigator.permissions.query = function(descriptor) {
          // Always grant common permissions to avoid detection
          const grantedDescriptors = [
            'geolocation',
            'notifications',
            'push',
            'camera',
            'microphone',
            'clipboard-read',
            'clipboard-write',
            'payment-handler',
            'midi'
          ];

          if (descriptor && descriptor.name) {
            const name = descriptor.name.toLowerCase();

            // Grant permissions that are typically granted or not applicable in mobile context
            if (grantedDescriptors.includes(name)) {
              return Promise.resolve({ state: 'granted' });
            }

            // For other permissions, return 'denied' instead of 'prompt' to avoid detection
            if (name === 'geolocation') {
              return Promise.resolve({ state: 'granted' });
            }
          }

          return originalPermissionsQuery.call(this, descriptor);
        };
      }

      // Patch Notification.permission
      Object.defineProperty(Notification, 'permission', {
        get: function() { return 'denied'; },
        configurable: true
      });

      // Patch navigator.userAgentData if available (Chromium 89+)
      if (navigator.userAgentData) {
        const originalGetHighEntropyValues = navigator.userAgentData.getHighEntropyValues;
        if (originalGetHighEntropyValues) {
          navigator.userAgentData.getHighEntropyValues = function(hints) {
            const originalPromise = originalGetHighEntropyValues.call(this, hints);
            if (originalPromise && typeof originalPromise.then === 'function') {
              return originalPromise.then(function(values) {
                // Remove or obfuscate platform info
                if (values.platform) values.platform = 'Android';
                if (values.platformVersion) values.platformVersion = fp ? fp.platformVersion : '13.0.0';
                if (values.architecture) values.architecture = 'arm';
                if (values.model) values.model = '';
                if (values.bitness) delete values.bitness;
                return values;
              });
            }
            return originalPromise;
          };
        }
      }
    })(); } catch(e) { /* Section 8 (PERMISSIONS): */ }


    // ============================================
    // 9. NAVIGATOR PROPERTIES PATCH
    // ============================================
    try { (function() {
      // navigator.hardwareConcurrency
      Object.defineProperty(navigator, 'hardwareConcurrency', {
        get: function() { return ${fp.hardwareConcurrency || 4}; },
        configurable: true
      });

      // navigator.language / languages
      const _fpLangs = ${JSON.stringify(fp.languages || ['en-US'])};
      if (navigator.languages) {
        Object.defineProperty(navigator, 'languages', {
          get: function() { return _fpLangs; },
          configurable: true
        });
      }

      Object.defineProperty(navigator, 'language', {
        get: function() { return _fpLangs[0]; },
        configurable: true
      });

      // navigator.platform
      Object.defineProperty(navigator, 'platform', {
        get: function() { return '${fp.platform || 'Android'}'; },
        configurable: true
      });

      // navigator.vendor
      Object.defineProperty(navigator, 'vendor', {
        get: function() { return 'Google Inc.'; },
        configurable: true
      });

      // navigator.product
      Object.defineProperty(navigator, 'product', {
        get: function() { return 'Gecko'; },
        configurable: true
      });

      // navigator.appName
      Object.defineProperty(navigator, 'appName', {
        get: function() { return 'Netscape'; },
        configurable: true
      });

      // navigator.appVersion
      Object.defineProperty(navigator, 'appVersion', {
        get: function() { return '${fp.appVersion || fp.userAgent}'; },
        configurable: true
      });

      // navigator.oscpu
      Object.defineProperty(navigator, 'oscpu', {
        get: function() { return undefined; },
        configurable: true
      });

      // navigator.deviceMemory
      Object.defineProperty(navigator, 'deviceMemory', {
        get: function() { return ${fp.deviceMemory || 4}; },
        configurable: true
      });

      // navigator.maxTouchPoints
      Object.defineProperty(navigator, 'maxTouchPoints', {
        get: function() { return ${fp.maxTouchPoints || 5}; },
        configurable: true
      });

      // navigator.bluetooth (stub)
      if (!navigator.bluetooth) {
        navigator.bluetooth = {};
      }

      // navigator.serial (stub)
      if (!navigator.serial) {
        navigator.serial = {};
      }

      // navigator.usb (stub)
      if (!navigator.usb) {
        navigator.usb = {};
      }

      // navigator.webdriver - double ensure removal
      try {
        delete navigator.webdriver;
      } catch(e) {}

      // Patch connection / network information
      if (navigator.connection) {
        Object.defineProperty(navigator.connection, 'effectiveType', {
          get: function() { return '4g'; },
          configurable: true
        });
        Object.defineProperty(navigator.connection, 'rtt', {
          get: function() { return ${fp.rtt || 50}; },
          configurable: true
        });
        Object.defineProperty(navigator.connection, 'downlink', {
          get: function() { return ${fp.downlink || 10}; },
          configurable: true
        });
      }

      // Patch navigator.cookieEnabled
      Object.defineProperty(navigator, 'cookieEnabled', {
        get: function() { return true; },
        configurable: true
      });

      // Patch doNotTrack
      Object.defineProperty(navigator, 'doNotTrack', {
        get: function() { return '1'; },
        configurable: true
      });

      // Patch WebGL vendor/renderer via canvas
      const glHack = function(canvas) {
        try {
          const gl = canvas.getContext('webgl') || canvas.getContext('experimental-webgl');
          if (gl) {
            const debugInfo = gl.getExtension('WEBGL_debug_renderer_info');
            if (debugInfo) {
              Object.defineProperty(gl, 'UNMASKED_VENDOR_WEBGL', { value: 0x9245 });
              Object.defineProperty(gl, 'UNMASKED_RENDERER_WEBGL', { value: 0x9246 });
            }
          }
        } catch(e) {}
      };

      const origCreateElement = document.createElement;
      document.createElement = function(tagName) {
        const el = origCreateElement.apply(this, arguments);
        if (tagName.toLowerCase() === 'canvas') {
          glHack(el);
        }
        return el;
      };
    })(); } catch(e) { /* Section 9 (NAVIGATOR PROPS): */ }


    // ============================================
    // 10. TRANSITION TRACKING PATCH
    // ============================================
    try { (function() {
      // Patch performance.timing for timing-based detection
      const origPerformance = window.performance;
      if (origPerformance && origPerformance.timing) {
        const timing = origPerformance.timing;
        const navigationStart = timing.navigationStart || Date.now();

        Object.defineProperty(timing, 'navigationStart', {
          get: function() { return navigationStart; },
          configurable: true
        });

        Object.defineProperty(timing, 'domContentLoadedEventStart', {
          get: function() { return navigationStart + 100; },
          configurable: true
        });

        Object.defineProperty(timing, 'domContentLoadedEventEnd', {
          get: function() { return navigationStart + 150; },
          configurable: true
        });

        Object.defineProperty(timing, 'domComplete', {
          get: function() { return navigationStart + 300; },
          configurable: true
        });

        Object.defineProperty(timing, 'loadEventStart', {
          get: function() { return navigationStart + 350; },
          configurable: true
        });

        Object.defineProperty(timing, 'loadEventEnd', {
          get: function() { return navigationStart + 400; },
          configurable: true
        });

        // Hide timing from JSON.stringify
        const origTimingKeys = Object.keys(timing);
        if (Object.getOwnPropertyNames) {
          const origGetOwnPropertyNames = Object.getOwnPropertyNames;
          Object.getOwnPropertyNames = function(obj) {
            const names = origGetOwnPropertyNames.call(this, obj);
            if (obj === timing || (typeof obj === 'object' && obj === origPerformance.timing)) {
              return names.filter(n => n !== 'navigationStart');
            }
            return names;
          };
        }
      }

      // Patch PerformanceNavigation.type
      if (window.performance && window.performance.navigation) {
        Object.defineProperty(window.performance.navigation, 'type', {
          get: function() { return 1; }, // TYPE_NAVIGATENEXT or TYPE_RELOAD
          configurable: true
        });
      }

      // Patch PerformanceEntry entries for navigation timing detection
      const origGetEntriesByType = performance.getEntriesByType;
      if (origGetEntriesByType) {
        performance.getEntriesByType = function(type) {
          if (type === 'navigation') {
            return [{
              entryType: 'navigation',
              name: window.location.href,
              startTime: 0,
              duration: 400,
              initiatorType: 'navigation',
              navigationType: 'reload',
              redirectCount: 0,
              unloadEventStart: 0,
              unloadEventEnd: 0,
              domInteractive: 100,
              domContentLoadedEventStart: 100,
              domContentLoadedEventEnd: 150,
              domComplete: 300,
              loadEventStart: 350,
              loadEventEnd: 400,
              type: 'reload'
            }];
          }
          return origGetEntriesByType.call(this, type);
        };
      }
    })(); } catch(e) { /* Section 10 (TRANSITION TRACKING): */ }


    // ============================================
    // 11. ADDITIONAL HARDENING
    // ============================================
    try { (function() {
      // Patch iframe sandbox detection
      try {
        const iframe = document.createElement('iframe');
        iframe.sandbox = '';
        const sandboxProto = iframe.contentWindow && iframe.contentWindow.location ?
          Object.getOwnPropertyDescriptor(HTMLIFrameElement.prototype, 'sandbox') : null;
        if (sandboxProto) {
          Object.defineProperty(HTMLIFrameElement.prototype, 'sandbox', sandboxProto);
        }
      } catch(e) {}

      // Patch toString for automation detection
      const patchToString = function(obj, prop, value) {
        try {
          Object.defineProperty(obj, prop, {
            get: function() { return value; },
            configurable: true
          });
        } catch(e) {}
      };

      // Remove all automation-related properties from window
      const automationProps = [
        'phantom', 'selenium', 'cypress', 'puppeteer', 'playwright',
        '__playwright', '__webdriver_scripts', '__webdriver_cmd_id',
        '_selenium', 'callFunction', 'callFunction_ensure',
        '$cdc_asdjflasposfnhicianhjieia'
      ];

      for (const prop of automationProps) {
        try {
          if (prop in window) {
            delete window[prop];
          }
        } catch(e) {}
      }

      // Patch eval toString
      const origEval = eval;
      Object.defineProperty(window, 'eval', {
        get: function() { return origEval; },
        configurable: true
      });

      // Patch Function.toString to hide bundled code
      const origFunctionToString = Function.prototype.toString;
      Function.prototype.toString = function() {
        if (this === applyFingerprint || this.name === 'applyFingerprint') {
          return 'function applyFingerprint() { [native code] }';
        }
        return origFunctionToString.call(this);
      };

      // Patch Error.stackTraceLimit
      if (Error.stackTraceLimit) {
        Error.stackTraceLimit = 10;
      }
    })(); } catch(e) { /* Section 11 (ADDITIONAL HARDENING): */ }
  `;
}


/**
 * Применяет все антидетект-патчи через page.evaluate().
 */
async function applyFingerprint(page, fp) {
  // 1. setUserAgent + viewport (базовые настройки)
  await page.setUserAgent(fp.userAgent);

  await page.setViewport({
    width: fp.viewport.width,
    height: fp.viewport.height,
    deviceScaleFactor: fp.viewport.dpr,
    isMobile: true,
    hasTouch: true
  });

  await page.setExtraHTTPHeaders({
    'Accept-Language': fp.languages.join(',')
  });

  // 2. Применяем все JS-патчи
  const patchScript = buildPatchScript(fp);
  await page.evaluate(patchScript);

  // 3. Блокируем доступ к /json/version (для Puppeteer detection)
  await page.setRequestInterception(true);
  page.on('request', (req) => {
    if (req.url().includes('/json/version') || req.url().includes('/json/protocol')) {
      return req.abort('blockedbyclient');
    }
    req.continue();
  });

  // 4. Скрываем Puppeteer signature в console
  await page.evaluateOnNewDocument(() => {
    // Override console methods to hide puppeteer logs
    const noop = function() {};
    const origLog = console.log;
    const origWarn = console.warn;
    const origError = console.error;

    // Patch window toString for detection libraries
    Object.defineProperty(window, 'toString', {
      value: function() { return 'function toString() { [native code] }'; },
      writable: false,
      configurable: true
    });

    // Patch navigator.toString
    Object.defineProperty(navigator, 'toString', {
      value: function() { return '[object Navigator]'; },
      writable: false,
      configurable: true
    });
  });
}


module.exports = { applyFingerprint, buildPatchScript };
